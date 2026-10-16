package envfile

import (
	"os"
	"os/exec"
	"syscall"
)

// Lock SYSTEM and the user running Docker Desktop, nothing inherited
func Lock(file string) error {
	c := exec.Command("icacls", file, "/inheritance:r", "/grant:r", os.Getenv("USERNAME")+":(M)", "/grant:r", "SYSTEM:(F)")
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return c.Run()
}
