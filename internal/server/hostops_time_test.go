package server

import "testing"

func TestLineTime(t *testing.T) {
	for _, l := range []string{
		"2026-10-19T21:16:03-0700 [run] up",
		"[cloudflared] 2026-10-19T21:16:03Z ERR x",
		"2026/10/19 21:16:03 [frontend] listening",
	} {
		if _, ok := lineTime(l); !ok {
			t.Errorf("no time in %q", l)
		}
	}
	if _, ok := lineTime("[mesh] couldn't sync"); ok {
		t.Error("time in an untimed line")
	}
}
