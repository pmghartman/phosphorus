package server

import (
	"testing"

	"github.com/pmghartman/phosphorus/internal/sysfs"
	"github.com/pmghartman/phosphorus/internal/users"
	"github.com/pmghartman/phosphorus/internal/util"
)

// the options for a user whose vault holds no host login: none offered, blocked
func TestCodeOptionsBlocked(t *testing.T) {
	sysfs.Root = t.TempDir()
	key := users.Derive("pw", "00")[32:]
	put := func(hosts map[string]any) {
		sysfs.Write("home/pmh/vault.json", users.Seal(key, string(util.Marshal(map[string]any{"hosts": hosts, "pages": map[string]any{}}))))
	}
	s := &users.Session{User: "pmh", Key: key}
	put(map[string]any{})
	o := codeOptions(s)
	if hs, _ := o["hosts"].([]string); len(hs) != 0 || o["blocked"] != codeBlockedMsg {
		t.Fatalf("no logins: %v", o)
	}
	if codeBlocked(s) != codeBlockedMsg {
		t.Fatal("not blocked")
	}
	if _, err := codeLogin(s, "razer"); err == nil {
		t.Fatal("a login from nowhere")
	}
	put(map[string]any{"razer": map[string]any{"user": "pmh", "pass": "x"}})
	o = codeOptions(s)
	if hs, _ := o["hosts"].([]string); len(hs) != 1 || hs[0] != "razer" || o["blocked"] != nil {
		t.Fatalf("one login: %v", o)
	}
	if c, err := codeLogin(s, "razer"); err != nil || c.User != "pmh" || c.Pass != "x" {
		t.Fatal(c, err)
	}
	// another password's key opens nothing
	if codeBlocked(&users.Session{User: "pmh", Key: users.Derive("other", "00")[32:]}) == "" {
		t.Fatal("opened with the wrong key")
	}
}
