//go:build windows

package main

import (
	_ "embed"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"fyne.io/systray"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

//go:embed assets/icon.ico
var trayIcon []byte

const (
	noWindow = 0x08000000
	idOK     = 1
	runKey   = `Software\Microsoft\Windows\CurrentVersion\Run`
)

// not %LOCALAPPDATA%\Phosphorus: the app's own install dir, wiped by its uninstaller
func homeDir() string {
	if h := os.Getenv("PHOSPHORUS_HOME"); h != "" {
		return h
	}
	return filepath.Join(os.Getenv("USERPROFILE"), "phosphorus")
}

func exeDir() string {
	exe, _ := os.Executable()
	return filepath.Dir(exe)
}

func hostBin() string { return filepath.Join(exeDir(), "phosphorus-host.exe") }

func payloadDir() string { return filepath.Join(exeDir(), "release") }

// where this app runs from, for the service updating it with no one signed in
func noteAppDir() {
	os.MkdirAll(filepath.Join(a.home, "state"), 0o755)
	os.WriteFile(filepath.Join(a.home, "state", "app-dir"), []byte(exeDir()+"\n"), 0o644)
}

func setIcon() { systray.SetIcon(trayIcon) }

func quiet(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: noWindow}
}

// one tray per user: a named mutex, held while this runs
func singleInstance() bool {
	name, _ := windows.UTF16PtrFromString(`Local\PhosphorusTray`)
	_, err := windows.CreateMutex(nil, false, name)
	return err != windows.ERROR_ALREADY_EXISTS
}

func box(text string, flags uint32) int32 {
	t, _ := windows.UTF16PtrFromString(text)
	c, _ := windows.UTF16PtrFromString("Phosphorus")
	r, _ := windows.MessageBox(0, t, c, flags|windows.MB_SETFOREGROUND|windows.MB_TOPMOST)
	return r
}

func notify(text string) { box(text, windows.MB_OK|windows.MB_ICONINFORMATION) }

func alert(text string) { box(text, windows.MB_OK|windows.MB_ICONERROR) }

// Windows' own buttons: OK for yes, Cancel for no
func confirm(text, _, _ string) bool {
	return box(text, windows.MB_OKCANCEL|windows.MB_ICONWARNING|windows.MB_DEFBUTTON2) == idOK
}

func openURL(u string) {
	c := exec.Command("rundll32", "url.dll,FileProtocolHandler", u)
	quiet(c)
	c.Start()
}

// raised by the binary itself
func adminSetup() {}

func asAdmin(...string) {}

// the login item: this app at login, its tray alone
func setAutostart(on bool) {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return
	}
	defer k.Close()
	if !on {
		k.DeleteValue("Phosphorus")
		return
	}
	exe, _ := os.Executable()
	k.SetStringValue("Phosphorus", `"`+exe+`" --background`)
}

// the installer's uninstaller run once this process is gone
func removeApp() {
	un := filepath.Join(exeDir(), "uninstall.exe")
	if _, err := os.Stat(un); err != nil {
		return
	}
	c := exec.Command("cmd", "/c", "timeout", "/t", "2", "/nobreak", ">nul", "&", un, "/S")
	quiet(c)
	c.Start()
}

// the release's setup run silently once this process is gone; it starts the new app
func installDownloaded(f string) error {
	c := exec.Command("cmd", "/c", "timeout", "/t", "2", "/nobreak", ">nul", "&", f, "/S", "/R")
	quiet(c)
	return c.Start()
}
