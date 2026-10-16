//go:build !windows

package cli

import (
	"os"
	"os/exec"
	"syscall"
)

var (
	sigResize     os.Signal = syscall.SIGWINCH
	notifySignals           = []os.Signal{syscall.SIGWINCH, syscall.SIGTERM, syscall.SIGHUP}
)

func chownLike(file string, st os.FileInfo) error {
	if sys, ok := st.Sys().(*syscall.Stat_t); ok {
		return os.Chown(file, int(sys.Uid), int(sys.Gid))
	}
	return nil
}

func detach(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
