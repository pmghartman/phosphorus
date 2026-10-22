// Package sulfur: the code editor's work on a mesh host as its user: what
// compilers and build tools a host has, and a build streamed from it as if run
// at its own terminal
package sulfur

import (
	"encoding/base64"
	"errors"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"golang.org/x/crypto/ssh"

	"github.com/pmghartman/phosphorus/internal/claude"
)

// probeTTL a host's toolchains kept this long before they're looked at again
const probeTTL = 10 * time.Minute

// Tool one compiler, build tool or runtime found on a host
type Tool struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Version string `json:"version"`
	Path    string `json:"path"`
}

// VS one Visual Studio install: its MSVC toolsets and the script that sets them up
type VS struct {
	Name    string   `json:"name"`
	Version string   `json:"version"`
	Path    string   `json:"path"`
	VCVars  string   `json:"vcvars"`
	MSVC    []string `json:"msvc"`
}

// Toolchains what a host offers to build with, as its user's login sees it
type Toolchains struct {
	Host   string   `json:"host"`
	OS     string   `json:"os"`
	Arch   string   `json:"arch"`
	Shell  string   `json:"shell"`
	Tools  []Tool   `json:"tools"`
	VS     []VS     `json:"vs"`
	Dotnet []string `json:"dotnet"`
	At     int64    `json:"at"`
}

// the tools looked for, each with what it is and how it tells its version
var known = []struct{ id, name, kind, ver string }{
	{"gcc", "GCC", "compiler", "--version"}, {"g++", "G++", "compiler", "--version"},
	{"clang", "Clang", "compiler", "--version"}, {"clang++", "Clang++", "compiler", "--version"},
	{"cl", "MSVC cl", "compiler", ""}, {"zig", "Zig", "compiler", "version"},
	{"rustc", "Rust", "compiler", "--version"}, {"cargo", "Cargo", "build", "--version"},
	{"go", "Go", "compiler", "version"}, {"dotnet", ".NET", "sdk", "--version"},
	{"javac", "Java", "compiler", "-version"}, {"mvn", "Maven", "build", "-v"}, {"gradle", "Gradle", "build", "--version"},
	{"cmake", "CMake", "build", "--version"}, {"ninja", "Ninja", "build", "--version"}, {"make", "Make", "build", "--version"},
	{"meson", "Meson", "build", "--version"}, {"msbuild", "MSBuild", "build", "-version"},
	{"node", "Node.js", "runtime", "--version"}, {"npm", "npm", "build", "--version"}, {"bun", "Bun", "runtime", "--version"},
	{"python3", "Python", "runtime", "--version"}, {"python", "Python", "runtime", "--version"},
	{"swift", "Swift", "compiler", "--version"}, {"git", "Git", "vcs", "--version"},
}

var (
	cacheMu sync.Mutex
	cache   = map[string]*Toolchains{}
)

// Probe host's toolchains as c's login, kept a while unless fresh
func Probe(host string, c claude.Creds, fresh bool) (*Toolchains, error) {
	key := c.User + "@" + host
	cacheMu.Lock()
	if t := cache[key]; t != nil && !fresh && time.Since(time.UnixMilli(t.At)) < probeTTL {
		cacheMu.Unlock()
		return t, nil
	}
	cacheMu.Unlock()
	cl, err := claude.Dial(host, c)
	if err != nil {
		return nil, err
	}
	defer cl.Close()
	win, err := isWindows(cl)
	if err != nil {
		return nil, err
	}
	var out string
	if win {
		out, err = output(cl, PowerShell(windowsProbe()), 90*time.Second)
	} else {
		out, err = output(cl, "sh -c "+claude.Quote(posixProbe()), 90*time.Second)
	}
	if err != nil {
		return nil, err
	}
	t := parseProbe(out)
	t.Host = host
	t.At = time.Now().UnixMilli()
	if win {
		t.OS, t.Shell = "windows", "cmd"
	}
	cacheMu.Lock()
	cache[key] = t
	cacheMu.Unlock()
	return t, nil
}

// isWindows whether the login's shell is Windows': sh's uname answers, cmd's doesn't
func isWindows(cl *ssh.Client) (bool, error) {
	out, err := output(cl, "uname -s", 20*time.Second)
	if err == nil && strings.TrimSpace(out) != "" && !strings.Contains(strings.ToLower(out), "not recognized") {
		return false, nil
	}
	// cmd's ver, asked through cmd so a PowerShell login answers it too
	ver, err2 := output(cl, "cmd /c ver", 20*time.Second)
	if err2 == nil && strings.Contains(strings.ToLower(ver), "windows") {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	return false, errors.New("can't tell which system the host runs")
}

// output one command's whole output, any exit taken
func output(cl *ssh.Client, cmd string, timeout time.Duration) (string, error) {
	ss, err := cl.NewSession()
	if err != nil {
		return "", err
	}
	defer ss.Close()
	var b strings.Builder
	w := &capped{b: &b, max: 1 << 20}
	ss.Stdout, ss.Stderr = w, w
	done := make(chan error, 1)
	go func() { done <- ss.Run(cmd) }()
	select {
	case <-done:
	case <-time.After(timeout):
		ss.Signal(ssh.SIGKILL)
		return b.String(), errors.New("timed out")
	}
	return b.String(), nil
}

type capped struct {
	mu  sync.Mutex
	b   *strings.Builder
	max int
}

func (c *capped) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.b.Len()+len(p) <= c.max {
		c.b.Write(p)
	}
	return len(p), nil
}

// PowerShell a script run by Windows PowerShell from any shell sshd gives,
// passed encoded so no shell's quoting touches it
func PowerShell(script string) string {
	u := utf16.Encode([]rune(script))
	b := make([]byte, len(u)*2)
	for i, r := range u {
		b[2*i], b[2*i+1] = byte(r), byte(r>>8)
	}
	return "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + base64.StdEncoding.EncodeToString(b)
}

// posixProbe a line per finding: O|os|arch, T|id|path|version, N|sdk
func posixProbe() string {
	var s strings.Builder
	s.WriteString(`PATH="$HOME/.local/bin:$HOME/.cargo/bin:$HOME/go/bin:$HOME/.dotnet:$HOME/.bun/bin:/usr/local/go/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; `)
	s.WriteString(`echo "O|$(uname -s)|$(uname -m)"; `)
	for _, k := range known {
		if k.ver == "" {
			continue
		}
		s.WriteString(`p=$(command -v ` + claude.Quote(k.id) + ` 2>/dev/null) && echo "T|` + k.id + `|$p|$("$p" ` + k.ver + ` 2>&1 </dev/null | grep -v '^\s*$' | head -n 1)"; `)
	}
	s.WriteString(`command -v dotnet >/dev/null 2>&1 && dotnet --list-sdks 2>/dev/null | while read -r v r; do echo "N|$v"; done; true`)
	return s.String()
}

// windowsProbe the same lines from PowerShell, Visual Studio's installs from
// vswhere as V|name|version|path|vcvars|msvc,versions
func windowsProbe() string {
	var s strings.Builder
	s.WriteString(`$ErrorActionPreference='SilentlyContinue'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; `)
	s.WriteString(`"O|Windows|$env:PROCESSOR_ARCHITECTURE"; `)
	s.WriteString(`$vw = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"; `)
	s.WriteString(`if (Test-Path $vw) { foreach ($i in (& $vw -all -products * -format json | ConvertFrom-Json)) { ` +
		`$p = $i.installationPath; $vc = Join-Path $p 'VC\Auxiliary\Build\vcvars64.bat'; ` +
		`$ms = (Get-ChildItem (Join-Path $p 'VC\Tools\MSVC') -Directory | ForEach-Object Name) -join ','; ` +
		`if (-not (Test-Path $vc)) { $vc = '' }; "V|$($i.displayName)|$($i.installationVersion)|$p|$vc|$ms" } }; `)
	s.WriteString(`foreach ($t in @(`)
	ids := []string{}
	for _, k := range known {
		if k.ver == "" {
			continue
		}
		ids = append(ids, "@('"+k.id+"','"+k.ver+"')")
	}
	s.WriteString(strings.Join(ids, ","))
	s.WriteString(`)) { $c = Get-Command $t[0] -CommandType Application | Select-Object -First 1; if ($c) { ` +
		`$v = (& $c.Source $t[1] 2>&1 | Out-String).Trim() -split "\r?\n" | Where-Object { $_.Trim() } | Select-Object -First 1; ` +
		`"T|$($t[0])|$($c.Source)|$v" } }; `)
	s.WriteString(`if (Get-Command dotnet) { foreach ($l in (dotnet --list-sdks)) { "N|" + ($l -split ' ')[0] } }`)
	return s.String()
}

// parseProbe the probe's lines as toolchains; one tool per name, the first found
func parseProbe(out string) *Toolchains {
	t := &Toolchains{OS: "unknown", Shell: "sh", Tools: []Tool{}, VS: []VS{}, Dotnet: []string{}}
	seen := map[string]bool{}
	names := map[string]struct{ name, kind string }{}
	for _, k := range known {
		names[k.id] = struct{ name, kind string }{k.name, k.kind}
	}
	for _, line := range strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n") {
		f := strings.Split(strings.TrimSpace(line), "|")
		switch {
		case len(f) == 3 && f[0] == "O":
			t.OS, t.Arch = strings.ToLower(f[1]), strings.ToLower(f[2])
		case len(f) >= 4 && f[0] == "T":
			id := f[1]
			k, ok := names[id]
			// python and python3 one tool, as gcc and cc would be
			if id == "python3" {
				id = "python"
			}
			if !ok || seen[id] || f[2] == "" {
				continue
			}
			v := version(strings.Join(f[3:], "|"))
			// the Store's stand-in python, which only offers to install one
			if strings.Contains(strings.ToLower(f[2]), `\windowsapps\`) && (v == "" || v[0] < '0' || v[0] > '9') {
				continue
			}
			seen[id] = true
			t.Tools = append(t.Tools, Tool{ID: id, Name: k.name, Kind: k.kind, Path: f[2], Version: v})
		case len(f) >= 6 && f[0] == "V":
			v := VS{Name: f[1], Version: f[2], Path: f[3], VCVars: f[4], MSVC: []string{}}
			for _, m := range strings.Split(f[5], ",") {
				if m = strings.TrimSpace(m); m != "" {
					v.MSVC = append(v.MSVC, m)
				}
			}
			sort.Sort(sort.Reverse(sort.StringSlice(v.MSVC)))
			t.VS = append(t.VS, v)
		case len(f) == 2 && f[0] == "N" && f[1] != "":
			t.Dotnet = append(t.Dotnet, f[1])
		}
	}
	return t
}

var dottedRe = regexp.MustCompile(`\d+(\.\d+)+`)

// version the version in a tool's banner: its first dotted number, else the banner
func version(s string) string {
	s = strings.TrimSpace(s)
	if v := dottedRe.FindString(s); v != "" {
		return v
	}
	if len(s) > 60 {
		s = s[:60]
	}
	return s
}
