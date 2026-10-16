package host

import (
	"os"
	"strings"
)

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
