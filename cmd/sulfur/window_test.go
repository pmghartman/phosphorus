package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestOriginOf(t *testing.T) {
	if got := originOf("http://127.0.0.1:47615/sulfur/"); got != "http://127.0.0.1:47615" {
		t.Fatal(got)
	}
}

func TestOpenURLOnlyWeb(t *testing.T) {
	for _, bad := range []string{"", "file:///etc/passwd", "javascript:alert(1)", "http://", "notepad.exe", "custom:run"} {
		if err := openURL(bad); err == nil {
			t.Errorf("%q opened", bad)
		}
	}
}

func TestRPCBindAndCall(t *testing.T) {
	var inits []string
	h := newRPC()
	h.initJS = func(js string) { inits = append(inits, js) }
	if err := h.Bind("sx_add", func(a, b int) int { return a + b }); err != nil {
		t.Fatal(err)
	}
	if err := h.Bind("sx_bad", 3); err == nil {
		t.Fatal("a value bound")
	}
	if len(inits) != 1 || !strings.Contains(inits[0], `"sx_add"`) {
		t.Fatal(inits)
	}
	out, err := call(h.fns["sx_add"], []json.RawMessage{json.RawMessage("2"), json.RawMessage("3")})
	if err != nil || out != 5 {
		t.Fatal(out, err)
	}
	if _, err := call(h.fns["sx_add"], []json.RawMessage{json.RawMessage("2")}); err == nil {
		t.Fatal("too few arguments taken")
	}
}

func TestRPCDispatchRuns(t *testing.T) {
	h := newRPC()
	ran := 0
	h.post = func(id uintptr) { h.run(id) }
	h.Dispatch(func() { ran++ })
	if ran != 1 || len(h.queue) != 0 {
		t.Fatal(ran, len(h.queue))
	}
}
