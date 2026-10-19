package mcp

// what the tools share past one call: terminals opened and not yet logged in,
// the audit of every write a key made

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/util"
)

const (
	openedFor_  = 10 * time.Minute
	auditMax    = 4 << 20
	auditArgMax = 400
)

var (
	openedMu sync.Mutex
	opened   = map[string]time.Time{}
)

// noteOpened a terminal opened on who's page for host, pending its login
func noteOpened(who, host string) {
	openedMu.Lock()
	opened[who+"\x00"+host] = time.Now()
	openedMu.Unlock()
}

// openedFor whether a terminal for host was opened for who in the last ten minutes
func openedFor(who, host string) bool {
	openedMu.Lock()
	defer openedMu.Unlock()
	at, ok := opened[who+"\x00"+host]
	return ok && time.Since(at) < openedFor_
}

// viaOf the agent a keyed call came through: as it says, else the name its session
// opened with, else just agent
func viaOf(m Meta) string {
	if m.Caller == nil {
		return ""
	}
	if m.Caller.Via != "" {
		return m.Caller.Via
	}
	if c := clientOf(m.Caller.User); c != "" {
		return c
	}
	return "agent"
}

// channelKnown nil for blank, mesh, a known person's dm or a channel with lines
func channelKnown(m Meta, want string) error {
	if want == "" || want == "mesh" {
		return nil
	}
	if p, ok := strings.CutPrefix(want, "dm:"); ok {
		if src.Known(p) {
			return nil
		}
		return errc("not_found", "no one called %s", p)
	}
	seen := map[string]bool{"mesh": true}
	for _, r := range chatRows(m, "") {
		seen[str(r["channel"])] = true
	}
	if seen[want] {
		return nil
	}
	names := []string{}
	for k := range seen {
		names = append(names, k)
	}
	return errc("not_found", "no channel %s; there are %s, or dm:<name>", want, strings.Join(names, ", "))
}

var auditMu sync.Mutex

func auditFile() string { return filepath.Join(util.StateDir, "mcp-audit.jsonl") }

// audit one write a key made, kept per host in state/mcp-audit.jsonl
func audit(c *Caller, tool string, args map[string]any, err error) {
	a := map[string]any{}
	for k, v := range args {
		b := util.Marshal(v)
		if len(b) > auditArgMax {
			a[k] = string(b[:auditArgMax]) + "…"
			continue
		}
		a[k] = json.RawMessage(b)
	}
	row := map[string]any{"at": time.Now().UTC().Format(time.RFC3339), "user": c.User, "via": viaOf(Meta{Caller: c}),
		"tool": tool, "args": a, "ok": err == nil, "host": src.Self()["host"]}
	if err != nil {
		row["error"] = err.Error()
	}
	auditMu.Lock()
	defer auditMu.Unlock()
	p := auditFile()
	// the older half dropped once it grows past its cap
	if st, e := os.Stat(p); e == nil && st.Size() > auditMax {
		if b, e := os.ReadFile(p); e == nil {
			os.WriteFile(p, b[len(b)/2:], 0o600)
		}
	}
	f, e := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if e != nil {
		return
	}
	defer f.Close()
	f.Write(append(util.Marshal(row), '\n'))
}

// auditRows this host's audit, newest last; user's own unless all
func auditRows(user string, all bool, limit int) []map[string]any {
	auditMu.Lock()
	defer auditMu.Unlock()
	f, err := os.Open(auditFile())
	if err != nil {
		return []map[string]any{}
	}
	defer f.Close()
	out := []map[string]any{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		var r map[string]any
		if json.Unmarshal(sc.Bytes(), &r) != nil || (!all && str(r["user"]) != user) {
			continue
		}
		// a partial first line after a trim skipped
		if r["tool"] == nil {
			continue
		}
		out = append(out, r)
	}
	if len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out
}
