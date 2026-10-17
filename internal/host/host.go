// Package host: the machine's side, run by the installers and the cli: install,
// bring-up, rebuild, start and stop, keys, the Linux update agent and game play/stop
package host

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/pmghartman/phosphorus/internal/envfile"
	"github.com/pmghartman/phosphorus/internal/ini"
)

var (
	home      string
	tag       = "phosphorus"
	isLinux   = runtime.GOOS == "linux"
	isMac     = runtime.GOOS == "darwin"
	isWindows = runtime.GOOS == "windows"
)

// Commands the ones Main takes, everything else run's children's roles
var Commands = map[string]bool{
	"": true, "start": true, "stop": true, "restart": true, "update": true, "keys": true, "install": true,
	"setup": true, "rebuild": true, "upgrade": true, "game-control": true, "game-control-setup": true,
	"run": true, "ps": true, "uninstall": true, "help": true, "-h": true, "--help": true,
}

func usage(w io.Writer) {
	fmt.Fprint(w, `usage: phos             the cli, the keys asked for on first start
       phos start       start host
       phos stop        stop host
       phos restart     restart host
       phos update      update host
       phos update all  update mesh
       phos keys        replace keys in .env
       phos ps          phosphorus's processes, by role
       phos status      whether phosphorus and Tailscale are up
       phos vpn on|off  Tailscale up, or phosphorus stopped and Tailscale down
       phos uninstall   remove phosphorus and its data from this host
`)
}

type flags struct {
	update  bool
	payload string
	rest    []string
}

func parse(args []string) flags {
	var f flags
	for i := 0; i < len(args); i++ {
		switch a := args[i]; {
		case a == "--update":
			f.update = true
		case a == "--home" && i+1 < len(args):
			i++
			home = args[i]
		case a == "--payload" && i+1 < len(args):
			i++
			f.payload = args[i]
		default:
			f.rest = append(f.rest, a)
		}
	}
	return f
}

// Main one host command, its exit code
func Main(cmd string, args []string) int {
	f := parse(args)
	if home == "" {
		home = homeDir()
	}
	// Linux: root's /var/lib/phosphorus, its .env root's alone
	if isLinux && os.Geteuid() != 0 && cmd != "game-control" && cmd != "game-control-setup" && cmd != "help" {
		return asRoot(append([]string{cmd}, args...))
	}
	tag = cmd
	var err error
	switch cmd {
	case "":
		tag = "phosphorus"
		err = tui(nil)
	case "start":
		err = start()
	case "stop":
		err = stop()
	case "restart":
		err = restart()
	case "update":
		if len(f.rest) > 0 && f.rest[0] == "all" {
			err = tui([]string{"update-all"})
		} else {
			err = update()
		}
	case "keys":
		err = keys(f.rest)
	case "install":
		err = install(f.payload, f.update)
	case "setup":
		err = setup(f.rest)
	case "rebuild":
		err = rebuild()
	case "upgrade":
		err = upgrade()
	case "game-control":
		err = gameControl()
	case "game-control-setup":
		err = gameControlSetup()
	case "run":
		err = runHost()
	case "uninstall":
		err = uninstall(f.rest)
	case "status":
		err = status(f.rest)
	case "vpn":
		err = vpn(f.rest)
	case "ps":
		// the roles file under this home, not the default state dir
		os.Setenv("STATE_DIR", at("state"))
		err = psHost(os.Stdout)
	default:
		usage(os.Stdout)
		return 0
	}
	if err != nil {
		var x exitCode
		if errors.As(err, &x) {
			return int(x)
		}
		fmt.Fprintf(os.Stderr, "[%s] ERROR: %s\n", tag, err)
		return 1
	}
	return 0
}

// exitCode a child's, passed on silently
type exitCode int

func (e exitCode) Error() string { return fmt.Sprintf("exit %d", int(e)) }

func homeDir() string {
	if h := os.Getenv("PHOSPHORUS_HOME"); h != "" {
		return h
	}
	switch {
	case isWindows:
		// not %LOCALAPPDATA%\Phosphorus: the app's own install dir, wiped by its uninstaller
		return filepath.Join(os.Getenv("USERPROFILE"), "phosphorus")
	case isMac:
		h, _ := os.UserHomeDir()
		return filepath.Join(h, "Library", "Phosphorus")
	}
	return "/var/lib/phosphorus"
}

func say(f string, a ...any) { fmt.Printf("["+tag+"] "+f+"\n", a...) }

func fail(f string, a ...any) error { return fmt.Errorf(f, a...) }

func at(p ...string) string { return filepath.Join(append([]string{home}, p...)...) }

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

func readTrim(p string) string {
	b, _ := os.ReadFile(p)
	return strings.TrimSpace(string(b))
}

func version() string { return readTrim(at("VERSION")) }

// Version the home's release
func Version() string {
	if home == "" {
		home = homeDir()
	}
	return version()
}

func envPath() string { return at(".env") }

func keysMissing() bool { return len(envfile.Missing(envPath())) > 0 }

func exe() string {
	p, err := os.Executable()
	if err != nil {
		return os.Args[0]
	}
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return p
}

// binPath the home's own copy, what PATH and the forced command point at
func binPath(name string) string {
	if isWindows {
		name += ".exe"
	}
	return at("bin", name)
}

// --- phosphorus.ini ------------------------------------------------------------------

func iniFile() string { return at("config", "phosphorus.ini") }

func iniGet(section, key string) string {
	b, _ := os.ReadFile(iniFile())
	return ini.Parse(string(b))[section+"\x00"+key]
}

// Linux alone: forgejo and the git daemon ship for it only
func isGitHost() bool   { return isLinux && iniGet("git", "host") == "true" }
func isModelHost() bool { return iniGet("model", "host") == "true" }

func has(name string) bool { _, err := exec.LookPath(name); return err == nil }

// inDpkg inside a package's maintainer script, dpkg's lock held
func inDpkg() bool { return os.Getenv("DPKG_MAINTSCRIPT_PACKAGE") != "" }

// up phosphorus itself running
func up() bool { return svcActive() }

// run a host command, its output on this terminal
func run(name string, args ...string) error {
	c := exec.Command(name, args...)
	hide(c)
	c.Stdout, c.Stderr = os.Stdout, os.Stderr
	return c.Run()
}

func quiet(name string, args ...string) bool {
	c := exec.Command(name, args...)
	hide(c)
	return c.Run() == nil
}

func output(name string, args ...string) string {
	c := exec.Command(name, args...)
	hide(c)
	b, _ := c.Output()
	return strings.TrimSpace(string(b))
}

func lockEnv() {
	if fileExists(envPath()) {
		envfile.Lock(envPath())
	}
}
