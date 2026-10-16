package host

import (
	"os"
	"strconv"
	"strings"
)

func init() {
	// Finder's PATH: no homebrew docker or colima
	os.Setenv("PATH", "/opt/homebrew/bin:/usr/local/bin:"+os.Getenv("PATH"))
}

func dockerHint() string {
	return "install colima and docker (brew install colima docker), then colima start"
}

// the container's tailscaled on this machine's network, a native client
// fighting it for the TUN and WireGuard port
func nativeTailscale() string {
	if quiet("pgrep", "-x", "tailscaled") || quiet("pgrep", "-x", "Tailscale") || strings.Contains(output("ifconfig"), "inet 100.") {
		return "native Tailscale client active, colliding with phosphorus's own, quit the Tailscale app (or stop tailscaled) first"
	}
	return ""
}

func machineRAM() int64 {
	n, _ := strconv.ParseInt(output("sysctl", "-n", "hw.memsize"), 10, 64)
	return n
}

// colima's ram fixed when its vm starts, so a hint, the model seeing only the vm
func ramHint(machine int64) {
	const gib = 1 << 30
	vm, _ := strconv.ParseInt(dockerOut("info", "--format", "{{.MemTotal}}"), 10, 64)
	if want := machine / gib; want > 0 && vm > 0 && vm*10 < machine*9 {
		say("docker's vm has %dGB of this machine's %dGB, and the mesh model only sees the vm", vm/gib, want)
		say("for all of it: colima stop && colima start --memory %d", want)
	}
}

const sshdName = "Remote Login (ssh)"

func enableSSHD() error {
	if run("systemsetup", "-setremotelogin", "on") != nil {
		// systemsetup without Full Disk Access on newer macOS
		return run("launchctl", "load", "-w", "/System/Library/LaunchDaemons/ssh.plist")
	}
	return nil
}
