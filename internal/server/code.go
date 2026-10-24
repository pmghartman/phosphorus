package server

// the code service's calls: harness sessions on a mesh host, run from here

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/pmghartman/phosphorus/internal/code"
	"github.com/pmghartman/phosphorus/internal/mcp"
	"github.com/pmghartman/phosphorus/internal/model"
	"github.com/pmghartman/phosphorus/internal/users"
	"github.com/pmghartman/phosphorus/internal/util"
)

var (
	codeSessRe = regexp.MustCompile(`^/api/code/sessions/([a-z0-9]{12})(?:/(send|stop|model|perm|permission|rename))?$`)
	codeWSRe   = regexp.MustCompile(`^/api/code/ws/([a-z0-9]{12})$`)
)

// meshBase this frontend as another host reaches it over the tailnet
func meshBase() (string, error) {
	ip := util.TailnetIP(selfHost)
	if ip == "" {
		return "", errors.New("can't find " + selfHost + "'s own tailnet address")
	}
	return fmt.Sprintf("http://%s:%d", ip, util.FrontendPort), nil
}

// codeBlockedMsg a user with no host login of their own: Code has nowhere to run
const codeBlockedMsg = "no saved login on any computer"

// codeBlocked why the user can't start anything, "" when they can: every
// start runs as a login from their own vault, opened by their session
func codeBlocked(s *users.Session) string {
	if !users.VaultOK(s) {
		return "this host hasn't your saved logins yet, try again shortly"
	}
	if len(users.HostLogins(s)) == 0 {
		return codeBlockedMsg
	}
	return ""
}

// codeLogin the session's vault login for host, as creds
func codeLogin(s *users.Session, host string) (code.Creds, error) {
	user, pass, ok := users.HostLogin(s, host)
	if !ok {
		return code.Creds{}, fmt.Errorf("no saved login for %s: open a terminal on it and save the login", host)
	}
	return code.Creds{User: user, Pass: pass}, nil
}

// codeCreds what a start needs of the logged in user, read from their vault
// at each call and handed to that start only
func codeCreds(s *users.Session, r *http.Request) code.CredsFn {
	return func(host, _ string) (code.Creds, error) {
		c, err := codeLogin(s, host)
		if err != nil {
			return c, err
		}
		key, ok := users.KeyOf(s, r)
		if !ok {
			return code.Creds{}, errors.New("this host hasn't your mcp key yet, try again shortly")
		}
		base, err := meshBase()
		if err != nil {
			return code.Creds{}, err
		}
		// the skill names the address the user knows, the base domain's when there is one
		sb := base
		if os.Getenv("BASE_DOMAIN") != "" {
			sb = users.MCPBase(r)
		}
		skill, err := mcp.Skill(s.User, s.Admin, sb)
		if err != nil {
			return code.Creds{}, err
		}
		c.Key, c.Token, c.Base, c.Skill = key, users.AnthropicToken(s), base, skill
		return c, nil
	}
}

// codeOptions the new session form's choices
func codeOptions(s *users.Session) map[string]any {
	ro := map[string]any{}
	for _, a := range model.Summary()["agents"].([]any) {
		if util.Obj(a)["id"] == "code" {
			ro = util.Obj(util.Obj(util.Obj(a)["slots"])["model"])
		}
	}
	models := []any{}
	for _, m := range code.Mesh {
		models = append(models, map[string]any{"id": m, "label": "Mesh model", "provider": "mesh", "ready": ro["ready"] == true, "why": util.Str(ro["why"])})
	}
	has := users.AnthropicToken(s) != ""
	if has {
		for _, m := range code.Anthropic {
			models = append(models, map[string]any{"id": m, "label": strings.ToUpper(m[:1]) + m[1:], "provider": "anthropic", "ready": true, "why": ""})
		}
	}
	out := map[string]any{"hosts": users.HostLogins(s), "models": models, "anthropic": has, "harnesses": code.Harnesses}
	if why := codeBlocked(s); why != "" {
		out["hosts"], out["blocked"] = []string{}, why
	}
	return out
}

// codeRoute the app's REST, false for a path that isn't one
func codeRoute(w http.ResponseWriter, r *http.Request, pathname string, q url.Values) bool {
	m := codeSessRe.FindStringSubmatch(pathname)
	known := m != nil || pathname == "/api/code/options" || pathname == "/api/code/sessions" || pathname == "/api/code/install" ||
		pathname == "/api/code/harnesses" || pathname == "/api/code/ls" || pathname == "/api/code/upload"
	if !known {
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
	body := func() map[string]any {
		b, err := readRaw(r, 512*1024)
		p := util.Obj(util.Decode(b))
		if err != nil || p == nil {
			return map[string]any{}
		}
		return p
	}
	reply := func(st int, b any) { sendJSON(w, st, b) }
	meth := r.Method
	// whatever runs on a host needs a login of the user's own there
	starts := (pathname == "/api/code/sessions" && meth == "POST") || pathname == "/api/code/install" ||
		pathname == "/api/code/harnesses" || pathname == "/api/code/ls" || pathname == "/api/code/upload" || (m != nil && m[2] == "send" && meth == "POST")
	if starts {
		if why := codeBlocked(s); why != "" {
			reply(403, map[string]any{"error": why})
			return true
		}
	}
	switch {
	case pathname == "/api/code/options" && meth == "GET":
		reply(200, codeOptions(s))
	case pathname == "/api/code/sessions" && meth == "GET":
		reply(code.List(s.User))
	case pathname == "/api/code/sessions" && meth == "POST":
		p := body()
		if anthropicOff(s, util.Str(p["model"])) {
			reply(400, map[string]any{"error": "save your Anthropic token in settings first"})
			return true
		}
		reply(code.Create(s.User, p, codeCreds(s, r)))
	case pathname == "/api/code/harnesses" && meth == "GET":
		c, err := codeLogin(s, q.Get("host"))
		if err != nil {
			reply(400, map[string]any{"error": err.Error()})
			return true
		}
		reply(code.HarnessesOn(q.Get("host"), c, q.Get("fresh") != ""))
	case pathname == "/api/code/install" && meth == "POST":
		p := body()
		host := util.Str(p["host"])
		c, err := codeLogin(s, host)
		if err != nil {
			reply(400, map[string]any{"error": err.Error()})
			return true
		}
		reply(code.InstallOf(host, c, util.Str(p["harness"])))
	case pathname == "/api/code/ls" && meth == "GET":
		c, err := codeLogin(s, q.Get("host"))
		if err != nil {
			reply(400, map[string]any{"error": err.Error()})
			return true
		}
		reply(code.Ls(q.Get("host"), q.Get("dir"), c))
	case pathname == "/api/code/upload" && meth == "POST":
		c, err := codeLogin(s, q.Get("host"))
		if err != nil {
			reply(400, map[string]any{"error": err.Error()})
			return true
		}
		reply(code.Upload(q.Get("host"), q.Get("dir"), q.Get("name"), r.ContentLength, http.MaxBytesReader(w, r.Body, code.UploadMax), c))
	case m != nil && m[2] == "" && meth == "GET":
		reply(code.Get(s.User, m[1]))
	case m != nil && m[2] == "" && meth == "DELETE":
		reply(code.Delete(s.User, m[1]))
	case m != nil && m[2] != "" && meth == "POST":
		id, p := m[1], body()
		switch m[2] {
		case "send":
			reply(code.Send(s.User, id, p, codeCreds(s, r)))
		case "stop":
			reply(code.Stop(s.User, id))
		case "model":
			if anthropicOff(s, util.Str(p["model"])) {
				reply(400, map[string]any{"error": "save your Anthropic token in settings first"})
				return true
			}
			reply(code.SetModel(s.User, id, p))
		case "perm":
			reply(code.SetPerm(s.User, id, p))
		case "permission":
			reply(code.Answer(s.User, id, p))
		case "rename":
			reply(code.Rename(s.User, id, p))
		}
	default:
		reply(405, map[string]any{"error": "method not allowed"})
	}
	return true
}

// anthropicOff an Anthropic model asked for with no token saved
func anthropicOff(s *users.Session, m string) bool {
	for _, a := range code.Anthropic {
		if a == m {
			return users.AnthropicToken(s) == ""
		}
	}
	return false
}

// codeSocket a page's socket on a session, false for a path that isn't one
func codeSocket(w http.ResponseWriter, r *http.Request, pathname string, q url.Values) bool {
	m := codeWSRe.FindStringSubmatch(pathname)
	if m == nil {
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
	if !code.Owns(s.User, m[1]) {
		refuse(w, 404)
		return true
	}
	since, _ := strconv.ParseInt(q.Get("since"), 10, 64)
	ws := accept(w, r)
	if ws == nil {
		return true
	}
	go drainWS(ws)
	if !code.Attach(ws, ws.Done(), s.User, m[1], max(since, 0)) {
		ws.Close(4000)
	}
	return true
}
