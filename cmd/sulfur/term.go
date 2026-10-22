package main

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/sulfur"
	"github.com/pmghartman/phosphorus/internal/wsock"
)

const (
	// ended: the shell's gone for good, as the mesh's terminals say it
	termEnded = 4000
	replayMax = 256 * 1024
	// a terminal whose page went away kept this long for its return
	termGrace = 10 * time.Minute
)

// termSession one shell on this computer, by the page's id, its recent output
// kept so a reloaded page picks up where it was
type termSession struct {
	mu    sync.Mutex
	l     *sulfur.Local
	buf   []byte
	total int64
	ws    *wsock.Conn
	ended bool
	idle  *time.Timer
}

var (
	termsMu sync.Mutex
	terms   = map[string]*termSession{}
)

// Write the shell's output: kept, and sent to the page if one's there
func (s *termSession) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.buf = append(s.buf, p...)
	if len(s.buf) > replayMax {
		s.buf = append([]byte(nil), s.buf[len(s.buf)-replayMax:]...)
	}
	s.total += int64(len(p))
	if s.ws != nil {
		s.ws.Binary(append([]byte(nil), p...))
	}
	return len(p), nil
}

func terminal(ws *wsock.Conn, sid string, since int64) {
	if sid == "" || len(sid) > 64 {
		ws.Close(termEnded)
		return
	}
	termsMu.Lock()
	s := terms[sid]
	termsMu.Unlock()
	if s != nil {
		s.attach(ws, since)
	}
	var run string
	started := s != nil
	for {
		b, binary, err := ws.Read()
		if err != nil {
			break
		}
		if binary {
			if s != nil {
				s.l.Input(b)
			}
			continue
		}
		var m struct {
			Type       string
			Cols, Rows int
			Run        string
		}
		if json.Unmarshal(b, &m) != nil {
			continue
		}
		switch m.Type {
		case "resize":
			// the first size the page gives is the shell's to start at
			if !started {
				started = true
				ns, err := startShell(sid, m.Cols, m.Rows)
				if err != nil {
					ws.Binary([]byte("\r\n\x1b[31m" + err.Error() + "\x1b[0m\r\n"))
					ws.Close(termEnded)
					return
				}
				s = ns
				s.attach(ws, 0)
			} else if s != nil {
				s.l.Resize(m.Cols, m.Rows)
			}
		case "login":
			// no login here, only the line Sulfur types first: into its folder
			run = m.Run
			if s != nil && run != "" {
				go func(l *sulfur.Local, line string) { time.Sleep(250 * time.Millisecond); l.Input([]byte(line + "\r")) }(s.l, run)
			}
		case "close":
			if s != nil {
				s.l.Stop()
			}
		}
	}
	if s != nil {
		s.detach(ws)
	}
}

func startShell(sid string, cols, rows int) (*termSession, error) {
	s := &termSession{}
	l, wait, err := sulfur.StartShell("", cols, rows, s)
	if err != nil {
		return nil, err
	}
	s.l = l
	termsMu.Lock()
	terms[sid] = s
	termsMu.Unlock()
	go func() {
		wait()
		s.mu.Lock()
		s.ended = true
		ws := s.ws
		s.mu.Unlock()
		if ws != nil {
			ws.Close(termEnded)
		}
		termsMu.Lock()
		if terms[sid] == s {
			delete(terms, sid)
		}
		termsMu.Unlock()
	}()
	return s, nil
}

// attach a page: what it missed, then live; another page's taken over
func (s *termSession) attach(ws *wsock.Conn, since int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.idle != nil {
		s.idle.Stop()
		s.idle = nil
	}
	if old := s.ws; old != nil && old != ws {
		old.Close(4001)
	}
	s.ws = ws
	from := since - (s.total - int64(len(s.buf)))
	if from < 0 || since > s.total {
		from = 0
	}
	if rest := s.buf[from:]; len(rest) > 0 {
		ws.Binary(append([]byte(nil), rest...))
	}
	if s.ended {
		ws.Close(termEnded)
	}
}

// detach the page; the shell kept a while for it to come back
func (s *termSession) detach(ws *wsock.Conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ws != ws {
		return
	}
	s.ws = nil
	if !s.ended {
		s.idle = time.AfterFunc(termGrace, s.l.Stop)
	}
}

// --- a build or a run: one task in a terminal of its own ------------------------------

type streamOut struct {
	mu sync.Mutex
	ws *wsock.Conn
}

func (o *streamOut) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ws.Binary(append([]byte(nil), p...))
	return len(p), nil
}

func runTask(ws *wsock.Conn) {
	data, _, err := ws.Read()
	if err != nil {
		return
	}
	var p struct {
		Task sulfur.Task `json:"task"`
	}
	fail := func(e string) {
		ws.JSON(map[string]any{"type": "exit", "code": -1, "error": e})
		ws.Close(termEnded)
	}
	if json.Unmarshal(data, &p) != nil {
		fail("bad task")
		return
	}
	run, wait, err := sulfur.StartLocal(p.Task, &streamOut{ws: ws})
	if err != nil {
		fail(err.Error())
		return
	}
	go func() {
		for {
			b, binary, err := ws.Read()
			if err != nil {
				run.Stop()
				return
			}
			if binary {
				run.Input(b)
				continue
			}
			var m struct {
				Type       string
				Cols, Rows int
			}
			json.Unmarshal(b, &m)
			switch m.Type {
			case "resize":
				run.Resize(m.Cols, m.Rows)
			case "kill":
				run.Stop()
			}
		}
	}()
	code := wait()
	ws.JSON(map[string]any{"type": "exit", "code": code})
	ws.Close(termEnded)
}
