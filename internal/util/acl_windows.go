package util

import (
	"fmt"
	"os/exec"
	"strings"
	"syscall"
)

// LockACL file's ACL to SYSTEM and Administrators, plus Authenticated Users
// read when shared, nothing inherited: what OpenSSH accepts for a SYSTEM caller
func LockACL(file string, shared bool) error {
	args := []string{file, "/reset", "/inheritance:r", "/grant:r", "*S-1-5-18:F", "*S-1-5-32-544:F"}
	if shared {
		args = append(args, "*S-1-5-11:RX")
	}
	c := exec.Command("icacls", args...)
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if out, err := c.CombinedOutput(); err != nil {
		return fmt.Errorf("icacls %s: %v: %s", file, err, strings.TrimSpace(string(out)))
	}
	return nil
}
