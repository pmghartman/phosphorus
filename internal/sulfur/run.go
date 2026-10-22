package sulfur

import (
	"errors"
	"io"
	"strings"
	"sync"

	"golang.org/x/crypto/ssh"

	"github.com/pmghartman/phosphorus/internal/code"
)

// posixPath where a user's toolchains install themselves, ahead of a
// non-login shell's PATH, as the probe looks
const posixPath = `PATH="$HOME/.local/bin:$HOME/.cargo/bin:$HOME/go/bin:$HOME/.dotnet:$HOME/.bun/bin:/usr/local/go/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH; `

// Task one build or run: its folder and command line on the host, a Windows
// one under Visual Studio's environment when VCVars names its script
type Task struct {
	Dir     string `json:"dir"`
	Command string `json:"command"`
	VCVars  string `json:"vcvars"`
	Windows bool   `json:"windows"`
	Cols    int    `json:"cols"`
	Rows    int    `json:"rows"`
}

// Line what sshd runs for t: sh in the folder, or cmd pushd'd there on Windows
func (t Task) Line() (string, error) {
	if strings.TrimSpace(t.Command) == "" {
		return "", errors.New("no command")
	}
	if strings.ContainsAny(t.Command+t.Dir+t.VCVars, "\x00\r\n") {
		return "", errors.New("a command is one line")
	}
	if !t.Windows {
		return "sh -c " + code.Quote(posixPath+`cd -- "$1" || exit 3; eval "$2"`) + " sh " + code.Quote(t.Dir) + " " + code.Quote(t.Command), nil
	}
	if strings.Contains(t.Dir, `"`) || strings.Contains(t.VCVars, `"`) {
		return "", errors.New("a folder or script with a quote in its name")
	}
	line := `pushd "` + t.Dir + `" && `
	if t.VCVars != "" {
		line += `call "` + t.VCVars + `" >nul && `
	}
	return `cmd /d /s /c "` + line + t.Command + `"`, nil
}

// Session a task running on a host: its input, its size, its end
type Session struct {
	cl   *ssh.Client
	ss   *ssh.Session
	in   io.WriteCloser
	once sync.Once
}

// Start t on host as c's login in a terminal of its own, its output to out
// as it comes; the returned wait gives its exit once it's done
func Start(host string, c code.Creds, t Task, out io.Writer) (*Session, func() int, error) {
	line, err := t.Line()
	if err != nil {
		return nil, nil, err
	}
	cl, err := code.Dial(host, c)
	if err != nil {
		return nil, nil, err
	}
	ss, err := cl.NewSession()
	if err != nil {
		cl.Close()
		return nil, nil, err
	}
	cols, rows := t.Cols, t.Rows
	if cols < 20 || cols > 1000 {
		cols = 120
	}
	if rows < 5 || rows > 500 {
		rows = 30
	}
	if err := ss.RequestPty("xterm-256color", rows, cols, ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 115200, ssh.TTY_OP_OSPEED: 115200}); err != nil {
		cl.Close()
		return nil, nil, err
	}
	in, _ := ss.StdinPipe()
	ss.Stdout, ss.Stderr = out, out
	if err := ss.Start(line); err != nil {
		cl.Close()
		return nil, nil, err
	}
	s := &Session{cl: cl, ss: ss, in: in}
	wait := func() int {
		err := ss.Wait()
		cl.Close()
		var ee *ssh.ExitError
		switch {
		case err == nil:
			return 0
		case errors.As(err, &ee):
			return ee.ExitStatus()
		}
		return -1
	}
	return s, wait, nil
}

// Input keys typed into the task
func (s *Session) Input(b []byte) { s.in.Write(b) }

// Resize the task's terminal
func (s *Session) Resize(cols, rows int) {
	if cols >= 20 && rows >= 5 {
		s.ss.WindowChange(rows, cols)
	}
}

// Stop the task, its connection closed after it so nothing's left running
func (s *Session) Stop() {
	s.once.Do(func() {
		s.ss.Signal(ssh.SIGINT)
		s.ss.Signal(ssh.SIGKILL)
		s.in.Close()
		s.cl.Close()
	})
}
