package sulfur

// The language server host: a user-scoped installer and stdio adapter, run in
// this process for the desktop user, or by `phosphorus sulfur-language` over
// the saved SSH login on a mesh host. Only install touches the network.
// Registry versions and downloaded artifact hashes are recorded in each
// manifest; staging keeps a failed install from replacing a working one.

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// langItem one language server a host can offer
type langItem struct {
	ID, Name, Server string
	Packages         []string
	Entry            string
	Prerequisites    string
}

var langCatalog = []langItem{
	{ID: "typescript", Name: "TypeScript", Server: "TypeScript Language Server", Packages: []string{"typescript-language-server", "typescript"}, Entry: "typescript-language-server/lib/cli.mjs", Prerequisites: "Node.js 22+ and npm"},
	{ID: "python", Name: "Python", Server: "Pyright", Packages: []string{"pyright"}, Entry: "pyright/langserver.index.js", Prerequisites: "Node.js 22+ and npm; select a project virtual environment in pyrightconfig.json"},
	{ID: "javascript", Name: "JavaScript", Server: "TypeScript Language Server", Packages: []string{"typescript-language-server", "typescript"}, Entry: "typescript-language-server/lib/cli.mjs", Prerequisites: "Node.js 22+ and npm"},
	{ID: "java", Name: "Java", Server: "Eclipse JDT LS", Prerequisites: "JDK 21+ (JAVA_HOME or java on PATH); Maven/Gradle projects may need cached dependencies"},
	{ID: "csharp", Name: "C#", Server: "csharp-ls", Prerequisites: ".NET 10 SDK; project dependencies must be restored for offline use"},
	{ID: "php", Name: "PHP", Server: "Intelephense", Packages: []string{"intelephense"}, Entry: "intelephense/lib/intelephense.js", Prerequisites: "Node.js 22+ and npm; free server features only"},
	{ID: "shell", Name: "Shell (Bash)", Server: "Bash Language Server", Packages: []string{"bash-language-server"}, Entry: "bash-language-server/out/cli.js", Prerequisites: "Node.js 22+, npm and Bash (Windows: Git Bash or WSL host); shellcheck optional"},
	{ID: "cpp", Name: "C / C++", Server: "clangd", Prerequisites: "platform clangd binary or x86-64 release, C/C++ toolchain and compile_commands.json; native ARM hosts can provide clangd on PATH"},
	{ID: "hcl", Name: "HCL / Terraform", Server: "terraform-ls", Prerequisites: "Terraform CLI recommended; cached Terraform providers for offline use"},
	{ID: "go", Name: "Go", Server: "gopls", Prerequisites: "current Go SDK; installation compiles gopls; cache project modules for offline use"},
}

func langByID(id string) (langItem, bool) {
	for _, i := range langCatalog {
		if i.ID == id {
			return i, true
		}
	}
	return langItem{}, false
}

// LanguageMain the host helper behind `phosphorus sulfur-language REQUEST`: the
// request's base64 JSON, LSP lines on stdin, events and LSP lines on stdout
func LanguageMain(arg string, in io.Reader, out, errw io.Writer) int {
	a := newAdapter(languageHome(), out, errw)
	defer a.cancel()
	var req LanguageRequest
	b, err := base64.StdEncoding.DecodeString(arg)
	if err == nil {
		err = json.Unmarshal(b, &req)
	}
	if err == nil {
		err = a.serve(req, in)
	}
	if err != nil {
		a.emit("error", map[string]any{"error": err.Error()})
		return 1
	}
	return 0
}

// ServeLanguage the same helper in this process, for the desktop user
func ServeLanguage(req LanguageRequest, in io.Reader, out, errw io.Writer) error {
	a := newAdapter(languageHome(), out, errw)
	defer a.cancel()
	if err := a.serve(req, in); err != nil {
		a.emit("error", map[string]any{"error": err.Error()})
		return err
	}
	return nil
}

func languageHome() string {
	if h := os.Getenv("SULFUR_LANGUAGE_HOME"); h != "" {
		return h
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".sulfur", "languages")
}

type adapter struct {
	home   string
	out    io.Writer
	errw   io.Writer
	wmu    sync.Mutex
	ctx    context.Context
	cancel context.CancelFunc
	procMu sync.Mutex
	proc   *exec.Cmd
	// seams for tests
	fetch      func(url string) ([]byte, error)
	executable func(name string) (string, error)
	command    func(item langItem, manifest map[string]any, req LanguageRequest) ([]string, error)
}

func newAdapter(home string, out, errw io.Writer) *adapter {
	a := &adapter{home: home, out: out, errw: errw}
	a.ctx, a.cancel = context.WithCancel(context.Background())
	a.fetch = a.httpFetch
	a.executable = lookRuntime
	a.command = a.serverCommand
	return a
}

func lookRuntime(name string) (string, error) {
	p, err := exec.LookPath(name)
	if err != nil {
		return "", errors.New("Missing runtime: " + name + ". Install it on this host and add it to the user's PATH.")
	}
	return p, nil
}

func (a *adapter) emit(kind string, v map[string]any) {
	m := map[string]any{"_sulfur": kind}
	for k, x := range v {
		m[k] = x
	}
	a.wmu.Lock()
	defer a.wmu.Unlock()
	enc := json.NewEncoder(a.out)
	enc.SetEscapeHTML(false)
	enc.Encode(m)
}

func (a *adapter) cancelled() error {
	if a.ctx.Err() != nil {
		return errors.New("Installation cancelled: client disconnected")
	}
	return nil
}

func platformName() string {
	switch runtime.GOOS {
	case "windows":
		return "Windows"
	case "darwin":
		return "Darwin"
	}
	return "Linux"
}

// serve one operation: status, install, uninstall, enable, disable or launch
func (a *adapter) serve(req LanguageRequest, in io.Reader) error {
	if req.Op != "launch" {
		// a client that goes away cancels what's running
		go func() { io.Copy(io.Discard, in); a.cancel(); a.killRunning() }()
	}
	if req.Op == "status" {
		a.emitStatus()
		return nil
	}
	item, ok := langByID(req.Language)
	if !ok {
		return errors.New("Unknown language")
	}
	if req.Op == "launch" {
		return a.launch(item, a.load(item.ID), req, in)
	}
	// mkdir is also the cross-process installer lock, shared by local and mesh UIs
	if err := os.MkdirAll(a.home, 0o755); err != nil {
		return err
	}
	lock := filepath.Join(a.home, ".lock-"+item.ID)
	if err := os.Mkdir(lock, 0o755); err != nil {
		if os.IsExist(err) {
			return errors.New("Another operation is using this extension; retry when it finishes")
		}
		return err
	}
	defer os.Remove(lock)
	switch req.Op {
	case "install":
		if err := a.install(item); err != nil {
			return err
		}
	case "uninstall":
		target := filepath.Join(a.home, item.ID)
		if isSymlink(target) {
			return errors.New("Refusing a symlink installation directory")
		}
		if err := os.RemoveAll(target); err != nil {
			return err
		}
	case "enable", "disable":
		m := a.load(item.ID)
		if m == nil {
			return errors.New("Install the extension first")
		}
		m["enabled"] = req.Op == "enable"
		if err := writeManifest(filepath.Join(a.home, item.ID, "manifest.json"), m); err != nil {
			return err
		}
	default:
		return errors.New("Unknown operation")
	}
	a.emitStatus()
	return nil
}

func isSymlink(p string) bool {
	fi, err := os.Lstat(p)
	return err == nil && fi.Mode()&os.ModeSymlink != 0
}

func writeManifest(p string, m map[string]any) error {
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, b, 0o644)
}

func (a *adapter) load(id string) map[string]any {
	b, err := os.ReadFile(filepath.Join(a.home, id, "manifest.json"))
	if err != nil {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return nil
	}
	return m
}

func (a *adapter) status() []map[string]any {
	out := []map[string]any{}
	for _, i := range langCatalog {
		m := a.load(i.ID)
		e := map[string]any{"id": i.ID, "name": i.Name, "server": i.Server, "prerequisites": i.Prerequisites,
			"installed": m != nil, "enabled": m != nil && m["enabled"] == true, "manifest": m}
		if i.Packages != nil {
			e["packages"] = i.Packages
			e["entry"] = i.Entry
		}
		out = append(out, e)
	}
	return out
}

func (a *adapter) emitStatus() {
	a.emit("status", map[string]any{"extensions": a.status(), "platform": platformName()})
}

// --- running and fetching ----------------------------------------------------

func (a *adapter) killRunning() {
	a.procMu.Lock()
	defer a.procMu.Unlock()
	if a.proc != nil && a.proc.Process != nil {
		killTree(a.proc.Process)
	}
}

func tail(s string, n int) string {
	if len(s) > n {
		return s[len(s)-n:]
	}
	return s
}

// run a command to its end, its output logged, killed with the client or past 15 minutes
func (a *adapter) run(dir string, env []string, name string, args ...string) error {
	if err := a.cancelled(); err != nil {
		return err
	}
	a.emit("log", map[string]any{"text": "Running " + strings.Join(append([]string{name}, args...), " ")})
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	if env != nil {
		cmd.Env = env
	}
	var buf bytes.Buffer
	cmd.Stdout, cmd.Stderr = &buf, &buf
	ownGroup(cmd)
	a.procMu.Lock()
	if err := a.cancelled(); err != nil {
		a.procMu.Unlock()
		return err
	}
	if err := cmd.Start(); err != nil {
		a.procMu.Unlock()
		return err
	}
	a.proc = cmd
	a.procMu.Unlock()
	done := make(chan struct{})
	go func() {
		select {
		case <-done:
		case <-time.After(15 * time.Minute):
			a.killRunning()
		}
	}()
	err := cmd.Wait()
	close(done)
	a.procMu.Lock()
	a.proc = nil
	a.procMu.Unlock()
	if cerr := a.cancelled(); cerr != nil {
		return cerr
	}
	a.emit("log", map[string]any{"text": tail(buf.String(), 24000)})
	if err != nil {
		code := -1
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			code = ee.ExitCode()
		}
		return fmt.Errorf("Installer exited with %d: %s", code, tail(buf.String(), 3000))
	}
	return nil
}

func (a *adapter) httpFetch(u string) ([]byte, error) {
	if err := a.cancelled(); err != nil {
		return nil, err
	}
	if !strings.HasPrefix(u, "https://") {
		return nil, errors.New("Downloads require HTTPS")
	}
	req, err := http.NewRequestWithContext(a.ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Sulfur-language-extensions")
	c := &http.Client{Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 90 * time.Second}).DialContext,
		TLSHandshakeTimeout:   90 * time.Second,
		ResponseHeaderTimeout: 90 * time.Second,
	}}
	r, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	if r.StatusCode < 200 || r.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP Error %d: %s", r.StatusCode, r.Status)
	}
	return io.ReadAll(io.LimitReader(r.Body, 512<<20))
}

func (a *adapter) getJSON(u string, v any) error {
	b, err := a.fetch(u)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

// unpack a downloaded zip or tar into dest, its hash noted, nothing allowed out of dest
func (a *adapter) unpack(u, dest string, manifest map[string]any) error {
	a.emit("log", map[string]any{"text": "Downloading " + u})
	data, err := a.fetch(u)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	manifest["source"], manifest["sha256"] = u, hex.EncodeToString(sum[:])
	if zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data))); err == nil {
		for _, f := range zr.File {
			if err := safeName(f.Name); err != nil {
				return err
			}
			if f.Mode()&os.ModeSymlink != 0 {
				return errors.New("Archive symlink refused")
			}
		}
		for _, f := range zr.File {
			target := filepath.Join(dest, filepath.FromSlash(f.Name))
			if f.FileInfo().IsDir() {
				if err := os.MkdirAll(target, 0o755); err != nil {
					return err
				}
				continue
			}
			rc, err := f.Open()
			if err != nil {
				return err
			}
			err = writeFile(target, rc, f.Mode().Perm())
			rc.Close()
			if err != nil {
				return err
			}
		}
		return nil
	}
	var src io.Reader = bytes.NewReader(data)
	if len(data) > 2 && data[0] == 0x1f && data[1] == 0x8b {
		gz, err := gzip.NewReader(src)
		if err != nil {
			return err
		}
		defer gz.Close()
		src = gz
	}
	raw, err := io.ReadAll(src)
	if err != nil {
		return err
	}
	check := tar.NewReader(bytes.NewReader(raw))
	for {
		h, err := check.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if err := safeName(h.Name); err != nil {
			return err
		}
		if h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeDir {
			return errors.New("Archive links/devices refused")
		}
	}
	tr := tar.NewReader(bytes.NewReader(raw))
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		target := filepath.Join(dest, filepath.FromSlash(h.Name))
		if h.Typeflag == tar.TypeDir {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := writeFile(target, tr, os.FileMode(h.Mode).Perm()); err != nil {
			return err
		}
	}
}

func safeName(name string) error {
	if !filepath.IsLocal(filepath.FromSlash(strings.TrimSuffix(name, "/"))) {
		return errors.New("Archive path escapes installation")
	}
	return nil
}

func writeFile(target string, r io.Reader, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm|0o600)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, r)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// --- install ------------------------------------------------------------------

func verOf(s string) []int {
	var v []int
	for _, p := range strings.Split(strings.TrimPrefix(s, "v"), ".") {
		n, _ := strconv.Atoi(p)
		v = append(v, n)
	}
	return v
}

func verLess(a, b []int) bool {
	for i := 0; i < len(a) || i < len(b); i++ {
		var x, y int
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		if x != y {
			return x < y
		}
	}
	return false
}

func newest(versions []string) string {
	best := ""
	for _, v := range versions {
		if best == "" || verLess(verOf(best), verOf(v)) {
			best = v
		}
	}
	return best
}

var (
	tsSixRe    = regexp.MustCompile(`^6\.\d+\.\d+$`)
	jdtVerRe   = regexp.MustCompile(`href=['"](?:[^'"]*/)?(\d+\.\d+\.\d+)/?['"]`)
	jdtTarRe   = regexp.MustCompile(`jdt-language-server-[\w.\-]+\.tar\.gz`)
	javaVerRe  = regexp.MustCompile(`version "(\d+)`)
	exeSuffix  = map[bool]string{true: ".exe", false: ""}[runtime.GOOS == "windows"]
	goosToSys  = map[string]string{"windows": "windows", "darwin": "mac", "linux": "linux"}
	goosToHash = map[string]string{"windows": "windows", "darwin": "darwin", "linux": "linux"}
)

func (a *adapter) install(item langItem) error {
	if err := os.MkdirAll(a.home, 0o755); err != nil {
		return err
	}
	target := filepath.Join(a.home, item.ID)
	if isSymlink(target) {
		return errors.New("Installation directory must not be a symlink")
	}
	manifest := map[string]any{"enabled": true, "server": item.Server}
	stage, err := os.MkdirTemp(a.home, ".install-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	switch {
	case item.Packages != nil:
		if err := a.installNpm(item, stage, manifest); err != nil {
			return err
		}
	case item.ID == "go":
		gopls, err := a.executable("go")
		if err != nil {
			return err
		}
		if err := a.run(stage, append(os.Environ(), "GOBIN="+stage), gopls, "install", "golang.org/x/tools/gopls@latest"); err != nil {
			return err
		}
		manifest["entry"] = "gopls" + exeSuffix
	case item.ID == "csharp":
		dotnet, err := a.executable("dotnet")
		if err != nil {
			return err
		}
		if err := a.run(stage, nil, dotnet, "tool", "install", "csharp-ls", "--tool-path", stage); err != nil {
			return err
		}
		manifest["entry"] = "csharp-ls" + exeSuffix
	case item.ID == "java":
		if err := a.installJava(stage, manifest); err != nil {
			return err
		}
	case item.ID == "cpp":
		if err := a.installClangd(stage, manifest); err != nil {
			return err
		}
	case item.ID == "hcl":
		if err := a.installTerraformLS(stage, manifest); err != nil {
			return err
		}
	}
	if err := writeManifest(filepath.Join(stage, "manifest.json"), manifest); err != nil {
		return err
	}
	if err := a.cancelled(); err != nil {
		return err
	}
	backup := filepath.Join(a.home, ".old-"+item.ID)
	os.RemoveAll(backup)
	if _, err := os.Lstat(target); err == nil {
		if err := os.Rename(target, backup); err != nil {
			return err
		}
	}
	if err := os.Rename(stage, target); err != nil {
		if _, serr := os.Lstat(backup); serr == nil {
			os.Rename(backup, target)
		}
		return err
	}
	os.RemoveAll(backup)
	return nil
}

func (a *adapter) installNpm(item langItem, stage string, manifest map[string]any) error {
	node, err := a.executable("node")
	if err != nil {
		return err
	}
	out, err := exec.Command(node, "--version").Output()
	if err != nil {
		return err
	}
	if verLess(verOf(strings.TrimSpace(string(out))), []int{22, 22, 2}) {
		return errors.New("Node.js 22.22.2 or newer is required (Node.js 24 LTS recommended)")
	}
	packages := []string{}
	for _, p := range item.Packages {
		var version string
		if p == "typescript" {
			// TypeScript 7's native distribution does not provide the legacy
			// tsserver.js consumed by typescript-language-server.
			var reg struct {
				Versions map[string]json.RawMessage `json:"versions"`
			}
			if err := a.getJSON("https://registry.npmjs.org/typescript", &reg); err != nil {
				return err
			}
			var six []string
			for v := range reg.Versions {
				if tsSixRe.MatchString(v) {
					six = append(six, v)
				}
			}
			if version = newest(six); version == "" {
				return errors.New("no TypeScript 6 release in the registry")
			}
		} else {
			var latest struct {
				Version string `json:"version"`
			}
			if err := a.getJSON("https://registry.npmjs.org/"+p+"/latest", &latest); err != nil {
				return err
			}
			version = latest.Version
		}
		packages = append(packages, p+"@"+version)
	}
	npm, err := a.executable("npm")
	if err != nil {
		return err
	}
	argv := []string{npm}
	if runtime.GOOS == "windows" {
		// npm's JS entry directly; a user home path never goes through cmd.exe's expansion
		cli := filepath.Join(filepath.Dir(npm), "node_modules", "npm", "bin", "npm-cli.js")
		if _, err := os.Stat(cli); err != nil {
			return errors.New("Install the official Node.js distribution with npm beside node.exe")
		}
		argv = []string{node, cli}
	}
	argv = append(argv, "install", "--prefix", stage, "--registry=https://registry.npmjs.org", "--fetch-retries=1", "--fetch-timeout=60000", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact")
	if err := a.run(stage, nil, argv[0], append(argv[1:], packages...)...); err != nil {
		return err
	}
	manifest["packages"] = packages
	manifest["entry"] = "node_modules/" + item.Entry
	return nil
}

func (a *adapter) javaExecutable() (string, error) {
	if h := os.Getenv("JAVA_HOME"); h != "" {
		return filepath.Join(h, "bin", "java"+exeSuffix), nil
	}
	return a.executable("java")
}

func (a *adapter) installJava(stage string, manifest map[string]any) error {
	java, err := a.javaExecutable()
	if err != nil {
		return err
	}
	out, _ := exec.Command(java, "-version").CombinedOutput()
	if m := javaVerRe.FindSubmatch(out); m == nil || atoi(string(m[1])) < 21 {
		return errors.New("JDT LS requires JDK 21 or newer")
	}
	base := "https://download.eclipse.org/jdtls/milestones/"
	listing, err := a.fetch(base)
	if err != nil {
		return err
	}
	var versions []string
	for _, m := range jdtVerRe.FindAllSubmatch(listing, -1) {
		versions = append(versions, string(m[1]))
	}
	if len(versions) == 0 {
		return errors.New("Eclipse JDT LS download service is unavailable; retry installation later")
	}
	version := newest(versions)
	listing, err = a.fetch(base + version + "/")
	if err != nil {
		return err
	}
	artifact := jdtTarRe.Find(listing)
	if artifact == nil {
		return errors.New("Eclipse JDT LS download service is unavailable; retry installation later")
	}
	if err := a.unpack(base+version+"/"+string(artifact), stage, manifest); err != nil {
		return err
	}
	manifest["entry"] = "jdtls"
	return nil
}

func atoi(s string) int { n, _ := strconv.Atoi(s); return n }

func (a *adapter) installClangd(stage string, manifest map[string]any) error {
	if existing, err := exec.LookPath("clangd"); err == nil {
		manifest["entry"], manifest["external"] = existing, true
		return nil
	}
	if runtime.GOARCH != "amd64" {
		return errors.New("Install a native clangd on PATH for this architecture, then retry")
	}
	var release struct {
		Assets []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := a.getJSON("https://api.github.com/repos/clangd/clangd/releases/latest", &release); err != nil {
		return err
	}
	prefix := "clangd-" + goosToSys[runtime.GOOS] + "-"
	url := ""
	for _, x := range release.Assets {
		if strings.HasPrefix(x.Name, prefix) && strings.HasSuffix(x.Name, ".zip") {
			url = x.URL
			break
		}
	}
	if url == "" {
		return errors.New("No clangd release for this platform; install clangd on PATH, then retry")
	}
	if err := a.unpack(url, stage, manifest); err != nil {
		return err
	}
	var entry string
	filepath.WalkDir(stage, func(p string, d os.DirEntry, err error) error {
		if err == nil && entry == "" && !d.IsDir() && d.Name() == "clangd"+exeSuffix {
			entry = p
		}
		return nil
	})
	if entry == "" {
		return errors.New("clangd missing from its release")
	}
	os.Chmod(entry, 0o755)
	rel, _ := filepath.Rel(stage, entry)
	manifest["entry"] = rel
	return nil
}

func (a *adapter) installTerraformLS(stage string, manifest map[string]any) error {
	var check struct {
		Current string `json:"current_version"`
	}
	if err := a.getJSON("https://checkpoint-api.hashicorp.com/v1/check/terraform-ls", &check); err != nil {
		return err
	}
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		return errors.New("No Terraform LS binary for " + runtime.GOARCH)
	}
	r := check.Current
	if err := a.unpack(fmt.Sprintf("https://releases.hashicorp.com/terraform-ls/%s/terraform-ls_%s_%s_%s.zip", r, r, goosToHash[runtime.GOOS], runtime.GOARCH), stage, manifest); err != nil {
		return err
	}
	manifest["entry"] = "terraform-ls" + exeSuffix
	return os.Chmod(filepath.Join(stage, "terraform-ls"+exeSuffix), 0o755)
}

// --- launch -------------------------------------------------------------------

func (a *adapter) serverCommand(item langItem, manifest map[string]any, req LanguageRequest) ([]string, error) {
	folder := filepath.Join(a.home, item.ID)
	entry := filepath.Join(folder, filepath.FromSlash(fmt.Sprint(manifest["entry"])))
	if item.Packages != nil {
		node, err := a.executable("node")
		if err != nil {
			return nil, err
		}
		args := []string{node, entry}
		if item.ID == "typescript" || item.ID == "javascript" {
			return append(args, "--stdio", "--tsserver-path", filepath.Join(folder, "node_modules", "typescript", "lib", "tsserver.js")), nil
		}
		if item.ID == "shell" {
			return append(args, "start"), nil
		}
		return append(args, "--stdio"), nil
	}
	switch item.ID {
	case "java":
		java, err := a.javaExecutable()
		if err != nil {
			return nil, err
		}
		system := map[string]string{"windows": "win", "darwin": "mac", "linux": "linux"}[runtime.GOOS]
		arch := ""
		if runtime.GOARCH == "arm64" {
			arch = "_arm"
		}
		config := filepath.Join(folder, "config_"+system+arch)
		if _, err := os.Stat(config); err != nil {
			config = filepath.Join(folder, "config_"+system)
		}
		// every root and active configuration has a separate writable JDT workspace
		key := sha256.Sum256([]byte(req.Root + req.Configuration))
		jars, _ := filepath.Glob(filepath.Join(folder, "plugins", "org.eclipse.equinox.launcher_*.jar"))
		if len(jars) == 0 {
			return nil, errors.New("The JDT LS launcher is missing; reinstall the extension")
		}
		sort.Strings(jars)
		return []string{java, "-Declipse.application=org.eclipse.jdt.ls.core.id1", "-Dosgi.bundles.defaultStartLevel=4", "-Declipse.product=org.eclipse.jdt.ls.core.product", "-Xmx1G", "--add-modules=ALL-SYSTEM",
			"--add-opens", "java.base/java.util=ALL-UNNAMED", "--add-opens", "java.base/java.lang=ALL-UNNAMED", "-jar", jars[0], "-configuration", config,
			"-data", filepath.Join(a.home, ".workspaces", hex.EncodeToString(key[:])[:24])}, nil
	case "cpp":
		args := []string{entry, "--background-index"}
		if req.BuildDirectory != "" {
			args = append(args, "--compile-commands-dir="+req.BuildDirectory)
		}
		return args, nil
	case "hcl":
		return []string{entry, "serve"}, nil
	}
	return []string{entry}, nil
}

// docAllowed whether a client's document is in the project, symlinks followed;
// a server's virtual document only after it has returned it as a location
func docAllowed(uri, method, root string, virtual map[string]bool) bool {
	if virtual[uri] {
		switch method {
		case "csharp/metadata", "textDocument/semanticTokens/full", "textDocument/definition", "textDocument/hover", "textDocument/documentSymbol":
			return true
		}
	}
	u, err := url.Parse(uri)
	if err != nil || u.Scheme != "file" || u.Host != "" {
		return false
	}
	p := u.Path
	if runtime.GOOS == "windows" {
		if len(p) > 2 && p[0] == '/' && p[2] == ':' {
			p = p[1:]
		}
		p = filepath.FromSlash(p)
	}
	return within(root, resolveLoose(p))
}

// resolveLoose the path with its existing part's symlinks resolved
func resolveLoose(p string) string {
	p = filepath.Clean(p)
	rest := ""
	for cur := p; ; cur = filepath.Dir(cur) {
		if r, err := filepath.EvalSymlinks(cur); err == nil {
			return filepath.Join(r, rest)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return p
		}
		rest = filepath.Join(filepath.Base(cur), rest)
	}
}

func within(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func fileURI(p string) string {
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(p)}
	if runtime.GOOS == "windows" {
		u.Path = "/" + u.Path
	}
	return u.String()
}

// rememberLocations the virtual document uris a server returned
func rememberLocations(v any, into map[string]bool) {
	switch x := v.(type) {
	case map[string]any:
		for k, part := range x {
			if s, ok := part.(string); ok && (k == "uri" || k == "targetUri") && strings.HasPrefix(s, "csharp:/") {
				into[s] = true
			} else {
				rememberLocations(part, into)
			}
		}
	case []any:
		for _, part := range x {
			rememberLocations(part, into)
		}
	}
}

func (a *adapter) launch(item langItem, manifest map[string]any, req LanguageRequest, in io.Reader) error {
	if manifest == nil || manifest["enabled"] != true {
		return errors.New("Extension is not installed and enabled")
	}
	if !filepath.IsAbs(req.Root) {
		return errors.New("Open an existing absolute project folder on this host")
	}
	if fi, err := os.Stat(req.Root); err != nil || !fi.IsDir() {
		return errors.New("Open an existing absolute project folder on this host")
	}
	root, err := filepath.EvalSymlinks(req.Root)
	if err != nil {
		return err
	}
	req.Root = root
	argv, err := a.command(item, manifest, req)
	if err != nil {
		return err
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = root
	cmd.Stderr = a.errw
	ownGroup(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	exited := make(chan struct{})
	var exitCode atomicInt
	go func() {
		err := cmd.Wait()
		code := 0
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			code = ee.ExitCode()
		}
		exitCode.set(code)
		close(exited)
	}()
	// virtual documents are only readable after this server returned them as a
	// location, never arbitrary paths on the host
	virtual := map[string]bool{}
	var vmu sync.Mutex
	a.emit("ready", map[string]any{"rootUri": fileURI(root)})
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		defer func() {
			// wakes the owning websocket even if the editor is otherwise idle
			var code any
			select {
			case <-exited:
				code = exitCode.get()
			case <-time.After(500 * time.Millisecond):
			}
			a.emit("stopped", map[string]any{"code": code})
		}()
		r := bufio.NewReaderSize(stdout, 64<<10)
		for {
			size := -1
			for {
				line, err := r.ReadSlice('\n')
				if err != nil && err != bufio.ErrBufferFull {
					return
				}
				if string(line) == "\r\n" {
					break
				}
				if h := strings.ToLower(string(line)); strings.HasPrefix(h, "content-length:") {
					size, _ = strconv.Atoi(strings.TrimSpace(h[len("content-length:"):]))
				}
			}
			if size < 0 || size > 32<<20 {
				a.emit("error", map[string]any{"error": "Invalid LSP Content-Length"})
				return
			}
			data := make([]byte, size)
			if _, err := io.ReadFull(r, data); err != nil {
				return
			}
			var line bytes.Buffer
			if err := json.Compact(&line, data); err != nil {
				a.emit("error", map[string]any{"error": err.Error()})
				return
			}
			if item.ID == "csharp" {
				var msg any
				if json.Unmarshal(data, &msg) == nil {
					vmu.Lock()
					rememberLocations(msg, virtual)
					vmu.Unlock()
				}
			}
			line.WriteByte('\n')
			a.wmu.Lock()
			a.out.Write(line.Bytes())
			a.wmu.Unlock()
		}
	}()
	defer func() {
		stdin.Close()
		killTree(cmd.Process)
		<-exited
		select {
		case <-readerDone:
		case <-time.After(2 * time.Second):
		}
	}()
	// the browser's JSON goes to the server as the UTF-8 bytes it came as
	br := bufio.NewReaderSize(in, 1<<20)
	for {
		line, err := br.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			var msg struct {
				Method string `json:"method"`
				Params struct {
					TextDocument struct {
						URI *string `json:"uri"`
					} `json:"textDocument"`
				} `json:"params"`
			}
			if jerr := json.Unmarshal(line, &msg); jerr != nil {
				return jerr
			}
			// a client's document stays in this project, through symlinks
			if uri := msg.Params.TextDocument.URI; uri != nil {
				vmu.Lock()
				ok := docAllowed(*uri, msg.Method, root, virtual)
				vmu.Unlock()
				if !ok {
					return errors.New("Document is outside the project")
				}
			}
			var body bytes.Buffer
			json.Compact(&body, line)
			if _, werr := fmt.Fprintf(stdin, "Content-Length: %d\r\n\r\n%s", body.Len(), body.Bytes()); werr != nil {
				return nil
			}
		}
		if err != nil {
			return nil
		}
	}
}

type atomicInt struct {
	mu sync.Mutex
	v  int
}

func (a *atomicInt) set(v int) { a.mu.Lock(); a.v = v; a.mu.Unlock() }
func (a *atomicInt) get() int  { a.mu.Lock(); defer a.mu.Unlock(); return a.v }
