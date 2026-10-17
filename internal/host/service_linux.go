package host

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

const (
	unit   = "phosphorus.service"
	tsUnit = "phosphorus-tailscaled.service"
)

// runDir the git daemon's and elector's shared files, systemd's RuntimeDirectory
const runDir = "/run/phosphorus"

// libexec the package's bundled tools
func libexec() string { return "/usr/libexec/phosphorus" }

func logHint() string { return "journalctl -u phosphorus" }

// --- systemd, the units shipped by the package --------------------------------------

func unitActive(u string) bool { return quiet("systemctl", "is-active", "--quiet", u) }

func svcInstall() error {
	if !fileExists("/run/systemd/system") {
		return fail("phosphorus runs under systemd on Linux, and this machine has none")
	}
	run("systemctl", "daemon-reload")
	quiet("systemctl", "enable", unit)
	return nil
}

func svcActive() bool { return unitActive(unit) }

func svcStart() error { return run("systemctl", "start", unit) }

// svcStop git handing off first, kept off through reboots
func svcStop() error { return run("systemctl", "disable", "--now", unit) }

func svcRestart(noBlock bool) error {
	quiet("systemctl", "enable", unit)
	if noBlock {
		return run("systemctl", "--no-block", "restart", unit)
	}
	return run("systemctl", "restart", unit)
}

func svcSince() string {
	return output("systemctl", "show", "-p", "ActiveEnterTimestampMonotonic", "--value", unit)
}

// --- tailscale: the machine's own tailscaled, else the bundled one ---------------------

func systemTailscale() bool { return unitActive("tailscaled.service") }

func tailscaleDirs() []string { return nil }

func tailscaleCLI() string {
	if systemTailscale() {
		return "tailscale"
	}
	return tool("tailscale")
}

// tailscaleInstalled the package's own tailscaled, nothing for setup to fetch
func tailscaleInstalled() bool { return true }

func tailscaleInstall() error { return nil }

func tailscaleKeepUp() {}

func tailscaleReady() error {
	if !systemTailscale() && !fileExists(tool("tailscaled")) {
		return fail("no tailscaled here: reinstall the phosphorus package")
	}
	return nil
}

// tailscaleStart the bundled tailscaled, its CLI on PATH when the machine has none
func tailscaleStart() error {
	if systemTailscale() {
		if unitActive(tsUnit) {
			quiet("systemctl", "disable", "--now", tsUnit)
		}
		return nil
	}
	os.MkdirAll(at("tailscale"), 0o700)
	if err := run("systemctl", "enable", "--now", tsUnit); err != nil {
		return fail("couldn't start tailscaled")
	}
	if !has("tailscale") {
		os.Symlink(tool("tailscale"), "/usr/local/bin/tailscale")
	}
	for i := 0; i < 60; i++ {
		if quiet(tool("tailscale"), "status", "--json") {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return nil
}

// --- distro packages ------------------------------------------------------------------

type dep struct{ bin, lib, pkg string }

// missingDeps the distro packages this host's roles need and lack
func missingDeps() []string {
	want := []dep{{bin: "ss", pkg: "iproute2"}, {bin: "ssh", pkg: "openssh-client"}, {bin: "setpriv", pkg: "util-linux"}}
	if isGitHost() {
		want = append(want, dep{bin: "git", pkg: "git"}, dep{bin: "rsync", pkg: "rsync"}, dep{bin: "sqlite3", pkg: "sqlite3"})
	}
	if isModelHost() {
		want = append(want, dep{bin: "curl", pkg: "curl"}, dep{bin: "git", pkg: "git"}, dep{bin: "rg", pkg: "ripgrep"},
			dep{lib: "libgomp.so.1", pkg: "libgomp1"})
	}
	libs := ""
	out, seen := []string{}, map[string]bool{}
	for _, d := range want {
		ok := false
		if d.bin != "" {
			ok = has(d.bin)
		} else {
			if libs == "" {
				libs = output("ldconfig", "-p")
			}
			ok = strings.Contains(libs, d.lib)
		}
		if !ok && !seen[d.pkg] {
			seen[d.pkg] = true
			out = append(out, d.pkg)
		}
	}
	return out
}

// aptInstall from the distro's own sources, waiting out a running dpkg
func aptInstall(pkgs []string) error {
	if !has("apt-get") {
		return fail("missing %s and no apt-get: install them, then phos start", strings.Join(pkgs, ", "))
	}
	say("installing %s...", strings.Join(pkgs, ", "))
	args := append([]string{"-q", "-y", "--no-install-recommends", "-o", "DPkg::Lock::Timeout=900", "install"}, pkgs...)
	try := func() error {
		c := exec.Command("apt-get", args...)
		c.Env = append(os.Environ(), "DEBIAN_FRONTEND=noninteractive")
		c.Stdout, c.Stderr = os.Stdout, os.Stderr
		return c.Run()
	}
	if try() == nil {
		return nil
	}
	// lists missing on a fresh image, or stale
	run("apt-get", "-q", "-o", "DPkg::Lock::Timeout=900", "update")
	if err := try(); err != nil {
		return fail("couldn't install %s", strings.Join(pkgs, ", "))
	}
	return nil
}

// deferRebuild the rest once dpkg lets go: apt can't run inside a package's own script
func deferRebuild() error {
	name := fmt.Sprintf("phosphorus-rebuild-%d", time.Now().Unix())
	if err := run("systemd-run", "--unit="+name, "--collect", "--no-block", "--description=Phosphorus rebuild",
		"--setenv=PHOSPHORUS_HOME="+home, binPath("phosphorus"), "rebuild", "--home", home); err != nil {
		return fail("couldn't hand the rebuild to systemd: %v", err)
	}
	say("finishing once the package manager is done, follow it with: journalctl -fu %s", name)
	return nil
}

// --- git: forgejo's account and paths ---------------------------------------------------

// gitEnv the git daemon's and elector's paths
func gitEnv() map[string]string {
	return map[string]string{
		"DATA_ROOT": at("git"), "GIT_USER": gitUser, "GIT_GROUP": gitUser,
		"FORGEJO_BIN": tool("forgejo"), "ELECTOR": binPath("phosphorus") + " elector",
		"APP_INI_TMPL": at("gitd", "app.ini.tmpl"), "RSYNCD_CONF_TMPL": at("gitd", "rsyncd.conf"),
		"RSYNCD_CONF": runDir + "/rsyncd.conf", "RSYNCD_PID": runDir + "/rsyncd.pid",
		"LOCAL_FILE": runDir + "/git-local", "DECISION_FILE": runDir + "/git-decision",
		"LEASE_UNTIL_FILE": runDir + "/git-lease-until", "FORGEJO_PID_FILE": runDir + "/git-forgejo-pid",
		"PROMOTING_FILE": runDir + "/git-promoting",
	}
}

// ensureGitUser forgejo's account, a system user of its own
func ensureGitUser() error {
	if quiet("getent", "passwd", gitUser) {
		return nil
	}
	if err := run("useradd", "--system", "--user-group", "-d", at("git"), "-M", "-s", "/usr/sbin/nologin", gitUser); err != nil {
		return fail("couldn't add the %s user", gitUser)
	}
	return nil
}

func svcRemove() {}
