package host

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// no console flashed up when the app runs us
func hide(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}

// asRoot never: Windows' admin steps raised one by one
func asRoot([]string) int { return 0 }

func isAdmin() bool { return quiet("net", "session") }

func ps(script string) string {
	return output("powershell", "-NoProfile", "-NonInteractive", "-Command", script)
}

func psq(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// spawnDetached outside the ssh session via WMI, Windows' sshd taking a dropped
// session's whole process tree with it
func spawnDetached(args []string, log *os.File) (func(), error) {
	log.Close()
	q := []string{`"` + exe() + `"`}
	for _, a := range args {
		q = append(q, `"`+a+`"`)
	}
	line := fmt.Sprintf(`cmd /c set PHOSPHORUS_DETACHED=1&& %s > "%s" 2>&1`, strings.Join(q, " "), log.Name())
	pid, err := strconv.Atoi(ps("(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=" + psq(line) + "}).ProcessId"))
	if err != nil || pid == 0 {
		return nil, fmt.Errorf("couldn't start it detached")
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return func() {}, nil
	}
	return func() { p.Wait() }, nil
}

// prepareOS phosphorus on PATH for new shells
func prepareOS(bool) error {
	bin := at("bin")
	path := ps("[Environment]::GetEnvironmentVariable('Path', 'User')")
	for _, p := range strings.Split(path, ";") {
		if strings.EqualFold(strings.TrimRight(p, `\`), bin) {
			return nil
		}
	}
	say("putting phosphorus on PATH, new shells pick it up")
	ps("[Environment]::SetEnvironmentVariable('Path', ((@([Environment]::GetEnvironmentVariable('Path', 'User'), " + psq(bin) + ") | Where-Object { $_ }) -join ';'), 'User')")
	return nil
}

func sshConfig() string { return filepath.Join(os.Getenv("ProgramData"), "ssh", "ssh_config") }

func needSetup() string {
	if !sshdUp() {
		return "OpenSSH Server"
	}
	b, _ := os.ReadFile(sshConfig())
	if !strings.Contains(string(b), sshInclude()) {
		return "ssh to hosts by name"
	}
	if !svcInstalled() {
		return "the phosphorus service"
	}
	return ""
}

// elevateWindows setup through UAC, waited on
func elevateWindows() error {
	ps("Start-Process -Wait -Verb RunAs -FilePath " + psq(exe()) + " -ArgumentList @('setup','--home'," + psq(`"`+home+`"`) + ")")
	if todo := needSetup(); todo != "" {
		return fail("still needs %s: run phos setup in an elevated shell", todo)
	}
	return nil
}

func setupOS() error {
	if sshdUp() {
		say("sshd already running, skipping")
	} else {
		say("installing and starting OpenSSH Server...")
		ps("if ((Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0').State -ne 'Installed') { Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null }; Set-Service -Name sshd -StartupType Automatic; Start-Service sshd")
		if !sshdUp() {
			return fail("sshd didn't start")
		}
	}
	// the Include first, counting only ahead of every Host block
	b, _ := os.ReadFile(sshConfig())
	if !strings.Contains(string(b), sshInclude()) {
		say("letting ssh reach hosts by name...")
		os.MkdirAll(filepath.Dir(sshConfig()), 0o755)
		if err := os.WriteFile(sshConfig(), append([]byte(sshInclude()+"\r\n"), b...), 0o644); err != nil {
			return err
		}
	}
	return createService()
}

// --- the phosphorus service, LocalSystem, startable by the account that set it up -------------

const svcName = "phosphorus"

// libexec the app's bundled tools, synced into the home with the release
func libexec() string { return at("tools") }

func logHint() string { return at("state", "phosphorus.log") }

func svcInstalled() bool {
	m, err := mgr.Connect()
	if err != nil {
		return quiet("sc", "query", svcName)
	}
	defer m.Disconnect()
	s, err := m.OpenService(svcName)
	if err != nil {
		return false
	}
	s.Close()
	return true
}

// createService installed once by the elevated setup, run with the home's
// binary; its DACL letting signed-in users start and stop it
func createService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fail("can't reach the service manager: %v", err)
	}
	defer m.Disconnect()
	args := []string{"run", "--home", home}
	if s, err := m.OpenService(svcName); err == nil {
		c, _ := s.Config()
		c.BinaryPathName = syscall.EscapeArg(binPath("phosphorus")) + " " + strings.Join(quoteAll(args), " ")
		c.StartType = mgr.StartAutomatic
		s.UpdateConfig(c)
		s.Close()
	} else {
		say("installing the phosphorus service...")
		s, err = m.CreateService(svcName, binPath("phosphorus"), mgr.Config{
			DisplayName: "Phosphorus host", StartType: mgr.StartAutomatic,
			Description: "phosphorus run: the frontend, the tunnel and the model as its own processes",
		}, args...)
		if err != nil {
			return fail("couldn't install the service: %v", err)
		}
		s.SetRecoveryActions([]mgr.RecoveryAction{{Type: mgr.ServiceRestart, Delay: 5 * time.Second}}, 0)
		s.Close()
	}
	// SY and BA full, interactive and service users query, authenticated users start and stop
	run("sc", "sdset", svcName, "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)(A;;CCLCSWRPWPLOCRRC;;;AU)")
	return nil
}

func quoteAll(a []string) []string {
	out := make([]string, len(a))
	for i, x := range a {
		out[i] = syscall.EscapeArg(x)
	}
	return out
}

func svcInstall() error {
	if svcInstalled() {
		return nil
	}
	if !isAdmin() {
		return fail("the phosphorus service isn't installed yet: phos start (it asks for admin once)")
	}
	return createService()
}

func svcState() svc.State {
	m, err := mgr.Connect()
	if err != nil {
		return 0
	}
	defer m.Disconnect()
	s, err := m.OpenService(svcName)
	if err != nil {
		return 0
	}
	defer s.Close()
	st, err := s.Query()
	if err != nil {
		return 0
	}
	return st.State
}

func svcActive() bool { return svcState() == svc.Running }

func svcSince() string {
	out := output("sc", "queryex", svcName)
	for _, l := range strings.Split(out, "\n") {
		if k, v, ok := strings.Cut(l, ":"); ok && strings.TrimSpace(k) == "PID" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func svcStart() error {
	quiet("sc", "config", svcName, "start=", "auto")
	if err := run("sc", "start", svcName); err != nil && !svcActive() {
		return err
	}
	return nil
}

// svcStop kept off through reboots
func svcStop() error {
	quiet("sc", "config", svcName, "start=", "demand")
	quiet("sc", "stop", svcName)
	for i := 0; i < 150 && svcState() != svc.Stopped; i++ {
		time.Sleep(time.Second)
	}
	return nil
}

func svcRestart(noBlock bool) error {
	if noBlock {
		// the stop kills this process's parent, so a detached one finishes the job
		c := exec.Command("cmd", "/c", "sc stop "+svcName+" & timeout /t 10 /nobreak >nul & sc start "+svcName)
		hide(c)
		return c.Start()
	}
	svcStop()
	return svcStart()
}

// --- tailscale: the Tailscale app's own node ---------------------------------------------

func tailscaleDirs() []string {
	return []string{filepath.Join(os.Getenv("ProgramFiles"), "Tailscale")}
}

func tailscaleCLI() string { return filepath.Join(tailscaleDirs()[0], "tailscale.exe") }

func tailscaleReady() error {
	if !fileExists(tailscaleCLI()) {
		return fail("no Tailscale here: install Tailscale for Windows (tailscale.com/download), then phos start")
	}
	return tailscaleLogin()
}

func tailscaleStart() error { return nil }

// --- no distro packages, no git host ------------------------------------------------------

func missingDeps() []string     { return nil }
func aptInstall([]string) error { return nil }
func deferRebuild() error       { return nil }
func gitEnv() map[string]string { return nil }
func ensureGitUser() error      { return nil }

// lockRebuild state/rebuild.lock held for the rebuild, a second one waiting
func lockRebuild() (func(), error) {
	f, err := os.OpenFile(at("state", "rebuild.lock"), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	ol := new(windows.Overlapped)
	if err := windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, ol); err != nil {
		f.Close()
		return nil, err
	}
	return func() { f.Close() }, nil
}
