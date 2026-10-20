package server

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/cli"
	"github.com/pmghartman/phosphorus/internal/files"
	"github.com/pmghartman/phosphorus/internal/mesh"
	"github.com/pmghartman/phosphorus/internal/services"
	"github.com/pmghartman/phosphorus/internal/users"
	"github.com/pmghartman/phosphorus/internal/util"
)

const (
	logLinesMax = 2000
	logOutMax   = 256 << 10
)

// logLevel the words a level's lines hold, worst first
var logLevel = map[string]*regexp.Regexp{
	"error": regexp.MustCompile(`(?i)\b(error|err|fail(ed|ure)?|fatal|panic|refused|denied)\b`),
	"warn":  regexp.MustCompile(`(?i)\b(error|err|fail(ed|ure)?|fatal|panic|refused|denied|warn(ing)?|retry(ing)?|timeout|timed out)\b`),
}

// logTime a since or until: RFC3339, a date, or an age like 30m, 2h, 1d
func logTime(v string) (time.Time, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return time.Time{}, nil
	}
	if n := len(v); n > 1 && strings.ContainsAny(v[n-1:], "smhd") {
		if x, err := strconv.Atoi(v[:n-1]); err == nil {
			unit := map[byte]time.Duration{'s': time.Second, 'm': time.Minute, 'h': time.Hour, 'd': 24 * time.Hour}[v[n-1]]
			return time.Now().Add(-time.Duration(x) * unit), nil
		}
	}
	for _, f := range []string{time.RFC3339, "2006-01-02 15:04:05", "2006-01-02T15:04", "2006-01-02"} {
		if t, err := time.ParseInLocation(f, v, time.Local); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("since/until: RFC3339, a date, or an age like 30m, 2h, 1d")
}

// lineTime a log line's own leading timestamp, journal's iso or Go's log
// a line's time at its start, or after a third party's [tag]
var lineTimeRe = regexp.MustCompile(`^(?:\[[^\]]*\] )?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^ ]*|\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2})`)

func lineTime(l string) (time.Time, bool) {
	sm := lineTimeRe.FindStringSubmatch(l)
	if sm == nil {
		return time.Time{}, false
	}
	m := sm[1]
	for _, f := range []string{"2006-01-02T15:04:05-0700", time.RFC3339, "2006/01/02 15:04:05"} {
		if t, err := time.ParseInLocation(f, m, time.Local); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// hostLogs this host's logs, their last lines filtered: source phosphorus (all
// of it), frontend, cloudflared, git, model or another role's tag, container:<name>
// for docker's, game:<name> for a game's start/stop output; match, level, since, until
func hostLogs(p map[string]any) (int, any) {
	lines := int(files.JSNumber(p["lines"]))
	if lines < 1 {
		lines = 200
	}
	if lines > logLinesMax {
		lines = logLinesMax
	}
	match, level, source := str(p["match"]), strings.ToLower(str(p["level"])), strings.ToLower(str(p["source"]))
	if source == "" {
		source = "phosphorus"
	}
	if level != "" && logLevel[level] == nil {
		return 400, map[string]any{"error": "level is error or warn"}
	}
	since, err := logTime(str(p["since"]))
	if err != nil {
		return 400, map[string]any{"error": err.Error()}
	}
	until, err := logTime(str(p["until"]))
	if err != nil {
		return 400, map[string]any{"error": err.Error()}
	}
	filtered := match != "" || level != "" || source != "phosphorus"
	n := lines
	if filtered {
		n = logLinesMax * 10
	}
	var all []string
	from := ""
	switch {
	case strings.HasPrefix(source, "container:"):
		name := strings.TrimPrefix(source, "container:")
		if !gameUserRe.MatchString(name) || strings.HasPrefix(name, "-") {
			return 400, map[string]any{"error": "bad container name"}
		}
		args := []string{"logs", "--tail", fmt.Sprint(n), "--timestamps"}
		if !since.IsZero() {
			args = append(args, "--since", since.Format(time.RFC3339))
		}
		if !until.IsZero() {
			args = append(args, "--until", until.Format(time.RFC3339))
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, "docker", append(args, name)...).CombinedOutput()
		if err != nil {
			return 404, map[string]any{"error": "docker logs " + name + ": " + strings.TrimSpace(string(out)+" "+err.Error())}
		}
		all, from = splitLines(string(out)), "docker"
	case strings.HasPrefix(source, "game:"):
		name := strings.TrimPrefix(source, "game:")
		if !gameUserRe.MatchString(name) || strings.Contains(name, "..") {
			return 400, map[string]any{"error": "bad game name"}
		}
		all, err = tailFile(filepath.Join(gameKeyDir, name+".log"))
		if err != nil {
			return 404, map[string]any{"error": "no output from " + name + " yet"}
		}
		from = "game"
	default:
		all, from = phosphorusLog(n, since, until)
		if source != "phosphorus" {
			tag := "[" + source
			if source == "git" {
				tag = "[git"
			}
			kept := []string{}
			for _, l := range all {
				if strings.Contains(l, tag) {
					kept = append(kept, l)
				}
			}
			all = kept
		}
	}
	m := strings.ToLower(match)
	kept := []string{}
	// an untimed line, a trace or a child's own print, as old as the last timed one;
	// none timed yet and a window asked, left out
	var at time.Time
	timed := false
	for _, l := range all {
		if t, ok := lineTime(l); ok {
			at, timed = t, true
		}
		if (!since.IsZero() || !until.IsZero()) && (!timed || !since.IsZero() && at.Before(since) || !until.IsZero() && at.After(until)) {
			continue
		}
		if m != "" && !strings.Contains(strings.ToLower(l), m) {
			continue
		}
		if level != "" && !logLevel[level].MatchString(l) {
			continue
		}
		kept = append(kept, l)
	}
	all = kept
	if len(all) > lines {
		all = all[len(all)-lines:]
	}
	text := strings.Join(all, "\n")
	if len(text) > logOutMax {
		text = text[len(text)-logOutMax:]
	}
	return 200, map[string]any{"host": selfHost, "source": source, "from": from, "lines": len(all), "text": text}
}

func splitLines(s string) []string {
	s = strings.TrimRight(s, "\n")
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

// phosphorusLog systemd's journal on Linux, state/phosphorus.log where it's
// empty or unreadable, and elsewhere
func phosphorusLog(n int, since, until time.Time) ([]string, string) {
	if runtime.GOOS == "linux" {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		args := []string{"-u", "phosphorus", "-n", fmt.Sprint(n), "--no-pager", "-o", "short-iso", "-q"}
		if !since.IsZero() {
			args = append(args, "--since", since.Format("2006-01-02 15:04:05"))
		}
		if !until.IsZero() {
			args = append(args, "--until", until.Format("2006-01-02 15:04:05"))
		}
		out, _ := exec.CommandContext(ctx, "journalctl", args...).Output()
		ls := []string{}
		for _, l := range splitLines(string(out)) {
			if !strings.HasPrefix(l, "-- ") {
				ls = append(ls, l)
			}
		}
		if len(ls) > 0 || since.IsZero() && until.IsZero() && !fileExists(filepath.Join(util.RepoDir, "state", "phosphorus.log")) {
			return ls, "journal"
		}
	}
	ls, _ := tailFile(filepath.Join(util.RepoDir, "state", "phosphorus.log"))
	return ls, "file"
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

// tailFile a log's last 8MB as lines
func tailFile(p string) ([]string, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, _ := f.Stat()
	// the tail alone, a long log never read whole
	if size := st.Size(); size > 8<<20 {
		f.Seek(size-(8<<20), 0)
	}
	var all []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		all = append(all, sc.Text())
	}
	return all, nil
}

// onHost a call run here when host is this one, else on the peer's /internal path
func onHost(host, path string, body map[string]any, wait time.Duration) (int, any) {
	if host == selfHost {
		return 0, nil
	}
	ip := util.TailnetIP(host)
	if ip == "" {
		return 502, map[string]any{"error": "can't find " + host + " on the tailnet"}
	}
	return util.PeerCall(host, util.Req{Host: ip, Method: "POST", Path: path, Body: body, Timeout: wait, ConnectTimeout: 5 * time.Second})
}

// configOp this host's config: get both files, or set one service or ini key,
// dry returning the diff alone; a service's outcome waited on once written
func configOp(p map[string]any) (int, any) {
	why, diff := "", ""
	dry := util.Truthy(p["dry_run"])
	switch str(p["op"]) {
	case "get":
		ini, svc := cli.ConfigText()
		return 200, map[string]any{"host": selfHost, "phosphorus.ini": ini, "services.export": svc, "shares": filesInfo()["shares"]}
	case "service":
		fields := map[string]string{}
		for k, v := range util.Obj(p["fields"]) {
			fields[k] = util.JSString(v)
		}
		why, diff = cli.EditService(str(p["name"]), fields, util.Truthy(p["remove"]), dry)
	case "ini":
		why, diff = cli.EditIni(str(p["section"]), str(p["key"]), str(p["value"]), dry)
	default:
		return 400, map[string]any{"error": "op is get, service or ini"}
	}
	if why != "" {
		return 400, map[string]any{"error": why}
	}
	out := map[string]any{"ok": true, "host": selfHost, "diff": diff}
	switch {
	case dry:
		out["dry_run"] = true
		out["note"] = "nothing written"
	case diff == "":
		out["note"] = "already so, nothing changed"
	case str(p["op"]) == "service" && !util.Truthy(p["remove"]):
		out["outcome"] = serviceOutcome(str(p["name"]))
	default:
		out["note"] = "saved, applied within seconds"
	}
	return 200, out
}

// serviceOutcome a just-written service waited on up to 12s: published, or why not
func serviceOutcome(name string) map[string]any {
	ip := util.TailnetIP(selfHost)
	if ip == "" {
		ip = "127.0.0.1"
	}
	var h map[string]any
	for end := time.Now().Add(12 * time.Second); ; time.Sleep(time.Second) {
		h = services.Health(name, ip)
		if h == nil || h["published"] == true || time.Now().After(end) {
			break
		}
	}
	if h == nil {
		return map[string]any{"published": false, "why": "not declared, services.export rejected it"}
	}
	if h["published"] == true {
		for _, r := range mesh.Routes() {
			if str(r["host"]) == selfHost && str(r["name"]) == name {
				h["route"] = r
			}
		}
	}
	return h
}

// hostConfig configOp here or on host
func hostConfig(host string, p map[string]any) (int, any) {
	if st, b := onHost(host, "/internal/config", p, 15*time.Second); st != 0 {
		return st, b
	}
	return configOp(p)
}

// hostLogsOn hostLogs here or on host
func hostLogsOn(host string, p map[string]any) (int, any) {
	if st, b := onHost(host, "/internal/logs", p, 30*time.Second); st != 0 {
		return st, b
	}
	return hostLogs(p)
}

// the page actions a key may send: nothing that asks the person for anything
var keyUI = map[string]bool{"agent": true, "notify": true, "code": true, "view": true, "terminal": true, "host": true}

// localUI an action to user's pages on this host, true when one took it
func localUI(user string, action map[string]any) bool {
	if user == "" || !keyUI[str(action["kind"])] {
		return false
	}
	cmu.Lock()
	cs := []*chatClient{}
	for c := range clients {
		if c.name == user {
			cs = append(cs, c)
		}
	}
	cmu.Unlock()
	ok := false
	for _, c := range cs {
		ok = uiFor(c, action) || ok
	}
	return ok
}

// userUI an action to user's pages on every host, sealed for each peer
func userUI(user string, action map[string]any) bool {
	if !keyUI[str(action["kind"])] {
		return false
	}
	ok := localUI(user, action)
	grant := users.SealGrant(map[string]any{"u": user, "a": action}, 30*1000)
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, ip := range mesh.PeerIPs() {
		wg.Add(1)
		go func(ip string) {
			defer wg.Done()
			res, err := util.RequestJSON(util.Req{Host: ip, Port: util.FrontendPort, Method: "POST", Path: "/internal/ui",
				Body: map[string]any{"grant": grant}, Timeout: 5 * time.Second})
			if err == nil && res.Status == 200 && util.Truthy(util.Obj(util.Decode(res.Body))["ok"]) {
				mu.Lock()
				ok = true
				mu.Unlock()
			}
		}(ip)
	}
	wg.Wait()
	return ok
}

// each peer's page actions in order, a slow or gone peer holding up only its own
var uiPeers = struct {
	sync.Mutex
	by map[string]chan string
}{by: map[string]chan string{}}

const uiPeerQueue = 256

// userUIAsync an action to user's pages here at once, to each peer's through its queue
func userUIAsync(user string, action map[string]any) {
	if !keyUI[str(action["kind"])] {
		return
	}
	localUI(user, action)
	grant := users.SealGrant(map[string]any{"u": user, "a": action}, 30*1000)
	for _, ip := range mesh.PeerIPs() {
		uiPeers.Lock()
		ch := uiPeers.by[ip]
		if ch == nil {
			ch = make(chan string, uiPeerQueue)
			uiPeers.by[ip] = ch
			go func(ip string) {
				for g := range ch {
					util.RequestJSON(util.Req{Host: ip, Port: util.FrontendPort, Method: "POST", Path: "/internal/ui",
						Body: map[string]any{"grant": g}, Timeout: 3 * time.Second})
				}
			}(ip)
		}
		uiPeers.Unlock()
		select {
		case ch <- grant:
		default:
		}
	}
}

const svcOutMax = 512 << 10

var svcClient = &http.Client{Timeout: 60 * time.Second, Transport: &http.Transport{Proxy: nil}}

// svcRequest one request to a published web service, straight to it, its body back as json or text
func svcRequest(host, name, method, path string, headers map[string]string, body string) (int, any) {
	var r map[string]any
	for _, x := range mesh.Routes() {
		if str(x["name"]) == name && x["type"] != "game" && (host == "" || str(x["host"]) == host) && (r == nil || x["master"] == true) {
			r = x
		}
	}
	if r == nil {
		return 404, map[string]any{"error": "no web service " + name + " on the mesh"}
	}
	ip := util.TailnetIP(str(r["host"]))
	if ip == "" {
		ip = str(r["host"])
	}
	scheme := str(r["scheme"])
	if scheme != "https" {
		scheme = "http"
	}
	base := ""
	if bp := strings.Trim(str(r["base_path"]), "/"); bp != "" {
		base = "/" + bp
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	if method == "" {
		method = "GET"
	}
	req, err := http.NewRequest(strings.ToUpper(method), fmt.Sprintf("%s://%s:%s%s%s", scheme, ip, util.JSString(r["port"]), base, path), strings.NewReader(body))
	if err != nil {
		return 400, map[string]any{"error": err.Error()}
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if body != "" && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := svcClient.Do(req)
	if err != nil {
		return 502, map[string]any{"error": err.Error()}
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, svcOutMax+1))
	out := map[string]any{"status": res.StatusCode, "host": r["host"], "contentType": res.Header.Get("Content-Type")}
	if len(b) > svcOutMax {
		b, out["truncated"] = b[:svcOutMax], true
	}
	if v := util.Decode(b); v != nil && strings.Contains(res.Header.Get("Content-Type"), "json") {
		out["json"] = v
	} else if !bytes.ContainsRune(b[:min(len(b), 8000)], 0) {
		out["text"] = util.UTF8(b)
	} else {
		out["bytes"] = len(b)
	}
	return 200, out
}
