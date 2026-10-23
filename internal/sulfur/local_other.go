//go:build !windows

package sulfur

import (
	"os"
	"os/exec"
	"syscall"
)

// shellLine a task's line, sh's to read
func shellLine(line string) *exec.Cmd { return exec.Command("/bin/sh", "-c", line) }

// loginShell the user's own shell as a login shell, so its PATH is theirs
func loginShell() *exec.Cmd {
	sh := os.Getenv("SHELL")
	if sh == "" {
		sh = "/bin/sh"
	}
	return exec.Command(sh, "-l")
}

// killTree its process group: the pty made it the leader of one
func killTree(p *os.Process) {
	if syscall.Kill(-p.Pid, syscall.SIGKILL) != nil {
		p.Kill()
	}
}

// ownGroup its own process group, so killTree takes what it started too
func ownGroup(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

func hideWindow(*exec.Cmd) {}
