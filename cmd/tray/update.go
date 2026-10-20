//go:build (darwin && cgo) || windows

package main

// the app's own updates: the signed feed's newer release, downloaded, checked
// against the release key and installed in this one's place

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/pmghartman/phosphorus/internal/minisign"
)

type release struct {
	Version   string `json:"version"`
	URL       string `json:"url"`
	Signature string `json:"signature"`
}

var feedClient = &http.Client{Timeout: 30 * time.Second}

// the feed file for this machine, as the release names it
func feedTarget() string {
	arch := map[string]string{"arm64": "aarch64", "amd64": "x86_64"}[runtime.GOARCH]
	return runtime.GOOS + "-" + arch
}

// the feed's release when newer than this app, nil when not or with no feed (a dev build)
func feedCheck() (*release, error) {
	if feedURL == "" || feedPubkey == "" {
		return nil, nil
	}
	res, err := feedClient.Get(strings.TrimRight(feedURL, "/") + "/" + feedTarget() + ".json")
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("feed answered %d", res.StatusCode)
	}
	var r release
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&r); err != nil {
		return nil, err
	}
	have := appVersion
	if have == "" {
		have = payloadVersion()
	}
	if r.URL == "" || !newer(r.Version, have) {
		return nil, nil
	}
	return &r, nil
}

// newer numeric, part by part, missing parts 0
func newer(a, b string) bool {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		x, y := 0, 0
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x > y
		}
	}
	return false
}

// installRelease downloaded, its signature checked, then handed to this OS's installer
func installRelease(r *release) error {
	key, err := minisign.ParsePublicKey(feedPubkey)
	if err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "phosphorus-update-")
	if err != nil {
		return err
	}
	res, err := (&http.Client{Timeout: 15 * time.Minute}).Get(r.URL)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("download answered %d", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<30))
	if err != nil {
		return err
	}
	if err := key.Verify(data, r.Signature); err != nil {
		return errors.New("the download's signature doesn't match the release key: " + err.Error())
	}
	f := filepath.Join(dir, filepath.Base(r.URL))
	if err := os.WriteFile(f, data, 0o755); err != nil {
		return err
	}
	return installDownloaded(f)
}
