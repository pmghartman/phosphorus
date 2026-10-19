package server

import (
	"io"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

// driveShell driven against a local /bin/sh, the same io a persistent ssh
// shell gives: state kept across commands, exit codes read, stdin fed
func TestDriveShell(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix shell")
	}
	c := exec.Command("/bin/sh")
	stdin, err := c.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	pr, pw := io.Pipe()
	c.Stdout, c.Stderr = pw, pw
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	go func() { c.Wait(); pw.Close() }()
	defer stdin.Close()
	lines := readLines(pr)
	n := 0
	run := func(cmd, feed string) (string, int) {
		n++
		tag := "__t 0 "
		if n > 1 {
			tag = "__t" + strings.Repeat("x", n) + " 0 "
		}
		o, code, err := driveShell(stdin, lines, cmd, feed, tag, 5*time.Second)
		if err != nil {
			t.Fatalf("%q: %v", cmd, err)
		}
		return o, code
	}

	if o, code := run("echo hello", ""); o != "hello" || code != 0 {
		t.Fatalf("echo: %q %d", o, code)
	}
	// stderr folded in
	if o, _ := run("echo oops 1>&2", ""); o != "oops" {
		t.Fatalf("stderr: %q", o)
	}
	// exit code carried
	if o, code := run("false", ""); code != 1 || o != "" {
		t.Fatalf("false: %q %d", o, code)
	}
	// state kept: cd then pwd, env set then read
	run("cd /tmp && A=42", "")
	if o, _ := run("pwd; echo $A", ""); o != "/tmp\n42" {
		t.Fatalf("state: %q", o)
	}
	// stdin fed to a reader
	if o, _ := run("cat", "fed line"); o != "fed line" {
		t.Fatalf("stdin: %q", o)
	}
	// output with no trailing newline
	if o, _ := run("printf nonl", ""); o != "nonl" {
		t.Fatalf("nonl: %q", o)
	}
}

func TestDriveShellTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix shell")
	}
	c := exec.Command("/bin/sh")
	stdin, _ := c.StdinPipe()
	pr, pw := io.Pipe()
	c.Stdout, c.Stderr = pw, pw
	c.Start()
	go func() { c.Wait(); pw.Close() }()
	defer stdin.Close()
	_, _, err := driveShell(stdin, readLines(pr), "sleep 5", "", "__to 0 ", 300*time.Millisecond)
	if err != errShellTimeout {
		t.Fatalf("want timeout, got %v", err)
	}
}
