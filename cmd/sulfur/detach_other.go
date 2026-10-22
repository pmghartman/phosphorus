//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// detach in its own session, so the app's exit doesn't take it along
func detach(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }

func detachedLine(string) error { panic("windows only") }
