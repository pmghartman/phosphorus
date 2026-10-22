// Package appfeed: a desktop app's own updates off the signed feed on the
// release `update`, a newer release downloaded and checked against the release key
package appfeed

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

// Release one feed file: the newest version for a target, its file and signature
type Release struct {
	Version   string `json:"version"`
	URL       string `json:"url"`
	Signature string `json:"signature"`
}

// Feed where an app looks: the feed's base url, the key its files are signed
// with, the app's prefix on each target's file ("" for phosphorus, "sulfur-")
type Feed struct {
	URL    string
	Pubkey string
	App    string
}

var client = &http.Client{Timeout: 30 * time.Second}

// Target this machine as the feed names it
func Target() string {
	arch := map[string]string{"arm64": "aarch64", "amd64": "x86_64"}[runtime.GOARCH]
	return runtime.GOOS + "-" + arch
}

// On whether the feed is set, false for a dev build
func (f Feed) On() bool { return f.URL != "" && f.Pubkey != "" }

// Check the feed's release when newer than have, nil when not or with no feed
func (f Feed) Check(have string) (*Release, error) {
	if !f.On() {
		return nil, nil
	}
	res, err := client.Get(strings.TrimRight(f.URL, "/") + "/" + f.App + Target() + ".json")
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == 404 {
		return nil, nil
	}
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("feed answered %d", res.StatusCode)
	}
	var r Release
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&r); err != nil {
		return nil, err
	}
	if r.URL == "" || !Newer(r.Version, have) {
		return nil, nil
	}
	return &r, nil
}

// Newer numeric, part by part, missing parts 0
func Newer(a, b string) bool {
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

// Fetch the release downloaded into a fresh temp folder, its signature
// checked; the file's path
func (f Feed) Fetch(r *Release) (string, error) {
	key, err := minisign.ParsePublicKey(f.Pubkey)
	if err != nil {
		return "", err
	}
	res, err := (&http.Client{Timeout: 15 * time.Minute}).Get(r.URL)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return "", fmt.Errorf("download answered %d", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<30))
	if err != nil {
		return "", err
	}
	if err := key.Verify(data, r.Signature); err != nil {
		return "", errors.New("the download's signature doesn't match the release key: " + err.Error())
	}
	dir, err := os.MkdirTemp("", "phosphorus-update-")
	if err != nil {
		return "", err
	}
	file := filepath.Join(dir, filepath.Base(r.URL))
	if err := os.WriteFile(file, data, 0o755); err != nil {
		return "", err
	}
	return file, nil
}
