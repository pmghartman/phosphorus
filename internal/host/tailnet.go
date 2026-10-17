package host

import (
	"context"
	"os"
	"os/exec"
	"strings"
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
	// turned off (vpn off, or by hand): back up as the same node, no re-auth
	if state == "Stopped" && (env["BASE_DOMAIN"] != "" || fileExists(joined)) {
		c := exec.Command(tailscaleCLI(), append([]string{"up"}, tailscaleUpFlags()...)...)
		hide(c)
		if c.Run() == nil {
			tailscaleKeepUp()
			return nil
		}
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
	c := exec.Command(tailscaleCLI(), a...)
	hide(c)
	if out, err := c.CombinedOutput(); err != nil {
		os.Stdout.Write(out)
		why := strings.TrimSpace(string(out))
		if i := strings.LastIndexByte(why, '\n'); i >= 0 {
			why = why[i+1:]
		}
		if why == "" {
			why = err.Error()
		}
		return fail("couldn't sign Tailscale in (%s); TS_AUTHKEY in .env must be reusable and unexpired", why)
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
