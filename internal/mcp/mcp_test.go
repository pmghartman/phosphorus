package mcp

import (
	"archive/zip"
	"bytes"
	"io"
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
	for _, f := range []string{"tools", "playbooks", "status", "diagnose", "run", "files", "service", "update", "chat", "git"} {
		if got["phosphorus/references/"+f+".md"] == "" {
			t.Fatalf("no references/%s.md", f)
		}
		if f != "tools" && !strings.Contains(sk, "references/"+f+".md") {
			t.Fatalf("SKILL.md never points at %s", f)
		}
	}
	if !strings.Contains(got["phosphorus/references/tools.md"], "## host_power") {
		t.Fatal("admin tools missing")
	}
}
