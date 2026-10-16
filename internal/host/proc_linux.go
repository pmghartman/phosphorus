package host

import (
	"os"
	"os/exec"
	"os/signal"
	"syscall"
)

func runtimeDir() string { return runDir }

// childAttr its own group, killed whole on the way out; gone with run if run dies
func childAttr(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGTERM}
}

// terminate TERM to the child alone, its own shutdown in order
func terminate(c *exec.Cmd) bool { return c.Process.Signal(syscall.SIGTERM) == nil }

func killTree(c *exec.Cmd) { syscall.Kill(-c.Process.Pid, syscall.SIGKILL) }

// logToFile none: systemd's journal has stdout
func logToFile() {}

func tailscaleUpFlags() []string { return []string{"--accept-dns=true"} }

func serve(main func(stop <-chan struct{}) error) error {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	stop := make(chan struct{})
	go func() { <-sig; close(stop) }()
	return main(stop)
}
