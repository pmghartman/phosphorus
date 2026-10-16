package host

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"
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

func dockerHint() string { return "install Docker Desktop first" }

func startDockerDesktop() error {
	exe := os.Getenv("ProgramFiles") + `\Docker\Docker\Docker Desktop.exe`
	if !fileExists(exe) {
		return fail("Docker Desktop not installed")
	}
	say("starting Docker Desktop...")
	c := exec.Command(exe)
	return c.Start()
}

// the container's tailscaled on this machine's network, a native client
// fighting it for the TUN interface
func nativeTailscale() string {
	if strings.Contains(output("sc", "query", "Tailscale"), "RUNNING") {
		return "native Tailscale service running, colliding with phosphorus's own, stop it first (Stop-Service Tailscale) and quit the tray app"
	}
	return ""
}

func machineRAM() int64 {
	n, _ := strconv.ParseInt(ps("(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory"), 10, 64)
	return n
}

func ramHint(int64) {}

// wsl2 capping its vm at half the machine, so with no memory= of their own,
// the whole machine; phosphorus on PATH for new shells
func prepareOS(up bool) error {
	const gib = 1 << 30
	machine := machineRAM()
	want := machine / gib
	conf := filepath.Join(os.Getenv("USERPROFILE"), ".wslconfig")
	b, _ := os.ReadFile(conf)
	lines := []string{}
	if len(b) > 0 {
		lines = strings.Split(strings.ReplaceAll(strings.TrimRight(string(b), "\r\n"), "\r\n", "\n"), "\n")
	}
	set, reclaim := "", false
	for _, l := range lines {
		t := strings.ReplaceAll(strings.TrimSpace(l), " ", "")
		if strings.HasPrefix(t, "memory=") {
			set = strings.TrimSpace(l)
		}
		if strings.HasPrefix(t, "autoMemoryReclaim=") {
			reclaim = true
		}
	}
	restart := false
	switch {
	case set != "":
		say("%s already sets '%s', the model sees that much of %dGB", conf, set, want)
	case want < 1:
		say("this machine has too little ram to hand docker any more")
	default:
		say("giving docker's wsl vm all %dGB this machine has", want)
		add := []string{fmt.Sprintf("memory=%dGB", want)}
		// the vm handing ram back to windows instead of holding its peak
		if !reclaim {
			add = append(add, "autoMemoryReclaim=gradual")
		}
		out, placed := []string{}, false
		for _, l := range lines {
			out = append(out, l)
			if !placed && strings.TrimSpace(l) == "[wsl2]" {
				out = append(out, add...)
				placed = true
			}
		}
		if !placed {
			if len(out) > 0 {
				out = append(out, "")
			}
			out = append(append(out, "[wsl2]"), add...)
		}
		if err := os.WriteFile(conf, []byte(strings.Join(out, "\r\n")+"\r\n"), 0o644); err == nil {
			restart = true
		}
	}
	// hyper-V backend: .wslconfig read by nothing
	if k := dockerOut("info", "--format", "{{.KernelVersion}}"); k != "" && !strings.Contains(k, "WSL") {
		say("docker here isn't on the wsl2 backend, set its memory in Docker Desktop > Settings > Resources instead")
		restart = false
	}
	switch {
	case restart && up:
		say("it applies on the next 'wsl --shutdown', which stops phosphorus and every other wsl distro for a moment")
	case restart && !term.IsTerminal(int(os.Stdin.Fd())):
		say("it applies on the next reboot or 'wsl --shutdown'")
	case restart:
		say("restarting wsl so it takes effect...")
		run("wsl", "--shutdown")
		for i := 0; i < 60 && !dockerUp(); i++ {
			time.Sleep(2 * time.Second)
		}
		if !dockerUp() {
			return fail("docker never came back after wsl --shutdown, start Docker Desktop and run phos start again")
		}
	}
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
	return nil
}

// sshDockerConfig no credential vault over ssh ("logon session does not exist"):
// a throwaway config with a dummy auths entry, the real ~/.docker left alone
func sshDockerConfig() {
	if os.Getenv("SSH_CONNECTION") == "" || os.Getenv("DOCKER_CONFIG") != "" {
		return
	}
	real := filepath.Join(os.Getenv("USERPROFILE"), ".docker")
	cfg := filepath.Join(os.TempDir(), "phosphorus-docker")
	os.MkdirAll(cfg, 0o755)
	ctx := "desktop-linux"
	var c struct {
		CurrentContext string `json:"currentContext"`
	}
	if b, err := os.ReadFile(filepath.Join(real, "config.json")); err == nil && json.Unmarshal(b, &c) == nil && c.CurrentContext != "" {
		ctx = c.CurrentContext
	}
	if fileExists(filepath.Join(real, "contexts")) {
		ps("Copy-Item " + psq(filepath.Join(real, "contexts")) + " " + psq(cfg) + " -Recurse -Force")
	}
	b, _ := json.Marshal(map[string]any{
		"auths":               map[string]any{"phosphorus.invalid": map[string]any{}},
		"currentContext":      ctx,
		"cliPluginsExtraDirs": []string{filepath.Join(os.Getenv("ProgramFiles"), `Docker\Docker\resources\cli-plugins`), filepath.Join(real, "cli-plugins")},
	})
	os.WriteFile(filepath.Join(cfg, "config.json"), b, 0o644)
	os.Setenv("DOCKER_CONFIG", cfg)
}
