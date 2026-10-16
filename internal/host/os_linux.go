package host

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
)

func dockerHint() string { return "install docker first" }

// the container's tailscaled sharing this machine's netns, a native one
// fighting it for tailscale0
func nativeTailscale() string {
	if quiet("ip", "link", "show", "tailscale0") || quiet("systemctl", "is-active", "--quiet", "tailscaled") {
		return "native tailscaled running, colliding with phosphorus's own, disable it first: sudo systemctl disable --now tailscaled"
	}
	return ""
}

func machineRAM() int64 {
	b, _ := os.ReadFile("/proc/meminfo")
	for _, l := range strings.Split(string(b), "\n") {
		if f := strings.Fields(l); len(f) >= 2 && f[0] == "MemTotal:" {
			n, _ := strconv.ParseInt(f[1], 10, 64)
			return n * 1024
		}
	}
	return 0
}

func ramHint(int64) {}

const sshdName = "an ssh server"

// installed already as the package's dependency: enabled only
func enableSSHD() error {
	if _, err := os.Stat("/usr/sbin/sshd"); err != nil {
		switch {
		case has("apt-get"):
			run("apt-get", "install", "-y", "openssh-server")
		case has("dnf"):
			run("dnf", "install", "-y", "openssh-server")
		case has("pacman"):
			run("pacman", "-Sy", "--noconfirm", "openssh")
		default:
			return fail("no apt, dnf or pacman: install and enable an ssh server, then run phos start again")
		}
	}
	if !quiet("systemctl", "enable", "--now", "ssh") && !quiet("systemctl", "enable", "--now", "sshd") {
		return fail("couldn't enable the ssh server")
	}
	if b, _ := os.ReadFile("/etc/ssh/ssh_config"); !strings.Contains(string(b), "ssh_config.d") {
		say("/etc/ssh/ssh_config never reads ssh_config.d, add 'Include /etc/ssh/ssh_config.d/*.conf' at its top for ssh <host>")
	}
	return nil
}

func has(name string) bool { _, err := exec.LookPath(name); return err == nil }
