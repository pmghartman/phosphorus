package sulfur

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
)

// shellLine a task's line run as written: cmd's own quoting, not Go's
func shellLine(line string) *exec.Cmd {
	comspec := os.Getenv("ComSpec")
	if comspec == "" {
		comspec = filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe")
	}
	cmd := exec.Command(comspec)
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: line}
	return cmd
}

// loginShell PowerShell 7 if it's there, else Windows PowerShell, as VS Code's default
func loginShell() *exec.Cmd {
	if p, err := exec.LookPath("pwsh.exe"); err == nil {
		return exec.Command(p, "-NoLogo")
	}
	return exec.Command("powershell.exe", "-NoLogo")
}

// killTree the process and its children: a build's compilers with it
func killTree(p *os.Process) {
	k := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(p.Pid))
	hideWindow(k)
	if k.Run() != nil {
		p.Kill()
	}
}

// hideWindow no console window flashing up for a background command
func hideWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= 0x08000000 // CREATE_NO_WINDOW
}

// ownGroup no console window of its own; taskkill /T takes the tree
func ownGroup(cmd *exec.Cmd) { hideWindow(cmd) }
