package sulfur

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/pmghartman/phosphorus/internal/code"
)

// gitVerbs the git commands Sulfur's Source Control runs, and no others
var gitVerbs = map[string]bool{
	"status": true, "diff": true, "add": true, "restore": true, "rm": true, "mv": true, "commit": true,
	"push": true, "pull": true, "fetch": true, "branch": true, "switch": true, "checkout": true,
	"log": true, "show": true, "stash": true, "rev-parse": true, "remote": true, "init": true,
	"clone": true, "merge": true, "rebase": true, "reset": true, "ls-files": true, "tag": true,
	"blame": true, "for-each-ref": true, "symbolic-ref": true, "check-ignore": true,
}

// GitCheck why args aren't a Source Control command: an unknown verb, or an
// option that would run a program of the caller's (an upload pack, an exec)
func GitCheck(args []string) error {
	if len(args) == 0 || !gitVerbs[args[0]] {
		return errors.New("not a git command Sulfur runs")
	}
	for _, a := range args[1:] {
		l := strings.ToLower(a)
		if strings.ContainsRune(a, 0) || strings.HasPrefix(l, "-c") && !strings.HasPrefix(l, "--c") ||
			strings.Contains(l, "upload-pack") || strings.Contains(l, "receive-pack") || strings.HasPrefix(l, "--exec") ||
			strings.HasPrefix(l, "--config") || strings.HasPrefix(l, "--template") || strings.HasPrefix(l, "--output") || l == "-u" && (args[0] == "clone" || args[0] == "fetch" || args[0] == "pull") {
			return errors.New("an option Sulfur doesn't pass to git: " + a)
		}
	}
	return nil
}

// GitResult a git command's end: its exit, what it wrote and what it said
type GitResult struct {
	Code int    `json:"code"`
	Out  string `json:"out"`
	Err  string `json:"err"`
}

// GitCreds a login git gives an https remote on Host and no other
type GitCreds struct {
	Host string `json:"host"`
	User string `json:"user"`
	Pass string `json:"pass"`
}

func gitTimeout(args []string) time.Duration {
	switch args[0] {
	case "clone", "push", "pull", "fetch":
		return 15 * time.Minute
	}
	return 2 * time.Minute
}

// helper git's credential helper for c.Host alone, its login read from the environment
func (c *GitCreds) env() []string {
	if c == nil || c.Host == "" || c.User == "" || strings.ContainsAny(c.Host, "'\"\\ \r\n") {
		return nil
	}
	return []string{"PHOS_GIT_USER=" + c.User, "PHOS_GIT_PASS=" + c.Pass, "GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_COUNT=1",
		"GIT_CONFIG_KEY_0=credential.https://" + c.Host + ".helper",
		`GIT_CONFIG_VALUE_0=!f() { test "$1" = get && printf "username=%s\npassword=%s\n" "$PHOS_GIT_USER" "$PHOS_GIT_PASS"; }; f`}
}

// GitLocal git in dir on this computer, as its user
func GitLocal(dir string, args []string, creds *GitCreds) (GitResult, error) {
	if err := GitCheck(args); err != nil {
		return GitResult{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout(args))
	defer cancel()
	full := args
	if dir != "" {
		full = append([]string{"-C", dir}, args...)
	}
	cmd := exec.CommandContext(ctx, "git", full...)
	hideWindow(cmd)
	cmd.Env = append(append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "LC_ALL=C"), creds.env()...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	r := GitResult{Out: out.String(), Err: errb.String()}
	var ee *exec.ExitError
	switch {
	case err == nil:
	case errors.As(err, &ee):
		r.Code = ee.ExitCode()
	case errors.Is(err, exec.ErrNotFound):
		return r, errors.New("git isn't installed on this computer")
	default:
		return r, err
	}
	return r, nil
}

// GitRemote git in dir on host, as c's login there; creds handed to git for
// its one https host, read from stdin so they're in no command line
func GitRemote(host string, c code.Creds, dir string, args []string, windows bool, creds *GitCreds) (GitResult, error) {
	if err := GitCheck(args); err != nil {
		return GitResult{}, err
	}
	cl, err := code.Dial(host, c)
	if err != nil {
		return GitResult{}, err
	}
	defer cl.Close()
	ss, err := cl.NewSession()
	if err != nil {
		return GitResult{}, err
	}
	defer ss.Close()
	var line, stdin string
	if windows {
		q := func(s string) string { return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"` }
		parts := []string{"git", "-C", q(dir)}
		for _, a := range args {
			if strings.ContainsAny(a, "\r\n%") {
				return GitResult{}, errors.New("a line break or % in a git argument, on a Windows host")
			}
			parts = append(parts, q(a))
		}
		line = `cmd /d /s /c "set GIT_TERMINAL_PROMPT=0&& ` + strings.Join(parts, " ") + `"`
	} else {
		parts := []string{"git", "-C", code.Quote(dir)}
		for _, a := range args {
			parts = append(parts, code.Quote(a))
		}
		prefix := "export GIT_TERMINAL_PROMPT=0 LC_ALL=C; "
		if env := creds.env(); env != nil {
			prefix = "IFS= read -r PHOS_GIT_USER; IFS= read -r PHOS_GIT_PASS; export PHOS_GIT_USER PHOS_GIT_PASS GIT_TERMINAL_PROMPT=0 LC_ALL=C GIT_CONFIG_COUNT=1 " +
				code.Quote(env[4]) + " " + code.Quote(env[5]) + "; "
			stdin = creds.User + "\n" + creds.Pass + "\n"
		}
		line = "sh -c " + code.Quote(posixPath+prefix+strings.Join(parts, " "))
	}
	var out, errb bytes.Buffer
	ss.Stdout, ss.Stderr = &out, &errb
	ss.Stdin = strings.NewReader(stdin)
	done := make(chan error, 1)
	go func() { done <- ss.Run(line) }()
	select {
	case err = <-done:
	case <-time.After(gitTimeout(args)):
		ss.Signal(ssh.SIGKILL)
		return GitResult{Out: out.String(), Err: errb.String(), Code: -1}, errors.New("git took too long")
	}
	r := GitResult{Out: out.String(), Err: errb.String()}
	var ee *ssh.ExitError
	switch {
	case err == nil:
	case errors.As(err, &ee):
		r.Code = ee.ExitStatus()
		if r.Code == 127 || (windows && r.Code == 9009) {
			return r, errors.New("git isn't installed on " + host)
		}
	default:
		return r, err
	}
	return r, nil
}
