package sulfur

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/charmbracelet/x/xpty"
)

// Local a shell or a task on this computer in a terminal of its own, as Sulfur's
// desktop app runs them offline: no ssh, no login, the user's own processes
type Local struct {
	pty  xpty.Pty
	cmd  *exec.Cmd
	once sync.Once
	done chan struct{}
}

// StartLocal t on this computer, its output to out as it comes; the returned
// wait gives its exit once it's done
func StartLocal(t Task, out io.Writer) (*Local, func() int, error) {
	t.Windows = runtime.GOOS == "windows"
	line, err := t.Line()
	if err != nil {
		return nil, nil, err
	}
	return startPty(shellLine(line), "", t.Cols, t.Rows, out)
}

// StartShell the user's own shell in dir: PowerShell on Windows, $SHELL as a
// login shell elsewhere
func StartShell(dir string, cols, rows int, out io.Writer) (*Local, func() int, error) {
	if st, err := os.Stat(dir); dir == "" || err != nil || !st.IsDir() {
		dir, _ = os.UserHomeDir()
	}
	return startPty(loginShell(), dir, cols, rows, out)
}

func startPty(cmd *exec.Cmd, dir string, cols, rows int, out io.Writer) (*Local, func() int, error) {
	if cols < 20 || cols > 1000 {
		cols = 120
	}
	if rows < 5 || rows > 500 {
		rows = 30
	}
	p, err := xpty.NewPty(cols, rows)
	if err != nil {
		return nil, nil, err
	}
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor", "TERM_PROGRAM=Sulfur")
	if err := p.Start(cmd); err != nil {
		p.Close()
		return nil, nil, err
	}
	l := &Local{pty: p, cmd: cmd, done: make(chan struct{})}
	copied := make(chan struct{})
	go func() {
		io.Copy(out, p)
		close(copied)
	}()
	wait := func() int {
		err := xpty.WaitProcess(context.Background(), cmd)
		close(l.done)
		// ConPTY holds its pipe open past the process: what's left read, then closed
		select {
		case <-copied:
		case <-time.After(300 * time.Millisecond):
		}
		p.Close()
		<-copied
		var ee *exec.ExitError
		switch {
		case err == nil:
			return 0
		case errors.As(err, &ee):
			return ee.ExitCode()
		}
		return -1
	}
	return l, wait, nil
}

// Input keys typed into it
func (l *Local) Input(b []byte) { l.pty.Write(b) }

// Resize its terminal
func (l *Local) Resize(cols, rows int) {
	if cols >= 20 && rows >= 5 {
		l.pty.Resize(cols, rows)
	}
}

// Stop it, and whatever it started
func (l *Local) Stop() {
	l.once.Do(func() {
		if l.cmd.Process != nil {
			killTree(l.cmd.Process)
		}
		select {
		case <-l.done:
		case <-time.After(2 * time.Second):
			l.pty.Close()
		}
	})
}

// ProbeLocal this computer's toolchains, as Probe a host's, kept a while unless fresh
func ProbeLocal(fresh bool) (*Toolchains, error) {
	const key = "\x00local"
	cacheMu.Lock()
	if t := cache[key]; t != nil && !fresh && time.Since(time.UnixMilli(t.At)) < probeTTL {
		cacheMu.Unlock()
		return t, nil
	}
	cacheMu.Unlock()
	win := runtime.GOOS == "windows"
	var cmd *exec.Cmd
	if win {
		cmd = exec.Command("powershell", strings.Fields(strings.TrimPrefix(PowerShell(windowsProbe()), "powershell "))...)
	} else {
		cmd = exec.Command("/bin/sh", "-c", posixProbe())
	}
	hideWindow(cmd)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	var b strings.Builder
	w := &capped{b: &b, max: 1 << 20}
	cmd.Stdout, cmd.Stderr = w, w
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go func() { <-ctx.Done(); cmd.Process.Kill() }()
	cmd.Wait()
	if ctx.Err() == context.DeadlineExceeded {
		return nil, errors.New("timed out")
	}
	t := parseProbe(b.String())
	t.Host, _ = os.Hostname()
	t.At = time.Now().UnixMilli()
	if win {
		t.OS, t.Shell = "windows", "powershell"
	}
	cacheMu.Lock()
	cache[key] = t
	cacheMu.Unlock()
	return t, nil
}
