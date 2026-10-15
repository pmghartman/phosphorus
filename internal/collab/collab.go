package collab

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/files"
	"github.com/pmghartman/phosphorus/internal/users"
	"github.com/pmghartman/phosphorus/internal/wsock"
)

const (
	maxText     = 512 * 1024
	history     = 2000
	idle        = 60 * time.Second
	hopTimeout  = 5 * time.Second
	typeSteps   = 24
	typeMS      = 40 * time.Millisecond
	agentStay   = 10 * time.Second
	autosave    = 1500 * time.Millisecond
	autosaveMax = 10 * time.Second
)

type who struct{ name, color string }

type client struct {
	ws    *wsock.Conn
	cid   int
	who   *who
	pos   int
	agent bool
}

type session struct {
	key      string
	share    files.Share
	rel      string
	text     []uint16
	eol      string
	version  int
	saved    int
	history  [][]Op
	clients  map[*client]bool
	order    []*client
	idle     *time.Timer
	autosave *time.Timer
	dirtyAt  time.Time
}

var (
	mu        sync.Mutex
	sessions  = map[string]*session{}
	clientSeq int
)

func keyOf(sh files.Share, rel string) string { return sh.ID + "\n" + rel }

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

func (s *session) add(c *client) {
	s.clients[c] = true
	s.order = append(s.order, c)
}

func (s *session) remove(c *client) {
	delete(s.clients, c)
	for i, x := range s.order {
		if x == c {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
}

func (s *session) people() []map[string]any {
	out := []map[string]any{}
	for _, c := range s.order {
		if c.who == nil {
			continue
		}
		p := map[string]any{"id": c.cid, "name": c.who.name, "color": c.who.color, "pos": c.pos}
		if c.agent {
			p["agent"] = true
		}
		out = append(out, p)
	}
	return out
}

func sendTo(c *client, body any) {
	if c.ws != nil && c.ws.Open() {
		c.ws.JSON(body)
	}
}

func (s *session) toAll(body any) {
	for _, c := range s.order {
		sendTo(c, body)
	}
}

var crlf = regexp.MustCompile(`\r\n?`)

func lf(t string) string { return crlf.ReplaceAllString(t, "\n") }

func (s *session) onDisk() string {
	t := Str(s.text)
	if s.eol == "\r\n" {
		return strings.ReplaceAll(t, "\n", "\r\n")
	}
	return t
}

func open(sh files.Share, rel string) (int, *session, any) {
	key := keyOf(sh, rel)
	if held := sessions[key]; held != nil {
		if held.idle != nil {
			held.idle.Stop()
		}
		return 200, held, nil
	}
	status, f := files.Read(&sh, rel)
	if status == 404 {
		return 404, nil, map[string]any{"error": "no such file: renamed, moved or deleted"}
	}
	if status != 200 {
		return status, nil, f
	}
	m := f.(map[string]any)
	if m["binary"] == true {
		return 415, nil, map[string]any{"error": "a binary file, not text"}
	}
	if m["tooBig"] == true {
		return 413, nil, map[string]any{"error": "over 512KB, too big to edit here"}
	}
	return 200, newSession(key, sh, rel, m["text"].(string), 0), nil
}

func newSession(key string, sh files.Share, rel, text string, saved int) *session {
	eol := "\n"
	if strings.Contains(text, "\r\n") {
		eol = "\r\n"
	}
	s := &session{key: key, share: sh, rel: rel, text: U16(lf(text)), eol: eol, saved: saved, clients: map[*client]bool{}}
	sessions[key] = s
	return s
}

func (s *session) leave(c *client) {
	s.remove(c)
	s.toAll(map[string]any{"type": "people", "people": s.people()})
	if len(s.clients) == 0 {
		s.idle = time.AfterFunc(idle, func() {
			mu.Lock()
			defer mu.Unlock()
			if len(s.clients) > 0 {
				return
			}
			s.saveNow("")
			delete(sessions, s.key)
		})
	}
}

func (s *session) saveNow(by string) (int, any) {
	if s.autosave != nil {
		s.autosave.Stop()
	}
	s.dirtyAt = time.Time{}
	if s.saved == s.version {
		return 200, map[string]any{"path": s.rel}
	}
	if !files.Can(&s.share, "w") {
		return 403, map[string]any{"error": "this share is read-only"}
	}
	t := s.onDisk()
	status, out := files.Save(&s.share, s.rel, files.SaveP{Text: &t})
	if status != 200 {
		e, _ := out.(map[string]any)["error"].(string)
		if e == "" {
			e = fmt.Sprintf("save failed (%d)", status)
		}
		s.toAll(map[string]any{"type": "error", "error": e})
		return status, out
	}
	s.saved = s.version
	s.toAll(map[string]any{"type": "saved", "v": s.version, "by": by})
	return status, out
}

func (s *session) saveSoon() {
	if !files.Can(&s.share, "w") {
		return
	}
	if s.autosave != nil {
		s.autosave.Stop()
	}
	if s.dirtyAt.IsZero() {
		s.dirtyAt = time.Now()
	}
	wait := autosave
	if left := time.Until(s.dirtyAt.Add(autosaveMax)); left < wait {
		wait = left
	}
	if wait < 0 {
		wait = 0
	}
	s.autosave = time.AfterFunc(wait, func() {
		mu.Lock()
		defer mu.Unlock()
		s.saveNow("")
	})
}

func (s *session) onMessage(c *client, msg map[string]any) {
	str := func(v any, def string) string {
		x, ok := v.(string)
		if !ok || x == "" {
			if v != nil && v != false && v != "" {
				return fmt.Sprint(v)
			}
			return def
		}
		return x
	}
	switch msg["type"] {
	case "join":
		c.who = &who{clip(str(msg["name"], "anon"), 32), clip(str(msg["color"], ""), 16)}
		s.toAll(map[string]any{"type": "people", "people": s.people()})
		return
	case "cursor":
		p, _ := msg["pos"].(float64)
		n := int(p)
		if n < 0 {
			n = 0
		}
		if n > len(s.text) {
			n = len(s.text)
		}
		c.pos = n
		s.toAll(map[string]any{"type": "people", "people": s.people()})
		return
	case "save":
		if !files.Can(&s.share, "w") {
			sendTo(c, map[string]any{"type": "error", "error": "this share is read-only"})
			return
		}
		by := ""
		if c.who != nil {
			by = c.who.name
		}
		s.saveNow(by)
		return
	case "op":
	default:
		return
	}
	if !files.Can(&s.share, "w") {
		sendTo(c, map[string]any{"type": "error", "error": "this share is read-only"})
		return
	}
	resync := func() {
		sendTo(c, map[string]any{"type": "resync", "text": Str(s.text), "v": s.version, "saved": s.saved, "id": msg["id"]})
	}
	basef, okb := msg["base"].(float64)
	if s2, ok := msg["base"].(string); ok {
		fmt.Sscan(s2, &basef)
		okb = true
	}
	ops, okv := Parse(msg["ops"])
	base := int(basef)
	oldest := s.version - len(s.history)
	if !okv || !okb || basef != float64(base) || base > s.version || base < oldest {
		resync()
		return
	}
	for _, h := range s.history[base-oldest:] {
		var err error
		ops, _, err = Transform(ops, h)
		if err != nil {
			resync()
			return
		}
	}
	text, err := Apply(s.text, ops)
	if err != nil {
		resync()
		return
	}
	if len(text) > maxText {
		sendTo(c, map[string]any{"type": "error", "error": "over 512KB, the edit was not kept"})
		resync()
		return
	}
	s.text = text
	s.commit(ops, msg["id"], c)
}

func (s *session) commit(ops []Op, id any, by *client) {
	s.version++
	s.history = append(s.history, ops)
	if len(s.history) > history {
		s.history = s.history[1:]
	}
	for _, c := range s.order {
		if c != by && c.pos != 0 {
			c.pos = MapPos(ops, c.pos)
		}
	}
	name := ""
	if by.who != nil {
		name = by.who.name
	}
	s.toAll(map[string]any{"type": "op", "v": s.version, "ops": ops, "id": id, "by": name})
	if by.agent {
		s.toAll(map[string]any{"type": "people", "people": s.people()})
	}
	s.saveSoon()
}

// WriteP an outside save: text, or old and new, by an agent
type WriteP struct {
	Text     *string
	Old, New *string
	ByName   string
	ByColor  string
}

// Write a save from outside the editor, typed into the live session when
// one is open, straight to disk otherwise
func Write(sh files.Share, rel string, p WriteP) (int, any) {
	mu.Lock()
	s := sessions[keyOf(sh, rel)]
	if s == nil || len(s.clients) == 0 {
		mu.Unlock()
		return files.Save(&sh, rel, files.SaveP{Text: p.Text, Old: p.Old, New: p.New})
	}
	if !files.Can(&sh, "w") {
		mu.Unlock()
		return 403, map[string]any{"error": "this share is read-only"}
	}
	cur := Str(s.text)
	var target *string
	if p.Text != nil {
		t := lf(*p.Text)
		target = &t
	}
	if p.Old != nil && p.New != nil {
		old := lf(*p.Old)
		at := -1
		if old != "" {
			at = strings.Index(cur, old)
		}
		if at < 0 {
			mu.Unlock()
			return 409, map[string]any{"error": "old text not found"}
		}
		if strings.Contains(cur[at+1:], old) {
			mu.Unlock()
			return 409, map[string]any{"error": "old text found more than once, give more of it"}
		}
		t := cur[:at] + lf(*p.New) + cur[at+len(old):]
		target = &t
	}
	if target == nil {
		mu.Unlock()
		return 400, map[string]any{"error": "text, or old and new"}
	}
	tgt := U16(*target)
	if len(tgt) > maxText {
		mu.Unlock()
		return 413, map[string]any{"error": "over 512KB"}
	}
	name := p.ByName
	if name == "" {
		name = "phosphorus"
	}
	agent := &client{agent: true, who: &who{clip(name, 32), clip(p.ByColor, 16)}}
	if s.idle != nil {
		s.idle.Stop()
	}
	s.add(agent)
	a := 0
	for a < len(s.text) && a < len(tgt) && s.text[a] == tgt[a] {
		a++
	}
	e := 0
	for e < len(s.text)-a && e < len(tgt)-a && s.text[len(s.text)-1-e] == tgt[len(tgt)-1-e] {
		e++
	}
	gone := len(s.text) - a - e
	typed := tgt[a : len(tgt)-e]
	put := func(at, del int, ins []uint16) {
		var b builder
		b.retain(at)
		b.insert(ins)
		b.del(del)
		b.retain(len(s.text) - at - del)
		b.ops = nonNil(b.ops)
		t, err := Apply(s.text, b.ops)
		if err != nil {
			return
		}
		s.text = t
		agent.pos = at + len(ins)
		s.commit(b.ops, fmt.Sprintf("agent-%d", time.Now().UnixMilli()), agent)
	}
	agent.pos = a
	s.toAll(map[string]any{"type": "people", "people": s.people()})
	if gone > 0 {
		put(a, gone, nil)
	}
	mu.Unlock()
	step := (len(typed) + typeSteps - 1) / typeSteps
	if step < 1 {
		step = 1
	}
	for i := 0; i < len(typed); i += step {
		time.Sleep(typeMS)
		end := i + step
		if end > len(typed) {
			end = len(typed)
		}
		mu.Lock()
		at := agent.pos
		if at > len(s.text) {
			at = len(s.text)
		}
		put(at, 0, append([]uint16{}, typed[i:end]...))
		mu.Unlock()
	}
	mu.Lock()
	status, out := s.saveNow(agent.who.name)
	mu.Unlock()
	time.AfterFunc(agentStay, func() {
		mu.Lock()
		defer mu.Unlock()
		s.leave(agent)
	})
	if status == 200 {
		m := map[string]any{}
		for k, v := range out.(map[string]any) {
			m[k] = v
		}
		m["live"] = true
		m["note"] = "typed into the open editor and saved"
		return status, m
	}
	return status, out
}

// Attach a tab on this host's file, a home's through its gate
func Attach(ws *wsock.Conn, shareID, rel string, w *files.Who) {
	fail := func(e string) {
		ws.JSON(map[string]any{"type": "error", "error": e})
		ws.Close(1000)
		drain(ws)
	}
	sh := files.ShareOf(shareID)
	if !files.Enabled() || sh == nil {
		fail("no such share here")
		return
	}
	if !files.Can(sh, "r") {
		fail("this share is not readable")
		return
	}
	if sh.ID == "home" {
		if why := files.HomeGate(w, rel, users.Exists); why != "" {
			fail(why)
			return
		}
	}
	mu.Lock()
	status, s, errBody := open(*sh, rel)
	if status != 200 {
		mu.Unlock()
		e, _ := errBody.(map[string]any)["error"].(string)
		if e == "" {
			e = fmt.Sprintf("can't open it (%d)", status)
		}
		fail(e)
		return
	}
	clientSeq++
	c := &client{ws: ws, cid: clientSeq}
	s.add(c)
	sendTo(c, map[string]any{"type": "init", "text": Str(s.text), "v": s.version, "saved": s.saved, "perms": sh.Perms, "people": s.people(), "you": c.cid})
	mu.Unlock()
	for {
		raw, _, err := ws.Read()
		if err != nil {
			break
		}
		var m map[string]any
		if json.Unmarshal(raw, &m) != nil || m == nil {
			continue
		}
		mu.Lock()
		s.onMessage(c, m)
		mu.Unlock()
	}
	mu.Lock()
	s.leave(c)
	mu.Unlock()
}

func drain(ws *wsock.Conn) {
	for {
		if _, _, err := ws.Read(); err != nil {
			return
		}
	}
}

// Forward a tab whose file is on another host, the login cookie along
func Forward(ws *wsock.Conn, lookup func() string, cookie string) {
	var mu sync.Mutex
	var up *wsock.Conn
	early := [][]byte{}
	go func() {
		url := lookup()
		if !ws.Open() {
			return
		}
		if url == "" {
			ws.JSON(map[string]any{"type": "error", "error": "can't find that host on the tailnet"})
			ws.Close(1000)
			return
		}
		h := http.Header{}
		if cookie != "" {
			h.Set("Cookie", cookie)
		}
		u, err := wsock.Dial(url, h, hopTimeout)
		if err != nil {
			ws.JSON(map[string]any{"type": "error", "error": "that host didn't answer: " + err.Error()})
			ws.Close(1000)
			return
		}
		mu.Lock()
		up = u
		for _, d := range early {
			u.TextBytes(d)
		}
		early = nil
		mu.Unlock()
		for {
			d, _, err := u.Read()
			if err != nil {
				ws.Close(1000)
				return
			}
			ws.TextBytes(d)
		}
	}()
	for {
		d, _, err := ws.Read()
		if err != nil {
			mu.Lock()
			if up != nil {
				up.Terminate()
			}
			mu.Unlock()
			return
		}
		mu.Lock()
		if up != nil && up.Open() {
			up.TextBytes(d)
		} else {
			early = append(early, d)
		}
		mu.Unlock()
	}
}
