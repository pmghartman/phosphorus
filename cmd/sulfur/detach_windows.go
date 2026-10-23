package main

import (
	"os/exec"
	"syscall"
)

// CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS, CREATE_NO_WINDOW
const detachFlags = 0x200 | 0x8 | 0x08000000

// detach in its own process group, no console, out of the app's way
func detach(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{CreationFlags: detachFlags, HideWindow: true}
}

// detachedLine a command line run as written, cmd's quoting its own; on a hidden console of its
// own: with DETACHED_PROCESS cmd has none and opens a visible one, the timeout's window
func detachedLine(line string) error {
	c := exec.Command("cmd")
	c.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x200 | 0x08000000, HideWindow: true, CmdLine: line}
	return c.Start()
}
