package cli

import (
	"os"
	"os/exec"
	"syscall"
	"time"
)

// no resize signal: the size polled by the loop's tick
var (
	sigResize     os.Signal = syscall.Signal(-1)
	notifySignals           = []os.Signal{os.Interrupt, syscall.SIGTERM}
)

func chownLike(string, os.FileInfo) error { return nil }

func detach(*exec.Cmd) {}

// StartDetached c after delay, outside this process's console
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
