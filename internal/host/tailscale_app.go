//go:build !linux

package host

import (
	"encoding/json"
	"os"
	"os/exec"

	"github.com/pmghartman/phosphorus/internal/envfile"
)

// tailscaleLogin the Tailscale app signed in with TS_AUTHKEY when it isn't yet
func tailscaleLogin() error {
	var st struct{ BackendState string }
	out, _ := exec.Command(tailscaleCLI(), "status", "--json").Output()
	if json.Unmarshal(out, &st) == nil && st.BackendState == "Running" {
		return nil
	}
	key := envfile.Read(envPath())["TS_AUTHKEY"]
	if key == "" {
		return fail("Tailscale isn't signed in and there's no TS_AUTHKEY in .env: sign in to the Tailscale app, then phos start")
	}
	a := append([]string{"up", "--authkey=" + key}, tailscaleUpFlags()...)
	if h := os.Getenv("TS_HOSTNAME"); h != "" {
		a = append(a, "--hostname="+h)
	}
	say("signing Tailscale in with TS_AUTHKEY...")
	if err := run(tailscaleCLI(), a...); err != nil {
		return fail("couldn't sign Tailscale in, check TS_AUTHKEY in .env (it must be reusable and unexpired)")
	}
	return nil
}
