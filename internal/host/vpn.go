package host

import (
	"encoding/json"
	"fmt"
	"os"
)

// vpnState Tailscale's backend state: Running, Stopped, NeedsLogin, or blank when it doesn't answer
func vpnState() string {
	var st struct{ BackendState string }
	out, _ := tailscaleStatus()
	json.Unmarshal(out, &st)
	return st.BackendState
}

// status this host's service and VPN, as text or, with --json, for the app's tray
func status(args []string) error {
	running, vpn := svcActive(), vpnState()
	if len(args) > 0 && args[0] == "--json" {
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"running": running, "vpn": vpn == "Running"})
	}
	svc := "stopped"
	if running {
		svc = "running"
	}
	if vpn == "" {
		vpn = "not answering"
	}
	fmt.Printf("phosphorus %s, tailscale %s\n", svc, vpn)
	return nil
}

// vpn on brings Tailscale back up on the tailnet it's signed in to; off stops
// phosphorus first, since nothing of the mesh works without it, then takes it down
func vpn(args []string) error {
	if len(args) == 0 {
		return status(nil)
	}
	switch args[0] {
	case "on":
		if err := run(tailscaleCLI(), append([]string{"up"}, tailscaleUpFlags()...)...); err != nil {
			return fail("couldn't bring Tailscale up: %v", err)
		}
		say("Tailscale up")
		return nil
	case "off":
		if svcActive() {
			if err := stop(); err != nil {
				return err
			}
		}
		if err := run(tailscaleCLI(), "down"); err != nil {
			return fail("couldn't take Tailscale down: %v", err)
		}
		say("Tailscale down, phosphorus stopped; Start brings both back")
		return nil
	}
	return fail("vpn on or vpn off")
}
