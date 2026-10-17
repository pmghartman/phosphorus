package host

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

func init() {
	// Finder's PATH: no homebrew tools
	os.Setenv("PATH", "/opt/homebrew/bin:/usr/local/bin:"+os.Getenv("PATH"))
}

const sshdName = "Remote Login (ssh)"

func enableSSHD() error {
	if run("systemsetup", "-setremotelogin", "on") != nil {
		// systemsetup without Full Disk Access on newer macOS
		return run("launchctl", "load", "-w", "/System/Library/LaunchDaemons/ssh.plist")
	}
	return nil
}

// --- launchd: a LaunchAgent of the account the app runs as --------------------------------

const label = "dev.phosphorus.host"

// libexec the app's bundled tools, synced into the home with the release
func libexec() string { return at("tools") }

func logHint() string { return at("state", "phosphorus.log") }

func plistPath() string {
	h, _ := os.UserHomeDir()
	return filepath.Join(h, "Library", "LaunchAgents", label+".plist")
}

func domain() string { return "gui/" + strconv.Itoa(os.Getuid()) }

func xmlEsc(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

func svcInstall() error {
	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>%s</string>
	<key>ProgramArguments</key>
	<array><string>%s</string><string>run</string><string>--home</string><string>%s</string></array>
	<key>EnvironmentVariables</key>
	<dict><key>PHOSPHORUS_HOME</key><string>%s</string></dict>
	<key>WorkingDirectory</key><string>%s</string>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>5</integer>
	<key>ExitTimeOut</key><integer>150</integer>
	<key>ProcessType</key><string>Interactive</string>
	<key>StandardOutPath</key><string>%s</string>
	<key>StandardErrorPath</key><string>%s</string>
</dict>
</plist>
`, label, xmlEsc(binPath("phosphorus")), xmlEsc(home), xmlEsc(home), xmlEsc(home), xmlEsc(logHint()), xmlEsc(logHint()))
	if b, _ := os.ReadFile(plistPath()); string(b) == plist {
		return nil
	}
	os.MkdirAll(filepath.Dir(plistPath()), 0o755)
	if err := os.WriteFile(plistPath(), []byte(plist), 0o644); err != nil {
		return fail("couldn't write %s: %v", plistPath(), err)
	}
	// a loaded job keeps its old plist until booted out
	if svcActive() {
		quiet("launchctl", "bootout", domain()+"/"+label)
	}
	return nil
}

var pidRe = regexp.MustCompile(`(?m)^\s*pid = (\d+)`)

func svcActive() bool { return pidRe.MatchString(output("launchctl", "print", domain()+"/"+label)) }

func svcSince() string {
	if m := pidRe.FindStringSubmatch(output("launchctl", "print", domain()+"/"+label)); m != nil {
		return m[1]
	}
	return ""
}

func svcStart() error {
	quiet("launchctl", "enable", domain()+"/"+label)
	quiet("launchctl", "bootstrap", domain(), plistPath())
	return run("launchctl", "kickstart", domain()+"/"+label)
}

// svcStop TERM to run, which stops its children in order; kept off through logins
func svcStop() error {
	quiet("launchctl", "disable", domain()+"/"+label)
	quiet("launchctl", "bootout", domain()+"/"+label)
	return nil
}

func svcRestart(noBlock bool) error {
	quiet("launchctl", "enable", domain()+"/"+label)
	if !svcActive() {
		return svcStart()
	}
	if noBlock {
		c := exec.Command("launchctl", "kickstart", "-k", domain()+"/"+label)
		return c.Start()
	}
	return run("launchctl", "kickstart", "-k", domain()+"/"+label)
}

// --- tailscale: the Tailscale app's own node ---------------------------------------------

var appCLI = []string{"/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"}

func tailscaleDirs() []string { return nil }

func tailscaleCLI() string { return tool("tailscale") }

func appTailscale() string {
	for _, c := range appCLI {
		if fileExists(c) {
			return c
		}
	}
	return ""
}

func tailscaleInstalled() bool { return appTailscale() != "" }

func tailscalePkg() (string, string) {
	return "Tailscale-" + tailscaleVersion + "-macos.pkg", "67ec55f18ee2afac0a8fb57f7811977f4ad6df1debd4a187fa0db3dbb5d401d5"
}

func tailscaleRunInstaller(pkg string) error { return run("installer", "-pkg", pkg, "-target", "/") }

// tailscaleLaunch the app, in the background: its daemon lives in it
func tailscaleLaunch() {
	if !quiet("open", "-g", "-a", "Tailscale") {
		quiet("open", "-g", "/Applications/Tailscale.app")
	}
}

// tailscaleReady the app's CLI linked into the tools as tailscale, logged in with TS_AUTHKEY when it isn't
func tailscaleReady() error {
	cli := appTailscale()
	if cli == "" {
		return fail("no Tailscale here: install the Tailscale app (tailscale.com/download), then phos start")
	}
	os.MkdirAll(libexec(), 0o755)
	if t, _ := os.Readlink(tool("tailscale")); t != cli {
		os.Remove(tool("tailscale"))
		if err := os.Symlink(cli, tool("tailscale")); err != nil {
			return err
		}
	}
	return tailscaleLogin()
}

func tailscaleStart() error { return nil }

// --- no distro packages, no git host ------------------------------------------------------

func missingDeps() []string     { return nil }
func aptInstall([]string) error { return nil }
func deferRebuild() error       { return nil }
func gitEnv() map[string]string { return nil }
func ensureGitUser() error      { return nil }

func svcRemove() { os.Remove(plistPath()) }
