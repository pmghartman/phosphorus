//go:build !linux

package host

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// tailscaleVersion the installer setup fetches when the machine has no Tailscale
const tailscaleVersion = "1.104.1"

// tailscaleInstall the pinned installer downloaded, checked and run; admin only
func tailscaleInstall() error {
	name, sum := tailscalePkg()
	f := filepath.Join(os.TempDir(), name)
	defer os.Remove(f)
	say("installing Tailscale %s...", tailscaleVersion)
	if err := download(f, "https://pkgs.tailscale.com/stable/"+name, sum); err != nil {
		return fail("couldn't download Tailscale: %v", err)
	}
	if err := tailscaleRunInstaller(f); err != nil {
		return fail("the Tailscale installer failed: %v", err)
	}
	return nil
}

func download(dst, url, sum string) error {
	c := &http.Client{Timeout: 10 * time.Minute}
	r, err := c.Get(url)
	if err != nil {
		return err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return fail("%s: %s", url, r.Status)
	}
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h), r.Body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != sum {
		return fail("checksum mismatch on %s (got %s)", url, got)
	}
	return nil
}

// tailscaleLogin Tailscale launched and waited on, an existing install's too, then
// on the mesh's tailnet
func tailscaleLogin() error {
	var st struct{ BackendState string }
	ready := func() bool {
		st.BackendState = ""
		out, _ := exec.Command(tailscaleCLI(), "status", "--json").Output()
		return json.Unmarshal(out, &st) == nil && st.BackendState != "" && st.BackendState != "NoState" && st.BackendState != "Starting"
	}
	if !ready() {
		say("waiting on Tailscale...")
		tailscaleLaunch()
		for i := 0; i < 120 && !ready(); i++ {
			time.Sleep(time.Second)
		}
		if st.BackendState == "" {
			return fail("Tailscale isn't running: %s, then Start", tailscaleHint())
		}
	}
	return tailnetJoin(st.BackendState)
}
