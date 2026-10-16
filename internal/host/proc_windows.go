package host

import (
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

func runtimeDir() string { return at("state", "run") }

// childAttr no console; the job run sits in kills it with run
func childAttr(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}

// terminate none: Windows has no TERM for another process, killTree does it
func terminate(*exec.Cmd) bool { return false }

func killTree(c *exec.Cmd) {
	k := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(c.Process.Pid))
	hide(k)
	if k.Run() != nil {
		c.Process.Kill()
	}
}

// killOnClose run in a job its children inherit, all of them gone with run
func killOnClose() {
	j, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	windows.SetInformationJobObject(j, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
	windows.AssignProcessToJobObject(j, windows.CurrentProcess())
}

// logToFile state/phosphorus.log for run and its children, the last one kept
// as .1 once past 20MB
func logToFile() {
	killOnClose()
	f := openLog()
	if f == nil {
		return
	}
	windows.SetStdHandle(windows.STD_OUTPUT_HANDLE, windows.Handle(f.Fd()))
	windows.SetStdHandle(windows.STD_ERROR_HANDLE, windows.Handle(f.Fd()))
	os.Stdout, os.Stderr = f, f
}

func tailscaleUpFlags() []string { return []string{"--unattended"} }

type service struct {
	main func(stop <-chan struct{}) error
}

func (s service) Execute(_ []string, req <-chan svc.ChangeRequest, st chan<- svc.Status) (bool, uint32) {
	st <- svc.Status{State: svc.StartPending}
	stop := make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- s.main(stop) }()
	st <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case err := <-done:
			if err != nil {
				return true, 1
			}
			return false, 0
		case c := <-req:
			switch c.Cmd {
			case svc.Interrogate:
				st <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				st <- svc.Status{State: svc.StopPending}
				close(stop)
				<-done
				return false, 0
			}
		}
	}
}

// serve under the service manager, or a console's Ctrl-C when run by hand
func serve(main func(stop <-chan struct{}) error) error {
	if ok, _ := svc.IsWindowsService(); ok {
		return svc.Run(svcName, service{main})
	}
	stop := make(chan struct{})
	sig := make(chan os.Signal, 1)
	signalNotify(sig)
	go func() { <-sig; close(stop) }()
	return main(stop)
}

func signalNotify(c chan os.Signal) { signal.Notify(c, os.Interrupt) }
