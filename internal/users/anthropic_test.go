package users

import (
	"strings"
	"testing"

	"github.com/pmghartman/phosphorus/internal/sysfs"
	"github.com/pmghartman/phosphorus/internal/util"
)

// a logged in session over a vault holding hosts
func vaultSession(t *testing.T, hosts map[string]any) *Session {
	t.Helper()
	key := Derive("pw", "00")[32:]
	sysfs.Write(vaultFile("pmh"), Seal(key, string(util.Marshal(map[string]any{"hosts": hosts, "pages": map[string]any{}}))))
	return &Session{User: "pmh", Key: key}
}

func TestAnthropicToken(t *testing.T) {
	sysfs.Root = t.TempDir()
	s := vaultSession(t, map[string]any{"razer": map[string]any{"user": "pmh", "pass": "x"}})
	if AnthropicToken(s) != "" {
		t.Fatal("token before any was saved")
	}
	if o := SetAnthropic(s, map[string]any{"token": "not a token\n"}); o.Status != 400 {
		t.Fatalf("bad token taken: %+v", o)
	}
	if o := SetAnthropic(s, map[string]any{"token": " sk-ant-oat01-abc_DEF-123 "}); o.Status != 200 || o.Body.(map[string]any)["anthropic"] != true {
		t.Fatalf("set: %+v", o)
	}
	if got := AnthropicToken(s); got != "sk-ant-oat01-abc_DEF-123" {
		t.Fatalf("token %q", got)
	}
	// sealed in the vault under the password's key, the logins kept
	if raw := string(sysfs.Read(vaultFile("pmh"))); raw == "" || strings.Contains(raw, "sk-ant") {
		t.Fatalf("stored %q", raw)
	}
	if u, _, ok := HostLogin(s, "razer"); !ok || u != "pmh" {
		t.Fatal("logins lost")
	}
	// another key (the mesh's, a wrong password) opens nothing
	if AnthropicToken(&Session{User: "pmh", Key: MeshKey()}) != "" {
		t.Fatal("opened without the user's key")
	}
	// the page never sees it, and saving the page's vault keeps it
	if v := Me(s)["vault"].(map[string]any); v["anthropic"] != nil {
		t.Fatalf("sent to the page: %v", v)
	}
	o := SetVault(s, map[string]any{"vault": map[string]any{"hosts": map[string]any{"mulab-01": map[string]any{"user": "u", "pass": "p"}}, "anthropic": "sk-ant-forged"}})
	if o.Status != 200 || o.Body.(map[string]any)["vault"].(map[string]any)["anthropic"] != nil {
		t.Fatalf("set vault: %+v", o)
	}
	if got := AnthropicToken(s); got != "sk-ant-oat01-abc_DEF-123" {
		t.Fatalf("token after a vault save %q", got)
	}
	if hs := HostLogins(s); len(hs) != 1 || hs[0] != "mulab-01" {
		t.Fatalf("hosts %v", hs)
	}
	if o := SetAnthropic(s, map[string]any{"token": ""}); o.Status != 200 || AnthropicToken(s) != "" {
		t.Fatalf("clear: %+v", o)
	}
	if o := SetAnthropic(&Session{Boot: true}, map[string]any{"token": "x"}); o.Status != 403 {
		t.Fatalf("boot: %+v", o)
	}
	if o := SetAnthropic(&Session{User: "pmh"}, map[string]any{"token": "x"}); o.Status != 403 {
		t.Fatalf("no key: %+v", o)
	}
}

func TestCleanVaultKeepsToken(t *testing.T) {
	v := cleanVault(map[string]any{"hosts": map[string]any{}, "anthropic": "sk-ant-oat01-x", "junk": 1})
	if v["anthropic"] != "sk-ant-oat01-x" || v["junk"] != nil {
		t.Fatalf("%v", v)
	}
	if v := cleanVault(map[string]any{"anthropic": "bad token\n"}); v["anthropic"] != nil {
		t.Fatalf("bad token kept: %v", v)
	}
}

func TestDropOldTokens(t *testing.T) {
	sysfs.Root = t.TempDir()
	sysfs.Write("home/pmh/anthropic.json", map[string]any{"t": "x"})
	sysfs.Write("home/pmh/prefs.json", map[string]any{})
	DropOldTokens()
	if sysfs.Read("home/pmh/anthropic.json") != nil || sysfs.Read("home/pmh/prefs.json") == nil {
		t.Fatal("not dropped, or too much")
	}
}
