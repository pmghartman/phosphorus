package host

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/pmghartman/phosphorus/internal/envfile"
	"golang.org/x/term"
)

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

// stop git first (run stops it before the rest), so a master hands off;
// kept stopped through reboots
func stop() error {
	if ok, err := detached("stop"); ok || err != nil {
		return err
	}
	return nativeStop()
}

func restart() error {
	if ok, err := detached("restart"); ok || err != nil {
		return err
	}
	return nativeRestart()
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
