package server

// a persistent login shell per user per host, kept over the host's own sshd so
// a key's commands share one working directory, environment and background jobs
// across calls, the way a shell session does. each command ends with a marker
// line carrying its exit code, read back as that command's output.

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

const (
	shellIdle   = 30 * time.Minute
	shellOutMax = 256 << 10
)

type shellLine struct {
	s   string
	err error
}

type shell struct {
	mu      sync.Mutex
	client  *ssh.Client
	sess    *ssh.Session
	stdin   io.WriteCloser
	lines   <-chan shellLine
	marker  string
	n       int
	lastUse time.Time
	dead    bool
}

// readLines one goroutine per session feeding its line channel, so no call
// leaks a reader that would steal the next command's output
func readLines(pr io.Reader) <-chan shellLine {
	ch := make(chan shellLine, 64)
	go func() {
		r := bufio.NewReader(pr)
		for {
			s, err := r.ReadString('\n')
			ch <- shellLine{s, err}
			if err != nil {
				close(ch)
				return
			}
		}
	}()
	return ch
}

var (
	shellsMu sync.Mutex
	shells   = map[string]*shell{}
)

// shellKey one session per user on this host
func shellKey(user string) string { return user }

// shellExec a command in the user's persistent shell here, the session opened
// on first use and reused after; reset drops any session first
func shellExec(user, pass, cmd string, stdin string, timeout int, reset bool) (int, any) {
	if user == "" || strings.TrimSpace(cmd) == "" {
		return 400, map[string]any{"error": "a login and a command"}
	}
	if strings.ContainsRune(cmd, 0) {
		return 400, map[string]any{"error": "the command holds a null byte"}
	}
	if timeout < 1 || timeout > execMax {
		timeout = 60
	}
	key := shellKey(user)
	if reset {
		closeShell(key)
	}
	sh, fresh, err := getShell(key, user, pass)
	if err != nil {
		return err.(coded).status, map[string]any{"error": err.Error()}
	}
	out, code, timedOut, err := sh.run(cmd, stdin, time.Duration(timeout)*time.Second)
	if err != nil {
		closeShell(key)
		// a session that broke mid-reuse: reopen once and try again
		if !fresh {
			return shellExec(user, pass, cmd, stdin, timeout, false)
		}
		return 502, map[string]any{"error": "the shell on " + selfHost + " stopped: " + err.Error()}
	}
	res := map[string]any{"host": selfHost, "user": user, "exit": code, "output": out, "session": true}
	if timedOut {
		closeShell(key)
		res["exit"], res["timedOut"] = nil, true
		res["note"] = "the command ran past the timeout, so the session was closed; the next command opens a fresh one"
	}
	return 200, res
}

type coded struct {
	status int
	msg    string
}

func (c coded) Error() string { return c.msg }

func getShell(key, user, pass string) (*shell, bool, error) {
	shellsMu.Lock()
	if sh := shells[key]; sh != nil && !sh.dead {
		shellsMu.Unlock()
		return sh, false, nil
	}
	shellsMu.Unlock()
	sh, err := openShell(user, pass)
	if err != nil {
		return nil, false, err
	}
	shellsMu.Lock()
	shells[key] = sh
	shellsMu.Unlock()
	return sh, true, nil
}

func closeShell(key string) {
	shellsMu.Lock()
	sh := shells[key]
	delete(shells, key)
	shellsMu.Unlock()
	if sh != nil {
		sh.close()
	}
}

func (s *shell) close() {
	s.mu.Lock()
	s.dead = true
	stdin, sess, client := s.stdin, s.sess, s.client
	s.mu.Unlock()
	if stdin != nil {
		stdin.Close()
	}
	if sess != nil {
		sess.Close()
	}
	if client != nil {
		client.Close()
	}
}

func openShell(user, pass string) (*shell, error) {
	c, err := sshDial(user, pass)
	if err != nil {
		return nil, err
	}
	ss, err := c.NewSession()
	if err != nil {
		c.Close()
		return nil, coded{502, err.Error()}
	}
	stdin, err := ss.StdinPipe()
	if err != nil {
		c.Close()
		return nil, coded{502, err.Error()}
	}
	pr, pw := io.Pipe()
	ss.Stdout, ss.Stderr = pw, pw
	m := make([]byte, 8)
	rand.Read(m)
	sh := &shell{client: c, sess: ss, stdin: stdin, lines: readLines(pr), marker: "__phos_" + hex.EncodeToString(m), lastUse: time.Now()}
	// a plain shell reading commands on stdin, errors folded into stdout
	if err := ss.Shell(); err != nil {
		c.Close()
		return nil, coded{502, err.Error()}
	}
	go func() {
		ss.Wait()
		pw.Close()
	}()
	return sh, nil
}

// sshDial the host's own sshd as the saved login, password or keyboard-interactive
func sshDial(user, pass string) (*ssh.Client, error) {
	cfg := &ssh.ClientConfig{
		User: user,
		Auth: []ssh.AuthMethod{ssh.Password(pass), ssh.KeyboardInteractive(func(_, _ string, qs []string, _ []bool) ([]string, error) {
			out := make([]string, len(qs))
			for i := range out {
				out[i] = pass
			}
			return out, nil
		})},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         10 * time.Second,
	}
	c, err := ssh.Dial("tcp", netJoin(hostSSHHost, hostSSHPort), cfg)
	if err != nil {
		if strings.Contains(err.Error(), "unable to authenticate") {
			return nil, coded{403, "the saved login for " + selfHost + " was refused"}
		}
		return nil, coded{502, "ssh to " + selfHost + ": " + err.Error()}
	}
	return c, nil
}

// run one command, its output up to the marker line, the marker's exit code,
// and whether the timeout cut it
func (s *shell) run(cmd, stdin string, timeout time.Duration) (string, int, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastUse = time.Now()
	s.n++
	tag := fmt.Sprintf("%s %d ", s.marker, s.n)
	out, code, err := driveShell(s.stdin, s.lines, cmd, stdin, tag, timeout)
	timedOut := err == errShellTimeout
	if timedOut {
		err = nil
	}
	return out, code, timedOut, err
}

var errShellTimeout = coded{504, "timeout"}

// driveShell feed one command, then a line printing the tag and $?, and read
// the combined output until that tag line; the core, ssh aside, so it is tested
// against a local shell
func driveShell(stdin io.Writer, lines <-chan shellLine, cmd, feed, tag string, timeout time.Duration) (string, int, error) {
	// feed delivered by a heredoc so the command sees a bounded stdin that ends,
	// the shell's own stdin staying open for the marker and the next command
	script := cmd + "\n"
	if feed != "" {
		delim := "PHOS_IN_" + strings.TrimPrefix(strings.Fields(tag)[0], "__phos_")
		script = cmd + " <<'" + delim + "'\n" + feed
		if !strings.HasSuffix(feed, "\n") {
			script += "\n"
		}
		script += delim + "\n"
	}
	script += "printf '\\n%s%d\\n' '" + tag + "' \"$?\"\n"
	if _, err := io.WriteString(stdin, script); err != nil {
		return "", -1, err
	}
	var buf strings.Builder
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case <-timer.C:
			return buf.String(), -1, errShellTimeout
		case ln, ok := <-lines:
			if !ok {
				if buf.Len() == 0 {
					return "", -1, io.EOF
				}
				return trimOneNL(buf.String()), -1, nil
			}
			t := strings.TrimRight(ln.s, "\r\n")
			if rest, ok := strings.CutPrefix(t, tag); ok {
				code, _ := strconv.Atoi(strings.TrimSpace(rest))
				return trimOneNL(buf.String()), code, nil
			}
			if ln.s != "" {
				if buf.Len() < shellOutMax {
					buf.WriteString(ln.s)
				}
			}
			if ln.err != nil {
				if buf.Len() == 0 {
					return "", -1, ln.err
				}
				return trimOneNL(buf.String()), -1, nil
			}
		}
	}
}

// trimOneNL trailing newlines dropped, the injected one and the command's own
func trimOneNL(s string) string { return strings.TrimRight(s, "\n") }

func netJoin(host, port string) string { return host + ":" + port }

// reapShells idle sessions closed on a tick, called from the server's loop
func reapShells() {
	shellsMu.Lock()
	var gone []*shell
	for k, sh := range shells {
		sh.mu.Lock()
		idle := time.Since(sh.lastUse) > shellIdle
		sh.mu.Unlock()
		if idle || sh.dead {
			gone = append(gone, sh)
			delete(shells, k)
		}
	}
	shellsMu.Unlock()
	for _, sh := range gone {
		sh.close()
	}
}
