package main

import (
	"os/exec"
	"syscall"
)

// CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS; never hidden, a window of its own
// being the installer's to show or not
const detachFlags = 0x200 | 0x8

// detach in its own process group, no console, out of the app's way
func detach(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{CreationFlags: detachFlags}
}
