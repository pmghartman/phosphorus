package envfile

import (
	"os"
	"os/exec"
	"syscall"
)

// Lock SYSTEM (the service) and the user running the app, nothing inherited
func Lock(file string) error {
	c := exec.Command("icacls", file, "/inheritance:r", "/grant:r", os.Getenv("USERNAME")+":(M)", "/grant:r", "SYSTEM:(F)")
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return c.Run()
}
