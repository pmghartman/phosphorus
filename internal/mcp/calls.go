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
	host   string
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

// watchers wanting a nudge when a user's status moves
var watchers = struct {
	sync.Mutex
	by map[string]map[chan struct{}]bool
}{by: map[string]map[chan struct{}]bool{}}

// Watch a channel nudged on any change to a user's calls, and its stop
func Watch(user string) (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	watchers.Lock()
	if watchers.by[user] == nil {
		watchers.by[user] = map[chan struct{}]bool{}
	}
	watchers.by[user][ch] = true
	watchers.Unlock()
	return ch, func() {
		watchers.Lock()
		delete(watchers.by[user], ch)
		if len(watchers.by[user]) == 0 {
			delete(watchers.by, user)
		}
		watchers.Unlock()
	}
}

func poke(user string) {
	watchers.Lock()
	defer watchers.Unlock()
	for ch := range watchers.by[user] {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

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
	poke(user)
}

// noteClient the agent that last opened a session on a user's key, by the name it gives
func noteClient(user, name string) {
	calls.Lock()
	logOf(user).client = name
	calls.Unlock()
	poke(user)
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

func callBegin(user, tool, detail, host string) uint64 {
	calls.Lock()
	calls.next++
	l := logOf(user)
	l.live = append(l.live, liveCall{id: calls.next, tool: tool, detail: detail, host: host, since: util.Now()})
	id := calls.next
	calls.Unlock()
	poke(user)
	return id
}

func callEnd(user string, id uint64, errText string) {
	calls.Lock()
	ended := false
	defer func() {
		calls.Unlock()
		if ended {
			poke(user)
		}
	}()
	l := logOf(user)
	for i, c := range l.live {
		if c.id != id {
			continue
		}
		l.live = append(l.live[:i], l.live[i+1:]...)
		at := util.Now()
		l.done = append([]map[string]any{{"tool": c.tool, "detail": c.detail, "host": c.host, "at": at, "ms": at - c.since, "ok": errText == "", "error": errText}}, l.done...)
		if len(l.done) > recentCalls {
			l.done = l.done[:recentCalls]
		}
		l.at = at
		ended = true
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
		live = append(live, map[string]any{"tool": c.tool, "detail": c.detail, "host": c.host, "since": c.since})
	}
	recent := make([]any, 0, len(l.done))
	for _, d := range l.done {
		recent = append(recent, d)
	}
	return map[string]any{"calls": live, "recent": recent, "seen": l.seen, "at": l.at, "client": l.client, "now": util.Now()}
}

// callHost the host a call acts on, a copy's source or destination when it names none
func callHost(args map[string]any) string {
	if h, ok := args["host"].(string); ok && h != "" {
		return h
	}
	for _, k := range []string{"from", "to"} {
		if h, ok := util.Obj(args[k])["host"].(string); ok && h != "" {
			return h
		}
	}
	return ""
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
