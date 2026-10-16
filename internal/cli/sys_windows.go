package cli

import (
	"os"
	"os/exec"
	"syscall"
)

// no resize signal: the size polled by the loop's tick
var (
	sigResize     os.Signal = syscall.Signal(-1)
	notifySignals           = []os.Signal{os.Interrupt, syscall.SIGTERM}
)

func chownLike(string, os.FileInfo) error { return nil }

func detach(*exec.Cmd) {}
