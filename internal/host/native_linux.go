package host

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/pmghartman/phosphorus/internal/envfile"
)

// the package's bundled tools: tailscale, tailscaled, cloudflared, forgejo
const libexec = "/usr/libexec/phosphorus"

const (
	unit       = "phosphorus.service"
	tsUnit     = "phosphorus-tailscaled.service"
	gitUser    = "phosphorus-git"
	runDir     = "/run/phosphorus"
	frontendUp = "http://127.0.0.1:8090/"
)

// native this machine running phosphorus under systemd, no containers
func native() bool { return isLinux && !inContainer }

func nativeEnvFile() string { return at("state", "native.env") }

// --- the baked env ------------------------------------------------------------

// bakeEnv what the containers' compose env and mounts were, as real paths,
// rewritten by every rebuild and read by run
func bakeEnv(homeDir string) map[string]string {
	files := at("files")
	m := map[string]string{
		"PHOSPHORUS_NATIVE": "1", "PHOSPHORUS_HOME": home, "PHOSPHORUS_REPO_DIR": home,
		"STATE_DIR": at("state"), "SERVICES_FILE": at("config", "services.export"),
		"PHOSPHORUS_INI_FILE": iniFile(), "PHOSPHORUS_CONFIG_DIR": at("config"), "PHOSPHORUS_ENV_FILE": envPath(),
		"VERSION_FILE": at("VERSION"), "REBUILD_CMD": binPath("phosphorus"),
		"FILES_ROOT": files, "PHOSPHORUS_FILES_DIR": files, "OPENCODE_DIR": files,
		"HOME_FS": homeDir, "PHOSPHORUS_HOME_DIR": homeDir,
		"PHOSPHORUS_HOST_ROOT": "/", "MODEL_DIR": at("state", "models"),
		"HOST_SSH_HOST": "127.0.0.1",
		// the git daemon and its elector
		"DATA_ROOT": at("git"), "GIT_USER": gitUser, "GIT_GROUP": gitUser,
		"FORGEJO_BIN": filepath.Join(libexec, "forgejo"), "ELECTOR": binPath("phosphorus") + " elector",
		"APP_INI_TMPL": at("container", "git", "app.ini.tmpl"), "RSYNCD_CONF_TMPL": at("container", "git", "rsyncd.conf"),
		"RSYNCD_CONF": runDir + "/rsyncd.conf", "RSYNCD_PID": runDir + "/rsyncd.pid",
		"LEGACY_DB":  at("git", "litefs-internal", "dbs", "forgejo.db", "database"),
		"LOCAL_FILE": runDir + "/git-local", "DECISION_FILE": runDir + "/git-decision",
		"LEASE_UNTIL_FILE": runDir + "/git-lease-until", "FORGEJO_PID_FILE": runDir + "/git-forgejo-pid",
		"PROMOTING_FILE": runDir + "/git-promoting",
	}
	if t := os.Getenv("TS_HOSTNAME"); t != "" {
		m["TS_HOSTNAME"] = t
	}
	dirs, perms := []string{}, []string{}
	ps := splitComma(iniGet("files", "priv"))
	for i, d := range splitComma(iniGet("files", "dir")) {
		if d = strings.TrimRight(d, "/"); d == "" {
			continue
		}
		abs := absTo(home, d)
		if !fileExists(abs) {
			fmt.Fprintf(os.Stderr, "[files] skipping '%s'; no such directory on this host\n", d)
			continue
		}
		p := "rwd"
		if i < len(ps) && ps[i] != "" {
			p = ps[i]
		}
		dirs, perms = append(dirs, abs), append(perms, p)
	}
	if len(dirs) > 0 {
		m["PHOSPHORUS_FILES_DIRS"] = strings.Join(dirs, ",")
		m["PHOSPHORUS_FILES_PERMS"] = strings.Join(perms, ",")
	}
	return m
}

func splitComma(v string) []string {
	out := []string{}
	for _, x := range strings.Split(v, ",") {
		out = append(out, strings.TrimSpace(x))
	}
	return out
}

func writeEnvFile(file string, m map[string]string) error {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	b := strings.Builder{}
	b.WriteString("# baked by phosphorus rebuild, read by phosphorus run\n")
	for _, k := range keys {
		b.WriteString(k + "=" + m[k] + "\n")
	}
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, []byte(b.String()), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

func readEnvFile(file string) map[string]string {
	m := map[string]string{}
	b, _ := os.ReadFile(file)
	for _, l := range strings.Split(string(b), "\n") {
		if l = strings.TrimSpace(l); l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		if k, v, ok := strings.Cut(l, "="); ok {
			m[k] = v
		}
	}
	return m
}

// runEnv the baked env and .env over this process's, PATH with the bundled tools
func runEnv() []string {
	m := readEnvFile(nativeEnvFile())
	for k, v := range envfile.Read(envPath()) {
		if v != "" {
			m[k] = v
		}
	}
	out := []string{}
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if _, over := m[k]; !over {
			out = append(out, kv)
		}
	}
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	return withPath(out)
}

func withPath(env []string) []string {
	for i, kv := range env {
		if strings.HasPrefix(kv, "PATH=") {
			env[i] = "PATH=" + libexec + ":" + strings.TrimPrefix(kv, "PATH=")
			return env
		}
	}
	return append(env, "PATH="+libexec+":/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
}

// --- systemd ------------------------------------------------------------------

func hasSystemd() bool { return fileExists("/run/systemd/system") }

func unitActive(u string) bool { return quiet("systemctl", "is-active", "--quiet", u) }

func nativeUp() bool { return unitActive(unit) }

// inService a child of phosphorus.service, whose restart would kill it first
func inService() bool { return os.Getenv("PHOSPHORUS_ROLE") != "" }

func activeSince() string {
	return output("systemctl", "show", "-p", "ActiveEnterTimestampMonotonic", "--value", unit)
}

// systemTailscale a tailscaled of the machine's own, adopted as it is
func systemTailscale() bool { return unitActive("tailscaled.service") }

// --- dependencies ---------------------------------------------------------------

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

// --- the git account and layout -----------------------------------------------------

// ensureGitUser forgejo's account, the image's ids where they're free
func ensureGitUser() error {
	if quiet("getent", "passwd", gitUser) {
		return nil
	}
	if !quiet("getent", "group", gitUser) {
		a := []string{"--system"}
		if !quiet("getent", "group", "4000") {
			a = append(a, "-g", "4000")
		}
		if err := run("groupadd", append(a, gitUser)...); err != nil {
			return fail("couldn't add the %s group", gitUser)
		}
	}
	a := []string{"--system", "-g", gitUser, "-d", at("git"), "-M", "-s", "/usr/sbin/nologin"}
	if !quiet("getent", "passwd", "4001") {
		a = append(a, "-u", "4001")
	}
	if err := run("useradd", append(a, gitUser)...); err != nil {
		return fail("couldn't add the %s user", gitUser)
	}
	return nil
}

// moveEntries every entry of from into to, rename only, to made first
func moveEntries(from, to string, skip string) error {
	ents, err := os.ReadDir(from)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(to, 0o755); err != nil {
		return err
	}
	for _, e := range ents {
		if e.Name() == skip {
			continue
		}
		if err := os.Rename(filepath.Join(from, e.Name()), filepath.Join(to, e.Name())); err != nil {
			return err
		}
	}
	return nil
}

// gitUp git/data's contents to git/, the image's data root at the same path
func gitUp() error {
	from := at("git", "data")
	if !fileExists(from) {
		return nil
	}
	say("moving git data from git/data to git/")
	if err := moveEntries(from, at("git"), ""); err != nil {
		return fail("couldn't move git data: %v", err)
	}
	return os.Remove(from)
}

// gitDown the containers' layout back, for a rollback
func gitDown() {
	if fileExists(at("git")) && !fileExists(at("git", "data")) {
		moveEntries(at("git"), at("git", "data"), "data")
	}
}

// --- the containers this release replaces -----------------------------------------------

var oldContainers = []string{"phosphorus-git", "phosphorus-model", "phosphorus"}

// dockerEra the containers of a release before this one, still here; an
// idle docker started first, or its restart policy would bring them back later
func dockerEra() bool {
	if !has("docker") {
		return false
	}
	if !dockerUp() && quiet("systemctl", "cat", "docker.service") {
		say("starting docker to find the old containers...")
		quiet("systemctl", "start", "docker.service")
		for i := 0; i < 30 && !dockerUp(); i++ {
			time.Sleep(2 * time.Second)
		}
	}
	if !dockerUp() {
		return false
	}
	for _, c := range append(oldContainers, "phosphorus-search") {
		if containerExists(c) {
			return true
		}
	}
	return false
}

func mountOf(container, dest string) string {
	return dockerOut("inspect", container, "--format", `{{range .Mounts}}{{if eq .Destination "`+dest+`"}}{{.Source}}{{end}}{{end}}`)
}

// notifyUpdating the elector told before the frontend goes, best effort
func notifyUpdating() {
	c := &http.Client{Timeout: 3 * time.Second}
	if r, err := c.Post("http://127.0.0.1:8090/internal/status/updating", "application/json", strings.NewReader("{}")); err == nil {
		r.Body.Close()
	}
}

// stopContainers git first for its hand-off, none restarted by docker after
func stopContainers() {
	for _, c := range oldContainers {
		if !containerExists(c) {
			continue
		}
		dockerQuiet("update", "--restart=no", c)
		if isRunning(c) {
			say("stopping %s...", c)
			dockerQuiet("stop", "-t", "30", c)
		}
	}
}

func startContainers() {
	for i := len(oldContainers) - 1; i >= 0; i-- {
		c := oldContainers[i]
		if containerExists(c) {
			dockerQuiet("update", "--restart=unless-stopped", c)
			dockerQuiet("start", c)
		}
	}
}

// tsStateFrom the container's tailnet identity, copied (never moved) so a
// rollback finds it, the same node, IP and name natively
func tsStateFrom() error {
	dst := at("tailscale", "tailscaled.state")
	if fileExists(dst) {
		return nil
	}
	mp := dockerOut("volume", "inspect", "phosphorus_tailscale-state", "--format", "{{.Mountpoint}}")
	src := filepath.Join(mp, "tailscaled.state")
	if mp == "" || !fileExists(src) {
		say("no tailnet identity in the old container, joining as a new node with TS_AUTHKEY")
		return nil
	}
	os.MkdirAll(filepath.Dir(dst), 0o700)
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	say("carrying the tailnet identity over from the container")
	return os.WriteFile(dst, b, 0o600)
}

var (
	ourImage    = regexp.MustCompile(`^(phosphorus(-model|-git)?|` + regexp.QuoteMeta(registry) + `/phosphorus(-model|-git)?|(docker\.io/)?searxng/searxng|[^ ]*hesperus[^/: ]*):`)
	sandboxRule = regexp.MustCompile(`^-A (DOCKER-USER .*-i phosphorus-sandbox0 .*)$`)
)

// cleanupDocker everything earlier releases left in docker: containers,
// images, volumes, networks and the sandbox fence's rules; docker itself kept
func cleanupDocker() {
	if !has("docker") || !dockerUp() {
		return
	}
	gone := map[string]bool{}
	ids := []string{}
	for _, c := range []string{"phosphorus", "phosphorus-git", "phosphorus-model", "phosphorus-search", "phosphorus-updater"} {
		if containerExists(c) {
			ids = append(ids, c)
		}
	}
	for _, f := range []string{"label=org.phosphorus", "label=org.phosphorus.sandbox", "name=^phosphorus-sandbox-"} {
		for _, id := range strings.Fields(dockerOut("ps", "-aq", "--filter", f)) {
			ids = append(ids, id)
		}
	}
	for _, id := range ids {
		if !gone[id] && dockerQuiet("rm", "-f", id) {
			gone[id] = true
			say("removed container %s", id)
		}
	}
	for _, l := range strings.Split(dockerOut("images", "--format", "{{.Repository}}:{{.Tag}} {{.ID}}"), "\n") {
		f := strings.Fields(l)
		if len(f) == 2 && ourImage.MatchString(f[0]) && dockerQuiet("rmi", "-f", f[0]) {
			say("removed image %s", f[0])
		}
	}
	for _, v := range []string{"phosphorus_tailscale-state", "phosphorus-git-data", "phosphorus-git-db", "phosphorus-models"} {
		// the tailnet identity only once carried over, or the machine's own in use
		if v == "phosphorus_tailscale-state" && !fileExists(at("tailscale", "tailscaled.state")) && !systemTailscale() {
			continue
		}
		if dockerQuiet("volume", "inspect", v) && dockerQuiet("volume", "rm", v) {
			say("removed volume %s", v)
		}
	}
	for _, n := range []string{"phosphorus_default", "phosphorus-sandbox"} {
		if dockerQuiet("network", "inspect", n) && dockerQuiet("network", "rm", n) {
			say("removed network %s", n)
		}
	}
	for _, bin := range []string{"iptables", "ip6tables"} {
		if !has(bin) {
			continue
		}
		for _, l := range strings.Split(output(bin, "-S", "DOCKER-USER"), "\n") {
			if m := sandboxRule.FindStringSubmatch(strings.TrimSpace(l)); m != nil {
				quiet(bin, append([]string{"-D"}, strings.Fields(m[1])...)...)
			}
		}
	}
	os.Remove(at(filepath.FromSlash(filesOverride)))
}

// cleanupLitefs litefs's store and mount point, once the git daemon has the db off it
func cleanupLitefs() {
	if st, err := os.Stat(at("git", "db", "forgejo.db")); err != nil || st.Size() == 0 {
		return
	}
	if fileExists(at("git", "litefs-internal")) {
		os.RemoveAll(at("git", "litefs-internal"))
		say("removed litefs's old db store")
	}
	os.Remove(at("git", "litefs"))
}

// --- rebuild --------------------------------------------------------------------------

// signature what the running service was started on, an unchanged one no restart
func signature(env map[string]string) string {
	h := sha256.New()
	fmt.Fprintln(h, version(), isGitHost(), isModelHost())
	if st, err := os.Stat(binPath("phosphorus")); err == nil {
		fmt.Fprintln(h, st.Size(), st.ModTime().UnixNano())
	}
	b, _ := json.Marshal(env)
	h.Write(b)
	return hex.EncodeToString(h.Sum(nil))
}

func waitFrontend(d time.Duration) bool {
	c := &http.Client{Timeout: 2 * time.Second}
	for end := time.Now().Add(d); time.Now().Before(end); time.Sleep(time.Second) {
		if r, err := c.Get(frontendUp); err == nil {
			r.Body.Close()
			return true
		}
	}
	return false
}

// nativeRebuild the release's config baked and the service (re)started on it;
// the first run after the containers moves their state over, rolling back on failure
func nativeRebuild() error {
	tag = "rebuild"
	if err := os.Chdir(home); err != nil {
		return err
	}
	lockEnv()
	addMissingSections()
	if !hasSystemd() {
		return fail("phosphorus runs under systemd on Linux, and this machine has none")
	}
	if missing := missingDeps(); len(missing) > 0 {
		if inDpkg() {
			return deferRebuild()
		}
		if err := aptInstall(missing); err != nil {
			return err
		}
	}
	if isGitHost() {
		if err := ensureGitUser(); err != nil {
			return err
		}
	} else {
		// git/ only on a git host, its empty folders gone elsewhere
		os.Remove(at("git", "data"))
		os.Remove(at("git"))
	}
	os.MkdirAll(at("files"), 0o755)
	os.MkdirAll(at("state"), 0o755)

	migrating := dockerEra()
	homeTo := at("files")
	if d := iniGet("home", "dir"); d != "" {
		homeTo = absTo(home, d)
		os.MkdirAll(homeTo, 0o755)
	}
	homeFrom := readTrim(at("state", "native-home"))
	if migrating {
		// the containers' own, any [home] move left to the next rebuild
		if h := mountOf("phosphorus", "/homefs"); h != "" {
			homeTo, homeFrom = h, ""
		}
	}
	if homeFrom == homeTo {
		homeFrom = ""
	}
	if homeFrom != "" && strings.HasPrefix(homeTo+"/", homeFrom+"/home/") {
		return fail("[home] dir can't be inside the folders it moves")
	}
	env := bakeEnv(homeTo)
	sig := signature(env)
	up := nativeUp()
	if up && !migrating && homeFrom == "" && readTrim(at("state", "native-sig")) == sig {
		say("already up to date, nothing to restart")
		return nil
	}

	ours := !systemTailscale()
	if migrating {
		say("moving phosphorus out of docker")
		notifyUpdating()
		stopContainers()
		if ours {
			if err := tsStateFrom(); err != nil {
				startContainers()
				return fail("couldn't copy the tailnet identity, containers left running: %v", err)
			}
		}
	} else if up && homeFrom != "" {
		notifyUpdating()
		run("systemctl", "stop", unit)
		up = false
	}
	if migrating {
		// the containers' forgejo config, for a rollback after native git rewrote it
		if b, err := os.ReadFile(at("git", "data", "conf", "app.ini")); err == nil {
			os.WriteFile(at("state", "app.ini.docker"), b, 0o600)
		}
	}
	if err := gitUp(); err != nil {
		if migrating {
			startContainers()
		}
		return err
	}
	if homeFrom != "" {
		say("moving home/ from %s to %s", homeFrom, homeTo)
		if err := moveHome(homeFrom, homeTo); err != nil {
			say("couldn't move the homes (%v), keeping them in %s", err, homeFrom)
			homeTo = homeFrom
			env = bakeEnv(homeTo)
			sig = signature(env)
		}
	}
	if err := writeEnvFile(nativeEnvFile(), env); err != nil {
		return err
	}
	os.WriteFile(at("state", "native-home"), []byte(homeTo+"\n"), 0o644)

	run("systemctl", "daemon-reload")
	if ours {
		if err := startTailscale(); err != nil {
			return rollback(migrating, err)
		}
	} else if unitActive(tsUnit) {
		quiet("systemctl", "disable", "--now", tsUnit)
	}
	quiet("systemctl", "enable", unit)
	switch {
	case up && inService():
		notifyUpdating()
		os.WriteFile(at("state", "native-sig"), []byte(sig+"\n"), 0o644)
		say("restarting phosphorus")
		return run("systemctl", "--no-block", "restart", unit)
	case up:
		notifyUpdating()
		say("restarting phosphorus")
		if err := run("systemctl", "restart", unit); err != nil {
			return fail("couldn't restart phosphorus")
		}
	default:
		say("starting phosphorus")
		if err := run("systemctl", "start", unit); err != nil {
			return rollback(migrating, fail("couldn't start phosphorus"))
		}
	}
	if !waitFrontend(3 * time.Minute) {
		return rollback(migrating, fail("the frontend never came up, see: journalctl -u phosphorus"))
	}
	os.WriteFile(at("state", "native-sig"), []byte(sig+"\n"), 0o644)
	cleanupDocker()
	cleanupLitefs()
	os.Remove(at("state", "app.ini.docker"))
	if migrating {
		say("phosphorus is out of docker, the old containers, images and volumes removed")
	}
	return nil
}

// rollback the containers back where the migration found them
func rollback(migrating bool, err error) error {
	if !migrating {
		return err
	}
	say("rolling back to the containers")
	quiet("systemctl", "disable", "--now", unit)
	quiet("systemctl", "disable", "--now", tsUnit)
	gitDown()
	if b, e := os.ReadFile(at("state", "app.ini.docker")); e == nil && fileExists(at("git", "data", "conf")) {
		os.WriteFile(at("git", "data", "conf", "app.ini"), b, 0o644)
		os.Chown(at("git", "data", "conf", "app.ini"), 4001, 4000)
	}
	os.Remove(at("git", "data", "obj", ".phosphorus-hooks"))
	// a retry copies the identity fresh
	os.RemoveAll(at("tailscale"))
	os.Remove(at("state", "native-sig"))
	startContainers()
	// hooks back on the image's forgejo, native git having rewritten them
	if containerExists("phosphorus-git") {
		dockerQuiet("exec", "-u", "git", "phosphorus-git", "sh", "-c",
			"HOME=/var/lib/phosphorus/git forgejo -w /var/lib/phosphorus/git -c /var/lib/phosphorus/git/conf/app.ini admin regenerate hooks")
	}
	return fail("%v; the containers are running again", err)
}

// startTailscale the bundled tailscaled, its CLI on PATH when the machine has none
func startTailscale() error {
	os.MkdirAll(at("tailscale"), 0o700)
	if err := run("systemctl", "enable", "--now", tsUnit); err != nil {
		return fail("couldn't start tailscaled")
	}
	if !has("tailscale") {
		os.Symlink(filepath.Join(libexec, "tailscale"), "/usr/local/bin/tailscale")
	}
	for i := 0; i < 60; i++ {
		if quiet(filepath.Join(libexec, "tailscale"), "status", "--json") {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return nil
}

// moveHome home/ copied whole, only then the old one deleted
func moveHome(from, to string) error {
	if !fileExists(filepath.Join(from, "home")) {
		return nil
	}
	os.MkdirAll(filepath.Join(to, "home"), 0o755)
	if err := run("cp", "-a", filepath.Join(from, "home")+"/.", filepath.Join(to, "home")+"/"); err != nil {
		return err
	}
	return os.RemoveAll(filepath.Join(from, "home"))
}

// --- start, stop, the cli ------------------------------------------------------------

func nativeStop() error {
	if !nativeUp() {
		fmt.Println("phosphorus isn't running")
		return nil
	}
	fmt.Println("stopping phosphorus (git hands off first)...")
	if err := run("systemctl", "disable", "--now", unit); err != nil {
		return fail("couldn't stop phosphorus")
	}
	fmt.Println("phosphorus stopped, phos start to resume")
	return nil
}

func nativeRestart() error {
	fmt.Println("restarting phosphorus...")
	if err := run("systemctl", "restart", unit); err != nil {
		return fail("couldn't restart phosphorus")
	}
	fmt.Println("phosphorus restarted")
	return nil
}

// nativeAttach the cli on the running service's env, reattached across a restart
func nativeAttach(args []string) error {
	for {
		before := activeSince()
		if !nativeUp() {
			return fail("phosphorus isn't running, run: phos start")
		}
		c := exec.Command(binPath("phosphorus"), append([]string{"cli"}, args...)...)
		c.Env = runEnv()
		c.Stdin, c.Stdout, c.Stderr = os.Stdin, os.Stdout, os.Stderr
		err := c.Run()
		if activeSince() == before {
			if x, ok := err.(*exec.ExitError); ok {
				return exitCode(x.ExitCode())
			}
			return err
		}
		fmt.Println("phosphorus is restarting, reattaching (ctrl-c to quit)...")
		for !nativeUp() {
			time.Sleep(time.Second)
		}
		if len(args) > 0 && args[0] == "update-all" {
			args = []string{"--tab", "update"}
		}
	}
}

// --- phos ps ------------------------------------------------------------------------

type proc struct {
	pid, ppid int
	role, cmd string
	rss       int64
}

// roleProcs every process carrying a phosphorus role, its children inheriting it
func roleProcs() []proc {
	out := []proc{}
	ents, _ := os.ReadDir("/proc")
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		env, _ := os.ReadFile(fmt.Sprintf("/proc/%d/environ", pid))
		role := ""
		for _, kv := range strings.Split(string(env), "\x00") {
			if strings.HasPrefix(kv, "PHOSPHORUS_ROLE=") {
				role = strings.TrimPrefix(kv, "PHOSPHORUS_ROLE=")
			}
		}
		if role == "" {
			continue
		}
		cmd, _ := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
		p := proc{pid: pid, role: role, cmd: strings.TrimSpace(strings.ReplaceAll(string(cmd), "\x00", " "))}
		if f, err := os.Open(fmt.Sprintf("/proc/%d/status", pid)); err == nil {
			s := bufio.NewScanner(f)
			for s.Scan() {
				k, v, _ := strings.Cut(s.Text(), ":")
				v = strings.TrimSpace(v)
				switch k {
				case "PPid":
					p.ppid, _ = strconv.Atoi(v)
				case "VmRSS":
					n, _ := strconv.ParseInt(strings.Fields(v)[0], 10, 64)
					p.rss = n * 1024
				}
			}
			f.Close()
		}
		out = append(out, p)
	}
	return out
}

// psHost phosphorus's own processes as a tree, by role
func psHost(w io.Writer) error {
	ps := roleProcs()
	if len(ps) == 0 {
		fmt.Fprintln(w, "no phosphorus processes running")
		return nil
	}
	by := map[int]proc{}
	kids := map[int][]int{}
	for _, p := range ps {
		by[p.pid] = p
	}
	roots := []int{}
	for _, p := range ps {
		if _, ok := by[p.ppid]; ok {
			kids[p.ppid] = append(kids[p.ppid], p.pid)
		} else {
			roots = append(roots, p.pid)
		}
	}
	sort.Ints(roots)
	fmt.Fprintf(w, "%-16s %7s %8s  %s\n", "ROLE", "PID", "RSS", "COMMAND")
	var walk func(pid int, depth int)
	walk = func(pid int, depth int) {
		p := by[pid]
		cmd := p.cmd
		if len(cmd) > 90 {
			cmd = cmd[:90] + "…"
		}
		fmt.Fprintf(w, "%-16s %7d %7dM  %s%s\n", p.role, p.pid, p.rss>>20, strings.Repeat("  ", depth), cmd)
		sort.Ints(kids[pid])
		for _, k := range kids[pid] {
			walk(k, depth+1)
		}
	}
	for _, r := range roots {
		walk(r, 0)
	}
	return nil
}
