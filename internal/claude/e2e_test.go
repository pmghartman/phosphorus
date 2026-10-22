package claude

// the real claude CLI against a fake mesh, run locally in place of ssh: set
// CLAUDE_E2E=1 with claude on PATH

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeConn a socket collecting what it's sent
type fakeConn struct {
	mu   sync.Mutex
	msgs []map[string]any
	n    int
	id   string
}

func (f *fakeConn) TextBytes(b []byte) bool {
	var m map[string]any
	json.Unmarshal(b, &m)
	f.mu.Lock()
	f.msgs = append(f.msgs, m)
	f.n++
	f.mu.Unlock()
	return true
}
func (f *fakeConn) Open() bool  { return true }
func (f *fakeConn) Queued() int { return 0 }
func (f *fakeConn) Close(int)   {}

func (f *fakeConn) find(pred func(m map[string]any) bool) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, m := range f.msgs {
		if pred(m) {
			return m
		}
	}
	return nil
}

func (f *fakeConn) wait(t *testing.T, what string, d time.Duration, pred func(m map[string]any) bool) map[string]any {
	t.Helper()
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		if m := f.find(pred); m != nil {
			return m
		}
		time.Sleep(50 * time.Millisecond)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, m := range f.msgs {
		b, _ := json.Marshal(m)
		if len(b) > 400 {
			b = b[:400]
		}
		t.Log(string(b))
	}
	_, rec := Get("pmh", f.id)
	t.Logf("record %+v", rec)
	if raw, err := os.ReadFile(logFile(f.id)); err == nil {
		t.Log(string(raw))
	}
	t.Fatalf("no %s", what)
	return nil
}

func sse(w http.ResponseWriter, events ...map[string]any) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(200)
	for _, e := range events {
		b, _ := json.Marshal(e)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", e["type"], b)
	}
}

// fakeAPI a Messages API: Bash once, then done; an mcp server noting its auth
func fakeAPI(t *testing.T, auths *sync.Map) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auths.Store(r.URL.Path, r.Header.Get("Authorization"))
		b, _ := io.ReadAll(r.Body)
		if strings.HasPrefix(r.URL.Path, "/api/mcp") {
			var m map[string]any
			json.Unmarshal(b, &m)
			if m["id"] == nil {
				w.WriteHeader(202)
				return
			}
			res := map[string]any{}
			switch m["method"] {
			case "initialize":
				res = map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "phosphorus", "version": "1"}}
			case "tools/list":
				res = map[string]any{"tools": []any{}}
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": m["id"], "result": res})
			return
		}
		if strings.HasSuffix(r.URL.Path, "/count_tokens") {
			w.Write([]byte(`{"input_tokens":10}`))
			return
		}
		if !strings.HasSuffix(r.URL.Path, "/v1/messages") {
			w.WriteHeader(404)
			return
		}
		var p map[string]any
		json.Unmarshal(b, &p)
		s := string(b)
		if strings.Contains(s, "run it") && strings.Contains(s, "after resume") {
			auths.Store("resumed", true)
		}
		hasBash := strings.Contains(s, `"name":"Bash"`)
		done := strings.Contains(s, `"tool_result"`)
		msg := map[string]any{"id": "msg_1", "type": "message", "role": "assistant", "model": p["model"], "content": []any{},
			"stop_reason": nil, "usage": map[string]any{"input_tokens": 10, "output_tokens": 1}}
		usage := map[string]any{"output_tokens": 5}
		if hasBash && !done && p["stream"] == true {
			sse(w, map[string]any{"type": "message_start", "message": msg},
				map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": map[string]any{}}},
				map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "input_json_delta", "partial_json": `{"command":"touch made-by-e2e && echo phos-e2e","description":"say it"}`}},
				map[string]any{"type": "content_block_stop", "index": 0},
				map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "tool_use"}, "usage": usage},
				map[string]any{"type": "message_stop"})
			return
		}
		if strings.Contains(s, "go slow") && !strings.Contains(s, "slow done") && p["stream"] == true {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(200)
			for i, e := range []map[string]any{{"type": "message_start", "message": msg},
				{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}}} {
				b, _ := json.Marshal(e)
				fmt.Fprintf(w, "event: %s\ndata: %s\n\n", e["type"], b)
				_ = i
			}
			for i := 0; i < 200; i++ {
				b, _ := json.Marshal(map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": "zz "}})
				if _, err := fmt.Fprintf(w, "event: content_block_delta\ndata: %s\n\n", b); err != nil {
					return
				}
				w.(http.Flusher).Flush()
				select {
				case <-r.Context().Done():
					auths.Store("interrupted", true)
					return
				case <-time.After(100 * time.Millisecond):
				}
			}
			return
		}
		text := "ok"
		if done {
			text = "all done"
		}
		if p["stream"] != true {
			msg["content"] = []any{map[string]any{"type": "text", "text": text}}
			msg["stop_reason"] = "end_turn"
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(msg)
			return
		}
		sse(w, map[string]any{"type": "message_start", "message": msg},
			map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}},
			map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": text}},
			map[string]any{"type": "content_block_stop", "index": 0},
			map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn"}, "usage": usage},
			map[string]any{"type": "message_stop"})
	}))
}

// localSpawn setup and claude run here under home, no ssh
func localSpawn(home string) spawner {
	env := []string{}
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, "CLAUDE") && !strings.HasPrefix(e, "ANTHROPIC") {
			env = append(env, e)
		}
	}
	env = append(env, "HOME="+home, "NO_PROXY=127.0.0.1,localhost", "no_proxy=127.0.0.1,localhost")
	return func(host string, c Creds, setup, command, envs string) (*proc, error) {
		st := exec.Command("sh", "-s")
		st.Env, st.Stdin = env, strings.NewReader(setup)
		if out, err := st.CombinedOutput(); err != nil {
			return nil, fmt.Errorf("setup: %v %s", err, out)
		}
		cmd := exec.Command("sh", "-c", command)
		cmd.Env, cmd.Dir = env, home
		in, _ := cmd.StdinPipe()
		out, _ := cmd.StdoutPipe()
		errs := &tail{}
		cmd.Stderr = errs
		if err := cmd.Start(); err != nil {
			return nil, err
		}
		io.WriteString(in, envs)
		return &proc{in: in, out: out, errs: errs,
			wait: func() int {
				cmd.Wait()
				return cmd.ProcessState.ExitCode()
			},
			kill: func() { in.Close(); cmd.Process.Signal(os.Interrupt) }}, nil
	}
}

func TestE2E(t *testing.T) {
	if os.Getenv("CLAUDE_E2E") == "" {
		t.Skip("CLAUDE_E2E=1 runs the real claude")
	}
	home, _ := os.MkdirTemp("", "claude-e2e")
	defer os.RemoveAll(home)
	runDir = t.TempDir()
	spawn = localSpawn(home)
	defer func() { spawn = sshSpawn }()
	var auths sync.Map
	api := fakeAPI(t, &auths)
	defer api.Close()

	var zb bytes.Buffer
	z := zip.NewWriter(&zb)
	f, _ := z.Create("phosphorus/SKILL.md")
	f.Write([]byte("---\nname: phosphorus\ndescription: test\n---\nhi\n"))
	z.Close()
	creds := func(host, model string) (Creds, error) {
		return Creds{Key: "testkey", Base: api.URL, Skill: zb.Bytes()}, nil
	}
	st, body := Create("pmh", map[string]any{"host": "here", "dir": "~", "model": "orangutan", "perm": "default", "prompt": "run it"}, creds)
	if st != 200 {
		t.Fatal(st, body)
	}
	id := body.(Record).ID
	fc := &fakeConn{id: id}
	done := make(chan struct{})
	defer close(done)
	go Attach(fc, done, "pmh", id, 0)

	perm := fc.wait(t, "permission ask", 90*time.Second, func(m map[string]any) bool { return m["kind"] == "permission" })
	if perm["tool"] != "Bash" || !strings.Contains(fmt.Sprint(perm["input"]), "phos-e2e") {
		t.Fatalf("ask %v", perm)
	}
	if st, b := Answer("pmh", id, map[string]any{"reqId": perm["reqId"], "allow": true}); st != 200 {
		t.Fatal(st, b)
	}
	fc.wait(t, "tool output", 60*time.Second, func(m map[string]any) bool {
		b, _ := json.Marshal(m["ev"])
		return m["kind"] == "claude" && strings.Contains(string(b), "tool_result") && strings.Contains(string(b), "phos-e2e")
	})
	fc.wait(t, "result", 60*time.Second, func(m map[string]any) bool {
		return m["kind"] == "claude" && m["ev"].(map[string]any)["type"] == "result"
	})
	if a, _ := auths.Load("/api/model/v1/messages"); a != "Bearer testkey" {
		t.Errorf("messages auth %v", a)
	}
	if a, ok := auths.Load("/api/mcp"); ok && a != "Bearer testkey" {
		t.Errorf("mcp auth %v", a)
	} else if !ok {
		t.Error("claude never called the mcp server")
	}
	if _, err := os.Stat(home + "/.phosphorus/claude/skills/phosphorus/SKILL.md"); err != nil {
		t.Error("skill not unpacked", err)
	}
	// a second prompt on the same process, then stop
	if st, b := Send("pmh", id, map[string]any{"text": "again"}, creds); st != 200 {
		t.Fatal(st, b)
	}
	_, g := Get("pmh", id)
	if g.(Record).ClaudeSID == "" {
		t.Error("no claude session id")
	}
	// a switch within the mesh in band
	if st, b := SetModel("pmh", id, map[string]any{"model": "chimp"}); st != 200 {
		t.Fatal(st, b)
	}
	if st, b := SetPerm("pmh", id, map[string]any{"mode": "acceptEdits"}); st != 200 {
		t.Fatal(st, b)
	}
	if st, _ := Stop("pmh", id); st != 200 {
		t.Fatal(st)
	}
	time.Sleep(2 * time.Second)
	// let go as idle, then resumed by the next prompt with the history
	s := of("pmh", id)
	s.mu.Lock()
	s.stopping = true
	s.p.kill()
	s.mu.Unlock()
	for i := 0; i < 100; i++ {
		if _, r := Get("pmh", id); r.(Record).Status == "ended" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if _, r := Get("pmh", id); r.(Record).Status != "ended" {
		t.Fatalf("not ended: %+v", r)
	}
	if st, b := Send("pmh", id, map[string]any{"text": "after resume"}, creds); st != 200 {
		t.Fatal(st, b)
	}
	for i := 0; i < 300; i++ {
		if _, ok := auths.Load("resumed"); ok {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if _, ok := auths.Load("resumed"); !ok {
		t.Error("resume lost the history")
	}
	// a slow turn stopped mid-stream
	fc.wait(t, "resumed result", 60*time.Second, func(m map[string]any) bool {
		return m["kind"] == "claude" && m["seq"].(float64) > 20 && m["ev"].(map[string]any)["type"] == "result"
	})
	Send("pmh", id, map[string]any{"text": "go slow"}, creds)
	fc.wait(t, "partial text", 30*time.Second, func(m map[string]any) bool {
		b, _ := json.Marshal(m)
		return m["kind"] == "claude" && m["seq"].(float64) == 0 && strings.Contains(string(b), "zz")
	})
	t0 := time.Now()
	Stop("pmh", id)
	for i := 0; i < 100; i++ {
		if _, ok := auths.Load("interrupted"); ok {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if _, ok := auths.Load("interrupted"); !ok {
		t.Error("stop didn't interrupt")
	}
	t.Log("interrupted in", time.Since(t0))
	time.Sleep(time.Second)
	if _, r := Get("pmh", id); r.(Record).Status != "idle" {
		t.Errorf("after stop: %+v", r)
	}
	if m := fc.find(func(m map[string]any) bool { return m["kind"] == "error" }); m != nil {
		t.Errorf("error %v", m)
	}
	Delete("pmh", id)
}
