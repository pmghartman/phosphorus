//go:build (darwin && cgo) || windows

// Phosphorus's menu bar and tray app, macOS and Windows: bundled with the host
// binary and release; keys, install, start and stop, feed updates, the frontend
// opened in the default browser
package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"fyne.io/systray"
)

// set at release: the app's version, the feed and the key its updates are signed with
var (
	appVersion = ""
	feedURL    = ""
	feedPubkey = ""
)

type app struct {
	payload string
	home    string
	host    string
}

var (
	a      app
	busy   atomic.Bool
	status *systray.MenuItem
	start  *systray.MenuItem
	stop   *systray.MenuItem
)

func main() {
	background := false
	for _, x := range os.Args[1:] {
		background = background || x == "--background"
	}
	a = app{payload: payloadDir(), home: homeDir(), host: hostBin()}
	// opened again: the running one's frontend brought up instead
	if !singleInstance() {
		openMain()
		return
	}
	systray.Run(func() { ready(background) }, func() {})
}

// the tray: the service's controls
func ready(background bool) {
	setIcon()
	systray.SetTooltip("Phosphorus")
	status = systray.AddMenuItem("Phosphorus", "")
	status.Disable()
	systray.AddSeparator()
	open := systray.AddMenuItem("Open Phosphorus", "the frontend in your browser")
	start = systray.AddMenuItem("Start", "")
	stop = systray.AddMenuItem("Stop", "")
	upd := systray.AddMenuItem("Check for Updates", "")
	systray.AddSeparator()
	keys := systray.AddMenuItem("Edit Keys…", "")
	systray.AddSeparator()
	unin := systray.AddMenuItem("Uninstall…", "")
	systray.AddSeparator()
	quitItem := systray.AddMenuItem("Quit (stops phosphorus)", "")
	click := func(m *systray.MenuItem, f func()) {
		go func() {
			for range m.ClickedCh {
				f()
			}
		}()
	}
	click(open, openMain)
	click(start, func() { go hostAction("start", false) })
	click(stop, func() { go hostAction("stop", false) })
	click(upd, func() { go handleUpdate(fmt.Sprintf("app-%d", time.Now().UnixMilli()), true) })
	click(keys, openKeys)
	click(unin, func() { go uninstall() })
	click(quitItem, func() { go quit() })
	// a host stays up across logins
	setAutostart(true)
	go startup(background)
}

func read(p string) string {
	b, _ := os.ReadFile(p)
	return strings.TrimSpace(string(b))
}

func writeJSON(p string, v any) {
	os.MkdirAll(filepath.Dir(p), 0o755)
	b, _ := json.Marshal(v)
	tmp := p + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		os.Rename(tmp, p)
	}
}

// what the frontend and `phosphorus update` wait on
func report(id, state string, current bool, version, errText string) {
	if len(errText) > 400 {
		errText = errText[:400]
	}
	writeJSON(filepath.Join(a.home, "state/update-agent.json"), map[string]any{"id": id, "state": state, "current": current,
		"version": version, "error": errText, "at": time.Now().UnixMilli()})
}

// the host binary, no console window, the home passed along
func hostCmd(args ...string) *exec.Cmd {
	c := exec.Command(a.host, append(args, "--home", a.home)...)
	quiet(c)
	return c
}

// a host command's ok and output, the output kept in state/<log>.log
func hostRun(log string, args ...string) (bool, string) {
	os.MkdirAll(filepath.Join(a.home, "state"), 0o755)
	out, err := hostCmd(args...).CombinedOutput()
	os.WriteFile(filepath.Join(a.home, "state", log+".log"), out, 0o644)
	if err != nil && len(out) == 0 {
		return false, err.Error()
	}
	return err == nil, string(out)
}

func lastError(text string) string {
	e := ""
	for _, l := range strings.Split(text, "\n") {
		if strings.Contains(l, "ERROR") {
			e = strings.TrimSpace(l)
		}
	}
	return e
}

// which keys .env holds, never their values, and the mesh's domain: one host run
func keyState() (map[string]bool, string) {
	_, out := hostRun("keys", "keys", "--state")
	ls := strings.Split(strings.TrimSpace(out), "\n")
	var m struct {
		Keys   map[string]bool
		Domain string
	}
	json.Unmarshal([]byte(ls[len(ls)-1]), &m)
	return m.Keys, m.Domain
}

func keyStatus() map[string]bool {
	k, _ := keyState()
	return k
}

func keysMissing() bool { return !keyStatus()["TS_AUTHKEY"] }

func setTip(text string) {
	systray.SetTooltip(text)
	if status != nil {
		status.SetTitle(text)
	}
}

func payloadVersion() string { return read(filepath.Join(a.payload, "VERSION")) }

// whether the service and Tailscale are up, both false when the host can't say
func hostState() (running, vpn bool) {
	out, _ := hostCmd("status", "--json").Output()
	var v struct{ Running, VPN bool }
	json.Unmarshal(out, &v)
	return v.Running, v.VPN
}

func statusTip(running, vpn bool) string {
	v := read(filepath.Join(a.home, ".phosphorus-installed"))
	if v == "" {
		return "Phosphorus not set up"
	}
	if keysMissing() {
		return "Phosphorus " + v + ": no keys yet"
	}
	svc, net := "stopped", "VPN off"
	if running {
		svc = "running"
	}
	if vpn {
		net = "VPN on"
	}
	return fmt.Sprintf("Phosphorus %s: %s, %s", v, svc, net)
}

// the status line and items set from the host's state, all off while busy
func refresh() {
	b := busy.Load()
	running := false
	if !b {
		var vpn bool
		running, vpn = hostState()
		setTip(statusTip(running, vpn))
	}
	enable(start, !b && !running)
	enable(stop, !b && running)
}

func enable(m *systray.MenuItem, on bool) {
	if m == nil {
		return
	}
	if on {
		m.Enable()
	} else {
		m.Disable()
	}
}

// start or stop, the status line following, a failure shown
func hostAction(action string, thenOpen bool) {
	if busy.Swap(true) {
		return
	}
	if action == "start" {
		if keysMissing() {
			busy.Store(false)
			openKeys()
			return
		}
		adminSetup()
	}
	if action == "start" {
		setTip("Phosphorus starting…")
	} else {
		setTip("Phosphorus stopping…")
	}
	refresh()
	ok, out := hostRun(action, action)
	busy.Store(false)
	refresh()
	switch {
	case !ok:
		e := lastError(out)
		if e == "" {
			e = "failed, see state/ in the Phosphorus folder"
		}
		alert(e)
	case thenOpen:
		openMain()
	case action == "start":
		notify("Phosphorus is running.")
	default:
		notify("Phosphorus stopped.")
	}
}

// an update request: the feed's newer app installed and relaunched (finished on the
// next launch), else this release's images and config re-applied
func handleUpdate(id string, ask bool) {
	if busy.Swap(true) {
		report(id, "failed", false, "", "busy starting, stopping or installing; try again once it's done")
		if ask {
			notify("Phosphorus is busy starting, stopping or installing; try again once it's done.")
		}
		return
	}
	defer func() { busy.Store(false); refresh() }()
	report(id, "running", false, "", "")
	setTip("Phosphorus checking for updates…")
	rel, err := feedCheck()
	if err != nil {
		fmt.Fprintln(os.Stderr, "phosphorus: update feed:", err)
	}
	if rel != nil {
		if ask && !confirm(fmt.Sprintf("Phosphorus %s is available. Updating restarts phosphorus on this host.", rel.Version), "Update", "Later") {
			report(id, "failed", false, "", "update declined")
			return
		}
		setTip("Phosphorus downloading " + rel.Version + "…")
		// running with the release named: the next launch finishes it
		report(id, "running", false, rel.Version, "")
		if err := installRelease(rel); err != nil {
			report(id, "failed", false, "", err.Error())
			if ask {
				alert("update failed: " + err.Error())
			}
			return
		}
		// the new app relaunched in this one's place
		os.Exit(0)
	}
	setTip("Phosphorus applying this release…")
	ok, out := hostRun("install", "install", "--update", "--payload", a.payload)
	v := payloadVersion()
	current := strings.Contains(out, "already up to date")
	if !ok {
		e := lastError(out)
		if e == "" {
			e = "install failed"
		}
		report(id, "failed", false, "", e)
		return
	}
	report(id, "ok", current, v, "")
	if ask {
		if current {
			notify("Phosphorus " + v + " is up to date.")
		} else {
			notify("Phosphorus " + v + " re-applied.")
		}
	}
}

// launch: a new release unpacked into home, a pending update's verdict written,
// the keys asked for when there are none, then the update requests watched
func startup(background bool) {
	noteAppDir()
	installed := read(filepath.Join(a.home, ".phosphorus-installed"))
	ver := payloadVersion()
	if installed != ver && !busy.Swap(true) {
		setTip("Phosphorus installing " + ver + "…")
		args := []string{"install", "--payload", a.payload}
		if installed != "" {
			args = append(args, "--update")
		}
		ok, out := hostRun("install", args...)
		// an update this launch finishes: running, with the release it was for
		if b, err := os.ReadFile(filepath.Join(a.home, "state/update-agent.json")); err == nil {
			var p struct{ ID, State, Version string }
			json.Unmarshal(b, &p)
			if p.State == "running" && p.Version != "" {
				if ok {
					report(p.ID, "ok", false, ver, "")
				} else {
					report(p.ID, "failed", false, "", lastError(out))
				}
			}
		}
		busy.Store(false)
	}
	// the menu's state beside the browser's opening, neither waiting on the other
	go refresh()
	// opened by hand: the frontend (or the keys); at login: the tray alone
	if keys, domain := keyState(); !keys["TS_AUTHKEY"] {
		openKeys()
	} else if !background {
		openURL(frontendURL(domain))
	}
	req := filepath.Join(a.home, "state/update-request.json")
	// the menu kept current with changes made elsewhere (the cli, the Tailscale app)
	for tick := 1; ; tick++ {
		time.Sleep(2 * time.Second)
		if tick%10 == 0 && !busy.Load() {
			refresh()
		}
		b, err := os.ReadFile(req)
		if err != nil {
			continue
		}
		os.Remove(req)
		var r struct{ ID string }
		json.Unmarshal(b, &r)
		handleUpdate(r.ID, false)
	}
}

// the keys asked for first when there are none, else the frontend in the browser
func openMain() {
	keys, domain := keyState()
	if !keys["TS_AUTHKEY"] {
		openKeys()
		return
	}
	openURL(frontendURL(domain))
}

// a domain's https, else this host's own frontend over the tailnet's port
func frontendURL(d string) string {
	if d != "" {
		return "https://" + d + "/"
	}
	return "http://localhost/"
}

// everything gone after a confirm: the host's service, setup and home, the
// login item, then the app
func uninstall() {
	if busy.Swap(true) {
		return
	}
	what := fmt.Sprintf("This removes Phosphorus from this computer: the host service, its setup and everything in %s, "+
		"including this host's git data and shares. Other hosts keep the mesh.", a.home)
	if !confirm(what, "Uninstall", "Cancel") {
		busy.Store(false)
		return
	}
	setTip("Phosphorus uninstalling…")
	asAdmin("uninstall", "--admin")
	// not hostRun: its log would put the home back
	out, err := hostCmd("uninstall").CombinedOutput()
	if err != nil {
		busy.Store(false)
		refresh()
		e := lastError(string(out))
		if e == "" {
			e = "uninstall failed"
		}
		alert(e)
		return
	}
	setAutostart(false)
	removeApp()
	systray.Quit()
	os.Exit(0)
}

// phosphorus stopped first, then the app gone
func quit() {
	if busy.Swap(true) {
		return
	}
	setTip("Phosphorus stopping…")
	ok, out := hostRun("stop", "stop")
	if !ok {
		busy.Store(false)
		refresh()
		e := lastError(out)
		if e == "" {
			e = "couldn't stop phosphorus, see state/ in the Phosphorus folder"
		}
		alert(e)
		return
	}
	systray.Quit()
	os.Exit(0)
}
