package claude

import (
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestOcTool(t *testing.T) {
	n, in := ocTool("edit", map[string]any{"filePath": "/w/a.c", "oldString": "x", "newString": "y"})
	if n != "Edit" || in["file_path"] != "/w/a.c" || in["old_string"] != "x" || in["new_string"] != "y" {
		t.Fatal(n, in)
	}
	n, in = ocTool("write", map[string]any{"filePath": "/w/b.c", "content": "z"})
	if n != "Write" || in["content"] != "z" {
		t.Fatal(n, in)
	}
	if _, in := ocTool("edit", map[string]any{"path": "/w/c.c", "oldString": "a", "newString": "b"}); in["file_path"] != "/w/c.c" {
		t.Fatal("today's path field", in)
	}
	if n, _ := ocTool("mystery", map[string]any{}); n != "mystery" {
		t.Fatal(n)
	}
}

func TestOcLaunch(t *testing.T) {
	l := ocLaunch("~/proj", "chimp", "default", "ses_1", "fix it's bug")
	if strings.Contains(ocLaunch("~/p", "chimp", "plan", "", "x"), "--auto") || !strings.Contains(l, "--auto") {
		t.Fatal("--auto only outside plan mode")
	}
	for _, want := range []string{"opencode run --format json", `--session '\''ses_1'\''`, "OPENCODE_CONFIG=", `-- '\''fix it'\''\'\'''\''s bug'\''`} {
		if !strings.Contains(l, want) {
			t.Fatalf("no %q in %s", want, l)
		}
	}
	if c := ocConfig("http://10.0.0.1:8090", "orangutan", "plan"); !strings.Contains(c, `"edit":"deny"`) || !strings.Contains(c, `"model":"phosphorus/orangutan"`) {
		t.Fatal(c)
	}
}

// a run: opencode's events in, claude's out, its session id kept for the next
func TestOcRun(t *testing.T) {
	runDir = t.TempDir()
	var mu sync.Mutex
	cmds := []string{}
	spawn = func(host string, c Creds, setup, command, env string) (*proc, error) {
		mu.Lock()
		cmds = append(cmds, command)
		mu.Unlock()
		out := `{"type":"step_start","sessionID":"ses_1","part":{}}` + "\n" +
			`{"type":"text","sessionID":"ses_1","part":{"text":"Fixed it."}}` + "\n" +
			`{"type":"tool_use","sessionID":"ses_1","part":{"id":"t1","tool":"edit","state":{"status":"completed","input":{"path":"/w/a.c","oldString":"x","newString":"y"},"output":"done"}}}` + "\n" +
			`{"type":"step_finish","sessionID":"ses_1","part":{"tokens":{"input":10,"output":5,"cache":{"read":2,"write":0}},"cost":0}}` + "\n"
		return &proc{in: nopCloser{}, out: strings.NewReader(out), errs: &tail{}, wait: func() int { return 0 }, kill: func() {}}, nil
	}
	defer func() { spawn = sshSpawn }()
	creds := func(string, string) (Creds, error) { return Creds{User: "u", Key: "k", Base: "http://b"}, nil }
	st, b := Create("ryan", map[string]any{"host": "razer", "dir": "~/w", "model": "chimp", "harness": "opencode"}, creds)
	if st != 200 {
		t.Fatal(st, b)
	}
	id := b.(Record).ID
	s := of("ryan", id)
	f := &fakeConn{}
	s.mu.Lock()
	s.subs[f] = &sub{c: f, ready: true}
	s.mu.Unlock()
	Send("ryan", id, map[string]any{"text": "fix the bug"}, creds)
	f.wait(t, "the result", 5*time.Second, func(m map[string]any) bool {
		ev, _ := m["ev"].(map[string]any)
		return ev != nil && ev["type"] == "result" && ev["subtype"] == "success"
	})
	if f.find(func(m map[string]any) bool {
		ev, _ := m["ev"].(map[string]any)
		c, _ := ev["message"].(map[string]any)
		parts, _ := c["content"].([]any)
		return len(parts) == 1 && parts[0].(map[string]any)["name"] == "Edit"
	}) == nil {
		t.Fatal("no Edit tool_use")
	}
	s.mu.Lock()
	sid, status, in := s.rec.ClaudeSID, s.rec.Status, s.rec.Usage.In
	s.mu.Unlock()
	if sid != "ses_1" || status != "idle" || in != 12 {
		t.Fatalf("sid %q status %q in %d", sid, status, in)
	}
	Send("ryan", id, map[string]any{"text": "again"}, creds)
	time.Sleep(200 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(cmds) != 2 || !strings.Contains(cmds[1], "ses_1") || strings.Contains(cmds[0], "--session") {
		t.Fatalf("%q", cmds)
	}
}

func TestOcRefusesAnthropic(t *testing.T) {
	st, _ := Create("ryan", map[string]any{"host": "razer", "dir": "~/w", "model": "opus", "harness": "opencode"}, nil)
	if st != 400 {
		t.Fatal(st)
	}
}

type nopCloser struct{ io.Writer }

func (nopCloser) Write(p []byte) (int, error) { return len(p), nil }
func (nopCloser) Close() error                { return nil }
