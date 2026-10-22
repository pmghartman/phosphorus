package server

// the Code app's calls: claude sessions on a mesh host, run from here

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/pmghartman/phosphorus/internal/claude"
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

// codeCreds what a start needs of the logged in user
func codeCreds(s *users.Session, r *http.Request) claude.CredsFn {
	return func(host, _ string) (claude.Creds, error) {
		user, pass, ok := users.HostLogin(s, host)
		if !ok {
			return claude.Creds{}, fmt.Errorf("no saved login for %s: save one in your profile", host)
		}
		key, ok := users.KeyOf(s, r)
		if !ok {
			return claude.Creds{}, errors.New("this host hasn't your mcp key yet, try again shortly")
		}
		base, err := meshBase()
		if err != nil {
			return claude.Creds{}, err
		}
		// the skill names the address the user knows, the base domain's when there is one
		sb := base
		if os.Getenv("BASE_DOMAIN") != "" {
			sb = users.MCPBase(r)
		}
		skill, err := mcp.Skill(s.User, s.Admin, sb)
		if err != nil {
			return claude.Creds{}, err
		}
		return claude.Creds{User: user, Pass: pass, Key: key, Token: users.AnthropicToken(s.User), Base: base, Skill: skill}, nil
	}
}

// codeOptions the new session form's choices
func codeOptions(s *users.Session) map[string]any {
	roles := util.Obj(model.Summary()["roles"])
	models := []any{}
	for _, m := range claude.Mesh {
		ro := util.Obj(roles[m])
		models = append(models, map[string]any{"id": m, "label": m, "provider": "mesh", "ready": ro["ready"] == true, "why": util.Str(ro["why"])})
	}
	has := users.HasAnthropic(s.User)
	if has {
		for _, m := range claude.Anthropic {
			models = append(models, map[string]any{"id": m, "label": strings.ToUpper(m[:1]) + m[1:], "provider": "anthropic", "ready": true, "why": ""})
		}
	}
	return map[string]any{"hosts": users.HostLogins(s), "models": models, "anthropic": has}
}

// codeRoute the app's REST, false for a path that isn't one
func codeRoute(w http.ResponseWriter, r *http.Request, pathname string, q url.Values) bool {
	m := codeSessRe.FindStringSubmatch(pathname)
	known := m != nil || pathname == "/api/code/options" || pathname == "/api/code/sessions" || pathname == "/api/code/install"
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
	switch {
	case pathname == "/api/code/options" && meth == "GET":
		reply(200, codeOptions(s))
	case pathname == "/api/code/sessions" && meth == "GET":
		reply(claude.List(s.User))
	case pathname == "/api/code/sessions" && meth == "POST":
		p := body()
		if anthropicOff(s, util.Str(p["model"])) {
			reply(400, map[string]any{"error": "save your Anthropic token in settings first"})
			return true
		}
		reply(claude.Create(s.User, p, codeCreds(s, r)))
	case pathname == "/api/code/install":
		host := q.Get("host")
		var p map[string]any
		if meth == "POST" {
			p = body()
			host = util.Str(p["host"])
		} else if meth != "GET" {
			reply(405, map[string]any{"error": "method not allowed"})
			return true
		}
		user, pass, ok := users.HostLogin(s, host)
		if !ok {
			reply(400, map[string]any{"error": "no saved login for " + host})
			return true
		}
		c := claude.Creds{User: user, Pass: pass}
		if meth == "GET" {
			reply(claude.Installed(host, c))
		} else {
			reply(claude.Install(host, c))
		}
	case m != nil && m[2] == "" && meth == "GET":
		reply(claude.Get(s.User, m[1]))
	case m != nil && m[2] == "" && meth == "DELETE":
		reply(claude.Delete(s.User, m[1]))
	case m != nil && m[2] != "" && meth == "POST":
		id, p := m[1], body()
		switch m[2] {
		case "send":
			reply(claude.Send(s.User, id, p, codeCreds(s, r)))
		case "stop":
			reply(claude.Stop(s.User, id))
		case "model":
			if anthropicOff(s, util.Str(p["model"])) {
				reply(400, map[string]any{"error": "save your Anthropic token in settings first"})
				return true
			}
			reply(claude.SetModel(s.User, id, p))
		case "perm":
			reply(claude.SetPerm(s.User, id, p))
		case "permission":
			reply(claude.Answer(s.User, id, p))
		case "rename":
			reply(claude.Rename(s.User, id, p))
		}
	default:
		reply(405, map[string]any{"error": "method not allowed"})
	}
	return true
}

// anthropicOff an Anthropic model asked for with no token saved
func anthropicOff(s *users.Session, m string) bool {
	for _, a := range claude.Anthropic {
		if a == m {
			return !users.HasAnthropic(s.User)
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
	if !claude.Owns(s.User, m[1]) {
		refuse(w, 404)
		return true
	}
	since, _ := strconv.ParseInt(q.Get("since"), 10, 64)
	ws := accept(w, r)
	if ws == nil {
		return true
	}
	go drainWS(ws)
	if !claude.Attach(ws, ws.Done(), s.User, m[1], max(since, 0)) {
		ws.Close(4000)
	}
	return true
}
