//go:build !windows

package cli

import (
	"os"
	"os/exec"
	"syscall"
	"time"
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

// StartDetached c in its own session, run after delay, outliving this process
func StartDetached(c *exec.Cmd, delay time.Duration) error {
	detach(c)
	go func() {
		time.Sleep(delay)
		if c.Start() == nil {
			c.Wait()
		}
	}()
	return nil
}
