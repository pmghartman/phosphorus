// Package services: this host's own services, services.export validated
// whole or not at all, health checked, live ones, games and git published
package services

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/clock"
	"github.com/pmghartman/phosphorus/internal/proxy"
	"github.com/pmghartman/phosphorus/internal/util"
)

// Row one published service, as JSON
type Row = map[string]any

var (
	servicesFile = util.Env("SERVICES_FILE", filepath.Join(util.RepoDir, "config", "services.export"))
	gitRoleFile  = filepath.Join(util.StateDir, "git-role")
	notes        = util.NewNotes("services")
	keys         = map[string]bool{"port": true, "scheme": true, "mode": true, "base_path": true, "extras": true, "type": true, "start": true, "stop": true}
	headRe       = regexp.MustCompile(`^\[\s*(.*?)\s*\]$`)
	commentRe    = regexp.MustCompile(`^[#;]`)
	digitsRe     = regexp.MustCompile(`^[0-9]+$`)
	quoteRe      = regexp.MustCompile(`^"|"$`)
)

const (
	probeTimeout  = time.Second
	gameConnectMS = 10000
)

var gameActionMS = map[string]int64{"start": 180000, "stop": 60000}

type section struct {
	name string
	f    map[string]string
}

// Parse every section as a declared row, or the first reason to reject
func Parse(text string) ([]Row, string) {
	sections := []*section{}
	var cur *section
	lines := strings.Split(text, "\n")
	for i, raw := range lines {
		line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		if line == "" || commentRe.MatchString(line) {
			continue
		}
		if m := headRe.FindStringSubmatch(line); m != nil {
			cur = &section{name: m[1], f: map[string]string{}}
			sections = append(sections, cur)
			continue
		}
		eq := strings.Index(line, "=")
		if eq < 0 {
			return nil, fmt.Sprintf("line %d is not key = value", i+1)
		}
		key := strings.TrimSpace(line[:eq])
		if cur == nil {
			return nil, fmt.Sprintf("line %d: %s outside any [section]", i+1, key)
		}
		if !keys[key] {
			return nil, fmt.Sprintf("[%s] has an unknown key, %s", cur.name, key)
		}
		cur.f[key] = quoteRe.ReplaceAllString(strings.TrimSpace(line[eq+1:]), "")
	}
	rows := []Row{}
	names := map[string]bool{}
	for _, s := range sections {
		if names[s.name] {
			return nil, fmt.Sprintf("[%s] is declared twice", s.name)
		}
		names[s.name] = true
		var port any = s.f["port"]
		if _, has := s.f["port"]; !has {
			port = nil
		}
		if digitsRe.MatchString(s.f["port"]) {
			n, _ := strconv.ParseFloat(s.f["port"], 64)
			port = n
		}
		var row Row
		if s.f["type"] == "game" {
			row = Row{"name": s.name, "port": port, "type": "game", "mode": "game", "controllable": s.f["start"] != "" && s.f["stop"] != ""}
		} else {
			ex := s.f["extras"]
			if ex == "" {
				ex = "{}"
			}
			var extras any
			if json.Unmarshal([]byte(ex), &extras) != nil {
				return nil, fmt.Sprintf("[%s] extras is not valid JSON", s.name)
			}
			eo, ok := extras.(map[string]any)
			if !ok {
				return nil, fmt.Sprintf("[%s] extras is not a JSON object", s.name)
			}
			for k := range eo {
				known := false
				for _, x := range proxy.ExtraKeys {
					known = known || x == k
				}
				if !known {
					return nil, fmt.Sprintf("[%s] extras has an unknown key, %s", s.name, k)
				}
			}
			row = Row{}
			for k, v := range eo {
				row[k] = v
			}
			row["name"] = s.name
			row["port"] = port
			row["scheme"] = or(s.f["scheme"], "http")
			row["mode"] = or(s.f["mode"], "path")
			row["base_path"] = s.f["base_path"]
			if s.f["type"] != "" {
				row["type"] = s.f["type"]
			}
		}
		if port == nil {
			delete(row, "port")
		}
		if why := proxy.RowError(row); why != "" {
			return nil, fmt.Sprintf("[%s] %s", s.name, why)
		}
		rows = append(rows, row)
	}
	return rows, ""
}

func or(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

var (
	mu       sync.Mutex
	text     *string
	declared = []Row{}
)

func readDeclared() {
	b, err := os.ReadFile(servicesFile)
	if err != nil {
		notes.Note("file", fmt.Sprintf("can't read %s; publishing nothing", servicesFile))
		text = nil
		declared = []Row{}
		return
	}
	notes.Clear("file")
	t := string(b)
	if text != nil && *text == t {
		return
	}
	text = &t
	rows, why := Parse(t)
	if why != "" {
		notes.Note("parse", fmt.Sprintf("%s rejected, still publishing the last good one: %s", servicesFile, why))
		return
	}
	notes.Note("parse", fmt.Sprintf("%s read: %d declared", servicesFile, len(rows)))
	declared = rows
	notes.Reset("svc:")
}

// --- health ----------------------------------------------------------------

type probeState struct {
	at   int64
	up   *bool
	busy bool
	seen bool
}

var probes = map[string]*probeState{}

func probe(key string, everyMS int64, check func() bool) *bool {
	p := probes[key]
	if p == nil {
		p = &probeState{}
		probes[key] = p
	}
	p.seen = true
	if !p.busy && util.Now()-p.at >= everyMS {
		p.busy = true
		p.at = util.Now()
		go func() {
			up := check()
			mu.Lock()
			if p.up == nil || *p.up != up {
				defer clock.MarkHot()
			}
			p.up = &up
			p.busy = false
			mu.Unlock()
		}()
	}
	return p.up
}

var probeClient = &http.Client{
	Timeout: probeTimeout,
	Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true,
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true}},
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func answers(scheme, host string, port int, base string) bool {
	res, err := probeClient.Get(fmt.Sprintf("%s://%s/%s", scheme, net.JoinHostPort(host, strconv.Itoa(port)), base))
	if err != nil {
		return false
	}
	res.Body.Close()
	return true
}

func connects(host string, port int) bool {
	c, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), probeTimeout)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

// --- game presses ----------------------------------------------------------

type press struct {
	action string
	until  int64
}

var pending = map[string]press{}

// SetPending starting/stopping until the port flips, "" clearing it
func SetPending(name, action string) {
	mu.Lock()
	if action != "" {
		pending[name] = press{action, util.Now() + gameActionMS[action]}
	} else {
		delete(pending, name)
	}
	mu.Unlock()
	clock.MarkHot()
}

func pendingFor(name string) string {
	p, ok := pending[name]
	if ok && p.until > util.Now() {
		return p.action
	}
	delete(pending, name)
	return ""
}

// --- rows ------------------------------------------------------------------

func copyRow(r Row) Row {
	out := Row{}
	for k, v := range r {
		out[k] = v
	}
	return out
}

func gameRow(r Row, ip string, ports map[int]bool) Row {
	port := int(r["port"].(float64))
	up := ports != nil && ports[port]
	if !up {
		p := probe(fmt.Sprintf("game:%s:%d", ip, port), gameConnectMS, func() bool { return connects(ip, port) })
		up = p != nil && *p
	}
	name := r["name"].(string)
	pr := pendingFor(name)
	status := "offline"
	switch {
	case up && pr == "stop":
		status = "stopping"
	case up:
		status = "online"
	case pr == "start":
		status = "starting"
	}
	notes.Note("svc:"+name, fmt.Sprintf("game %s on port %d is %s", name, port, status))
	out := copyRow(r)
	out["status"] = status
	return out
}

func webRow(r Row, ip string) Row {
	port := int(r["port"].(float64))
	scheme, _ := r["scheme"].(string)
	base, _ := r["base_path"].(string)
	up := probe(fmt.Sprintf("web:%s:%s:%d:%s", scheme, ip, port, base), int64(clock.IdleMS), func() bool { return answers(scheme, ip, port, base) })
	if up == nil {
		return nil
	}
	name := r["name"].(string)
	if *up {
		notes.Note("svc:"+name, fmt.Sprintf("%s is up on port %d, published", name, port))
		return r
	}
	notes.Note("svc:"+name, fmt.Sprintf("%s is not answering on port %d, not published", name, port))
	return nil
}

func gitRow(ip string) Row {
	g := util.ReadJSONMap(gitRoleFile)
	if g == nil || g["publish"] != true {
		notes.Clear("git")
		return nil
	}
	str := func(k, def string) string {
		if s, ok := g[k].(string); ok && s != "" {
			return s
		}
		if v, ok := g[k]; ok && util.Truthy(v) {
			return util.JSString(v)
		}
		return def
	}
	row := Row{"name": g["name"], "port": g["port"], "scheme": str("scheme", "http"), "mode": str("mode", "subdomain"),
		"base_path": str("base_path", ""), "master": g["master"] == true}
	if why := proxy.RowError(row); why != "" {
		notes.Note("git", "ignoring git-role: "+why)
		return nil
	}
	port := int(row["port"].(float64))
	scheme := row["scheme"].(string)
	base := row["base_path"].(string)
	up := probe(fmt.Sprintf("web:%s:%s:%d:%s", scheme, ip, port, base), int64(clock.IdleMS), func() bool { return answers(scheme, ip, port, base) })
	if up == nil {
		return nil
	}
	name := util.JSString(row["name"])
	if *up {
		notes.Note("git", fmt.Sprintf("%s is up on port %d, published (master=%v)", name, port, row["master"]))
		return row
	}
	notes.Note("git", fmt.Sprintf("git-role says publish, but %s is not answering on port %d, not published", name, port))
	return nil
}

var (
	own      = []Row{}
	lastScan int64
	ports    map[int]bool
)

// Refresh once per tick at ip, the tailnet address peers route to
func Refresh(ip string) []Row {
	mu.Lock()
	readDeclared()
	pressing := false
	for name := range pending {
		if pendingFor(name) != "" {
			pressing = true
		}
	}
	games := false
	for _, r := range declared {
		games = games || r["type"] == "game"
	}
	scan := games && (pressing || util.Now()-lastScan >= int64(clock.IdleMS))
	mu.Unlock()
	if pressing {
		clock.MarkHot()
	}
	if scan {
		lastScan = util.Now()
		p := listening(ip)
		mu.Lock()
		ports = p
		mu.Unlock()
	}
	mu.Lock()
	defer mu.Unlock()
	for _, p := range probes {
		p.seen = false
	}
	rows := []Row{}
	for _, r := range declared {
		var out Row
		if r["type"] == "game" {
			out = gameRow(r, ip, ports)
		} else {
			out = webRow(r, ip)
		}
		if out != nil {
			rows = append(rows, out)
		}
	}
	if g := gitRow(ip); g != nil {
		rows = append(rows, g)
	}
	for k, p := range probes {
		if !p.seen && !p.busy {
			delete(probes, k)
		}
	}
	own = rows
	return rows
}

// Own the last refresh's rows
func Own() []Row {
	mu.Lock()
	defer mu.Unlock()
	return own
}
