package code

// the harnesses a session may run, each an optional install on a host: found
// by its own command, installed by its own official installer as the login

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	// Claude and Opencode the harnesses a session runs
	Claude   = "claude"
	Opencode = "opencode"
)

// Harness one agent CLI a session runs, as the pages offer it
type Harness struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	About string `json:"about"`
	Icon  string `json:"icon"`
	// MeshOnly runs on the mesh's models alone, never an Anthropic one
	MeshOnly bool `json:"meshOnly"`
	// Site where its installer comes from, for the install prompt
	Site string `json:"site"`
	// bin its command; path what a non-login PATH lacks of where it installs
	bin, path, install string
}

// Harnesses every harness a session may run, in the pages' order
var Harnesses = []Harness{
	{ID: Claude, Label: "Claude Code", About: "an agent in the project: it reads, runs and edits", Icon: "spark",
		Site: "claude.ai", bin: "claude", path: pathPrefix, install: "curl -fsSL https://claude.ai/install.sh | bash 2>&1"},
	{ID: Opencode, Label: "opencode", About: "an open agent in the project, on the mesh's models", Icon: "terminal", MeshOnly: true,
		Site: "opencode.ai", bin: "opencode", path: ocPath, install: "curl -fsSL https://opencode.ai/install | bash 2>&1"},
}

// harnessByID the harness named, nil for none
func harnessByID(id string) *Harness {
	for i := range Harnesses {
		if Harnesses[i].ID == id {
			return &Harnesses[i]
		}
	}
	return nil
}

func harnessIDs() []string {
	ids := []string{}
	for _, h := range Harnesses {
		ids = append(ids, h.ID)
	}
	return ids
}

// harnessOf a record's harness, claude for the ones from before there was a choice
func harnessOf(r Record) string {
	if r.Harness == "" {
		return Claude
	}
	return r.Harness
}

// missing a harness not found on host, as a session's error
func missing(id, host string) string {
	label := id
	if h := harnessByID(id); h != nil {
		label = h.Label
	}
	return fmt.Sprintf("%s isn't installed on %s: install it there first", label, host)
}

// probeCommand every harness on a line: id, 1 when found or 0, its version
func probeCommand() string {
	var s strings.Builder
	for _, h := range Harnesses {
		fmt.Fprintf(&s, "(%scommand -v %s >/dev/null 2>&1 && printf '%s\\t1\\t%%s\\n' \"$(%s --version 2>/dev/null | head -n 1)\" || printf '%s\\t0\\t\\n'); ",
			h.path, h.bin, h.ID, h.bin, h.ID)
	}
	return "sh -c " + quote(s.String())
}

// HarnessState a harness as found on one host
type HarnessState struct {
	Harness
	Installed bool   `json:"installed"`
	Version   string `json:"version"`
}

var (
	probeMu sync.Mutex
	probed  = map[string]probeHit{}
)

type probeHit struct {
	at  time.Time
	out []HarnessState
}

// probeTTL a host's harnesses taken as found for this long, an install clearing it
const probeTTL = 2 * time.Minute

// HarnessesOn every harness and whether host has it, as the login finds it
func HarnessesOn(host string, c Creds, fresh bool) (int, any) {
	if !hostRe.MatchString(host) {
		return 400, errB("pick a host")
	}
	k := host + "|" + c.User
	probeMu.Lock()
	hit, ok := probed[k]
	probeMu.Unlock()
	if ok && !fresh && time.Since(hit.at) < probeTTL {
		return 200, map[string]any{"host": host, "harnesses": hit.out}
	}
	cl, err := dial(host, c.User, c.Pass)
	if err != nil {
		return 502, errB(err.Error())
	}
	defer cl.Close()
	code, out, err := run(cl, probeCommand(), "", 30*time.Second)
	if err != nil {
		return 502, errB(err.Error())
	}
	low := strings.ToLower(out)
	if code != 0 && (strings.Contains(low, "not recognized") || strings.Contains(low, "commandnotfound")) {
		return 200, map[string]any{"host": host, "harnesses": []HarnessState{}, "why": host + " runs Windows, where no harness runs yet"}
	}
	res := parseProbe(out)
	probeMu.Lock()
	probed[k] = probeHit{at: time.Now(), out: res}
	probeMu.Unlock()
	return 200, map[string]any{"host": host, "harnesses": res}
}

// parseProbe the probe's lines as every harness's state, one it didn't name missing
func parseProbe(out string) []HarnessState {
	found := map[string][]string{}
	for _, l := range strings.Split(out, "\n") {
		if f := strings.SplitN(strings.TrimRight(l, "\r"), "\t", 3); len(f) == 3 {
			found[f[0]] = f[1:]
		}
	}
	res := []HarnessState{}
	for _, h := range Harnesses {
		st := HarnessState{Harness: h}
		if f := found[h.ID]; len(f) == 2 && f[0] == "1" {
			st.Installed, st.Version = true, strings.TrimSpace(f[1])
		}
		res = append(res, st)
	}
	return res
}

var (
	installMu sync.Mutex
	installs  = map[string]bool{}
)

// InstallOf a harness's official installer run on host as the login
func InstallOf(host string, c Creds, id string) (int, any) {
	h := harnessByID(id)
	switch {
	case !hostRe.MatchString(host):
		return 400, errB("pick a host")
	case h == nil:
		return 400, errB("harness is one of " + strings.Join(harnessIDs(), ", "))
	}
	k := host + "|" + c.User + "|" + id
	installMu.Lock()
	if installs[k] {
		installMu.Unlock()
		return 409, errB("already installing on " + host)
	}
	installs[k] = true
	installMu.Unlock()
	defer func() {
		installMu.Lock()
		delete(installs, k)
		installMu.Unlock()
	}()
	ok, out, err := install(host, c, "sh -c "+quote(h.path+h.install))
	probeMu.Lock()
	delete(probed, host+"|"+c.User)
	probeMu.Unlock()
	if err != nil && out == "" {
		return 502, errB(err.Error())
	}
	return 200, map[string]any{"ok": ok && err == nil, "out": out}
}
