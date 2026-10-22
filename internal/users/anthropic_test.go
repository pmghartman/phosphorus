package users

import (
	"strings"
	"testing"

	"github.com/pmghartman/phosphorus/internal/sysfs"
)

func TestAnthropicToken(t *testing.T) {
	sysfs.Root = t.TempDir()
	s := &Session{User: "pmh"}
	if HasAnthropic("pmh") {
		t.Fatal("token before any was saved")
	}
	if o := SetAnthropic(s, map[string]any{"token": "not a token\n"}); o.Status != 400 {
		t.Fatalf("bad token taken: %+v", o)
	}
	if o := SetAnthropic(s, map[string]any{"token": " sk-ant-oat01-abc_DEF-123 "}); o.Status != 200 || o.Body.(map[string]any)["anthropic"] != true {
		t.Fatalf("set: %+v", o)
	}
	if got := AnthropicToken("pmh"); got != "sk-ant-oat01-abc_DEF-123" {
		t.Fatalf("token %q", got)
	}
	if raw := string(sysfs.Read(anthropicFile("pmh"))); raw == "" || strings.Contains(raw, "sk-ant") {
		t.Fatalf("stored %q", raw)
	}
	if o := SetAnthropic(s, map[string]any{"token": ""}); o.Status != 200 || HasAnthropic("pmh") {
		t.Fatalf("clear: %+v", o)
	}
	if o := SetAnthropic(&Session{Boot: true}, map[string]any{"token": "x"}); o.Status != 403 {
		t.Fatalf("boot: %+v", o)
	}
	if AnthropicToken("../etc") != "" {
		t.Fatal("bad name read")
	}
}
