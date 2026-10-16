//go:build !windows

package host

import (
	"os"
	"os/exec"
	"syscall"
)

func hide(*exec.Cmd) {}

// asRoot this command again through sudo, its exit code passed on
func asRoot(args []string) int {
	c := exec.Command("sudo", append([]string{exe()}, args...)...)
	c.Stdin, c.Stdout, c.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := c.Run(); err != nil {
		if x, ok := err.(*exec.ExitError); ok {
			return x.ExitCode()
		}
		return 1
	}
	return 0
}

func isAdmin() bool { return os.Geteuid() == 0 }

// spawnDetached its own session, out of reach of a dropped terminal's hangup
func spawnDetached(args []string, log *os.File) (func(), error) {
	c := exec.Command(exe(), args...)
	c.Env = append(os.Environ(), "PHOSPHORUS_DETACHED=1")
	c.Stdout, c.Stderr = log, log
	c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := c.Start(); err != nil {
		return nil, err
	}
	return func() { c.Wait() }, nil
}

const sshInc = "/etc/ssh/ssh_config.d/phosphorus.conf"

var links = []string{"/usr/local/bin/phosphorus", "/usr/local/bin/phos"}

func needSetup() string {
	switch {
	case !sshdUp():
		return sshdName
	case readTrim(sshInc) != sshInclude():
		return "ssh to hosts by name"
	case !linked():
		return "phosphorus on PATH"
	}
	return ""
}

func linked() bool {
	for _, l := range links {
		if t, _ := os.Readlink(l); t != binPath("phosphorus") {
			return false
		}
	}
	return true
}

func setupOS() error {
	if sshdUp() {
		say("%s already up, skipping", sshdName)
	} else {
		say("turning on %s...", sshdName)
		if err := enableSSHD(); err != nil {
			return err
		}
	}
	if readTrim(sshInc) != sshInclude() {
		say("letting ssh reach hosts by name...")
		os.MkdirAll("/etc/ssh/ssh_config.d", 0o755)
		if err := os.WriteFile(sshInc, []byte(sshInclude()+"\n"), 0o644); err != nil {
			return err
		}
	}
	if !linked() {
		say("putting phosphorus and phos on PATH...")
		os.MkdirAll("/usr/local/bin", 0o755)
		for _, l := range links {
			os.Remove(l)
			if err := os.Symlink(binPath("phosphorus"), l); err != nil {
				return err
			}
		}
	}
	return nil
}

func elevateWindows() error { return nil }

func prepareOS(bool) error { return nil }
