package host

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/pmghartman/phosphorus/internal/ini"
)

const gameTag = "phosphorus-game-control"

var gameName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

// gameControl the play/stop key's forced command: a game's start or stop line
// from config/services.export, on the host, the key never reaching a shell
func gameControl() error {
	f := strings.Fields(os.Getenv("SSH_ORIGINAL_COMMAND"))
	if len(f) != 2 || (f[0] != "start" && f[0] != "stop") {
		return fail("usage: start|stop <name>")
	}
	action, name := f[0], f[1]
	if !gameName.MatchString(name) {
		return fail("bad game name")
	}
	b, _ := os.ReadFile(at("config", "services.export"))
	keys := ini.Parse(string(b))
	cmd := ""
	if keys[name+"\x00type"] == "game" {
		cmd = keys[name+"\x00"+action]
	}
	if cmd == "" {
		return fail("%s has no %s command in services.export", name, action)
	}
	// output to a file, not the ssh channel a backgrounded server would hold open
	dir := at("state", "game-control")
	os.MkdirAll(dir, 0o755)
	logf := filepath.Join(dir, name+".log")
	l, err := os.OpenFile(logf, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	fmt.Fprintf(l, "--- %s %s: %s\n", time.Now().Format("2006-01-02 15:04:05"), action, cmd)
	var c *exec.Cmd
	if isWindows {
		c = exec.Command("powershell", "-NoProfile", "-Command", cmd)
	} else {
		sh := os.Getenv("SHELL")
		if sh == "" {
			sh = "/bin/sh"
		}
		c = exec.Command(sh, "-lc", cmd)
	}
	c.Stdout, c.Stderr = l, l
	err = c.Run()
	l.Close()
	if err != nil {
		b, _ := os.ReadFile(logf)
		ls := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
		if len(ls) > 5 {
			ls = ls[len(ls)-5:]
		}
		fmt.Fprintln(os.Stderr, strings.Join(ls, "\n"))
		if x, ok := err.(*exec.ExitError); ok {
			return exitCode(x.ExitCode())
		}
		return err
	}
	return nil
}

// gameControlSetup the frontend's play/stop onto this host: a key in
// state/game-control/, authorized for the forced command alone, safe to re-run
func gameControlSetup() error {
	u, err := user.Current()
	if err != nil {
		return err
	}
	dir := at("state", "game-control")
	key := filepath.Join(dir, "id_ed25519")
	// state/ root's on Linux
	if err := os.MkdirAll(dir, 0o755); err != nil || !writable(dir) {
		if isWindows || run("sudo", "mkdir", "-p", dir) != nil || run("sudo", "chown", u.Username, dir) != nil {
			return fail("can't write %s", dir)
		}
	}
	if !fileExists(key) {
		if err := run("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", gameTag, "-f", key); err != nil {
			return fail("ssh-keygen failed")
		}
	}
	name := u.Username
	if i := strings.LastIndex(name, `\`); i >= 0 {
		name = name[i+1:]
	}
	os.WriteFile(filepath.Join(dir, "user"), []byte(name+"\n"), 0o644)
	changed, err := authorizeGameKey(u)
	if err != nil {
		return err
	}
	if !changed {
		say("play/stop key already authorized for %s", name)
		return nil
	}
	say("authorized the play/stop key for %s, it can only start and stop games in services.export", name)
	return nil
}

// authorizeGameKey u's authorized_keys line for the key, pointed at this
// binary; a stale one (an older key, or a script an old release shipped) swapped out
func authorizeGameKey(u *user.User) (bool, error) {
	pub, err := os.ReadFile(filepath.Join(at("state", "game-control"), "id_ed25519.pub"))
	if err != nil {
		return false, err
	}
	line := "restrict,command=" + strconv.Quote(binPath("phosphorus")+" game-control --home "+home) + " " + strings.TrimSpace(string(pub))
	sshDir := filepath.Join(u.HomeDir, ".ssh")
	ak := filepath.Join(sshDir, "authorized_keys")
	os.MkdirAll(sshDir, 0o700)
	b, _ := os.ReadFile(ak)
	kept := []string{}
	keyPart := strings.Join(strings.Fields(string(pub))[:min(2, len(strings.Fields(string(pub))))], " ")
	for _, l := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
		if l == line {
			return false, nil
		}
		if l != "" && !strings.Contains(l, gameTag) && (keyPart == "" || !strings.Contains(l, keyPart)) {
			kept = append(kept, l)
		}
	}
	if err := os.WriteFile(ak, []byte(strings.Join(append(kept, line), "\n")+"\n"), 0o600); err != nil {
		return false, err
	}
	return true, nil
}

// refreshGameKey at rebuild: a host already set up for play/stop kept pointed
// at the binary in place, never a path an older release used
func refreshGameKey() {
	dir := at("state", "game-control")
	b, err := os.ReadFile(filepath.Join(dir, "user"))
	if err != nil || !fileExists(filepath.Join(dir, "id_ed25519.pub")) {
		return
	}
	u, err := user.Lookup(strings.TrimSpace(string(b)))
	if err != nil {
		return
	}
	changed, err := authorizeGameKey(u)
	if err != nil {
		say("couldn't refresh the play/stop key for %s: %v", u.Username, err)
		return
	}
	if changed {
		chownUser(u, filepath.Join(u.HomeDir, ".ssh"), filepath.Join(u.HomeDir, ".ssh", "authorized_keys"))
		say("play/stop key for %s pointed at %s", u.Username, binPath("phosphorus"))
	}
}

// chownUser paths given to u, where ids mean anything
func chownUser(u *user.User, paths ...string) {
	uid, err1 := strconv.Atoi(u.Uid)
	gid, err2 := strconv.Atoi(u.Gid)
	if err1 != nil || err2 != nil {
		return
	}
	for _, p := range paths {
		os.Chown(p, uid, gid)
	}
}

func writable(dir string) bool {
	f, err := os.CreateTemp(dir, ".w")
	if err != nil {
		return false
	}
	f.Close()
	os.Remove(f.Name())
	return true
}
