package host

import (
	"os"
	"os/user"
	"path/filepath"
	"strings"
)

// uninstall everything this host added, its home last: the service, the admin
// setup behind its own prompt, PATH, the play/stop key; Linux's the package purged
func uninstall(opts []string) error {
	for _, o := range opts {
		if o == "--admin" {
			if !isAdmin() {
				return fail("uninstall --admin needs root or an elevated shell")
			}
			return uninstallAdmin()
		}
	}
	if isLinux {
		return purgeLinux()
	}
	if !fileExists(at(".phosphorus-installed")) && !fileExists(envPath()) {
		return fail("%s isn't a phosphorus home", home)
	}
	say("stopping phosphorus...")
	svcStop()
	svcRemove()
	unauthorizeGame()
	unpath()
	if isAdmin() {
		uninstallAdmin()
	} else {
		elevateUninstall()
	}
	if err := os.RemoveAll(home); err != nil {
		return fail("couldn't remove %s: %v", home, err)
	}
	say("removed %s", home)
	return nil
}

// purgeLinux the package's own scripts: units stopped, links, git account and
// /var/lib/phosphorus gone; in a unit of its own, outliving phosphorus's terminals
func purgeLinux() error {
	say("purging the phosphorus package...")
	if fileExists("/run/systemd/system") {
		return run("systemd-run", "--quiet", "--collect", "--wait", "--unit", "phosphorus-uninstall", "apt-get", "purge", "-y", "phosphorus")
	}
	return run("apt-get", "purge", "-y", "phosphorus")
}

// unauthorizeGame the play/stop key's line out of authorized_keys
func unauthorizeGame() {
	u, err := user.Current()
	if err != nil {
		return
	}
	ak := filepath.Join(u.HomeDir, ".ssh", "authorized_keys")
	b, err := os.ReadFile(ak)
	if err != nil || !strings.Contains(string(b), gameTag) {
		return
	}
	kept := []string{}
	for _, l := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
		if !strings.Contains(l, gameTag) {
			kept = append(kept, l)
		}
	}
	os.WriteFile(ak, []byte(strings.Join(kept, "\n")+"\n"), 0o600)
}
