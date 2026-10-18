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
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/cli"
	"github.com/pmghartman/phosphorus/internal/mesh"
	"github.com/pmghartman/phosphorus/internal/users"
	"github.com/pmghartman/phosphorus/internal/util"
)

const (
	logLinesMax = 2000
	logOutMax   = 256 << 10
)

// hostLogs this host's own log, its last lines, those holding match when given:
// systemd's journal on Linux, state/phosphorus.log elsewhere
func hostLogs(lines int, match string) (int, any) {
	if lines < 1 {
		lines = 200
	}
	if lines > logLinesMax {
		lines = logLinesMax
	}
	var all []string
	if runtime.GOOS == "linux" {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		n := lines
		// a filter reads further back for its lines
		if match != "" {
			n = logLinesMax * 10
		}
		out, err := exec.CommandContext(ctx, "journalctl", "-u", "phosphorus", "-n", fmt.Sprint(n), "--no-pager", "-o", "short-iso").Output()
		if err != nil && len(out) == 0 {
			return 500, map[string]any{"error": "journalctl: " + err.Error()}
		}
		all = strings.Split(strings.TrimRight(string(out), "\n"), "\n")
	} else {
		f, err := os.Open(filepath.Join(util.RepoDir, "state", "phosphorus.log"))
		if err != nil {
			return 404, map[string]any{"error": "no log yet"}
		}
		defer f.Close()
		st, _ := f.Stat()
		// the tail alone, a long log never read whole
		if size := st.Size(); size > 8<<20 {
			f.Seek(size-(8<<20), 0)
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		for sc.Scan() {
			all = append(all, sc.Text())
		}
	}
	if match != "" {
		m := strings.ToLower(match)
		kept := []string{}
		for _, l := range all {
			if strings.Contains(strings.ToLower(l), m) {
				kept = append(kept, l)
			}
		}
		all = kept
	}
	if len(all) > lines {
		all = all[len(all)-lines:]
	}
	text := strings.Join(all, "\n")
	if len(text) > logOutMax {
		text = text[len(text)-logOutMax:]
	}
	return 200, map[string]any{"host": selfHost, "lines": len(all), "text": text}
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

// configOp this host's config: get both files, or set one service or ini key
func configOp(p map[string]any) (int, any) {
	why := ""
	switch str(p["op"]) {
	case "get":
		ini, svc := cli.ConfigText()
		return 200, map[string]any{"host": selfHost, "phosphorus.ini": ini, "services.export": svc}
	case "service":
		fields := map[string]string{}
		for k, v := range util.Obj(p["fields"]) {
			fields[k] = util.JSString(v)
		}
		why = cli.SetService(str(p["name"]), fields, util.Truthy(p["remove"]))
	case "ini":
		why = cli.SetIni(str(p["section"]), str(p["key"]), str(p["value"]))
	default:
		return 400, map[string]any{"error": "op is get, service or ini"}
	}
	if why != "" {
		return 400, map[string]any{"error": why}
	}
	return 200, map[string]any{"ok": true, "host": selfHost, "note": "saved, applied within seconds"}
}

// hostConfig configOp here or on host
func hostConfig(host string, p map[string]any) (int, any) {
	if st, b := onHost(host, "/internal/config", p, 15*time.Second); st != 0 {
		return st, b
	}
	return configOp(p)
}

// hostLogsOn hostLogs here or on host
func hostLogsOn(host string, lines int, match string) (int, any) {
	if st, b := onHost(host, "/internal/logs", map[string]any{"lines": lines, "match": match}, 30*time.Second); st != 0 {
		return st, b
	}
	return hostLogs(lines, match)
}

// the page actions a key may send: nothing that asks the person for anything
var keyUI = map[string]bool{"notify": true, "code": true, "view": true, "terminal": true, "host": true}

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
