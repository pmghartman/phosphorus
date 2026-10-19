package mcp

import "testing"

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
	id := callBegin("tester", "terminal_run", "ls")
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
