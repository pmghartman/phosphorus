package mcp

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"regexp"
	"strings"
	"testing"
)

func rpc(method string, params map[string]any) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
}

func TestHandle(t *testing.T) {
	Init(Src{Self: func() map[string]any { return map[string]any{"host": "h", "version": "1"} }})
	_, out := Handle(rpc("ping", nil), false, nil)
	if out.(map[string]any)["result"] == nil {
		t.Fatal("ping")
	}
	list := func(c *Caller) int {
		_, o := Handle(rpc("tools/list", nil), false, c)
		return len(o.(map[string]any)["result"].(map[string]any)["tools"].([]any))
	}
	user, admin := list(&Caller{User: "u"}), list(&Caller{User: "a", Admin: true})
	if user == 0 || admin <= user {
		t.Fatalf("a key sees %d tools, an admin's %d", user, admin)
	}
	_, o := Handle(rpc("tools/call", map[string]any{"name": "nope"}), false, &Caller{User: "u"})
	if o.(map[string]any)["error"] == nil {
		t.Fatal("unknown tool answered")
	}
	if st, _ := Handle(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}, false, nil); st != 202 {
		t.Fatalf("notification answered %d", st)
	}
}

func TestCallLog(t *testing.T) {
	if d := callDetail(map[string]any{"host": "a", "command": "ls   -la\n/tmp"}); d != "ls -la /tmp" {
		t.Fatalf("detail %q", d)
	}
	if d := callDetail(map[string]any{"n": 1.0, "zz": "z", "b": "b"}); d != "b" {
		t.Fatalf("fallback %q", d)
	}
	id := callBegin("tester", "terminal_run", "ls", "")
	if c := Calls("tester"); len(c["calls"].([]any)) != 1 {
		t.Fatalf("live %v", c)
	}
	callEnd("tester", id, "boom")
	c := Calls("tester")
	rec := c["recent"].([]any)
	if len(c["calls"].([]any)) != 0 || len(rec) != 1 || rec[0].(map[string]any)["error"] != "boom" {
		t.Fatalf("done %v", c)
	}
}

// backticked words in the skill that are arguments, not tools
var skillWords = map[string]bool{"dry_run": true, "wait_s": true, "base_path": true, "clone_url": true, "mcp__phosphorus__": true, "bad_input": true, "not_found": true}

func TestSkill(t *testing.T) {
	Init(Src{Self: func() map[string]any { return map[string]any{"host": "h", "version": "1.2"} }})
	b, err := Skill("pat", true, "https://mesh.example")
	if err != nil {
		t.Fatal(err)
	}
	z, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, f := range z.File {
		r, _ := f.Open()
		s, _ := io.ReadAll(r)
		got[f.Name] = string(s)
	}
	for n, s := range got {
		if !strings.HasPrefix(n, "phosphorus/") {
			t.Fatalf("%s outside the skill's folder", n)
		}
		if strings.Contains(s, "{{") || strings.Contains(s, "$ARGUMENTS") {
			t.Fatalf("%s left a placeholder", n)
		}
		if strings.Contains(s, "/api/mcp") {
			t.Fatalf("%s carries a key", n)
		}
	}
	sk := got["phosphorus/SKILL.md"]
	if !strings.HasPrefix(sk, "---\nname: phosphorus\ndescription: ") || !strings.Contains(sk, "https://mesh.example") {
		t.Fatal("SKILL.md frontmatter or base missing")
	}
	for _, f := range []string{"status", "diagnose", "run", "files", "service", "update", "chat", "git"} {
		if got["phosphorus/references/"+f+".md"] == "" {
			t.Fatalf("no references/%s.md", f)
		}
		if !strings.Contains(sk, "references/"+f+".md") {
			t.Fatalf("SKILL.md never points at %s", f)
		}
	}
	// every tool the skill names is one the server lists
	toolsOnce.Do(buildOnce)
	for _, body := range got {
		for _, m := range regexp.MustCompile("`([a-z]+_[a-z_]+)`").FindAllStringSubmatch(body, -1) {
			if toolIndex[m[1]] == nil && !skillWords[m[1]] {
				t.Fatalf("the skill names %s, no tool", m[1])
			}
		}
	}
}

func TestMeshHostsSelfVersion(t *testing.T) {
	rows := []map[string]any{{"name": "h"}, {"name": "p", "version": "1"}}
	Init(Src{Self: func() map[string]any { return map[string]any{"host": "h", "version": "2"} },
		Domain: func() string { return "" }, Tailnet: func() []map[string]any { return rows }})
	_, o := Handle(rpc("tools/call", map[string]any{"name": "mesh_hosts"}), false, &Caller{User: "u"})
	text := o.(map[string]any)["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	var got struct{ Hosts []map[string]any }
	json.Unmarshal([]byte(text), &got)
	if got.Hosts[0]["version"] != "2" {
		t.Fatalf("self row unversioned: %s", text)
	}
	if rows[0]["version"] != nil {
		t.Fatal("the mesh's own row changed")
	}
}

func TestStatsShape(t *testing.T) {
	long := strings.Repeat("x", 300)
	s := map[string]any{"host": "h", "cpu": map[string]any{"total": 12.5, "cores": []any{1.0, 2.0}, "load": []any{0.123456, nil, 1.0}},
		"mem":   map[string]any{"total": 200.0, "used": 50.0, "avail": 150.0, "cached": 9.0, "swapTotal": 10.0, "swapUsed": 5.0},
		"disk":  map[string]any{"count": 1.0, "total": 1000.0, "used": 778.0},
		"gpus":  []any{map[string]any{"name": "g", "util": 38.886, "temp": nil}},
		"procs": map[string]any{"count": 9.0, "top": []any{map[string]any{"name": "a", "cmd": long}, map[string]any{}, map[string]any{}, map[string]any{}, map[string]any{}, map[string]any{}, map[string]any{}}},
		"parts": []any{map[string]any{"name": "frontend", "cpu": 1.0, "mem": 2.0, "pids": 3.0}}}
	st := statsShape(s)
	if st["containers"] != nil || len(st["parts"].([]any)) != 1 {
		t.Fatalf("parts %v", st)
	}
	if m := st["mem"].(map[string]any); m["usedPct"] != 25.0 || m["cached"] != nil {
		t.Fatalf("mem %v", m)
	}
	top := st["procs"].(map[string]any)["top"].([]any)
	if len(top) != 6 || len([]rune(top[0].(map[string]any)["cmd"].(string))) != 101 {
		t.Fatalf("procs %v", top)
	}
	if g := st["gpus"].([]any)[0].(map[string]any); g["util"] != 38.9 || g["temp"] != nil {
		t.Fatalf("gpu %v", g)
	}
	r := statsRow(st)
	if r["diskPct"] != 77.8 || r["swapPct"] != 50.0 || r["gpuPct"] != 38.9 || r["cpuPct"] != 12.5 {
		t.Fatalf("row %v", r)
	}
}

func TestKeyGrants(t *testing.T) {
	Init(Src{Self: func() map[string]any { return map[string]any{"host": "h", "version": "1"} }, Domain: func() string { return "mesh.example" }})
	bare := func() *Caller { return &Caller{User: "u", Pages: func() map[string]any { return nil }} }
	git := &Caller{User: "u", Hosts: func() []string { return []string{"b", "a"} },
		Pages: func() map[string]any { return map[string]any{"git": map[string]any{"user": "u", "pass": "p"}} }}
	names := func(c *Caller) map[string]string {
		_, o := Handle(rpc("tools/list", nil), false, c)
		out := map[string]string{}
		for _, x := range o.(map[string]any)["result"].(map[string]any)["tools"].([]any) {
			m := x.(map[string]any)
			out[m["name"].(string)] = m["description"].(string)
		}
		return out
	}
	if _, ok := names(bare())["forgejo"]; ok {
		t.Fatal("forgejo listed without a forgejo login")
	}
	g := names(git)
	if _, ok := g["forgejo"]; !ok || !strings.Contains(g["terminal_run"], "saved logins: a, b;") {
		t.Fatalf("forgejo or logins missing: %q", g["terminal_run"])
	}
	_, o := Handle(rpc("tools/call", map[string]any{"name": "forgejo"}), false, bare())
	if e := o.(map[string]any)["error"].(map[string]any)["message"].(string); !strings.Contains(e, "off this key") {
		t.Fatalf("withheld tool said %q", e)
	}
	_, o = Handle(rpc("initialize", nil), false, bare())
	ins := o.(map[string]any)["result"].(map[string]any)["instructions"].(string)
	for _, w := range []string{"acts as u, a user", "no saved host logins", "No forgejo login", "Off this key:", "host_power"} {
		if !strings.Contains(ins, w) {
			t.Fatalf("instructions lack %q: %s", w, ins)
		}
	}
}
