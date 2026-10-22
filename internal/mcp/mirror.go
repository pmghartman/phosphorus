package mcp

// a keyed call shown on the user's own pages as it happens: its start with the
// arguments, its end with the outcome; each user's sent in order, never holding the call

import (
	"sync"

	"github.com/pmghartman/phosphorus/internal/util"
)

const (
	mirrorQueue = 64
	mirrorArg   = 4000
	mirrorOut   = 64 << 10
)

// arguments never put on a screen: a service's own auth
var mirrorHidden = map[string]bool{"headers": true}

// tools whose output the page prints, as a console does
var mirrorPrinted = map[string]bool{"terminal_run": true, "host_logs": true,
	"service_request": true, "forgejo": true, "host_config": true, "service_edit": true, "config_set": true, "host_power": true,
	"game_power": true, "terminal_screen": true}

var mirrors = struct {
	sync.Mutex
	by map[string]chan map[string]any
}{by: map[string]chan map[string]any{}}

// mirror one step to user's pages on every host, dropped when they fall behind
func mirror(user string, step map[string]any) {
	send := src.Actions.UserUIAsync
	if send == nil {
		return
	}
	step["kind"] = "agent"
	mirrors.Lock()
	ch := mirrors.by[user]
	if ch == nil {
		ch = make(chan map[string]any, mirrorQueue)
		mirrors.by[user] = ch
		go func() {
			for s := range ch {
				send(user, s)
			}
		}()
	}
	mirrors.Unlock()
	select {
	case ch <- step:
	default:
	}
}

func mirrorArgs(args map[string]any) map[string]any {
	out := make(map[string]any, len(args))
	for k, v := range args {
		if mirrorHidden[k] {
			continue
		}
		if s, ok := v.(string); ok {
			v = clipBytes(s, mirrorArg, false)
		}
		out[k] = v
	}
	return out
}

// mirrorEnd a call's outcome; a printed tool's shell output as typed, else its JSON, its tail kept
func mirrorEnd(step map[string]any, tool string, out any) {
	if !mirrorPrinted[tool] || out == nil {
		return
	}
	m := util.Obj(toAny(out))
	if m != nil {
		step["exit"] = m["exit"]
		step["timedOut"] = m["timedOut"] == true
	}
	switch {
	case m != nil && m["output"] != nil:
		step["out"] = clipBytes(util.Str(m["output"]), mirrorOut, true)
	case m != nil && m["stdout"] != nil:
		step["out"] = clipBytes(util.Str(m["stdout"])+util.Str(m["stderr"]), mirrorOut, true)
	case m != nil && m["screen"] != nil:
		step["out"] = clipBytes(util.Str(m["screen"]), mirrorOut, true)
	default:
		step["out"] = clipBytes(string(util.Marshal(toAny(out))), mirrorOut, true)
	}
}

// clipBytes s to n bytes, its head or its tail, never splitting a rune
func clipBytes(s string, n int, tail bool) string {
	if len(s) <= n {
		return s
	}
	if tail {
		return util.UTF8([]byte(s[len(s)-n:]))
	}
	return util.UTF8([]byte(s[:n])) + "…"
}
