package main

// Sulfur's own updates, as the menu bar app's: the signed feed's newer
// release fetched, checked against the release key, put in this app's place
// and the app opened again once its window's closed

import (
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/pmghartman/phosphorus/internal/appfeed"
)

// set at release: the feed and the key its updates are signed with
var (
	feedURL    = ""
	feedPubkey = ""
)

var (
	updMu   sync.Mutex
	updBusy bool
)

func sulfurFeed() appfeed.Feed { return appfeed.Feed{URL: feedURL, Pubkey: feedPubkey, App: "sulfur-"} }

// update GET what the feed has, POST it installed; the page closes the window after
func update(w http.ResponseWriter, r *http.Request) {
	f := sulfurFeed()
	rel, err := f.Check(version)
	if r.Method == "GET" {
		out := map[string]any{"version": version, "on": f.On()}
		if err != nil {
			out["error"] = err.Error()
		}
		if rel != nil {
			out["latest"] = rel.Version
		}
		send(w, 200, out)
		return
	}
	if r.Method != "POST" {
		send(w, 405, errB("method not allowed"))
		return
	}
	switch {
	case err != nil:
		send(w, 502, errB("the update feed didn't answer: "+err.Error()))
		return
	case rel == nil:
		send(w, 409, errB("Sulfur "+version+" is the latest"))
		return
	}
	updMu.Lock()
	if updBusy {
		updMu.Unlock()
		send(w, 409, errB("already updating"))
		return
	}
	updBusy = true
	updMu.Unlock()
	defer func() { updMu.Lock(); updBusy = false; updMu.Unlock() }()
	file, err := f.Fetch(rel)
	if err == nil {
		err = installUpdate(file)
	}
	if err != nil {
		send(w, 500, errB(err.Error()))
		return
	}
	send(w, 200, map[string]any{"ok": true, "version": rel.Version})
}

// installUpdate the fetched file handed on, to run once this app's gone
func installUpdate(file string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	dir := filepath.Dir(exe)
	switch runtime.GOOS {
	case "windows":
		app := filepath.Join(dir, "Sulfur.exe")
		if _, err := os.Stat(app); err != nil {
			app = filepath.Join(dir, "sulfur.exe")
		}
		// the installer once the window's closed, then the app again
		return detachedLine(`cmd /c timeout /t 3 /nobreak >nul & "` + file + `" /S & start "" "` + app + `"`)
	case "darwin":
		// Contents/MacOS/Sulfur, in Sulfur.app
		bundle := filepath.Dir(filepath.Dir(dir))
		if !strings.HasSuffix(bundle, ".app") {
			return errors.New("not running from Sulfur.app")
		}
		return detached("/bin/sh", "-c", `sleep 3; S=$(mktemp -d "$2.update.XXXXXX") && /usr/bin/tar -xzf "$1" -C "$S" && `+
			`N=$(ls -d "$S"/*.app | head -n 1) && [ -n "$N" ] && mv "$2" "$S/old.app" && mv "$N" "$2" && rm -rf "$S"; /usr/bin/open "$2"`, "sh", file, bundle)
	default:
		// Linux has no feed: the .deb is the app, and apt updates it
		return errors.New("Sulfur on Linux updates with apt: sudo apt install ./sulfur_VERSION_ARCH.deb from the latest release")
	}
}

// detached a process outliving this server and the app around it
func detached(name string, args ...string) error {
	c := exec.Command(name, args...)
	detach(c)
	return c.Start()
}
