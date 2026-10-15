// Package term: an ssh session per browser tab into the host sshd, or a hop
// to the owning peer, binary frames for bytes, text for JSON resize and close
package term

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/vt"
	"golang.org/x/crypto/ssh"

	"github.com/pmghartman/phosphorus/internal/wsock"
)

const (
	loginTimeout = 120 * time.Second
	maxTries     = 3
	maxField     = 256
	grace        = 10 * time.Minute
	replayMax    = 256 * 1024
	// Ended close code for a session gone for good
	Ended = 4000
	// Taken close code for a socket another tab took the session from
	Taken       = 4001
	hopTimeout  = 10 * time.Second
	screenLines = 120
	settle      = 1500 * time.Millisecond
	maxCommand  = 2000
)

var (
	control      = regexp.MustCompile(`[\x00-\x1f\x7f-\x9f]`)
	secretPrompt = regexp.MustCompile(`(?i)pass(word|phrase)|token|secret|\bpin\b|\[sudo\]`)
)

func dim(n any, fallback int) int {
	f, ok := n.(float64)
	if ok && f == float64(int(f)) && f > 0 && f <= 1000 {
		return int(f)
	}
	return fallback
}

type session struct {
	mu         sync.Mutex
	sid        string
	ws         *wsock.Conn
	client     *ssh.Client
	sess       *ssh.Session
	stdin      io.WriteCloser
	onInput    func([]byte)
	shared     bool
	owner      string
	cols, rows int
	seq, base  int64
	chunks     [][]byte
	graceTimer *time.Timer
	loginTimer *time.Timer
	lastOut    time.Time
	waiter     func(string)
	streaming  bool
}

var (
	smu      sync.Mutex
	sessions = map[string]*session{}
)

func send(ws *wsock.Conn, b []byte) {
	if ws != nil && ws.Open() {
		ws.Binary(b)
	}
}

func (s *session) out(b []byte) {
	if len(b) == 0 {
		return
	}
	b = append([]byte{}, b...)
	s.mu.Lock()
	s.chunks = append(s.chunks, b)
	s.seq += int64(len(b))
	s.lastOut = time.Now()
	kept := s.seq - s.base
	for len(s.chunks) > 0 && kept-int64(len(s.chunks[0])) >= replayMax {
		kept -= int64(len(s.chunks[0]))
		s.base += int64(len(s.chunks[0]))
		s.chunks = s.chunks[1:]
	}
	ws := s.ws
	s.mu.Unlock()
	send(ws, b)
}

func live(sid string) bool {
	smu.Lock()
	defer smu.Unlock()
	_, ok := sessions[sid]
	return ok
}

func (s *session) end() {
	smu.Lock()
	if sessions[s.sid] != s {
		smu.Unlock()
		return
	}
	delete(sessions, s.sid)
	smu.Unlock()
	s.mu.Lock()
	w := s.waiter
	if s.graceTimer != nil {
		s.graceTimer.Stop()
	}
	if s.loginTimer != nil {
		s.loginTimer.Stop()
	}
	c, ws := s.client, s.ws
	s.mu.Unlock()
	if w != nil {
		w("closed")
	}
	if c != nil {
		c.Close()
	}
	if ws != nil {
		ws.Close(Ended)
	}
}

func (s *session) join(ws *wsock.Conn, since int64) {
	s.mu.Lock()
	if s.graceTimer != nil {
		s.graceTimer.Stop()
	}
	if s.ws != nil && s.ws != ws {
		s.ws.Close(Taken)
	}
	s.ws = ws
	at := s.base
	for _, c := range s.chunks {
		skip := since - at
		if skip < 0 {
			skip = 0
		}
		if skip < int64(len(c)) {
			send(ws, c[skip:])
		}
		at += int64(len(c))
	}
	s.mu.Unlock()
	go func() {
		for {
			data, binary, err := ws.Read()
			if err != nil {
				break
			}
			s.mu.Lock()
			mine := s.ws == ws
			w, in := s.waiter, s.onInput
			s.mu.Unlock()
			if !mine {
				continue
			}
			if binary {
				if w != nil && bytes.IndexByte(data, 0x0d) >= 0 {
					w("enter")
				} else if w != nil && bytes.IndexByte(data, 0x03) >= 0 {
					w("cancel")
				}
				if in != nil {
					in(data)
				}
				continue
			}
			var m map[string]any
			if json.Unmarshal(data, &m) != nil {
				continue
			}
			switch m["type"] {
			case "close":
				s.end()
				return
			case "share":
				s.mu.Lock()
				s.shared = m["on"] == true
				if by, ok := m["by"].(string); ok {
					if utf8.RuneCountInString(by) > maxField {
						by = string([]rune(by)[:maxField])
					}
					s.owner = by
				}
				s.mu.Unlock()
			case "resize":
				s.mu.Lock()
				s.cols = dim(m["cols"], s.cols)
				s.rows = dim(m["rows"], s.rows)
				ss, c, r := s.sess, s.cols, s.rows
				s.mu.Unlock()
				if ss != nil {
					ss.WindowChange(r, c)
				}
			}
		}
		s.mu.Lock()
		if s.ws != ws {
			s.mu.Unlock()
			return
		}
		s.ws = nil
		streaming := s.streaming
		if streaming {
			s.graceTimer = time.AfterFunc(grace, s.end)
		}
		s.mu.Unlock()
		if !streaming {
			s.end()
		}
	}()
}

// Opts a tab's join
type Opts struct {
	Host    string
	SID     string
	Since   int64
	Resume  bool
	SSHHost string
	Port    int
	Shell   string
}

// Attach login and password prompts, then the host's own shell, or a rejoin
func Attach(ws *wsock.Conn, o Opts) {
	smu.Lock()
	if l := sessions[o.SID]; l != nil {
		smu.Unlock()
		l.join(ws, o.Since)
		return
	}
	if o.Resume {
		smu.Unlock()
		send(ws, []byte("\r\n\x1b[2m[session ended]\x1b[0m\r\n"))
		ws.Close(Ended)
		go drain(ws)
		return
	}
	s := &session{sid: o.SID, cols: 80, rows: 24}
	sessions[o.SID] = s
	smu.Unlock()
	s.join(ws, 0)
	s.mu.Lock()
	s.loginTimer = time.AfterFunc(loginTimeout, func() {
		s.mu.Lock()
		up := s.streaming
		s.mu.Unlock()
		if !up {
			s.end()
		}
	})
	s.mu.Unlock()

	lines := make(chan string, 1)
	ask := func(label string, echo bool) (string, bool) {
		s.out([]byte(label))
		line := []rune{}
		s.mu.Lock()
		s.onInput = func(buf []byte) {
			for _, ch := range string(buf) {
				switch {
				case ch == '\r' || ch == '\n':
					s.out([]byte("\r\n"))
					s.mu.Lock()
					s.onInput = nil
					s.mu.Unlock()
					select {
					case lines <- string(line):
					default:
					}
					return
				case ch == 0x7f || ch == '\b':
					if len(line) == 0 {
						continue
					}
					line = line[:len(line)-1]
					if echo {
						s.out([]byte("\b \b"))
					}
				case ch >= ' ' && len(line) < maxField:
					line = append(line, ch)
					if echo {
						s.out([]byte(string(ch)))
					}
				}
			}
		}
		s.mu.Unlock()
		for {
			select {
			case l := <-lines:
				return l, true
			case <-time.After(time.Second):
				if !live(o.SID) {
					return "", false
				}
			}
		}
	}

	go func() {
		for i := 0; i < maxTries; i++ {
			user, ok := ask(o.Host+" login: ", true)
			if !ok || !live(o.SID) {
				return
			}
			user = strings.TrimSpace(user)
			if user == "" {
				i--
				continue
			}
			pass, ok := ask("password: ", false)
			if !ok {
				return
			}
			why := connect(s, o, user, pass)
			if why == "" || !live(o.SID) {
				return
			}
			s.mu.Lock()
			s.client = nil
			s.mu.Unlock()
			s.out([]byte(why + "\r\n\r\n"))
		}
		s.end()
	}()
}

func drain(ws *wsock.Conn) {
	for {
		if _, _, err := ws.Read(); err != nil {
			return
		}
	}
}

// connect "" once the shell is up, else why not
func connect(s *session, o Opts, user, pass string) string {
	cfg := &ssh.ClientConfig{
		User: user,
		Auth: []ssh.AuthMethod{
			ssh.Password(pass),
			ssh.KeyboardInteractive(func(_, _ string, qs []string, _ []bool) ([]string, error) {
				out := make([]string, len(qs))
				for i := range out {
					out[i] = pass
				}
				return out, nil
			}),
		},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         10 * time.Second,
	}
	c, err := ssh.Dial("tcp", net.JoinHostPort(o.SSHHost, strconv.Itoa(o.Port)), cfg)
	if err != nil {
		if strings.Contains(err.Error(), "unable to authenticate") {
			return "access denied"
		}
		return err.Error()
	}
	s.mu.Lock()
	s.client = c
	cols, rows := s.cols, s.rows
	s.mu.Unlock()
	ss, err := c.NewSession()
	if err != nil {
		c.Close()
		return err.Error()
	}
	if err := ss.RequestPty("xterm-256color", rows, cols, ssh.TerminalModes{}); err != nil {
		c.Close()
		return err.Error()
	}
	stdin, _ := ss.StdinPipe()
	stdout, _ := ss.StdoutPipe()
	stderr, _ := ss.StderrPipe()
	if o.Shell != "" {
		err = ss.Start(o.Shell)
	} else {
		err = ss.Shell()
	}
	if err != nil {
		c.Close()
		return err.Error()
	}
	s.mu.Lock()
	s.sess = ss
	s.stdin = stdin
	s.streaming = true
	s.onInput = func(b []byte) { stdin.Write(b) }
	s.mu.Unlock()
	pump := func(r io.Reader, wg *sync.WaitGroup) {
		defer wg.Done()
		buf := make([]byte, 32*1024)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				s.out(buf[:n])
			}
			if err != nil {
				return
			}
		}
	}
	go func() {
		var wg sync.WaitGroup
		wg.Add(2)
		go pump(stdout, &wg)
		go pump(stderr, &wg)
		wg.Wait()
		ss.Wait()
		s.end()
	}()
	go func() {
		c.Wait()
		s.end()
	}()
	return ""
}

// Forward the browser's socket spliced onto the owning peer's
func Forward(ws *wsock.Conn, host string, lookup func() string, resume bool) {
	var mu sync.Mutex
	var up *wsock.Conn
	type msg struct {
		b   []byte
		bin bool
	}
	early := []msg{}
	fail := func(why string) {
		send(ws, []byte(why+"\r\n"))
		if resume {
			ws.Close(1000)
		} else {
			ws.Close(Ended)
		}
	}
	go func() {
		for {
			b, bin, err := ws.Read()
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
				if bin {
					up.Binary(b)
				} else {
					up.TextBytes(b)
				}
			} else {
				early = append(early, msg{b, bin})
			}
			mu.Unlock()
		}
	}()
	go func() {
		url := lookup()
		if !ws.Open() {
			return
		}
		if url == "" {
			fail("can't find " + host + " on the tailnet")
			return
		}
		u, err := wsock.Dial(url, nil, hopTimeout)
		if err != nil {
			fail(fmt.Sprintf("%s didn't answer: %v", host, err))
			return
		}
		mu.Lock()
		up = u
		for _, m := range early {
			if m.bin {
				u.Binary(m.b)
			} else {
				u.TextBytes(m.b)
			}
		}
		early = nil
		mu.Unlock()
		if !ws.Open() {
			u.Terminate()
			return
		}
		for {
			b, bin, err := u.Read()
			if err != nil {
				code := u.CloseCode()
				if code == Ended || code == Taken {
					ws.Close(code)
				} else {
					ws.Close(1000)
				}
				return
			}
			if bin {
				ws.Binary(b)
			} else {
				ws.TextBytes(b)
			}
		}
	}()
}

// SessionCount sessions alive here
func SessionCount() int {
	smu.Lock()
	defer smu.Unlock()
	return len(sessions)
}

func lineText(cell func(x int) string, w int) string {
	var b strings.Builder
	for x := 0; x < w; x++ {
		b.WriteString(cell(x))
	}
	return strings.TrimRight(b.String(), " ")
}

// render kept output replayed through a vt emulator at the tab's size
func (s *session) render() string {
	s.mu.Lock()
	cols, rows := s.cols, s.rows
	all := bytes.Join(s.chunks, nil)
	s.mu.Unlock()
	e := vt.NewEmulator(cols, rows)
	e.SetScrollbackSize(screenLines)
	go io.Copy(io.Discard, e)
	e.Write(all)
	lines := []string{}
	sb := e.ScrollbackLen()
	for y := 0; y < sb; y++ {
		lines = append(lines, lineText(func(x int) string { return cellStr(e.ScrollbackCellAt(x, y)) }, cols))
	}
	for y := 0; y < rows; y++ {
		lines = append(lines, lineText(func(x int) string { return cellStr(e.CellAt(x, y)) }, cols))
	}
	e.Close()
	if len(lines) > screenLines {
		lines = lines[len(lines)-screenLines:]
	}
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	return strings.Join(lines, "\n")
}

func cellStr(c *uv.Cell) string {
	switch {
	case c == nil:
		return " "
	case c.Content == "" && c.Width == 0:
		return ""
	case c.Content == "":
		return " "
	}
	return c.Content
}

// Screen one shared terminal as phosphorus sees it
type Screen struct {
	ID     string `json:"id"`
	Cols   int    `json:"cols"`
	Rows   int    `json:"rows"`
	Screen string `json:"screen"`
}

func shared(by string) []*session {
	smu.Lock()
	defer smu.Unlock()
	out := []*session{}
	for _, s := range sessions {
		s.mu.Lock()
		ok := s.shared && s.streaming && (by == "" || s.owner == by)
		s.mu.Unlock()
		if ok {
			out = append(out, s)
		}
	}
	return out
}

// Screens every logged-in session its owner shared, by: one person's only
func Screens(by string) []Screen {
	out := []Screen{}
	for _, s := range shared(by) {
		s.mu.Lock()
		id, c, r := s.sid[:6], s.cols, s.rows
		s.mu.Unlock()
		out = append(out, Screen{id, c, r, s.render()})
	}
	return out
}

// Type a command typed into the owner's shared screen, left for them to run
func Type(by, id, text string, waitS int) (map[string]any, error) {
	mine := []*session{}
	for _, s := range shared("") {
		s.mu.Lock()
		ok := by != "" && s.owner == by && strings.HasPrefix(s.sid, id)
		s.mu.Unlock()
		if ok {
			mine = append(mine, s)
		}
	}
	if len(mine) != 1 {
		if len(mine) > 0 {
			return nil, errors.New("several shared terminals, give its id")
		}
		return nil, errors.New("no terminal of theirs is shared with phosphorus and logged in here")
	}
	s := mine[0]
	s.mu.Lock()
	busy := s.waiter != nil
	s.mu.Unlock()
	if busy {
		return nil, errors.New("already waiting on a command there")
	}
	before := s.render()
	ls := strings.Split(before, "\n")
	if secretPrompt.MatchString(ls[len(ls)-1]) {
		return nil, errors.New("the terminal is asking for a credential, they type that themselves")
	}
	cmd := control.ReplaceAllString(text, "")
	if r := []rune(cmd); len(r) > maxCommand {
		cmd = string(r[:maxCommand])
	}
	if strings.TrimSpace(cmd) == "" {
		return nil, errors.New("nothing to type")
	}
	s.mu.Lock()
	in := s.stdin
	s.mu.Unlock()
	in.Write([]byte(cmd))
	until := time.Now().Add(time.Duration(waitS) * time.Second)
	keys := make(chan string, 1)
	s.mu.Lock()
	s.waiter = func(k string) {
		s.mu.Lock()
		s.waiter = nil
		s.mu.Unlock()
		select {
		case keys <- k:
		default:
		}
	}
	s.mu.Unlock()
	var key string
	select {
	case key = <-keys:
	case <-time.After(time.Duration(waitS) * time.Second):
		s.mu.Lock()
		s.waiter = nil
		s.mu.Unlock()
		key = "timeout"
	}
	id6 := s.sid[:6]
	if key != "enter" {
		why := map[string]string{"cancel": "they cancelled it", "closed": "the terminal closed",
			"timeout": fmt.Sprintf("no Enter in %ds, still typed there", waitS)}[key]
		return map[string]any{"id": id6, "ran": false, "why": why, "screen": s.render()}, nil
	}
	entered := time.Now()
	quiet := func() time.Duration {
		s.mu.Lock()
		last := s.lastOut
		s.mu.Unlock()
		if entered.After(last) {
			last = entered
		}
		return time.Since(last)
	}
	for time.Now().Before(until) && quiet() < settle && live(s.sid) {
		time.Sleep(250 * time.Millisecond)
	}
	out := map[string]any{"id": id6, "ran": true, "screen": s.render()}
	if quiet() < settle {
		out["note"] = "still printing, terminal_screen with wait_s reads more"
	}
	return out, nil
}
