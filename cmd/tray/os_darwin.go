//go:build darwin && cgo

package main

import (
	_ "embed"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"fyne.io/systray"
)

//go:embed assets/tray.png
var trayIcon []byte

// the login item
const launchAgent = "Library/LaunchAgents/Phosphorus.plist"

func homeDir() string {
	if h := os.Getenv("PHOSPHORUS_HOME"); h != "" {
		return h
	}
	return filepath.Join(os.Getenv("HOME"), "Library/Phosphorus")
}

func exeDir() string {
	exe, _ := os.Executable()
	exe, _ = filepath.EvalSymlinks(exe)
	return filepath.Dir(exe)
}

// Phosphorus.app/Contents/MacOS/phosphorus-host, beside this one
func hostBin() string { return filepath.Join(exeDir(), "phosphorus-host") }

// not "phosphorus": beside the Phosphorus binary on a case-insensitive disk
func payloadDir() string { return filepath.Join(exeDir(), "../Resources/release") }

// none: Windows' service alone updates the app without it
func noteAppDir() {}

// the app bundle this runs from, "" when run bare
func bundle() string {
	d := filepath.Clean(filepath.Join(exeDir(), "../.."))
	if strings.HasSuffix(d, ".app") {
		return d
	}
	return ""
}

// the white glyph as a template, tinted like the system's own
func setIcon() { systray.SetTemplateIcon(trayIcon, trayIcon) }

func quiet(*exec.Cmd) {}

// one tray per user: a lock in the home, held while this runs
func singleInstance() bool {
	os.MkdirAll(filepath.Join(a.home, "state"), 0o755)
	f, err := os.OpenFile(filepath.Join(a.home, "state/tray.lock"), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return true
	}
	if syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		f.Close()
		return false
	}
	// held open for the process's life
	lockFile = f
	return true
}

var lockFile *os.File

// an AppleScript string literal
func asq(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}

func dialog(text, icon string, buttons ...string) bool {
	bs := make([]string, len(buttons))
	for i, b := range buttons {
		bs[i] = asq(b)
	}
	script := fmt.Sprintf(`display dialog %s with title "Phosphorus" buttons {%s} default button %s with icon %s`,
		asq(text), strings.Join(bs, ", "), asq(buttons[len(buttons)-1]), icon)
	// the first of several a cancel, osascript failing on it
	if len(buttons) > 1 {
		script += " cancel button 1"
	}
	return exec.Command("/usr/bin/osascript", "-e", script).Run() == nil
}

func notify(text string) { dialog(text, "note", "OK") }

func alert(text string) { dialog(text, "stop", "OK") }

// yes on the last button, the first cancelling
func confirm(text, yes, no string) bool { return dialog(text, "caution", no, yes) }

func openURL(u string) { exec.Command("/usr/bin/open", u).Start() }

// the admin-only steps (Remote Login, ssh by name, PATH) behind the system's own
// password prompt, once
func adminSetup() {
	if hostCmd("setup", "--check").Run() == nil {
		return
	}
	asAdmin("setup")
}

// one host command as root behind the system's password prompt
func asAdmin(args ...string) {
	q := func(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
	sh := q(a.host) + " " + strings.Join(args, " ") + " --home " + q(a.home)
	exec.Command("/usr/bin/osascript", "-e", "do shell script "+asq(sh)+" with administrator privileges").Run()
}

// the login item: this app at login, its tray alone
func setAutostart(on bool) {
	p := filepath.Join(os.Getenv("HOME"), launchAgent)
	if !on {
		os.Remove(p)
		return
	}
	exe, _ := os.Executable()
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>Phosphorus</string>
  <key>ProgramArguments</key><array><string>` + xmlEsc(exe) + `</string><string>--background</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`
	if read(p) == strings.TrimSpace(plist) {
		return
	}
	os.MkdirAll(filepath.Dir(p), 0o755)
	os.WriteFile(p, []byte(plist), 0o644)
}

func xmlEsc(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

// the bundle removed once this process is gone
func removeApp() {
	if b := bundle(); b != "" {
		exec.Command("/bin/sh", "-c", "sleep 2; rm -rf '"+strings.ReplaceAll(b, "'", `'\''`)+"'").Start()
	}
}

// the release's Phosphorus.app.tar.gz unpacked beside this bundle, swapped in
// for it, then started once this one exits
func installDownloaded(f string) error {
	b := bundle()
	if b == "" {
		return errors.New("not running from Phosphorus.app")
	}
	stage, err := os.MkdirTemp(filepath.Dir(b), ".phosphorus-update-")
	if err != nil {
		return fmt.Errorf("can't write beside %s: %w", b, err)
	}
	defer os.RemoveAll(stage)
	if out, err := exec.Command("/usr/bin/tar", "-xzf", f, "-C", stage).CombinedOutput(); err != nil {
		return fmt.Errorf("unpacking: %s", strings.TrimSpace(string(out)))
	}
	ents, _ := os.ReadDir(stage)
	fresh := ""
	for _, e := range ents {
		if strings.HasSuffix(e.Name(), ".app") {
			fresh = filepath.Join(stage, e.Name())
		}
	}
	if fresh == "" {
		return errors.New("no app in the download")
	}
	old := filepath.Join(stage, "old.app")
	if err := os.Rename(b, old); err != nil {
		return err
	}
	if err := os.Rename(fresh, b); err != nil {
		os.Rename(old, b)
		return err
	}
	exec.Command("/bin/sh", "-c", "sleep 1; /usr/bin/open '"+strings.ReplaceAll(b, "'", `'\''`)+"' --args --background").Start()
	if lockFile != nil {
		lockFile.Close()
	}
	return nil
}
