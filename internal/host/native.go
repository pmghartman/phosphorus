package host

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/pmghartman/phosphorus/internal/envfile"
	"github.com/pmghartman/phosphorus/internal/procs"
)

const (
	gitUser    = "phosphorus-git"
	frontendUp = "http://127.0.0.1:8090/"
)

func nativeEnvFile() string { return at("state", "native.env") }

// tool a bundled binary: tailscale, cloudflared, forgejo
func tool(name string) string {
	if isWindows {
		name += ".exe"
	}
	return filepath.Join(libexec(), name)
}

// --- the baked env ------------------------------------------------------------

// bakeEnv every path the roles read, rewritten by every rebuild and read by run
func bakeEnv(homeDir string) map[string]string {
	files := at("files")
	m := map[string]string{
		"PHOSPHORUS_HOME": home, "PHOSPHORUS_REPO_DIR": home,
		"STATE_DIR": at("state"), "SERVICES_FILE": at("config", "services.export"),
		"PHOSPHORUS_INI_FILE": iniFile(), "PHOSPHORUS_CONFIG_DIR": at("config"), "PHOSPHORUS_ENV_FILE": envPath(),
		"VERSION_FILE": at("VERSION"), "REBUILD_CMD": binPath("phosphorus"),
		"FILES_ROOT": files, "PHOSPHORUS_FILES_DIR": files, "OPENCODE_DIR": files,
		"HOME_FS": homeDir, "PHOSPHORUS_HOME_DIR": homeDir,
		"MODEL_DIR": at("state", "models"), "HOST_SSH_HOST": "127.0.0.1",
	}
	if isLinux {
		for k, v := range gitEnv() {
			m[k] = v
		}
	}
	if t := os.Getenv("TS_HOSTNAME"); t != "" {
		m["TS_HOSTNAME"] = t
	}
	dirs, perms := []string{}, []string{}
	ps := splitComma(iniGet("files", "priv"))
	for i, d := range splitComma(iniGet("files", "dir")) {
		if d = strings.TrimRight(d, `/\`); d == "" {
			continue
		}
		abs := filepath.Clean(absTo(home, d))
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

func absTo(base, p string) string {
	p = strings.TrimRight(strings.TrimSpace(p), `/\`)
	if filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(base, p)
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
	return replace(tmp, file)
}

func readEnvFile(file string) map[string]string {
	m := map[string]string{}
	b, _ := os.ReadFile(file)
	for _, l := range strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n") {
		if l = strings.TrimSpace(l); l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		if k, v, ok := strings.Cut(l, "="); ok {
			m[k] = v
		}
	}
	return m
}

// runEnv the baked env and .env over this process's, PATH with the tools
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
	extra := strings.Join(append([]string{libexec()}, tailscaleDirs()...), string(os.PathListSeparator))
	for i, kv := range env {
		if k, v, _ := strings.Cut(kv, "="); strings.EqualFold(k, "PATH") {
			env[i] = k + "=" + extra + string(os.PathListSeparator) + v
			return env
		}
	}
	return append(env, "PATH="+extra+string(os.PathListSeparator)+"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
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

// notifyUpdating the elector told before the frontend goes, best effort
func notifyUpdating() {
	c := &http.Client{Timeout: 3 * time.Second}
	if r, err := c.Post("http://127.0.0.1:8090/internal/status/updating", "application/json", strings.NewReader("{}")); err == nil {
		r.Body.Close()
	}
}

// inService a child of the running service, whose restart would kill it first
func inService() bool { return os.Getenv("PHOSPHORUS_ROLE") != "" }

// rebuild the release's config baked and the service (re)started on it
func rebuild() error {
	tag = "rebuild"
	if err := os.Chdir(home); err != nil {
		return err
	}
	os.MkdirAll(at("state"), 0o755)
	// one rebuild at a time: the update's deferred one and a phos start never interleave
	unlock, err := lockRebuild()
	if err != nil {
		return err
	}
	defer unlock()
	lockEnv()
	if isGitHost() && !isLinux {
		return fail("git hosts run forgejo, which ships for Linux alone: set [git] host = false in config/phosphorus.ini")
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
		os.Remove(at("git", "data"))
		os.Remove(at("git"))
	}
	os.MkdirAll(at("files"), 0o755)
	os.MkdirAll(at("state"), 0o755)

	homeTo := at("files")
	if d := iniGet("home", "dir"); d != "" {
		homeTo = filepath.Clean(absTo(home, d))
		os.MkdirAll(homeTo, 0o755)
	}
	homeFrom := readTrim(at("state", "native-home"))
	if homeFrom == homeTo {
		homeFrom = ""
	}
	if homeFrom != "" && strings.HasPrefix(homeTo+string(os.PathSeparator), filepath.Join(homeFrom, "home")+string(os.PathSeparator)) {
		return fail("[home] dir can't be inside the folders it moves")
	}
	env := bakeEnv(homeTo)
	sig := signature(env)
	if err := svcInstall(); err != nil {
		return err
	}
	up := svcActive()
	if up && homeFrom == "" && readTrim(at("state", "native-sig")) == sig {
		say("already up to date, nothing to restart")
		return nil
	}
	if err := tailscaleReady(); err != nil {
		return err
	}

	if up && homeFrom != "" {
		notifyUpdating()
		svcStop()
		up = false
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
	if err := tailscaleStart(); err != nil {
		return err
	}
	switch {
	case up && inService():
		notifyUpdating()
		os.WriteFile(at("state", "native-sig"), []byte(sig+"\n"), 0o644)
		say("restarting phosphorus")
		return svcRestart(true)
	case up:
		notifyUpdating()
		say("restarting phosphorus")
		if err := svcRestart(false); err != nil {
			return fail("couldn't restart phosphorus: %v", err)
		}
	default:
		say("starting phosphorus")
		if err := svcStart(); err != nil {
			return fail("couldn't start phosphorus: %v", err)
		}
	}
	if !waitFrontend(3 * time.Minute) {
		return fail("the frontend never came up, see %s", logHint())
	}
	os.WriteFile(at("state", "native-sig"), []byte(sig+"\n"), 0o644)
	return nil
}

// moveHome home/ copied whole, only then the old one deleted
func moveHome(from, to string) error {
	src := filepath.Join(from, "home")
	if !fileExists(src) {
		return nil
	}
	if err := copyTree(src, filepath.Join(to, "home")); err != nil {
		return err
	}
	return os.RemoveAll(src)
}

func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		to := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(to, 0o755)
		}
		if d.Type()&os.ModeSymlink != 0 {
			t, err := os.Readlink(p)
			if err != nil {
				return err
			}
			return os.Symlink(t, to)
		}
		return copyFile(p, to)
	})
}

// --- start, stop, the cli ------------------------------------------------------------

func nativeStop() error {
	if !svcActive() {
		fmt.Println("phosphorus isn't running")
		return nil
	}
	fmt.Println("stopping phosphorus (git hands off first)...")
	if err := svcStop(); err != nil {
		return fail("couldn't stop phosphorus: %v", err)
	}
	fmt.Println("phosphorus stopped, phos start to resume")
	return nil
}

func nativeRestart() error {
	fmt.Println("restarting phosphorus...")
	if err := svcRestart(false); err != nil {
		return fail("couldn't restart phosphorus: %v", err)
	}
	fmt.Println("phosphorus restarted")
	return nil
}

// attach the cli on the running service's env, reattached across a restart
func attach(args []string) error {
	for {
		before := svcSince()
		if !svcActive() {
			return fail("phosphorus isn't running, run: phos start")
		}
		c := exec.Command(binPath("phosphorus"), append([]string{"cli"}, args...)...)
		c.Env = runEnv()
		c.Stdin, c.Stdout, c.Stderr = os.Stdin, os.Stdout, os.Stderr
		err := c.Run()
		if svcSince() == before {
			if x, ok := err.(*exec.ExitError); ok {
				return exitCode(x.ExitCode())
			}
			return err
		}
		fmt.Println("phosphorus is restarting, reattaching (ctrl-c to quit)...")
		for !svcActive() {
			time.Sleep(time.Second)
		}
		if len(args) > 0 && args[0] == "update-all" {
			args = []string{"--tab", "update"}
		}
	}
}

// --- phos ps ------------------------------------------------------------------------

// psHost phosphorus's own processes as a tree, by role
func psHost(w io.Writer) error {
	ps := procs.Ours()
	if len(ps) == 0 {
		fmt.Fprintln(w, "no phosphorus processes running")
		return nil
	}
	by := map[int32]procs.P{}
	kids := map[int32][]int32{}
	for _, p := range ps {
		by[p.PID] = p
	}
	roots := []int32{}
	for _, p := range ps {
		if _, ok := by[p.PPID]; ok {
			kids[p.PPID] = append(kids[p.PPID], p.PID)
		} else {
			roots = append(roots, p.PID)
		}
	}
	less := func(a []int32) { sort.Slice(a, func(i, j int) bool { return a[i] < a[j] }) }
	less(roots)
	fmt.Fprintf(w, "%-16s %7s %8s  %s\n", "ROLE", "PID", "RSS", "COMMAND")
	var walk func(pid int32, depth int)
	walk = func(pid int32, depth int) {
		p := by[pid]
		cmd := p.Cmd
		if cmd == "" {
			cmd = p.Name
		}
		if len(cmd) > 90 {
			cmd = cmd[:90] + "…"
		}
		fmt.Fprintf(w, "%-16s %7d %7dM  %s%s\n", p.Role, p.PID, p.RSS>>20, strings.Repeat("  ", depth), cmd)
		less(kids[pid])
		for _, k := range kids[pid] {
			walk(k, depth+1)
		}
	}
	for _, r := range roots {
		walk(r, 0)
	}
	return nil
}
