package claude

// the host reached over ssh with the user's saved login, as the terminal's:
// this host's own sshd as the terminal finds it, a peer's on its tailnet address

import (
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/pmghartman/phosphorus/internal/util"
)

const tailMax = 8 * 1024

var (
	sshHost = util.Env("HOST_SSH_HOST", "127.0.0.1")
	sshPort = util.Env("HOST_SSH_PORT", "22")
)

// addrOf where host's sshd answers
func addrOf(host string) (string, error) {
	if host == util.SelfHost {
		return net.JoinHostPort(sshHost, sshPort), nil
	}
	ip := util.TailnetIP(host)
	if ip == "" {
		return "", fmt.Errorf("can't find %s on the tailnet", host)
	}
	return net.JoinHostPort(ip, "22"), nil
}

// dial host as user, a password or keyboard-interactive login
func dial(host, user, pass string) (*ssh.Client, error) {
	addr, err := addrOf(host)
	if err != nil {
		return nil, err
	}
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
	c, err := ssh.Dial("tcp", addr, cfg)
	if err != nil {
		if strings.Contains(err.Error(), "unable to authenticate") {
			return nil, fmt.Errorf("the saved login for %s was refused", host)
		}
		return nil, fmt.Errorf("ssh to %s: %v", host, err)
	}
	return c, nil
}

// tail a writer keeping the last tailMax bytes
type tail struct {
	mu sync.Mutex
	b  []byte
}

func (t *tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	t.b = append(t.b, p...)
	if len(t.b) > tailMax {
		t.b = t.b[len(t.b)-tailMax:]
	}
	t.mu.Unlock()
	return len(p), nil
}

func (t *tail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.TrimSpace(util.UTF8(t.b))
}

// exitCode a session's exit, -1 when it never gave one
func exitCode(err error) int {
	var ee *ssh.ExitError
	switch {
	case err == nil:
		return 0
	case errors.As(err, &ee):
		return ee.ExitStatus()
	}
	return -1
}

// run one command to its end, stdin fed it: its exit code and output's tail
func run(c *ssh.Client, cmd, stdin string, timeout time.Duration) (int, string, error) {
	ss, err := c.NewSession()
	if err != nil {
		return -1, "", err
	}
	defer ss.Close()
	out := &tail{}
	ss.Stdout, ss.Stderr = out, out
	if stdin != "" {
		ss.Stdin = strings.NewReader(stdin)
	}
	done := make(chan error, 1)
	go func() { done <- ss.Run(cmd) }()
	select {
	case err = <-done:
	case <-time.After(timeout):
		ss.Signal(ssh.SIGKILL)
		return -1, out.String(), errors.New("timed out")
	}
	code := exitCode(err)
	if code == -1 {
		return code, out.String(), err
	}
	return code, out.String(), nil
}

// proc a running claude: its stdin, stdout, stderr's tail and end
type proc struct {
	in   io.WriteCloser
	out  io.Reader
	errs *tail
	wait func() int
	kill func()
}

// spawner a claude started on host: setup run first, then command with env on stdin
type spawner func(host string, c Creds, setup, command, env string) (*proc, error)

var spawn spawner = sshSpawn

func sshSpawn(host string, c Creds, setup, command, env string) (*proc, error) {
	cl, err := dial(host, c.User, c.Pass)
	if err != nil {
		return nil, err
	}
	code, out, err := run(cl, "sh -s", setup, 60*time.Second)
	if err != nil || code != 0 {
		cl.Close()
		return nil, setupErr(host, code, out, err)
	}
	ss, err := cl.NewSession()
	if err != nil {
		cl.Close()
		return nil, err
	}
	in, _ := ss.StdinPipe()
	o, _ := ss.StdoutPipe()
	errs := &tail{}
	ss.Stderr = errs
	if err := ss.Start(command); err != nil {
		cl.Close()
		return nil, err
	}
	if _, err := io.WriteString(in, env); err != nil {
		cl.Close()
		return nil, err
	}
	var once sync.Once
	return &proc{in: in, out: o, errs: errs,
		wait: func() int {
			code := exitCode(ss.Wait())
			cl.Close()
			return code
		},
		kill: func() {
			once.Do(func() {
				in.Close()
				ss.Signal(ssh.SIGTERM)
				// a claude ignoring its closed stdin gone with the connection
				time.AfterFunc(5*time.Second, func() { cl.Close() })
			})
		}}, nil
}

// setupErr why setup failed, a Windows host's shell named
func setupErr(host string, code int, out string, err error) error {
	low := strings.ToLower(out)
	switch {
	case code == 127 && !strings.Contains(low, "not found") && !strings.Contains(low, "not recognized"):
		return fmt.Errorf("claude isn't installed on %s: install it from the Code app", host)
	case strings.Contains(low, "not recognized") || strings.Contains(low, "commandnotfound"):
		return fmt.Errorf("%s runs Windows, which Code doesn't support yet", host)
	case err != nil:
		return fmt.Errorf("setting up claude on %s: %v", host, err)
	}
	if len(out) > 400 {
		out = out[len(out)-400:]
	}
	return fmt.Errorf("setting up claude on %s failed (exit %d): %s", host, code, out)
}

// version claude's on host, "" when it isn't installed
func version(host string, c Creds) (string, error) {
	cl, err := dial(host, c.User, c.Pass)
	if err != nil {
		return "", err
	}
	defer cl.Close()
	code, out, err := run(cl, versionCommand(), "", 30*time.Second)
	if err != nil {
		return "", err
	}
	if code != 0 {
		return "", nil
	}
	return strings.TrimSpace(strings.SplitN(out, "\n", 2)[0]), nil
}

// install the official installer run as the login: ok and its output's tail
func install(host string, c Creds) (bool, string, error) {
	cl, err := dial(host, c.User, c.Pass)
	if err != nil {
		return false, "", err
	}
	defer cl.Close()
	code, out, err := run(cl, installCommand(), "", 10*time.Minute)
	if err != nil {
		return false, out, err
	}
	return code == 0, out, nil
}
