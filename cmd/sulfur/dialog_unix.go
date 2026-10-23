//go:build !windows

package main

import (
	"log"
	"os/exec"
	"runtime"
	"strings"
)

// pickPath the system's folder or file dialog through what the OS ships, the
// chosen absolute path; empty when cancelled or with no dialog to ask
func pickPath(p pick) string {
	var c *exec.Cmd
	if runtime.GOOS == "darwin" {
		ask := "choose file"
		if p.Directory {
			ask = "choose folder"
		}
		script := `POSIX path of (` + ask
		if p.Title != "" {
			script += ` with prompt ` + asString(p.Title)
		}
		if p.DefaultPath != "" {
			script += ` default location (POSIX file ` + asString(p.DefaultPath) + `)`
		}
		c = exec.Command("osascript", "-e", script+")")
	} else if z, err := exec.LookPath("zenity"); err == nil {
		args := []string{"--file-selection"}
		if p.Directory {
			args = append(args, "--directory")
		}
		if p.Title != "" {
			args = append(args, "--title="+p.Title)
		}
		if p.DefaultPath != "" {
			args = append(args, "--filename="+p.DefaultPath+"/")
		}
		c = exec.Command(z, args...)
	} else if k, err := exec.LookPath("kdialog"); err == nil {
		start := p.DefaultPath
		if start == "" {
			start = "."
		}
		verb := "--getopenfilename"
		if p.Directory {
			verb = "--getexistingdirectory"
		}
		c = exec.Command(k, verb, start)
	} else {
		return ""
	}
	out, err := c.Output()
	if err != nil {
		return ""
	}
	got := strings.TrimSpace(string(out))
	if len(got) > 1 {
		got = strings.TrimRight(got, "/")
	}
	return got
}

// asString an AppleScript string literal
func asString(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}

// showError what stopped the window, on the log: no dialog to ask with
func showError(msg string) { log.Print(msg) }
