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
