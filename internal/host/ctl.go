package host

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/pmghartman/phosphorus/internal/envfile"
	"golang.org/x/term"
)

func started() string {
	return dockerOut("inspect", "-f", "{{.State.Running}} {{.State.StartedAt}}", "phosphorus")
}

// attach the cli in the container; a mesh update swapping it out from under
// the cli, the new one waited for and reattached on the same tab
func attach(args []string) error {
	for {
		before := started()
		if !strings.HasPrefix(before, "true") {
			return fail("phosphorus isn't running, run: phos start")
		}
		t := os.Getenv("TERM")
		if t == "" {
			t = "xterm-256color"
		}
		a := []string{"exec", "-it", "-e", "TERM=" + t}
		for _, k := range []string{"COLORTERM", "COLORFGBG", "TERM_PROGRAM"} {
			if v := os.Getenv(k); v != "" {
				a = append(a, "-e", k+"="+v)
			}
		}
		c := exec.Command("docker", append(append(a, "phosphorus", "phosphorus", "cli"), args...)...)
		c.Stdin, c.Stdout, c.Stderr = os.Stdin, os.Stdout, os.Stderr
		err := c.Run()
		if started() == before {
			if x, ok := err.(*exec.ExitError); ok {
				return exitCode(x.ExitCode())
			}
			return err
		}
		fmt.Println("phosphorus is restarting, reattaching (ctrl-c to quit)...")
		for !strings.HasPrefix(started(), "true") {
			time.Sleep(time.Second)
		}
		if len(args) > 0 && args[0] == "update-all" {
			args = []string{"--tab", "update"}
		}
	}
}

// detached this command rerun in its own session and its log followed: a
// terminal inside phosphorus dropping mid-stop never leaves git stopped
func detached(cmd string) (bool, error) {
	if os.Getenv("PHOSPHORUS_DETACHED") != "" {
		return false, nil
	}
	os.MkdirAll(at("state"), 0o755)
	logf := at("state", cmd+".log")
	f, err := os.Create(logf)
	if err != nil {
		return false, nil
	}
	wait, err := spawnDetached([]string{cmd, "--home", home}, f)
	if err != nil {
		f.Close()
		return false, nil
	}
	done := make(chan struct{})
	go func() { wait(); close(done) }()
	var seen int64
	follow := func() {
		r, err := os.Open(logf)
		if err != nil {
			return
		}
		r.Seek(seen, io.SeekStart)
		n, _ := io.Copy(os.Stdout, r)
		seen += n
		r.Close()
	}
	for {
		select {
		case <-done:
			time.Sleep(300 * time.Millisecond)
			follow()
			return true, nil
		case <-time.After(300 * time.Millisecond):
			follow()
		}
	}
}

// stop git first, so a master hands off before the frontend goes, stopped
// through reboots since compose restarts only unless-stopped
func stop() error {
	if ok, err := detached("stop"); ok || err != nil {
		return err
	}
	for _, c := range []string{"phosphorus-git", "phosphorus", "phosphorus-model", "phosphorus-search"} {
		if !isRunning(c) {
			continue
		}
		fmt.Printf("stopping %s...\n", c)
		if !dockerQuiet("stop", "-t", "30", c) {
			return fail("couldn't stop %s", c)
		}
	}
	fmt.Println("phosphorus stopped, phos start to resume")
	return nil
}

// restart git stopped first for the hand-off, started again once phosphorus is back
func restart() error {
	if ok, err := detached("restart"); ok || err != nil {
		return err
	}
	gitUp := isRunning("phosphorus-git")
	if gitUp {
		fmt.Println("stopping phosphorus-git...")
		if !dockerQuiet("stop", "-t", "30", "phosphorus-git") {
			return fail("couldn't stop phosphorus-git")
		}
	}
	fmt.Println("restarting phosphorus...")
	var err error
	if !dockerQuiet("restart", "-t", "30", "phosphorus") {
		err = fail("couldn't restart phosphorus")
	}
	// git back whatever became of phosphorus, else it stays stopped
	if gitUp {
		fmt.Println("starting phosphorus-git...")
		if !dockerQuiet("start", "phosphorus-git") {
			err = fail("couldn't start phosphorus-git")
		}
	}
	if err == nil {
		fmt.Println("phosphorus restarted")
	}
	return err
}

// update handed to the host's agent (the systemd path unit, the app), its
// verdict waited on; ADMIN_PASS the gate when set
func update() error {
	if want := envfile.Read(envPath())["ADMIN_PASS"]; want != "" {
		fmt.Print("admin password: ")
		got, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Println()
		if err != nil || string(got) != want {
			return fail("wrong password")
		}
	}
	id := fmt.Sprintf("cli-%d-%d", time.Now().Unix(), os.Getpid())
	os.MkdirAll(at("state"), 0o755)
	b, _ := json.Marshal(map[string]any{"id": id, "at": time.Now().UnixMilli()})
	tmp := at("state", "update-request.json.tmp")
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, at("state", "update-request.json")); err != nil {
		return err
	}
	fmt.Println("update requested, checking the release feed...")
	last := ""
	for i := 1; i <= 1800; i++ {
		var a struct {
			ID, State, Version, Error string
			Current                   bool
		}
		raw, _ := os.ReadFile(at("state", "update-agent.json"))
		if json.Unmarshal(raw, &a) == nil && a.ID == id && string(raw) != last {
			last = string(raw)
			switch {
			case a.State == "failed":
				return fail("update failed: %s", a.Error)
			case a.State == "ok" && a.Current:
				fmt.Println("already up to date")
				return nil
			case a.State == "ok":
				fmt.Printf("updated to %s\n", a.Version)
				return nil
			default:
				fmt.Println("updating...")
			}
		}
		if i == 30 && last == "" {
			fmt.Println("nothing picked it up yet: is the update agent running (Linux: phosphorus-update.path, else the Phosphorus app)?")
		}
		time.Sleep(time.Second)
	}
	return fail("gave up waiting, see %s", at("state", "update-agent.json"))
}
