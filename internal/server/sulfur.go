package server

// Sulfur's calls: a host's toolchains, a folder of a host published as a
// share for projects, a build streamed from a host as its own terminal, git in
// a host's folder for Source Control, and the mesh's Forgejo as the user

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"

	"github.com/pmghartman/phosphorus/internal/sulfur"
	"github.com/pmghartman/phosphorus/internal/users"
	"github.com/pmghartman/phosphorus/internal/util"
	"github.com/pmghartman/phosphorus/internal/wsock"
)

var absDirRe = regexp.MustCompile(`^(/|[A-Za-z]:\\)`)

// sulfurRoute Sulfur's REST, false for a path that isn't one
func sulfurRoute(w http.ResponseWriter, r *http.Request, pathname string, q url.Values) bool {
	if pathname != "/api/sulfur/toolchains" && pathname != "/api/sulfur/share" && pathname != "/api/sulfur/git" && pathname != "/api/sulfur/forgejo" && pathname != "/api/sulfur/vsx/search" && pathname != "/api/sulfur/vsx/convert" {
		return false
	}
	if !isLocalOrPeer(r) || (r.Method != "GET" && !sameOrigin(r)) {
		forbidden(w)
		return true
	}
	w.Header().Set("Cache-Control", "no-store")
	s := users.Soon(r)
	if s == nil || s.Boot {
		sendJSON(w, 401, map[string]any{"error": "log in as a user"})
		return true
	}
	switch {
	// Open VSX's library and Convert & Install (internal/sulfur/vsx.go): the user's to browse
	case pathname == "/api/sulfur/vsx/search" || pathname == "/api/sulfur/vsx/convert":
		sulfur.VSXServe(w, r)
	case pathname == "/api/sulfur/toolchains" && r.Method == "GET":
		host := q.Get("host")
		c, err := codeLogin(s, host)
		if err != nil {
			sendJSON(w, 400, map[string]any{"error": err.Error()})
			return true
		}
		t, err := sulfur.Probe(host, c, q.Get("fresh") != "")
		if err != nil {
			sendJSON(w, 502, map[string]any{"error": err.Error()})
			return true
		}
		sendJSON(w, 200, t)
	case pathname == "/api/sulfur/git" && r.Method == "POST":
		onJSON(w, r, maxJSONBody, true, func(p map[string]any) (int, any) { return sulfurGit(s, p) })
	case pathname == "/api/sulfur/forgejo" && r.Method == "POST":
		onJSON(w, r, maxJSONBody, true, func(p map[string]any) (int, any) { return sulfurForgejo(s, p) })
	case pathname == "/api/sulfur/share" && r.Method == "POST":
		if !s.Admin {
			sendJSON(w, 403, map[string]any{"error": "only an admin publishes a folder"})
			return true
		}
		onJSON(w, r, maxJSONBody, true, func(p map[string]any) (int, any) {
			return publishShare(str(p["host"]), str(p["dir"]))
		})
	default:
		sendJSON(w, 405, map[string]any{"error": "method not allowed"})
	}
	return true
}

// publishShare dir added to host's shares, every share it has now kept with
// its perms: the home lives apart, in [home], so it never moves
func publishShare(host, dir string) (int, any) {
	dir = strings.TrimSpace(dir)
	if len(dir) > 3 {
		dir = strings.TrimRight(dir, `/\`)
	}
	if !absDirRe.MatchString(dir) || strings.ContainsAny(dir, ",\r\n\x00") {
		return 400, map[string]any{"error": "a full path to a folder, no commas in it"}
	}
	if dir == "/" || (len(dir) <= 3 && strings.HasSuffix(dir, `:\`)) {
		return 400, map[string]any{"error": "a folder, not a whole drive"}
	}
	st, b := hostConfig(host, map[string]any{"op": "get"})
	if st != 200 {
		return st, b
	}
	dirs, perms := []string{}, []string{}
	for _, x := range anySlice(util.Obj(b)["shares"]) {
		sh := util.Obj(x)
		if sh["home"] == true {
			continue
		}
		label := str(sh["label"])
		if strings.EqualFold(label, dir) {
			return 200, map[string]any{"ok": true, "note": "already a share", "dir": dir}
		}
		p := str(sh["perms"])
		if p == "" {
			p = "rwd"
		}
		dirs, perms = append(dirs, label), append(perms, p)
	}
	dirs, perms = append(dirs, dir), append(perms, "rwd")
	if st, out := hostConfig(host, map[string]any{"op": "ini", "section": "files", "key": "dir", "value": strings.Join(dirs, ", ")}); st != 200 {
		return st, out
	}
	if st, out := hostConfig(host, map[string]any{"op": "ini", "section": "files", "key": "priv", "value": strings.Join(perms, ", ")}); st != 200 {
		return st, out
	}
	return 200, map[string]any{"ok": true, "dir": dir, "note": "published, up within seconds"}
}

func anySlice(v any) []any {
	if s, ok := v.([]any); ok {
		return s
	}
	return nil
}

// sulfurSocket a build's socket, false for a path that isn't one: its first
// message the task, then keys and sizes in, the host's output out as it
// comes, its exit last
func sulfurSocket(w http.ResponseWriter, r *http.Request, pathname string, _ url.Values) bool {
	if pathname != "/api/sulfur/run" && pathname != "/api/sulfur/languages" {
		return false
	}
	if !sameOrigin(r) {
		refuse(w, 403)
		return true
	}
	s := users.Of(r)
	if s == nil || s.Boot {
		refuse(w, 401)
		return true
	}
	ws := accept(w, r)
	if ws == nil {
		return true
	}
	if pathname == "/api/sulfur/languages" {
		creds, err := codeLogin(s, r.URL.Query().Get("host"))
		if err != nil {
			ws.JSON(map[string]any{"_sulfur": "error", "error": err.Error()})
			ws.Close(4000)
			return true
		}
		sulfur.LanguageSocket(ws, r.URL.Query().Get("host"), creds)
	} else {
		runTask(ws, s)
	}
	return true
}

// streamOut a task's output as binary frames to its socket
type streamOut struct {
	mu sync.Mutex
	ws *wsock.Conn
}

func (o *streamOut) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ws.Binary(append([]byte(nil), p...))
	return len(p), nil
}

func runTask(ws *wsock.Conn, s *users.Session) {
	data, _, err := ws.Read()
	if err != nil {
		return
	}
	p := util.Obj(util.Decode(data))
	host := str(p["host"])
	var t sulfur.Task
	if err := json.Unmarshal(util.Marshal(p["task"]), &t); err != nil {
		ws.JSON(map[string]any{"type": "exit", "code": -1, "error": "bad task"})
		ws.Close(4000)
		return
	}
	c, err := codeLogin(s, host)
	if err != nil {
		ws.JSON(map[string]any{"type": "exit", "code": -1, "error": err.Error()})
		ws.Close(4000)
		return
	}
	run, wait, err := sulfur.Start(host, c, t, &streamOut{ws: ws})
	if err != nil {
		ws.JSON(map[string]any{"type": "exit", "code": -1, "error": err.Error()})
		ws.Close(4000)
		return
	}
	go func() {
		for {
			b, binary, err := ws.Read()
			if err != nil {
				run.Stop()
				return
			}
			if binary {
				run.Input(b)
				continue
			}
			m := util.Obj(util.Decode(b))
			switch str(m["type"]) {
			case "resize":
				run.Resize(int(num(m["cols"])), int(num(m["rows"])))
			case "kill":
				run.Stop()
			}
		}
	}()
	code := wait()
	ws.JSON(map[string]any{"type": "exit", "code": code})
	ws.Close(4000)
}

// gitLogin the user's Forgejo login, for git's https to the mesh's own Forgejo alone
func gitLogin(s *users.Session) *sulfur.GitCreds {
	if baseDomain == "" {
		return nil
	}
	host := "git." + baseDomain
	user, pass, ok := users.PageLogin(s, "git", "//"+host)
	if !ok {
		return nil
	}
	return &sulfur.GitCreds{Host: host, User: user, Pass: pass}
}

// sulfurGit {host, dir, args}: git in dir on host, as the user's saved login
// there, their Forgejo login handed to git for the mesh's Forgejo
func sulfurGit(s *users.Session, p map[string]any) (int, any) {
	host, dir := str(p["host"]), str(p["dir"])
	args := []string{}
	for _, a := range anyList(p["args"]) {
		args = append(args, str(a))
	}
	if !absDirRe.MatchString(dir) && !(len(args) > 0 && args[0] == "clone") {
		return 400, map[string]any{"error": "a full path to the folder"}
	}
	c, err := codeLogin(s, host)
	if err != nil {
		return 400, map[string]any{"error": err.Error()}
	}
	r, err := sulfur.GitRemote(host, c, dir, args, absDirRe.MatchString(dir) && !strings.HasPrefix(dir, "/"), gitLogin(s))
	if err != nil {
		return 502, map[string]any{"error": err.Error(), "out": r.Out, "err": r.Err}
	}
	return 200, r
}

// sulfurForgejo {method, path, body}: the mesh's Forgejo API as the user, with
// the Forgejo login saved in their vault; its domain and who it is said too
func sulfurForgejo(s *users.Session, p map[string]any) (int, any) {
	if baseDomain == "" {
		return 503, map[string]any{"error": "the mesh has no domain, so no Forgejo"}
	}
	creds := gitLogin(s)
	if creds == nil {
		return 403, map[string]any{"error": "save your Forgejo login as the page login git in your vault (the desktop's settings), and Sulfur uses it"}
	}
	path := "/" + strings.TrimPrefix(strings.TrimPrefix(str(p["path"]), "/"), "api/v1/")
	if strings.Contains(path, "..") {
		return 400, map[string]any{"error": "path holds .."}
	}
	method := strings.ToUpper(str(p["method"]))
	if method == "" {
		method = "GET"
	}
	if method != "GET" && method != "POST" && method != "PATCH" && method != "PUT" && method != "DELETE" {
		return 400, map[string]any{"error": "a method Forgejo takes"}
	}
	body := ""
	switch b := p["body"].(type) {
	case nil:
	case string:
		body = b
	default:
		body = string(util.Marshal(b))
	}
	hs := map[string]string{"Accept": "application/json", "Content-Type": "application/json",
		"Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte(creds.User+":"+creds.Pass))}
	st, out := svcRequest("", "git", method, "/api/v1"+path, hs, body)
	o := util.Obj(out)
	if st != 200 {
		return st, o
	}
	reply := o["json"]
	if reply == nil {
		reply = o["text"]
	}
	return 200, map[string]any{"status": o["status"], "body": reply, "domain": baseDomain, "host": creds.Host, "user": creds.User}
}
