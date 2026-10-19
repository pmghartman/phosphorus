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
