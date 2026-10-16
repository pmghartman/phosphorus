package host

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/pmghartman/phosphorus/internal/cli"
	"github.com/pmghartman/phosphorus/internal/envfile"
	"golang.org/x/term"
)

// start bring-up, safe to re-run: checks, the one-time admin setup, the
// rebuild, then the frontend waited on when nothing ran before
func start() error {
	if _, err := exec.LookPath("docker"); err != nil {
		return fail("docker not found, %s", dockerHint())
	}
	if err := ensureEngine(); err != nil {
		return err
	}
	if keysMissing() {
		return fail("no TS_AUTHKEY in %s, run phosphorus to enter the keys", envPath())
	}
	if !fileExists(at("config", "services.export")) {
		return fail("config/services.export not found in %s", home)
	}
	envfile.Lock(envPath())
	up := isRunning("phosphorus")
	if up {
		say("phosphorus is already running, skipping the native Tailscale check")
	} else if why := nativeTailscale(); why != "" {
		return fail("%s", why)
	}
	if err := prepareOS(up); err != nil {
		return err
	}
	if b := machineRAM(); b > 0 {
		os.MkdirAll(at("state"), 0o755)
		os.WriteFile(at("state", "machine.json"), []byte(fmt.Sprintf("{\"ram\":%d}\n", b)), 0o644)
		ramHint(b)
	}
	if todo := needSetup(); todo != "" {
		say("needs %s", todo)
		if err := elevate(); err != nil {
			say("%v", err)
		}
	}
	say("building and starting phosphorus...")
	if err := rebuild(); err != nil {
		return fail("build failed, nothing changed: %v", err)
	}
	if up {
		say("swapping in phosphorus-updater, docker logs -f phosphorus-updater to follow")
		return nil
	}
	// everything after tailscaled waiting on its login, real time allowed
	say("waiting for the frontend...")
	for i := 0; i < 240; i++ {
		if dockerQuiet("exec", "phosphorus", "curl", "-s", "-o", "/dev/null", "http://127.0.0.1:8090/") {
			say("the frontend is up")
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fail("the frontend never came up, check: docker logs -f phosphorus")
}

// setup the steps only an admin can take, once per machine: the ssh server,
// ssh <host> by name, phosphorus on PATH
func setup(opts []string) error {
	for _, o := range opts {
		// the app asking whether its admin prompt is needed
		if o == "--check" {
			if todo := needSetup(); todo != "" {
				fmt.Println(todo)
				return exitCode(1)
			}
			return nil
		}
	}
	if !isAdmin() {
		return fail("setup needs root (sudo phosphorus setup) or an elevated shell")
	}
	if err := setupOS(); err != nil {
		return err
	}
	say("done")
	return nil
}

// elevate setup run as admin: sudo on a terminal, the app's own prompt otherwise
func elevate() error {
	if isAdmin() {
		return setupOS()
	}
	if isWindows {
		return elevateWindows()
	}
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return fail("left for the Phosphorus app's admin prompt, or: sudo phosphorus setup")
	}
	c := exec.Command("sudo", exe(), "setup", "--home", home)
	c.Stdin, c.Stdout, c.Stderr = os.Stdin, os.Stdout, os.Stderr
	return c.Run()
}

// sshdUp something answering on 22, the frontend's terminals logging in there
func sshdUp() bool {
	c, err := net.DialTimeout("tcp", "127.0.0.1:22", time.Second)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

// the Include line for state/ssh_config, one Host per tailnet peer
func sshInclude() string {
	return `Include "` + strings.ReplaceAll(at("state", "ssh_config"), `\`, "/") + `"`
}

// ensureEngine docker answering: colima on macOS, Docker Desktop on Windows
func ensureEngine() error {
	if dockerUp() {
		return nil
	}
	// Linux: docker.service still coming up at boot, nothing to start
	tries := 15
	if isMac {
		if _, err := exec.LookPath("colima"); err == nil {
			say("starting colima...")
			if err := run("colima", "start"); err != nil {
				return fail("colima didn't start")
			}
			tries = 90
		}
	}
	if isWindows {
		if err := startDockerDesktop(); err != nil {
			return err
		}
		tries = 90
	}
	for i := 0; i < tries && !dockerUp(); i++ {
		time.Sleep(2 * time.Second)
	}
	if !dockerUp() {
		return fail("docker isn't answering, %s", dockerHint())
	}
	return nil
}

// tui the cli in the container, the keys asked for first on a new host
func tui(args []string) error {
	if !isRunning("phosphorus") {
		if !keysMissing() {
			return fail("phosphorus isn't running, run: phos start")
		}
		if err := envfile.Ensure(envPath()); err != nil {
			return fail("can't write %s: %v", envPath(), err)
		}
		if cli.Keys(envPath()) != 0 {
			return nil
		}
		envfile.Lock(envPath())
		tag = "start"
		if err := start(); err != nil {
			return err
		}
		tag = "phosphorus"
	}
	return attach(args)
}

// keys replaced in .env, never shown; the app's through --status, --stdin and --domain
func keys(opts []string) error {
	if err := envfile.Ensure(envPath()); err != nil {
		return fail("can't write %s: %v", envPath(), err)
	}
	for _, o := range opts {
		switch o {
		case "--domain":
			// not secret: the app's window opened on it
			fmt.Println(envfile.Read(envPath())["BASE_DOMAIN"])
			return nil
		case "--status":
			set := map[string]bool{}
			have := envfile.Read(envPath())
			for _, k := range envfile.Keys {
				set[k.Name] = have[k.Name] != ""
			}
			b, _ := json.Marshal(set)
			fmt.Println(string(b))
			return nil
		case "--stdin":
			b, err := io.ReadAll(io.LimitReader(os.Stdin, 1<<16))
			if err != nil {
				return err
			}
			if err := envfile.Set(envPath(), envfile.Parse(string(b))); err != nil {
				return fail("can't write %s: %v", envPath(), err)
			}
			return envfile.Lock(envPath())
		}
	}
	if cli.Keys(envPath()) != 0 {
		return nil
	}
	envfile.Lock(envPath())
	if !isRunning("phosphorus") {
		say("saved, phos start to bring phosphorus up")
		return nil
	}
	// env_file read only when a container is made: recreated on the new keys
	say("saved, restarting phosphorus with them")
	return rebuild()
}
