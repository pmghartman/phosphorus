// dualrun: the same calls against a JS and a Go frontend, their answers
// diffed with the volatile fields masked; -cookie-from reuses one side's
// login on the other, for state handed across
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"context"
	"github.com/coder/websocket"
)

var volatile = regexp.MustCompile(`^(bootId|pollMs|at|timestamp|mtime|checkedAt|serverSince|news|started|deadline|ended|prefsAt|wallpaper|e|pwAt|salt|hash|iv|tag|data|rttMs|id|seq|uptime|since|sysDigest)$`)

type side struct {
	name   string
	base   string
	cookie string
}

type result struct {
	status int
	body   any
	raw    string
	set    []string
}

func (s *side) do(method, path string, body any, extra map[string]string) result {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, s.base+path, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if s.cookie != "" {
		req.Header.Set("Cookie", s.cookie)
	}
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return result{status: -1, raw: err.Error()}
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	var v any
	if json.Unmarshal(b, &v) != nil {
		v = nil
	}
	r := result{status: res.StatusCode, body: v, raw: string(b), set: res.Header.Values("Set-Cookie")}
	for _, c := range r.set {
		if strings.HasPrefix(c, "phosphorus-user=") && !strings.HasPrefix(c, "phosphorus-user=;") {
			s.cookie = strings.SplitN(c, ";", 2)[0]
		}
	}
	return r
}

func mask(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, x := range t {
			if volatile.MatchString(k) {
				out[k] = "<v>"
				continue
			}
			out[k] = mask(x)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = mask(x)
		}
		return out
	}
	return v
}

var sideDir = regexp.MustCompile(`/dualrun/(js|go)/`)

func canon(v any) string {
	b, _ := json.MarshalIndent(mask(nested(v)), "", " ")
	return sideDir.ReplaceAllString(string(b), "/dualrun/side/")
}

// nested JSON held in a string (an mcp result's text) parsed for comparing
func nested(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, x := range t {
			out[k] = nested(x)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = nested(x)
		}
		return out
	case string:
		var x any
		if (strings.HasPrefix(t, "{") || strings.HasPrefix(t, "[")) && json.Unmarshal([]byte(t), &x) == nil {
			return nested(x)
		}
	}
	return v
}

var fails, passes int

func compare(label string, a, b result) {
	ca, cb := canon(a.body), canon(b.body)
	if a.body == nil && b.body == nil {
		ca, cb = strings.TrimSpace(a.raw), strings.TrimSpace(b.raw)
	}
	if a.status != b.status || ca != cb {
		fails++
		fmt.Printf("DIFF %s\n  js %d %s\n  go %d %s\n", label, a.status, trim(ca), b.status, trim(cb))
		return
	}
	passes++
	fmt.Printf("ok   %s (%d)\n", label, a.status)
}

func trim(s string) string {
	s = strings.ReplaceAll(s, "\n", "")
	if len(s) > 900 {
		return s[:900] + "..."
	}
	return s
}

type call struct {
	label        string
	method, path string
	body         any
	headers      map[string]string
}

func both(js, gs *side, c call) (result, result) {
	a := js.do(c.method, c.path, c.body, c.headers)
	b := gs.do(c.method, c.path, c.body, c.headers)
	compare(c.label, a, b)
	return a, b
}

func wsHistory(s *side) any {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	h := http.Header{}
	if s.cookie != "" {
		h.Set("Cookie", s.cookie)
	}
	c, _, err := websocket.Dial(ctx, strings.Replace(s.base, "http", "ws", 1)+"/ws", &websocket.DialOptions{HTTPHeader: h})
	if err != nil {
		return err.Error()
	}
	defer c.CloseNow()
	c.Write(ctx, websocket.MessageText, []byte(`{"type":"join","name":"tester","color":"#4f9eff"}`))
	c.Write(ctx, websocket.MessageText, []byte(`{"type":"message","text":"hello **world** $x$"}`))
	got := []any{}
	for len(got) < 6 {
		_, b, err := c.Read(ctx)
		if err != nil {
			break
		}
		var m map[string]any
		json.Unmarshal(b, &m)
		if m["type"] == "presence" || m["type"] == "system" {
			continue
		}
		delete(m, "html")
		if msgs, ok := m["messages"].([]any); ok {
			for _, x := range msgs {
				delete(x.(map[string]any), "html")
			}
		}
		got = append(got, m)
		if m["type"] == "message" {
			break
		}
	}
	return got
}

func main() {
	jsURL := flag.String("js", "http://127.0.0.1:18090", "")
	goURL := flag.String("go", "http://127.0.0.1:28090", "")
	handoff := flag.Bool("handoff", false, "go reads js's state: js's login used on go")
	flag.Parse()
	js := &side{name: "js", base: *jsURL}
	gs := &side{name: "go", base: *goURL}

	if *handoff {
		b, _ := os.ReadFile("/tmp/dualrun/cookie")
		js.cookie, gs.cookie = string(b), string(b)
		both(js, gs, call{"me with js's cookie", "GET", "/api/me", nil, nil})
		both(js, gs, call{"users list", "GET", "/api/users", nil, nil})
		both(js, gs, call{"home list", "GET", "/api/files/dualrun/list?share=home&path=", nil, nil})
		both(js, gs, call{"read saved", "GET", "/api/files/dualrun/read?share=0&path=docs/note.md", nil, nil})
		ha, hb := wsHistory(js), wsHistory(gs)
		compare("chat history after handoff", result{body: ha}, result{body: hb})
		fmt.Printf("\n%d ok, %d diff\n", passes, fails)
		if fails > 0 {
			os.Exit(1)
		}
		return
	}

	same := map[string]string{"Origin": ""}
	calls := []call{
		{"state", "GET", "/api/state", nil, nil},
		{"snapshot", "GET", "/api/mesh/snapshot?since=0", nil, nil},
		{"update status", "GET", "/api/update/local/status", nil, nil},
		{"me logged out", "GET", "/api/me", nil, nil},
		{"sys stamps from loopback", "GET", "/api/sys/stamps", nil, nil},
		{"git view from loopback", "GET", "/api/git/view", nil, nil},
		{"unknown api", "GET", "/api/nope", nil, nil},
		{"bad json strict", "POST", "/api/model/role", "[", nil},
		{"model role bad", "POST", "/api/model/role", map[string]any{"role": "gorilla"}, nil},
		{"model role bad model", "POST", "/api/model/role", map[string]any{"role": "chimp", "model": "nope"}, nil},
		{"model key bad", "POST", "/api/model/key", map[string]any{"provider": "phosphorus", "key": "x"}, nil},
		{"projects", "GET", "/api/projects", nil, nil},
		{"project missing", "GET", "/api/projects/dualrun/abcdefabcdef", nil, nil},
		{"project start bad", "POST", "/api/projects", map[string]any{"title": ""}, nil},
		{"files info", "GET", "/api/files/dualrun/info", nil, nil},
		{"files list root", "GET", "/api/files/dualrun/list?share=0&path=", nil, nil},
		{"files list traversal", "GET", "/api/files/dualrun/list?share=0&path=../../etc", nil, nil},
		{"files read missing", "GET", "/api/files/dualrun/read?share=0&path=nope.txt", nil, nil},
		{"files no share", "GET", "/api/files/dualrun/list?share=9", nil, nil},
		{"home logged out", "GET", "/api/files/dualrun/list?share=home&path=", nil, nil},
		{"login wrong", "POST", "/api/login", map[string]any{"user": "admin", "pass": "x"}, same},
		{"login boot admin", "POST", "/api/login", map[string]any{"user": "admin", "pass": "adminpass"}, same},
		{"me as boot admin", "GET", "/api/me", nil, nil},
		{"users as boot", "GET", "/api/users", nil, nil},
		{"create user bad", "POST", "/api/users", map[string]any{"name": "shared", "pass": "abcd"}, same},
		{"create user", "POST", "/api/users", map[string]any{"name": "ann", "pass": "hunter22", "admin": true}, same},
		{"create dup", "POST", "/api/users", map[string]any{"name": "ann", "pass": "hunter22"}, same},
		{"boot off once admin", "GET", "/api/me", nil, nil},
		{"login ann", "POST", "/api/login", map[string]any{"user": "ann", "pass": "hunter22"}, same},
		{"me ann", "GET", "/api/me", nil, nil},
		{"vault", "POST", "/api/me/vault", map[string]any{"vault": map[string]any{"hosts": map[string]any{"box": map[string]any{"user": "u", "pass": "p"}, "BAD": map[string]any{"user": "x"}}}}, same},
		{"prefs", "POST", "/api/me/prefs", map[string]any{"prefs": map[string]any{"theme": "dark", "junk": "x", "icons": ""}}, same},
		{"me after", "GET", "/api/me", nil, nil},
		{"home list ann", "GET", "/api/files/dualrun/list?share=home&path=", nil, nil},
		{"home sys refused", "GET", "/api/files/dualrun/list?share=home&path=sys", nil, nil},
		{"mkdir", "POST", "/api/files/dualrun/mkdir?share=0", map[string]any{"path": "docs"}, nil},
		{"mkdir again", "POST", "/api/files/dualrun/mkdir?share=0", map[string]any{"path": "docs"}, nil},
		{"save", "POST", "/api/files/dualrun/save?share=0", map[string]any{"path": "docs/note.md", "text": "hello\r\nworld\n"}, nil},
		{"save edit", "POST", "/api/files/dualrun/save?share=0", map[string]any{"path": "docs/note.md", "old": "world", "new": "there"}, nil},
		{"save edit missing", "POST", "/api/files/dualrun/save?share=0", map[string]any{"path": "docs/note.md", "old": "zzz", "new": "y"}, nil},
		{"read", "GET", "/api/files/dualrun/read?share=0&path=docs/note.md", nil, nil},
		{"tree", "GET", "/api/files/dualrun/tree?share=0&path=&depth=3", nil, nil},
		{"tree glob", "GET", "/api/files/dualrun/tree?share=0&path=&depth=3&match=*.MD", nil, nil},
		{"rename into", "POST", "/api/files/dualrun/rename?share=0", map[string]any{"from": "docs/note.md", "to": "docs/sub/"}, nil},
		{"list docs", "GET", "/api/files/dualrun/list?share=0&path=docs", nil, nil},
		{"rename back", "POST", "/api/files/dualrun/rename?share=0", map[string]any{"from": "docs/sub/note.md", "to": "docs/note.md"}, nil},
		{"run not runnable", "POST", "/api/files/dualrun/run?share=0", map[string]any{"path": "docs/note.md"}, nil},
		{"upload bad chunk", "POST", "/api/files/dualrun/upload?share=0&path=up.bin&id=x&offset=0&total=3", "abc", nil},
		{"delete share root", "POST", "/api/files/dualrun/delete?share=0", map[string]any{"path": ""}, nil},
		{"mirror off home", "POST", "/api/files/dualrun/mirror?share=0", map[string]any{"path": "x", "on": true}, nil},
		{"chain bad action", "POST", "/api/update/chain", map[string]any{"action": "x"}, nil},
		{"chain cancel none", "POST", "/api/update/chain", map[string]any{"action": "cancel"}, nil},
		{"mcp init", "POST", "/api/mcp", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}}, nil},
		{"mcp tools", "POST", "/api/mcp", map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, nil},
		{"mcp call git", "POST", "/api/mcp", map[string]any{"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": map[string]any{"name": "git", "arguments": map[string]any{}}}, nil},
		{"mcp files_read", "POST", "/api/mcp", map[string]any{"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": map[string]any{"name": "files_read", "arguments": map[string]any{"host": "dualrun", "share": "0", "path": "docs/note.md"}}}, nil},
		{"mcp press no asker", "POST", "/api/mcp", map[string]any{"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": map[string]any{"name": "game_power", "arguments": map[string]any{"host": "dualrun", "name": "x", "action": "start"}}}, nil},
		{"mcp notification", "POST", "/api/mcp", map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}, nil},
		{"mcp bad", "POST", "/api/mcp", map[string]any{"jsonrpc": "1.0"}, nil},
		{"terms shared", "GET", "/api/terms/shared", nil, nil},
		{"favicon none", "GET", "/api/favicon/dualrun/web", nil, nil},
		{"media missing", "GET", "/api/chat/media/dualrun/0123456789abcdef0123456789abcdef", nil, nil},
		{"run expired", "GET", "/api/run/dualrun/bad/index.html", nil, nil},
		{"password wrong", "POST", "/api/me/password", map[string]any{"old": "nope", "pass": "newpass1"}, same},
		{"password short", "POST", "/api/me/password", map[string]any{"old": "hunter22", "pass": "x"}, same},
		{"set admin self off", "POST", "/api/users/admin", map[string]any{"name": "ann", "admin": false}, same},
		{"delete self", "POST", "/api/users/delete", map[string]any{"name": "ann"}, same},
		{"wallpaper bad", "POST", "/api/me/wallpaper", map[string]any{"data": "data:text/html;base64,AAAA"}, same},
		{"wallpaper set", "POST", "/api/me/wallpaper", map[string]any{"data": "data:image/png;base64,iVBORw0KGgo="}, same},
		{"wallpaper get", "GET", "/api/me/wallpaper", nil, nil},
		{"logout", "POST", "/api/logout", nil, same},
	}
	for _, c := range calls {
		if s, ok := c.body.(string); ok {
			a := js.doRaw(c.method, c.path, s)
			b := gs.doRaw(c.method, c.path, s)
			compare(c.label, a, b)
			continue
		}
		both(js, gs, c)
	}
	// ann logged in again for the chat and the handoff
	js.do("POST", "/api/login", map[string]any{"user": "ann", "pass": "hunter22"}, nil)
	gs.do("POST", "/api/login", map[string]any{"user": "ann", "pass": "hunter22"}, nil)
	os.WriteFile("/tmp/dualrun/cookie", []byte(js.cookie), 0o600)
	a, b := wsHistory(js), wsHistory(gs)
	compare("chat join, history and a message", result{body: a}, result{body: b})
	fmt.Printf("\n%d ok, %d diff\n", passes, fails)
	if fails > 0 {
		os.Exit(1)
	}
}

func (s *side) doRaw(method, path, body string) result {
	req, _ := http.NewRequest(method, s.base+path, strings.NewReader(body))
	if s.cookie != "" {
		req.Header.Set("Cookie", s.cookie)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return result{status: -1, raw: err.Error()}
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	var v any
	if json.Unmarshal(b, &v) != nil {
		v = nil
	}
	_ = sort.Strings
	return result{status: res.StatusCode, body: v, raw: string(b)}
}
