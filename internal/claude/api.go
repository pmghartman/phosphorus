package claude

// the page's calls, each answering a status and a body; a session another
// user's is no session at all

import (
	"crypto/rand"
	"os"
	"sort"
	"strings"
	"sync"

	"github.com/pmghartman/phosphorus/internal/util"
)

const (
	// liveMax processes running at once per user
	liveMax  = 8
	textMax  = 256 * 1024
	dirMax   = 1024
	titleMax = 200
)

// CredsFn what a start on host needs, for model, from the logged in user
type CredsFn func(host, model string) (Creds, error)

func errB(msg string) map[string]any { return map[string]any{"error": msg} }

var gone = errB("no such session")

// List the user's sessions, the latest active first
func List(user string) (int, any) {
	loadOnce.Do(load)
	allMu.Lock()
	ss := []*session{}
	for _, s := range all {
		ss = append(ss, s)
	}
	allMu.Unlock()
	out := []Record{}
	for _, s := range ss {
		s.mu.Lock()
		if s.rec.User == user && !s.deleted {
			out = append(out, s.rec)
		}
		s.mu.Unlock()
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Updated > out[j].Updated })
	return 200, map[string]any{"sessions": out}
}

// Get one session's record
func Get(user, id string) (int, any) {
	s := of(user, id)
	if s == nil {
		return 404, gone
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return 200, s.rec
}

// Owns whether id is the user's session
func Owns(user, id string) bool { return of(user, id) != nil }

func liveCount(user string) int {
	allMu.Lock()
	ss := []*session{}
	for _, s := range all {
		ss = append(ss, s)
	}
	allMu.Unlock()
	n := 0
	for _, s := range ss {
		s.mu.Lock()
		if s.rec.User == user && (s.p != nil || s.starting) {
			n++
		}
		s.mu.Unlock()
	}
	return n
}

func cleanText(v any, n int) string {
	t := util.Str(v)
	if len(t) > n {
		return ""
	}
	return t
}

// Create a session on host in dir, started and sent prompt
func Create(user string, p map[string]any, creds CredsFn) (int, any) {
	loadOnce.Do(load)
	host := strings.TrimSpace(util.Str(p["host"]))
	dir := strings.TrimSpace(util.Str(p["dir"]))
	model := util.Str(p["model"])
	perm := util.Str(p["perm"])
	prompt := cleanText(p["prompt"], textMax)
	switch {
	case !hostRe.MatchString(host):
		return 400, errB("pick a host")
	case dir == "" || len(dir) > dirMax || strings.ContainsAny(dir, "\x00\r\n"):
		return 400, errB("pick a folder")
	case provider(model) == "":
		return 400, errB("model is one of " + strings.Join(append(append([]string{}, Mesh...), Anthropic...), ", "))
	}
	if perm == "" {
		perm = "default"
	}
	if !has(Perms, perm) {
		return 400, errB("perm is one of " + strings.Join(Perms, ", "))
	}
	if liveCount(user) >= liveMax {
		return 429, errB("too many sessions running: stop one first")
	}
	c, err := creds(host, model)
	if err != nil {
		return 400, errB(err.Error())
	}
	now := util.Now()
	rec := Record{ID: newID(), User: user, Host: host, Dir: dir, Model: model, Perm: perm, Status: "starting", Created: now, Updated: now}
	s := newSession(rec)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.begin(c); err != nil {
		return 400, errB(err.Error())
	}
	allMu.Lock()
	all[rec.ID] = s
	allMu.Unlock()
	if strings.TrimSpace(prompt) != "" {
		s.send(prompt)
	}
	return 200, s.rec
}

func newID() string {
	const abc = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 12)
	rand.Read(b)
	for i := range b {
		b[i] = abc[int(b[i])%len(abc)]
	}
	return string(b)
}

// send a prompt logged, then written or queued for the process; under s.mu
func (s *session) send(text string) {
	if s.rec.Title == "" {
		s.rec.Title = clip(strings.Join(strings.Fields(text), " "), 80)
	}
	s.emit(map[string]any{"kind": "user", "text": text, "at": util.Now()}, true)
	if s.alive() && !s.starting {
		s.prompt(text)
	} else {
		s.queue = append(s.queue, text)
	}
	if s.rec.Status != "starting" {
		s.status("working")
	} else {
		s.status("")
	}
}

// Send a prompt, the process resumed when it's gone
func Send(user, id string, p map[string]any, creds CredsFn) (int, any) {
	s := of(user, id)
	if s == nil {
		return 404, gone
	}
	text := cleanText(p["text"], textMax)
	if strings.TrimSpace(text) == "" {
		return 400, errB("text: what to send, up to 256KB")
	}
	s.mu.Lock()
	needs := !s.alive() && !s.starting && s.next == nil
	host, model := s.rec.Host, s.rec.Model
	s.mu.Unlock()
	var c Creds
	if needs {
		if liveCount(user) >= liveMax {
			return 429, errB("too many sessions running: stop one first")
		}
		var err error
		if c, err = creds(host, model); err != nil {
			return 400, errB(err.Error())
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if needs && !s.alive() && !s.starting {
		if err := s.begin(c); err != nil {
			return 400, errB(err.Error())
		}
	}
	s.send(text)
	return 200, map[string]any{}
}

// Stop the turn under way interrupted, queued prompts dropped
func Stop(user, id string) (int, any) {
	s := of(user, id)
	if s == nil {
		return 404, gone
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.queue = nil
	if s.alive() {
		s.control("interrupt", map[string]any{"subtype": "interrupt"})
	}
	return 200, map[string]any{}
}

// SetModel within a provider claude's own switch; across one refused, a new
// session's to make
func SetModel(user, id string, p map[string]any) (int, any) {
	s := of(user, id)
	if s == nil {
		return 404, gone
	}
	m := util.Str(p["model"])
	if provider(m) == "" {
		return 400, errB("model is one of " + strings.Join(append(append([]string{}, Mesh...), Anthropic...), ", "))
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if m == s.rec.Model {
		return 200, s.rec
	}
	if s.starting {
		return 409, errB("still starting, switch once it's up")
	}
	if provider(m) != provider(s.rec.Model) {
		return 409, errB("start a new session to change provider")
	}
	s.rec.Model = m
	if s.alive() {
		s.control("model", map[string]any{"subtype": "set_model", "model": m})
	}
	s.status("")
	return 200, s.rec
}

// SetPerm the permission mode, claude's own switch while it runs
func SetPerm(user, id string, p map[string]any) (int, any) {
	s := of(user, id)
	if s == nil {
		return 404, gone
	}
	m := util.Str(p["mode"])
	if !has(Perms, m) {
		return 400, errB("mode is one of " + strings.Join(Perms, ", "))
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rec.Perm = m
	if s.alive() {
		s.control("permission mode", map[string]any{"subtype": "set_permission_mode", "mode": m})
	}
	s.status("")
	return 200, s.rec
}

// permAnswer claude's can_use_tool answer: the input as asked, always the
// rules claude suggested kept for the session
func permAnswer(req map[string]any, allow, always bool, msg string) map[string]any {
	if !allow {
		if strings.TrimSpace(msg) == "" {
			msg = "The user denied this. Ask them what to do instead."
		}
		return map[string]any{"behavior": "deny", "message": msg}
	}
	out := map[string]any{"behavior": "allow", "updatedInput": orObj(req["input"])}
	if sg, ok := req["permission_suggestions"].([]any); always && ok && len(sg) > 0 {
		out["updatedPermissions"] = sg
	}
	return out
}

// Answer a pending permission ask
func Answer(user, id string, p map[string]any) (int, any) {
	s := of(user, id)
	if s == nil {
		return 404, gone
	}
	reqID := util.Str(p["reqId"])
	allow := p["allow"] == true
	s.mu.Lock()
	defer s.mu.Unlock()
	req := s.perms[reqID]
	if req == nil {
		return 404, errB("no such permission waiting")
	}
	delete(s.perms, reqID)
	s.respond(reqID, true, permAnswer(req, allow, p["always"] == true, cleanText(p["message"], 4096)))
	s.emit(map[string]any{"kind": "permission_done", "reqId": reqID, "allow": allow}, true)
	return 200, map[string]any{}
}

// Rename the session's title
func Rename(user, id string, p map[string]any) (int, any) {
	s := of(user, id)
	if s == nil {
		return 404, gone
	}
	t := strings.Join(strings.Fields(util.Str(p["title"])), " ")
	if t == "" {
		return 400, errB("title: a name")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rec.Title = clip(t, titleMax)
	s.status("")
	return 200, s.rec
}

// Delete the process ended, its record and log gone; the files in dir untouched
func Delete(user, id string) (int, any) {
	s := of(user, id)
	if s == nil {
		return 404, gone
	}
	allMu.Lock()
	delete(all, id)
	allMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deleted = true
	s.queue, s.next = nil, nil
	if s.p != nil {
		s.stopping = true
		s.p.kill()
	}
	for c := range s.subs {
		c.Close(4000)
	}
	s.log.remove()
	os.Remove(recFile(id))
	return 200, map[string]any{}
}

// Installed claude's version on host
func Installed(host string, c Creds) (int, any) {
	if !hostRe.MatchString(host) {
		return 400, errB("pick a host")
	}
	v, err := version(host, c)
	if err != nil {
		return 502, errB(err.Error())
	}
	return 200, map[string]any{"installed": v != "", "version": v}
}

var (
	installMu sync.Mutex
	installs  = map[string]bool{}
)

// Install the official installer run on host as the login
func Install(host string, c Creds) (int, any) {
	if !hostRe.MatchString(host) {
		return 400, errB("pick a host")
	}
	k := host + "|" + c.User
	installMu.Lock()
	if installs[k] {
		installMu.Unlock()
		return 409, errB("already installing on " + host)
	}
	installs[k] = true
	installMu.Unlock()
	defer func() {
		installMu.Lock()
		delete(installs, k)
		installMu.Unlock()
	}()
	ok, out, err := install(host, c)
	if err != nil && out == "" {
		return 502, errB(err.Error())
	}
	return 200, map[string]any{"ok": ok && err == nil, "out": out}
}
