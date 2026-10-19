package mcp

import (
	_ "embed"
	"encoding/base64"
	"sort"
	"strings"
	"sync"

	"github.com/pmghartman/phosphorus/internal/util"
)

// a keyed user's calls on this host, in flight and just done, for the agent tray

const recentCalls = 40

type liveCall struct {
	id     uint64
	tool   string
	detail string
	since  int64
}

type callLog struct {
	live   []liveCall
	done   []map[string]any
	seen   int64
	at     int64
	client string
}

var calls = struct {
	sync.Mutex
	next uint64
	by   map[string]*callLog
}{by: map[string]*callLog{}}

func logOf(user string) *callLog {
	l := calls.by[user]
	if l == nil {
		l = &callLog{}
		calls.by[user] = l
	}
	return l
}

// markSeen any request on a user's key, its agent's connector saying it's there
func markSeen(user string) {
	calls.Lock()
	logOf(user).seen = util.Now()
	calls.Unlock()
}

// noteClient the agent that last opened a session on a user's key, by the name it gives
func noteClient(user, name string) {
	calls.Lock()
	logOf(user).client = name
	calls.Unlock()
}

// clientOf that agent's name as a word, claude-ai or Claude Code as claude; blank for none
func clientOf(user string) string {
	calls.Lock()
	defer calls.Unlock()
	l := calls.by[user]
	if l == nil {
		return ""
	}
	w := strings.FieldsFunc(strings.ToLower(l.client), func(r rune) bool { return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9') })
	if len(w) == 0 {
		return ""
	}
	return w[0]
}

func callBegin(user, tool, detail string) uint64 {
	calls.Lock()
	defer calls.Unlock()
	calls.next++
	l := logOf(user)
	l.live = append(l.live, liveCall{id: calls.next, tool: tool, detail: detail, since: util.Now()})
	return calls.next
}

func callEnd(user string, id uint64, errText string) {
	calls.Lock()
	defer calls.Unlock()
	l := logOf(user)
	for i, c := range l.live {
		if c.id != id {
			continue
		}
		l.live = append(l.live[:i], l.live[i+1:]...)
		at := util.Now()
		l.done = append([]map[string]any{{"tool": c.tool, "detail": c.detail, "at": at, "ms": at - c.since, "ok": errText == "", "error": errText}}, l.done...)
		if len(l.done) > recentCalls {
			l.done = l.done[:recentCalls]
		}
		l.at = at
		return
	}
}

// Calls a user's calls on this host: in flight, the recent newest first, when last seen
func Calls(user string) map[string]any {
	calls.Lock()
	defer calls.Unlock()
	l := calls.by[user]
	if l == nil {
		return map[string]any{"calls": []any{}, "recent": []any{}, "seen": 0, "at": 0, "client": "", "now": util.Now()}
	}
	live := make([]any, 0, len(l.live))
	for _, c := range l.live {
		live = append(live, map[string]any{"tool": c.tool, "detail": c.detail, "since": c.since})
	}
	recent := make([]any, 0, len(l.done))
	for _, d := range l.done {
		recent = append(recent, d)
	}
	return map[string]any{"calls": live, "recent": recent, "seen": l.seen, "at": l.at, "client": l.client, "now": util.Now()}
}

var detailKeys = []string{"command", "script", "path", "file", "url", "query", "host", "name", "repo", "text"}

// callDetail a call's arguments in a line: the usual subject keys first, else the first string
func callDetail(args map[string]any) string {
	s := ""
	for _, k := range detailKeys {
		if v, ok := args[k].(string); ok && v != "" {
			s = v
			break
		}
	}
	if s == "" {
		ks := make([]string, 0, len(args))
		for k := range args {
			ks = append(ks, k)
		}
		sort.Strings(ks)
		for _, k := range ks {
			if v, ok := args[k].(string); ok && v != "" {
				s = v
				break
			}
		}
	}
	r := []rune(strings.Join(strings.Fields(s), " "))
	if len(r) > 120 {
		return string(r[:120]) + "…"
	}
	return string(r)
}

//go:embed icon.png
var iconPNG []byte

// iconURI the mesh's mark for an agent's connector list, its background clear
var iconURI = "data:image/png;base64," + base64.StdEncoding.EncodeToString(iconPNG)
