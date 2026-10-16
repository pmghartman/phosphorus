package host

import (
	"os"
	"os/exec"
	"os/signal"
	"syscall"
)

func runtimeDir() string { return at("state", "run") }

// childAttr run's own group kept, launchd killing it whole when run goes
func childAttr(*exec.Cmd) {}

func terminate(c *exec.Cmd) bool { return c.Process.Signal(syscall.SIGTERM) == nil }

func killTree(c *exec.Cmd) { c.Process.Kill() }

// logToFile state/phosphorus.log for run and its children, the last one kept
// as .1 once past 20MB
func logToFile() {
	f := openLog()
	if f == nil {
		return
	}
	syscall.Dup2(int(f.Fd()), 1)
	syscall.Dup2(int(f.Fd()), 2)
	os.Stdout, os.Stderr = f, f
}

func tailscaleUpFlags() []string { return nil }

func serve(main func(stop <-chan struct{}) error) error {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	stop := make(chan struct{})
	go func() { <-sig; close(stop) }()
	return main(stop)
}
