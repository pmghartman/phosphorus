package host

// Windows' update agent with no one signed in: the app (the tray) picks update
// requests up only inside a desktop session, so after a reboot nobody has
// signed in to, the service hands on any request the app leaves to
// `phosphorus upgrade <id>`, run outside the service so its restart can't take
// the update down with it

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/pmghartman/phosphorus/internal/appfeed"
	"golang.org/x/sys/windows"
)

// the app's own feed, set by packaging/host/windows.sh as the tray's is
var (
	feedURL    = ""
	feedPubkey = ""
)

// how long the app gets to pick a request up first, it looking every 2s
const appPickup = 10 * time.Second

// watchUpdateRequests run's: a request the app left past appPickup handed on
// to a detached upgrade
func watchUpdateRequests(stop <-chan struct{}) {
	req := at("state", "update-request.json")
	for {
		select {
		case <-stop:
			return
		case <-time.After(2 * time.Second):
		}
		st, err := os.Stat(req)
		if err != nil || time.Since(st.ModTime()) < appPickup || updating() {
			continue
		}
		var r struct{ ID string }
		b, err := os.ReadFile(req)
		if err != nil {
			continue
		}
		json.Unmarshal(b, &r)
		// consumed first, never handed on twice
		if os.Remove(req) != nil {
			continue
		}
		say("update %s: no app picked it up, updating as the service", r.ID)
		f, err := os.Create(at("state", "upgrade.log"))
		if err == nil {
			_, err = spawnDetached([]string{"upgrade", r.ID, "--home", home}, f)
		}
		if err != nil {
			say("couldn't start the update: %v", err)
			agentReport(r.ID)("failed", false, "", "couldn't start the update: "+err.Error())
		}
	}
}

// updating an update already under way here, the app's or this agent's,
// one stuck past the frontend's 20 minutes not counted
func updating() bool {
	var a struct {
		State string
		At    int64
	}
	b, err := os.ReadFile(at("state", "update-agent.json"))
	if err != nil || json.Unmarshal(b, &a) != nil {
		return false
	}
	return a.State == "running" && time.Since(time.UnixMilli(a.At)) < 20*time.Minute
}

// upgradeApp the app's update without it: the feed's newer setup downloaded,
// its signature checked and run silently into the app's folder, then the app's
// release installed into the home as the app would; this release re-applied
// when it's the newest
func upgradeApp(report agentReporter) error {
	dir := appDir()
	host := filepath.Join(dir, "phosphorus-host.exe")
	if !fileExists(host) {
		report("failed", false, "", "no Phosphorus app in "+dir+": reinstall from the latest release")
		return fail("no Phosphorus app in %s", dir)
	}
	feed := appfeed.Feed{URL: feedURL, Pubkey: feedPubkey}
	rel, err := feed.Check(readTrim(filepath.Join(dir, "release", "VERSION")))
	if err != nil {
		report("failed", false, "", "update feed: "+err.Error())
		return fail("update feed: %v", err)
	}
	if rel != nil {
		say("downloading %s", rel.Version)
		report("running", false, rel.Version, "")
		setup, err := feed.Fetch(rel)
		if err != nil {
			report("failed", false, "", err.Error())
			return err
		}
		defer os.RemoveAll(filepath.Dir(setup))
		say("installing the app %s into %s", rel.Version, dir)
		c := exec.Command(setup)
		hide(c)
		// NSIS's /D last and unquoted, spaces and all; /AGENT: no tray started
		// and nothing written to the service's own registry
		c.SysProcAttr.CmdLine = syscall.EscapeArg(setup) + " /S /AGENT /D=" + dir
		if out, err := c.CombinedOutput(); err != nil {
			report("failed", false, "", "the app's setup failed: "+strings.TrimSpace(err.Error()+" "+string(out)))
			return fail("the app's setup failed: %v", err)
		}
	}
	c := exec.Command(host, "install", "--update", "--payload", filepath.Join(dir, "release"), "--home", home)
	hide(c)
	// the .env lock granting the home's user, not this service's account
	if u := homeOwner(); u != "" {
		c.Env = append(os.Environ(), "USERNAME="+u)
	}
	var buf bytes.Buffer
	c.Stdout, c.Stderr = io.MultiWriter(&buf, os.Stdout), io.MultiWriter(&buf, os.Stderr)
	if err := c.Run(); err != nil {
		e := lastLine(buf.String(), regexp.MustCompile(`ERROR`))
		if e == "" {
			e = "install failed"
		}
		report("failed", false, "", e)
		return fail("install failed")
	}
	report("ok", rel == nil && strings.Contains(buf.String(), "already up to date"), readTrim(filepath.Join(dir, "release", "VERSION")), "")
	return nil
}

// appDir the app's folder: where it last said it runs from, else the per-user
// install's default in the home's profile
func appDir() string {
	if d := readTrim(at("state", "app-dir")); d != "" {
		return d
	}
	return filepath.Join(filepath.Dir(home), "AppData", "Local", "Phosphorus")
}

// homeOwner the user account the home belongs to, "" when it's none
func homeOwner() string {
	sd, err := windows.GetNamedSecurityInfo(home, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return ""
	}
	sid, _, err := sd.Owner()
	if err != nil || sid == nil {
		return ""
	}
	name, _, use, err := sid.LookupAccount("")
	if err != nil || use != windows.SidTypeUser || sid.IsWellKnown(windows.WinLocalSystemSid) {
		return ""
	}
	return name
}
