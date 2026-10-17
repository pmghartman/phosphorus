package host

import (
	"context"
	"os"
	"os/exec"
	"time"

	"github.com/pmghartman/phosphorus/internal/envfile"
)

// tailnetJoin Tailscale in its given state signed in to the mesh's tailnet: with
// TS_AUTHKEY when it isn't signed in, and on a first join when an existing
// install is signed in to a tailnet where no peer has the mesh's keys
func tailnetJoin(state string) error {
	env := envfile.Read(envPath())
	joined := at("state", "tailnet-joined")
	mark := func() {
		os.MkdirAll(at("state"), 0o755)
		os.WriteFile(joined, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o644)
	}
	if state == "Running" {
		if env["BASE_DOMAIN"] != "" || fileExists(joined) {
			tailscaleKeepUp()
			return nil
		}
		if _, ip, err := peerKeys(); err == nil {
			say("Tailscale already on the mesh's tailnet, %s has the keys", ip)
			tailscaleKeepUp()
			mark()
			return nil
		}
		say("Tailscale is signed in to a tailnet without the mesh, switching to TS_AUTHKEY's")
	}
	key := env["TS_AUTHKEY"]
	if key == "" {
		return fail("Tailscale isn't on the mesh's tailnet and there's no TS_AUTHKEY in .env to sign in with")
	}
	a := append([]string{"up", "--reset", "--timeout=90s", "--authkey=" + key}, tailscaleUpFlags()...)
	if state == "Running" {
		a = append(a, "--force-reauth")
	}
	if h := os.Getenv("TS_HOSTNAME"); h != "" {
		a = append(a, "--hostname="+h)
	}
	say("signing Tailscale in with TS_AUTHKEY...")
	if err := run(tailscaleCLI(), a...); err != nil {
		return fail("couldn't sign Tailscale in, check TS_AUTHKEY in .env (it must be reusable and unexpired)")
	}
	mark()
	return nil
}

// tailscaleStatus status --json, cut off at 10s; signed out exits nonzero, its JSON still printed
func tailscaleStatus() ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, tailscaleCLI(), "status", "--json")
	hide(c)
	return c.Output()
}
