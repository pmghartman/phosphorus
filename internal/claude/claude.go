// Package claude: Code sessions, the claude CLI run over ssh on a mesh host
// as its user, on a mesh model or their own Anthropic subscription; its
// stream-json logged, fanned out to the page's sockets, permission asks
// answered from the page
package claude

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/util"
)

const (
	// idleAfter a process waiting this long on a prompt let go, resumed on the next
	idleAfter = 30 * time.Minute
	// queueHigh a replay waits while the socket holds this many frames
	queueHigh = 256
	outMax    = 64 << 20
)

var (
	runDir   = filepath.Join(util.StateDir, "claude-runs")
	idRe     = regexp.MustCompile(`^[a-z0-9]{12}$`)
	hostRe   = regexp.MustCompile(`^[A-Za-z0-9-]{1,63}$`)
	allMu    sync.Mutex
	all      = map[string]*session{}
	loadOnce sync.Once
)

// Usage summed from claude's result events
type Usage struct {
	In      int64   `json:"in"`
	Out     int64   `json:"out"`
	CostUSD float64 `json:"costUSD"`
}

// Record a session as the page sees it and as it's kept on disk
type Record struct {
	ID        string `json:"id"`
	User      string `json:"user"`
	Host      string `json:"host"`
	Dir       string `json:"dir"`
	Title     string `json:"title"`
	Model     string `json:"model"`
	Perm      string `json:"perm"`
	Status    string `json:"status"`
	Err       string `json:"err"`
	ClaudeSID string `json:"claudeSID"`
	Created   int64  `json:"created"`
	Updated   int64  `json:"updated"`
	Usage     Usage  `json:"usage"`
	// Harness what runs the session: claude, or opencode
	Harness string `json:"harness,omitempty"`
}

// conn a page's socket, as wsock.Conn
type conn interface {
	TextBytes(b []byte) bool
	Open() bool
	Queued() int
	Close(code int)
}

// sub a socket joined, live messages held back while its replay goes out
type sub struct {
	c       conn
	ready   bool
	backlog [][]byte
	seqs    []int64
}

type session struct {
	mu       sync.Mutex
	rec      Record
	log      *evlog
	p        *proc
	gen      int
	starting bool
	stopping bool
	deleted  bool
	// queue prompts waiting on the process
	queue []string
	// next the creds of a start held until the dying process is gone
	next  *Creds
	subs  map[conn]*sub
	perms map[string]map[string]any
	ctl   map[string]string
	idle  *time.Timer
	// oc an opencode session's creds, each prompt its own run; run what the current one's said
	oc  *Creds
	run ocRun
}

func recFile(id string) string { return filepath.Join(runDir, id+".json") }
func logFile(id string) string { return filepath.Join(runDir, id+".jsonl") }

func newSession(rec Record) *session {
	return &session{rec: rec, log: openLog(logFile(rec.ID)), subs: map[conn]*sub{},
		perms: map[string]map[string]any{}, ctl: map[string]string{}}
}

// load the records kept here, none running after a restart
func load() {
	ents, _ := os.ReadDir(runDir)
	for _, e := range ents {
		id, ok := strings.CutSuffix(e.Name(), ".json")
		if !ok || !idRe.MatchString(id) {
			continue
		}
		var rec Record
		if !util.ReadJSON(recFile(id), &rec) || rec.ID != id {
			continue
		}
		switch rec.Status {
		case "starting", "working", "idle":
			rec.Status = "ended"
		}
		allMu.Lock()
		all[id] = newSession(rec)
		allMu.Unlock()
	}
}

// of the user's session id, nil for none or another's
func of(user, id string) *session {
	loadOnce.Do(load)
	if !idRe.MatchString(id) {
		return nil
	}
	allMu.Lock()
	defer allMu.Unlock()
	s := all[id]
	if s == nil || s.rec.User != user {
		return nil
	}
	return s
}

// save the record; under s.mu
func (s *session) save() {
	if s.deleted {
		return
	}
	writePrivate(recFile(s.rec.ID), util.Marshal(s.rec))
}

// emit m to every socket, logged under a seq when keep, else seq 0; under s.mu
func (s *session) emit(m map[string]any, keep bool) {
	var b []byte
	var seq int64
	if keep {
		b = s.log.add(m)
		seq = s.log.last()
	} else {
		m["seq"] = 0
		b = util.Marshal(m)
	}
	for _, x := range s.subs {
		if x.ready {
			x.c.TextBytes(b)
		} else {
			x.backlog = append(x.backlog, b)
			x.seqs = append(x.seqs, seq)
		}
	}
}

// status the record's new status saved and sent; under s.mu
func (s *session) status(st string) {
	if st != "" {
		s.rec.Status = st
	}
	s.rec.Updated = util.Now()
	s.save()
	s.emit(map[string]any{"kind": "status", "record": s.rec}, false)
}

// fail the error logged and the session failed; under s.mu
func (s *session) fail(err string) {
	s.rec.Err = err
	s.emit(map[string]any{"kind": "error", "text": err, "at": util.Now()}, true)
	s.status("failed")
}

// alive a process taking prompts; under s.mu
func (s *session) alive() bool { return s.p != nil && !s.stopping }

// begin a process started, resumed when claude's session is known; under s.mu
func (s *session) begin(c Creds) error {
	if s.starting || s.deleted {
		return nil
	}
	if harnessOf(s.rec) == Opencode {
		return s.ocBegin(c)
	}
	if s.p != nil {
		// the old one still going: started once it's gone
		s.next = &c
		return nil
	}
	env, err := envLines(s.rec.Model, c)
	if err != nil {
		return err
	}
	setup, err := setupScript(c.Skill, c.Base)
	if err != nil {
		return err
	}
	cmd := launchCommand(s.rec.Dir, s.rec.Model, s.rec.Perm, s.rec.ClaudeSID)
	s.starting = true
	s.rec.Err = ""
	s.status("starting")
	host := s.rec.Host
	go func() {
		p, err := spawn(host, c, setup, cmd, envBlock(env))
		s.mu.Lock()
		defer s.mu.Unlock()
		s.starting = false
		if err != nil {
			s.queue = nil
			s.fail(err.Error())
			return
		}
		if s.deleted {
			p.kill()
			return
		}
		s.p, s.stopping = p, false
		s.gen++
		g := s.gen
		go s.read(p, g)
		st := "idle"
		for _, t := range s.queue {
			s.prompt(t)
			st = "working"
		}
		s.queue = nil
		s.status(st)
	}()
	return nil
}

// write one stream-json message to claude; under s.mu
func (s *session) write(v any) {
	if s.p == nil {
		return
	}
	s.p.in.Write(append(util.Marshal(v), '\n'))
}

// prompt a user message to claude; under s.mu
func (s *session) prompt(text string) {
	s.write(userMessage(text))
	if s.idle != nil {
		s.idle.Stop()
	}
}

func userMessage(text string) map[string]any {
	return map[string]any{"type": "user", "parent_tool_use_id": nil, "session_id": "",
		"message": map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": text}}}}
}

// control a request of claude's control protocol; under s.mu
func (s *session) control(what string, req map[string]any) {
	id := "phos-" + randHex(6)
	s.ctl[id] = what
	s.write(map[string]any{"type": "control_request", "request_id": id, "request": req})
}

// respond claude's own control request answered; under s.mu
func (s *session) respond(id string, ok bool, body any) {
	r := map[string]any{"subtype": "success", "request_id": id, "response": body}
	if !ok {
		r = map[string]any{"subtype": "error", "request_id": id, "error": body}
	}
	s.write(map[string]any{"type": "control_response", "response": r})
}

// read claude's stdout to its end, then its exit
func (s *session) read(p *proc, g int) {
	sc := bufio.NewScanner(p.out)
	sc.Buffer(make([]byte, 256*1024), outMax)
	for sc.Scan() {
		var ev map[string]any
		if json.Unmarshal(sc.Bytes(), &ev) != nil || ev == nil {
			// a profile's chatter, kept with stderr for the error
			p.errs.Write(append(append([]byte{}, sc.Bytes()...), '\n'))
			continue
		}
		s.mu.Lock()
		if g == s.gen {
			if harnessOf(s.rec) == Opencode {
				for _, e := range s.ocEvents(ev) {
					s.on(e)
				}
			} else {
				s.on(ev)
			}
		}
		s.mu.Unlock()
	}
	code := p.wait()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.exited(g, code, p.errs.String())
}

// on one claude event; under s.mu
func (s *session) on(ev map[string]any) {
	typ := util.Str(ev["type"])
	switch typ {
	case "keep_alive":
		return
	case "control_request":
		id := util.Str(ev["request_id"])
		req := util.Obj(ev["request"])
		if util.Str(req["subtype"]) != "can_use_tool" {
			s.respond(id, false, "phosphorus doesn't handle "+util.Str(req["subtype"]))
			return
		}
		s.perms[id] = req
		s.emit(map[string]any{"kind": "permission", "reqId": id, "tool": util.Str(req["tool_name"]), "input": orObj(req["input"]),
			"reason": util.Str(req["decision_reason"]), "toolUseId": util.Str(req["tool_use_id"]), "at": util.Now()}, true)
		return
	case "control_cancel_request":
		id := util.Str(ev["request_id"])
		if s.perms[id] != nil {
			delete(s.perms, id)
			s.emit(map[string]any{"kind": "permission_done", "reqId": id, "allow": false, "cancelled": true}, true)
		}
		return
	case "control_response":
		r := util.Obj(ev["response"])
		id := util.Str(r["request_id"])
		what := s.ctl[id]
		delete(s.ctl, id)
		if util.Str(r["subtype"]) == "error" && what != "" {
			s.emit(map[string]any{"kind": "error", "text": what + ": " + util.Str(r["error"]), "at": util.Now()}, true)
		}
		return
	case "stream_event":
		s.emit(map[string]any{"kind": "claude", "ev": ev}, false)
		if s.rec.Status != "working" {
			s.status("working")
		}
		return
	}
	if sid := util.Str(ev["session_id"]); sid != "" && sid != s.rec.ClaudeSID {
		s.rec.ClaudeSID = sid
		s.save()
	}
	s.emit(map[string]any{"kind": "claude", "ev": ev}, true)
	switch typ {
	case "result":
		u := util.Obj(ev["usage"])
		s.rec.Usage.In += int64(num(u["input_tokens"]) + num(u["cache_read_input_tokens"]) + num(u["cache_creation_input_tokens"]))
		s.rec.Usage.Out += int64(num(u["output_tokens"]))
		if provider(s.rec.Model) == "anthropic" {
			s.rec.Usage.CostUSD += num(ev["total_cost_usd"])
		}
		s.rec.Err = ""
		if ev["is_error"] == true {
			s.rec.Err = clip(util.Str(ev["result"]), 500)
		}
		s.status("idle")
		s.armIdle()
	case "assistant", "user":
		if s.rec.Status != "working" {
			s.status("working")
		}
	}
}

// armIdle the process let go once idle long enough; under s.mu
func (s *session) armIdle() {
	if s.idle != nil {
		s.idle.Stop()
	}
	g := s.gen
	s.idle = time.AfterFunc(idleAfter, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if g == s.gen && s.rec.Status == "idle" && s.p != nil && len(s.perms) == 0 {
			s.stopping = true
			s.p.kill()
		}
	})
}

// exited the process gone: its asks void, the session ended or failed; under s.mu
func (s *session) exited(g, code int, errs string) {
	if harnessOf(s.rec) == Opencode {
		s.ocExited(g, code, errs)
		return
	}
	if g != s.gen {
		return
	}
	s.p = nil
	s.gen++
	if s.idle != nil {
		s.idle.Stop()
	}
	for id := range s.perms {
		s.emit(map[string]any{"kind": "permission_done", "reqId": id, "allow": false, "cancelled": true}, true)
	}
	s.perms = map[string]map[string]any{}
	s.ctl = map[string]string{}
	stopping := s.stopping
	s.stopping = false
	if s.deleted {
		return
	}
	switch {
	case stopping || code == 0:
		s.status("ended")
	case code == 127:
		s.fail(fmt.Sprintf("claude isn't installed on %s: install it from the Code app", s.rec.Host))
	case code == 3:
		s.fail(fmt.Sprintf("no folder %s on %s", s.rec.Dir, s.rec.Host))
	default:
		why := lastLine(errs)
		if why == "" {
			why = fmt.Sprintf("claude exited with %d", code)
		}
		s.fail(why)
	}
	if n := s.next; n != nil {
		s.next = nil
		if err := s.begin(*n); err != nil {
			s.fail(err.Error())
		}
	}
}

func lastLine(s string) string {
	ls := strings.Split(strings.TrimSpace(s), "\n")
	return clip(strings.TrimSpace(ls[len(ls)-1]), 500)
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

func num(v any) float64 {
	f, _ := v.(float64)
	return f
}

func orObj(v any) any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}
