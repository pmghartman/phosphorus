package model

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pmghartman/phosphorus/internal/sysfs"
)

func TestTarget(t *testing.T) {
	for in, want := range map[string][2]string{
		"chimp": {"", "chimp"}, "Orangutan": {"", "orangutan"}, "phosphorus/razer": {"razer", ""},
		"claude-3-5-haiku-20241022": {"", "chimp"}, "claude-sonnet-4-5": {"", "orangutan"}, "": {"", "orangutan"},
		"phosphorus/bad host": {"", "orangutan"},
	} {
		h, r := Target(in)
		if h != want[0] || r != want[1] {
			t.Errorf("%q: %q %q, want %v", in, h, r, want)
		}
	}
}

func TestAnthUsage(t *testing.T) {
	u := anthUsage(map[string]any{"input_tokens": 10.0, "cache_read_input_tokens": 5.0, "output_tokens": 7.0})
	if u["prompt_tokens"] != 15.0 || u["completion_tokens"] != 7.0 {
		t.Fatal(u)
	}
	if anthUsage(nil) != nil {
		t.Fatal("nil usage")
	}
}

func TestChatShaped(t *testing.T) {
	m := chatShaped(map[string]any{"system": []any{map[string]any{"type": "text", "text": "be "}, map[string]any{"type": "text", "text": "brief"}},
		"messages": []any{map[string]any{"role": "user", "content": "hi"}}})
	if len(m) != 2 || m[0].(map[string]any)["content"] != "be brief" || m[0].(map[string]any)["role"] != "system" {
		t.Fatal(m)
	}
}

func TestGateRefuses(t *testing.T) {
	sysfs.Root = t.TempDir()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/model/v1/messages", nil)
	if gate(r, w, false) || w.Code != 401 {
		t.Fatal("no key passed")
	}
	if !gate(r, httptest.NewRecorder(), true) {
		t.Fatal("a peer's hop refused")
	}
	r.Header.Set("Authorization", "Bearer junk")
	w = httptest.NewRecorder()
	if gate(r, w, false) || w.Code != 401 {
		t.Fatal("junk key passed")
	}
	if keyOf(r) != "junk" {
		t.Fatal(keyOf(r))
	}
	r2, _ := http.NewRequest("POST", "/", nil)
	r2.Header.Set("x-api-key", "k2")
	if keyOf(r2) != "k2" {
		t.Fatal(keyOf(r2))
	}
}
