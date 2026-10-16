package host

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

const aptList = "/etc/apt/sources.list.d/phosphorus.list"

// upgrade the Linux update agent, phosphorus-update.service on
// state/update-request.json: apt to the feed's newest, else this release re-applied
func upgrade() error {
	req := at("state", "update-request.json")
	var r struct{ ID string }
	b, _ := os.ReadFile(req)
	json.Unmarshal(b, &r)
	// consumed first, or the path unit fires again
	os.Remove(req)
	report := func(state string, current bool, version, why string) {
		why = strings.Map(func(c rune) rune {
			if c == '\n' {
				return ' '
			}
			return c
		}, why)
		if len(why) > 400 {
			why = why[:400]
		}
		b, _ := json.Marshal(map[string]any{"id": r.ID, "state": state, "current": current, "version": version, "error": why, "at": time.Now().UnixMilli()})
		out := at("state", "update-agent.json")
		if os.WriteFile(out+".tmp", b, 0o644) == nil {
			os.Rename(out+".tmp", out)
		}
	}
	report("running", false, "", "")
	if !fileExists(aptList) {
		report("failed", false, "", "no update feed ("+aptList+" missing), reinstall from the latest release")
		return fail("no update feed")
	}
	// the feed's Origin and Label free to change
	apt := func(tee bool, args ...string) (string, error) {
		a := append([]string{"-q", "-o", "Dir::Etc::sourcelist=sources.list.d/phosphorus.list", "-o", "Dir::Etc::sourceparts=-",
			"-o", "Acquire::AllowReleaseInfoChange::Origin=true", "-o", "Acquire::AllowReleaseInfoChange::Label=true"}, args...)
		c := exec.Command("apt-get", a...)
		c.Env = append(os.Environ(), "DEBIAN_FRONTEND=noninteractive")
		var buf bytes.Buffer
		var w io.Writer = &buf
		if tee {
			w = io.MultiWriter(&buf, os.Stdout)
		}
		c.Stdout, c.Stderr = w, w
		err := c.Run()
		return buf.String(), err
	}
	if out, err := apt(false, "update", "-o", "APT::Get::List-Cleanup=0"); err != nil {
		report("failed", false, "", "apt-get update failed: "+lastLine(out, nil))
		return fail("apt-get update failed")
	}
	policy := output("apt-cache", "policy", "phosphorus")
	have, cand := field(policy, "Installed:"), field(policy, "Candidate:")
	if cand != "" && cand != "(none)" && cand != have {
		say("%s -> %s", have, cand)
		// postinst installs the release and rebuilds
		out, err := apt(true, "install", "-y", "-o", "Dpkg::Options::=--force-confold", "--only-upgrade", "phosphorus")
		if err != nil {
			report("failed", false, "", lastLine(out, regexp.MustCompile(`ERROR|E:`)))
			return fail("apt-get install failed")
		}
		report("ok", false, cand, "")
		return nil
	}
	// newest already: this release's images and config re-applied
	say("%s is the newest", have)
	c := exec.Command(exe(), "install", "--update", "--home", home)
	var buf bytes.Buffer
	c.Stdout, c.Stderr = io.MultiWriter(&buf, os.Stdout), io.MultiWriter(&buf, os.Stderr)
	if err := c.Run(); err != nil {
		report("failed", false, "", lastLine(buf.String(), regexp.MustCompile(`ERROR`)))
		return fail("install failed")
	}
	report("ok", strings.Contains(buf.String(), "already up to date"), have, "")
	return nil
}

func field(text, key string) string {
	for _, l := range strings.Split(text, "\n") {
		if f := strings.Fields(l); len(f) >= 2 && f[0] == key {
			return f[1]
		}
	}
	return ""
}

// lastLine the last line matching re, any line when nil
func lastLine(text string, re *regexp.Regexp) string {
	ls := strings.Split(strings.TrimSpace(text), "\n")
	for i := len(ls) - 1; i >= 0; i-- {
		if re == nil || re.MatchString(ls[i]) {
			return ls[i]
		}
	}
	return ""
}
