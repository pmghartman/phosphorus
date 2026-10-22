package claude

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestRecordShape(t *testing.T) {
	b, _ := json.Marshal(Record{ID: "abc", Usage: Usage{In: 1, Out: 2, CostUSD: 0.5}})
	var m map[string]any
	json.Unmarshal(b, &m)
	for _, k := range []string{"id", "user", "host", "dir", "title", "model", "perm", "status", "err", "claudeSID", "created", "updated", "usage"} {
		if _, ok := m[k]; !ok {
			t.Errorf("record lacks %s", k)
		}
	}
	u := m["usage"].(map[string]any)
	if u["in"] != 1.0 || u["out"] != 2.0 || u["costUSD"] != 0.5 {
		t.Errorf("usage %v", u)
	}
}

func TestEnvLines(t *testing.T) {
	c := Creds{Key: "k1", Base: "http://100.1.2.3:8090", Token: "tok"}
	mesh, err := envLines("orangutan", c)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"PHOSPHORUS_MCP_KEY=k1", "ANTHROPIC_BASE_URL=http://100.1.2.3:8090/api/model", "ANTHROPIC_AUTH_TOKEN=k1",
		"ANTHROPIC_MODEL=orangutan", "ANTHROPIC_SMALL_FAST_MODEL=chimp", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"}
	for _, w := range want {
		if !has(mesh, w) {
			t.Errorf("mesh env lacks %s", w)
		}
	}
	for _, l := range mesh {
		if strings.Contains(l, "tok") {
			t.Errorf("mesh env carries the token: %s", l)
		}
	}
	an, err := envLines("sonnet", c)
	if err != nil || !has(an, "CLAUDE_CODE_OAUTH_TOKEN=tok") || len(an) != 2 {
		t.Fatal(an, err)
	}
	if _, err := envLines("opus", Creds{Key: "k"}); err == nil {
		t.Error("anthropic without a token")
	}
	if _, err := envLines("chimp", Creds{Key: "k\nX=1", Base: "b"}); err == nil {
		t.Error("a line break let through")
	}
	if _, err := envLines("gpt", c); err == nil {
		t.Error("unknown model")
	}
	if envBlock([]string{"A=1", "B=2"}) != "A=1\nB=2\n\n" {
		t.Error(envBlock([]string{"A=1"}))
	}
}

func TestLaunchCommand(t *testing.T) {
	c := launchCommand("~/src/it's", "opus", "default", "sid-1")
	for _, w := range []string{"--input-format stream-json", "--output-format stream-json", "--include-partial-messages",
		"--permission-prompt-tool stdio", "--strict-mcp-config", "--model opus", "--resume"} {
		if !strings.Contains(c, w) {
			t.Errorf("no %s in %s", w, c)
		}
	}
	if strings.Contains(c, "--permission-mode") {
		t.Error("default mode passed")
	}
	if !strings.Contains(launchCommand("/x", "chimp", "plan", ""), "--permission-mode plan") {
		t.Error("plan mode dropped")
	}
	if strings.Contains(launchCommand("/x", "chimp", "plan", ""), "--resume") {
		t.Error("resume with no session")
	}
}

// sh reads the launch script as written: env off stdin, then claude in dir
func TestLaunchScriptRuns(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
	home := t.TempDir()
	bin := filepath.Join(home, ".local", "bin")
	os.MkdirAll(bin, 0o755)
	os.MkdirAll(filepath.Join(home, "it's here"), 0o755)
	// a fake claude printing its env, args and stdin's rest
	os.WriteFile(filepath.Join(bin, "claude"), []byte("#!/bin/sh\necho \"dir=$PWD\"\necho \"key=$PHOSPHORUS_MCP_KEY cfg=$CLAUDE_CONFIG_DIR api=$ANTHROPIC_API_KEY\"\necho \"args=$*\"\ncat\n"), 0o755)
	cmd := exec.Command("sh", "-c", launchCommand("~/it's here", "chimp", "acceptEdits", "s'1"))
	cmd.Env = []string{"HOME=" + home, "PATH=/usr/bin:/bin", "ANTHROPIC_API_KEY=leak"}
	cmd.Stdin = strings.NewReader(envBlock([]string{"PHOSPHORUS_MCP_KEY=sec ret"}) + "{\"type\":\"user\"}\n")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatal(err, string(out))
	}
	o := string(out)
	for _, w := range []string{"dir=" + filepath.Join(home, "it's here"), "key=sec ret cfg=" + home + "/.phosphorus/claude api=\n",
		"--resume s'1", "--permission-mode acceptEdits", "--mcp-config " + home + "/.phosphorus/claude/mcp.json", `{"type":"user"}`} {
		if !strings.Contains(o, w) {
			t.Errorf("no %q in\n%s", w, o)
		}
	}
	// no claude: 127; no folder: 3
	cmd = exec.Command("sh", "-c", launchCommand("/nowhere/at/all", "chimp", "", ""))
	cmd.Env = []string{"HOME=" + home, "PATH=/usr/bin:/bin"}
	cmd.Stdin = strings.NewReader("\n")
	if err := cmd.Run(); cmd.ProcessState.ExitCode() != 3 {
		t.Errorf("no folder: %v", err)
	}
	os.Remove(filepath.Join(bin, "claude"))
	cmd = exec.Command("sh", "-c", launchCommand("~", "chimp", "", ""))
	cmd.Env = []string{"HOME=" + home, "PATH=/usr/bin:/bin"}
	cmd.Stdin = strings.NewReader("\n")
	if err := cmd.Run(); cmd.ProcessState.ExitCode() != 127 {
		t.Errorf("no claude: %v", err)
	}
}

func skillZip(t *testing.T, files map[string]string) []byte {
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	for n, body := range files {
		f, _ := z.Create(n)
		f.Write([]byte(body))
	}
	z.Close()
	return b.Bytes()
}

func TestSetupScript(t *testing.T) {
	home := t.TempDir()
	old := filepath.Join(home, ".phosphorus/claude/skills/phosphorus/stale.md")
	os.MkdirAll(filepath.Dir(old), 0o755)
	os.WriteFile(old, []byte("x"), 0o644)
	body := "---\nname: phosphorus\n---\nit's $HOME `x` PHOS_EOF_ \\ no newline"
	s, err := setupScript(skillZip(t, map[string]string{"phosphorus/SKILL.md": body, "phosphorus/references/a.md": "a\n"}), "http://1.2.3.4:8090")
	if err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(filepath.Join(home, ".local/bin"), 0o755)
	os.WriteFile(filepath.Join(home, ".local/bin/claude"), []byte("#!/bin/sh\n"), 0o755)
	cmd := exec.Command("sh", "-s")
	cmd.Env = []string{"HOME=" + home, "PATH=/usr/bin:/bin"}
	cmd.Stdin = strings.NewReader(s)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatal(err, string(out))
	}
	d := filepath.Join(home, ".phosphorus/claude")
	got, _ := os.ReadFile(filepath.Join(d, "skills/phosphorus/SKILL.md"))
	if string(got) != body+"\n" {
		t.Errorf("skill %q", got)
	}
	if _, err := os.Stat(old); err == nil {
		t.Error("stale skill file kept")
	}
	var mc map[string]any
	raw, _ := os.ReadFile(filepath.Join(d, "mcp.json"))
	if json.Unmarshal(raw, &mc) != nil {
		t.Fatalf("mcp.json %s", raw)
	}
	ph := mc["mcpServers"].(map[string]any)["phosphorus"].(map[string]any)
	if ph["url"] != "http://1.2.3.4:8090/api/mcp" || ph["headers"].(map[string]any)["Authorization"] != "Bearer ${PHOSPHORUS_MCP_KEY}" {
		t.Errorf("mcp.json %v", ph)
	}
	if fi, _ := os.Stat(filepath.Join(d, "mcp.json")); fi.Mode().Perm() != 0o600 {
		t.Errorf("mcp.json mode %v", fi.Mode())
	}
	if _, err := setupScript(skillZip(t, map[string]string{"../evil": "x"}), "b"); err == nil {
		t.Error("a path out of the skill taken")
	}
}

func TestPermAnswer(t *testing.T) {
	req := map[string]any{"input": map[string]any{"command": "ls"}, "permission_suggestions": []any{map[string]any{"type": "addRules"}}}
	a := permAnswer(req, true, false, "")
	if a["behavior"] != "allow" || a["updatedInput"].(map[string]any)["command"] != "ls" || a["updatedPermissions"] != nil {
		t.Error(a)
	}
	if a := permAnswer(req, true, true, ""); a["updatedPermissions"] == nil {
		t.Error("always kept no rule", a)
	}
	if d := permAnswer(req, false, true, "no"); d["behavior"] != "deny" || d["message"] != "no" {
		t.Error(d)
	}
	if d := permAnswer(map[string]any{}, false, false, ""); d["message"] == "" {
		t.Error("deny without a message")
	}
}

func TestLogReplay(t *testing.T) {
	f := filepath.Join(t.TempDir(), "x.jsonl")
	l := openLog(f)
	for i := 0; i < 5; i++ {
		l.add(map[string]any{"kind": "user", "text": "t"})
	}
	seqs := []int64{}
	l.each(2, func(seq int64, _ []byte) { seqs = append(seqs, seq) })
	if len(seqs) != 3 || seqs[0] != 3 || seqs[2] != 5 {
		t.Fatal(seqs)
	}
	if l2 := openLog(f); l2.last() != 5 || l2.lines != 5 {
		t.Fatal(l2.last(), l2.lines)
	}
	big := l.add(map[string]any{"kind": "claude", "ev": map[string]any{"type": "user", "x": strings.Repeat("a", lineMax)}})
	if len(big) > 1000 || !strings.Contains(string(big), `"truncated":true`) {
		t.Fatalf("big line %d", len(big))
	}
	for i := 0; i < logMax+logMax/10; i++ {
		l.add(map[string]any{"kind": "user"})
	}
	n, first := 0, int64(0)
	l.each(0, func(seq int64, _ []byte) {
		if first == 0 {
			first = seq
		}
		n++
	})
	if n > logMax+logMax/10 || n < logMax || first <= 6 {
		t.Fatal(n, first)
	}
}

// a socket joining mid-session: the log replayed past since, a line logged
// during the replay sent once, live ones after, the status last
func TestAttachReplay(t *testing.T) {
	runDir = t.TempDir()
	s := newSession(Record{ID: "aaaaaaaaaaaa", User: "pmh", Status: "idle"})
	allMu.Lock()
	all[s.rec.ID] = s
	allMu.Unlock()
	loadOnce.Do(func() {})
	s.mu.Lock()
	for i := 0; i < 4; i++ {
		s.emit(map[string]any{"kind": "user", "text": "x"}, true)
	}
	s.mu.Unlock()
	fc := &fakeConn{}
	done := make(chan struct{})
	ok := make(chan bool)
	go func() { ok <- Attach(fc, done, "pmh", s.rec.ID, 2) }()
	for {
		fc.mu.Lock()
		n := len(fc.msgs)
		fc.mu.Unlock()
		if n >= 3 {
			break
		}
	}
	s.mu.Lock()
	s.emit(map[string]any{"kind": "claude", "ev": map[string]any{"type": "stream_event"}}, false)
	s.emit(map[string]any{"kind": "user", "text": "late"}, true)
	s.mu.Unlock()
	close(done)
	if !<-ok {
		t.Fatal("no session")
	}
	seqs := []float64{}
	for _, m := range fc.msgs {
		seqs = append(seqs, m["seq"].(float64))
	}
	want := []float64{3, 4, 0, 0, 5}
	if len(seqs) != len(want) {
		t.Fatalf("seqs %v", seqs)
	}
	for i := range want {
		if seqs[i] != want[i] {
			t.Fatalf("seqs %v, want %v", seqs, want)
		}
	}
	if fc.msgs[2]["kind"] != "status" {
		t.Fatal("status not sent after the replay", fc.msgs[2])
	}
	if Attach(fc, done, "other", s.rec.ID, 0) {
		t.Fatal("another user's session joined")
	}
}

func TestCreateValidates(t *testing.T) {
	runDir = t.TempDir()
	never := func(string, string) (Creds, error) { t.Fatal("creds asked"); return Creds{}, nil }
	for _, p := range []map[string]any{
		{"host": "", "dir": "/x", "model": "chimp"},
		{"host": "razer", "dir": "", "model": "chimp"},
		{"host": "razer", "dir": "/x\ny", "model": "chimp"},
		{"host": "razer", "dir": "/x", "model": "gpt-5"},
		{"host": "razer", "dir": "/x", "model": "chimp", "perm": "yolo"},
	} {
		if st, _ := Create("pmh", p, never); st != 400 {
			t.Errorf("%v: %d", p, st)
		}
	}
	if st, _ := Get("pmh", "nope"); st != 404 {
		t.Error(st)
	}
	if newID() == newID() || !idRe.MatchString(newID()) {
		t.Error("ids")
	}
}
