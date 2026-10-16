package server

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/pmghartman/phosphorus/internal/chatmedia"
	"github.com/pmghartman/phosphorus/internal/clock"
	"github.com/pmghartman/phosphorus/internal/collab"
	"github.com/pmghartman/phosphorus/internal/envfile"
	"github.com/pmghartman/phosphorus/internal/files"
	"github.com/pmghartman/phosphorus/internal/git"
	"github.com/pmghartman/phosphorus/internal/harness"
	"github.com/pmghartman/phosphorus/internal/mcp"
	"github.com/pmghartman/phosphorus/internal/mesh"
	"github.com/pmghartman/phosphorus/internal/mirror"
	"github.com/pmghartman/phosphorus/internal/model"
	"github.com/pmghartman/phosphorus/internal/project"
	"github.com/pmghartman/phosphorus/internal/proxy"
	"github.com/pmghartman/phosphorus/internal/sysfs"
	"github.com/pmghartman/phosphorus/internal/term"
	"github.com/pmghartman/phosphorus/internal/update"
	"github.com/pmghartman/phosphorus/internal/users"
	"github.com/pmghartman/phosphorus/internal/util"
	"github.com/pmghartman/phosphorus/internal/web"
)

var (
	gitForceRe = regexp.MustCompile(`^/api/githosts/([A-Za-z0-9-]{1,63})/force$`)
	projectRe  = regexp.MustCompile(`(?i)^/api/projects/([a-z0-9][a-z0-9-]*)/([a-z0-9]{12})(?:/(stop|note|delete|extend|restart|events))?$`)
	gameRe     = regexp.MustCompile(`^/api/games/([a-z0-9][a-z0-9-]*)/([a-z0-9][a-z0-9-]*)/(start|stop)$`)
	mediaRe    = regexp.MustCompile(`^/api/chat/media/([a-z0-9][a-z0-9-]*)/([0-9a-f]{32})$`)
	runRe      = regexp.MustCompile(`^/api/run/([a-z0-9][a-z0-9-]*)/([A-Za-z0-9_-]+)/(.*)$`)
	mirrorRe   = regexp.MustCompile(`^/internal/mirror/([0-9a-f]{24})$`)
	pingRe     = regexp.MustCompile(`^/api/ping/([a-z0-9-]+)$`)
	filesRe    = regexp.MustCompile(`^/api/files/([a-z0-9][a-z0-9-]*)/(info|list|tree|read|download|upload|save|mkdir|rename|delete|run|mirror)$`)
	faviconRe  = regexp.MustCompile(`^/api/favicon/([a-z0-9][a-z0-9-]*)/([a-z0-9][a-z0-9-]*)$`)
)

func urlUnescape(s string) (string, error) { return url.PathUnescape(s) }

type userCall func(s *users.Session, p map[string]any, r *http.Request) users.R

var userCalls = map[string]userCall{
	"GET /api/me": func(s *users.Session, _ map[string]any, r *http.Request) users.R {
		if s == nil {
			return users.R{Status: 401, Body: map[string]any{"error": "log in", "setup": users.Setup()}}
		}
		return users.R{Status: 200, Body: users.Me(s), Cookie: users.Refresh(r, s)}
	},
	"POST /api/login": func(_ *users.Session, p map[string]any, r *http.Request) users.R { return users.Login(p, r) },
	"POST /api/logout": func(_ *users.Session, _ map[string]any, r *http.Request) users.R {
		return users.R{Status: 200, Body: map[string]any{"ok": true}, Cookie: users.ClearCookie(r)}
	},
	"POST /api/me/vault":     func(s *users.Session, p map[string]any, _ *http.Request) users.R { return users.SetVault(s, p) },
	"POST /api/me/prefs":     func(s *users.Session, p map[string]any, _ *http.Request) users.R { return users.SetPrefs(s, p) },
	"POST /api/me/wallpaper": func(s *users.Session, p map[string]any, _ *http.Request) users.R { return users.SetWallpaper(s, p) },
	"POST /api/me/password":  func(s *users.Session, p map[string]any, r *http.Request) users.R { return users.ChangePass(s, p, r) },
	"GET /api/users":         func(s *users.Session, _ map[string]any, _ *http.Request) users.R { return users.List(s) },
	"POST /api/users":        func(s *users.Session, p map[string]any, _ *http.Request) users.R { return users.Create(s, p) },
	"POST /api/users/admin":  func(s *users.Session, p map[string]any, _ *http.Request) users.R { return users.SetAdmin(s, p) },
	"POST /api/users/delete": func(s *users.Session, p map[string]any, _ *http.Request) users.R { return users.Remove(s, p) },
}

func hopErr(host string) (int, any) {
	return 421, map[string]any{"error": fmt.Sprintf("sent to %s, which isn't %s", selfHost, host)}
}

// appHandler every request on the frontend port, and the ingress's leftovers
func appHandler(w http.ResponseWriter, r *http.Request) {
	pathname := r.URL.EscapedPath()
	q := r.URL.Query()
	method := r.Method

	if proxy.IsUpgrade(r) {
		onUpgrade(w, r, pathname, q)
		return
	}

	switch {
	case method == "GET" && (pathname == "/api/state" || pathname == "/api/mesh/snapshot" || pathname == "/api/update/local/status"):
		if !isLocalOrPeer(r) {
			forbidden(w)
			return
		}
		switch pathname {
		case "/api/state":
			s := buildState()
			noteState(s)
			s["pollMs"] = clock.IntervalMS()
			sendJSON(w, 200, s)
		case "/api/mesh/snapshot":
			sendJSON(w, 200, snapshot(q))
		default:
			st := util.ReadJSONMap(updateResultFile)
			if st == nil {
				st = map[string]any{"state": "ok"}
			}
			sendJSON(w, 200, st)
		}
		return
	case pathname == "/api/sys/stamps" && method == "GET":
		if !isTailnet(r) {
			forbidden(w)
			return
		}
		sendJSON(w, 200, sysfs.Stamps())
		return
	case pathname == "/api/sys/sync" && method == "GET":
		if !isTailnet(r) {
			forbidden(w)
			return
		}
		var rels []string
		if v := q.Get("rels"); v != "" {
			rels = strings.Split(v, ",")
			if len(rels) > 200 {
				rels = rels[:200]
			}
		}
		sendJSON(w, 200, sysfs.Dump(rels))
		return
	case pathname == "/api/me/wallpaper" && method == "GET":
		if !isLocalOrPeer(r) {
			forbidden(w)
			return
		}
		t, b := users.Wallpaper(users.Of(r))
		if b == nil {
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(404)
			return
		}
		w.Header().Set("Content-Type", t)
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(200)
		w.Write(b)
		return
	}

	if call := userCalls[method+" "+pathname]; call != nil {
		if !isLocalOrPeer(r) || (method == "POST" && !sameOrigin(r)) {
			forbidden(w)
			return
		}
		reply := func(o users.R) {
			for _, c := range o.Cookie {
				w.Header().Add("Set-Cookie", c)
			}
			sendJSON(w, o.Status, o.Body)
		}
		if method == "GET" {
			reply(call(users.Soon(r), map[string]any{}, r))
			return
		}
		max := int64(maxJSONBody)
		if pathname == "/api/me/wallpaper" {
			max = int64((users.MaxWall*14+9)/10) + 1024
		}
		b, err := readRaw(r, max)
		if err != nil {
			plain(w, 400, "bad request")
			return
		}
		p := util.Obj(util.Decode(b))
		if p == nil {
			p = map[string]any{}
		}
		reply(call(users.Soon(r), p, r))
		return
	}

	if strings.HasPrefix(pathname, "/api/git/") {
		if !isTailnet(r) {
			forbidden(w)
			return
		}
		switch {
		case pathname == "/api/git/vote" && method == "POST":
			onJSON(w, r, maxJSONBody, true, git.Vote)
			return
		case pathname == "/api/git/view" && method == "GET":
			sendJSON(w, 200, map[string]any{"states": git.View(), "pollMs": clock.IntervalMS(), "offlineMs": mesh.OfflineMS()})
			return
		case pathname == "/api/git/promote" && method == "POST":
			onJSON(w, r, maxJSONBody, false, func(p map[string]any) (int, any) {
				st, out := git.Promote(p)
				if st == 200 {
					clock.MarkHot()
				}
				return st, out
			})
			return
		}
	}

	switch {
	case pathname == "/api/model/role" && method == "POST":
		onJSON(w, r, maxJSONBody, true, func(p map[string]any) (int, any) {
			st, out := model.Choose(p)
			if st == 200 {
				clock.MarkHot()
			}
			return st, out
		})
		return
	case pathname == "/api/model/key" && method == "POST":
		onJSON(w, r, maxJSONBody, true, func(p map[string]any) (int, any) {
			st, out := model.SetKey(p)
			if st == 200 {
				clock.MarkHot()
			}
			return st, out
		})
		return
	case pathname == "/api/model/catalog" && method == "GET":
		_, hop := q["hop"]
		b, err := model.Catalog(hop && isTailnet(r))
		if err != nil {
			sendJSON(w, 502, map[string]any{"error": err.Error()})
			return
		}
		sendJSON(w, 200, b)
		return
	case pathname == "/api/terms/shared" && method == "GET":
		if !isLoopback(r) && !isTailnet(r) {
			forbidden(w)
			return
		}
		sendJSON(w, 200, term.Screens(q.Get("by")))
		return
	case pathname == "/api/terms/type" && method == "POST":
		if !isLoopback(r) && !isTailnet(r) {
			forbidden(w)
			return
		}
		onJSON(w, r, maxJSONBody, true, func(p map[string]any) (int, any) {
			ws := int(files.JSNumber(p["wait_s"]))
			if ws < 1 {
				ws = 60
			}
			out, err := term.Type(str(p["by"]), str(p["id"]), str(p["text"]), ws)
			if err != nil {
				return 500, map[string]any{"error": err.Error()}
			}
			return 200, out
		})
		return
	case pathname == "/api/mcp":
		if !isLoopback(r) && !isTailnet(r) {
			forbidden(w)
			return
		}
		if method != "POST" {
			w.Header().Set("Allow", "POST")
			w.WriteHeader(405)
			return
		}
		b, err := readRaw(r, maxJSONBody)
		if err != nil {
			plain(w, 400, "bad request")
			return
		}
		if len(b) == 0 {
			b = []byte("{}")
		}
		v := util.Decode(b)
		if v == nil {
			sendJSON(w, 400, map[string]any{"error": "invalid json"})
			return
		}
		st, body := mcp.Handle(v, isLoopback(r))
		if body == nil {
			body = map[string]any{}
		}
		sendJSON(w, st, body)
		return
	case pathname == "/api/fetch" && method == "GET":
		if !isLoopback(r) {
			forbidden(w)
			return
		}
		t, b, err := mcp.FetchRaw(q.Get("key"), q.Get("url"), r.Header.Get("Accept"))
		if err != nil {
			w.Header().Set("Content-Type", "text/plain")
			w.WriteHeader(502)
			io.WriteString(w, err.Error())
			return
		}
		if t == "" {
			t = "application/octet-stream"
		}
		w.Header().Set("Content-Type", t)
		w.Header().Set("Content-Length", strconv.Itoa(len(b)))
		w.WriteHeader(200)
		w.Write(b)
		return
	case pathname == "/api/model/v1/chat/completions" && method == "POST":
		if !isLoopback(r) && !isTailnet(r) {
			forbidden(w)
			return
		}
		b, err := readRaw(r, 16*1024*1024)
		p := util.Obj(util.Decode(b))
		if len(b) == 0 {
			p = map[string]any{}
		}
		if err != nil || p == nil {
			sendJSON(w, 400, map[string]any{"error": "bad request"})
			return
		}
		model.ServeChat(r, p, w, isLoopback(r), r.Header.Get("X-Phosphorus-Ask"))
		return
	case pathname == "/api/model/ask" && method == "POST":
		// a peer's ask, answered by this model host's opencode
		if !isTailnet(r) {
			forbidden(w)
			return
		}
		onJSON(w, r, 16*1024*1024, true, func(p map[string]any) (int, any) {
			if !model.HarnessHere() {
				return 409, map[string]any{"error": "opencode isn't on " + selfHost}
			}
			msgs := []harness.Msg{}
			for _, x := range anyList(p["messages"]) {
				m := util.Obj(x)
				msgs = append(msgs, harness.Msg{Role: util.Str(m["role"]), Content: util.Str(m["content"])})
			}
			if len(msgs) < 2 {
				return 400, map[string]any{"error": "an ask is a system turn and at least one more"}
			}
			rep, err := model.AskHere(msgs, util.Str(p["role"]), util.Str(p["asker"]), util.Truthy(p["direct"]), r.Context())
			if err != nil {
				return 502, map[string]any{"error": err.Error()}
			}
			return 200, map[string]any{"text": rep.Text, "by": rep.By}
		})
		return
	case pathname == "/api/model/asker" && method == "POST":
		// the model host reaching an asker's page here: their name, a button, a login
		if !isTailnet(r) {
			forbidden(w)
			return
		}
		onJSON(w, r, maxJSONBody, true, func(p map[string]any) (int, any) {
			c := askerFor(util.Str(p["id"]))
			if c == nil {
				return 404, map[string]any{"error": "that ask is over"}
			}
			switch util.Str(p["op"]) {
			case "name":
				return 200, map[string]any{"name": c.name}
			case "ui":
				return 200, map[string]any{"ok": uiFor(c, util.Obj(p["action"]))}
			case "creds":
				return 200, map[string]any{"out": askCreds(c, util.Str(p["action"]), util.Str(p["why"]))}
			}
			return 400, map[string]any{"error": "op is name, ui or creds"}
		})
		return
	case pathname == "/api/model/purge" && method == "POST":
		if !isLoopback(r) && !isTailnet(r) {
			forbidden(w)
			return
		}
		b, err := model.EraseSlots()
		if err != nil {
			sendJSON(w, 502, map[string]any{"error": err.Error()})
			return
		}
		sendJSON(w, 200, b)
		return
	case pathname == "/api/md" && method == "POST":
		// the page's own markdown, no parser in the browser
		if !isBrowser(r) {
			forbidden(w)
			return
		}
		onJSON(w, r, maxSaveBody, true, func(p map[string]any) (int, any) {
			if items, ok := p["items"].([]any); ok {
				if len(items) > 500 {
					items = items[:500]
				}
				out := make([]string, len(items))
				for i, x := range items {
					it := util.Obj(x)
					out[i] = web.Markdown(str(it["text"]), it["breaks"] != false)
				}
				return 200, map[string]any{"html": out}
			}
			text := str(p["text"])
			if lang, ok := p["highlight"].(string); ok {
				return 200, map[string]any{"html": web.Highlight(text, lang)}
			}
			if p["blocks"] == true {
				return 200, map[string]any{"blocks": web.Blocks(text)}
			}
			return 200, map[string]any{"html": web.Markdown(text, p["breaks"] != false)}
		})
		return
	}

	if m := gitForceRe.FindStringSubmatch(pathname); m != nil && method == "POST" {
		// the tailnet and this machine, the public side admins only
		if s := users.Of(r); proxy.IsIngress(r) && (s == nil || !s.Admin) {
			forbidden(w)
			return
		}
		clock.MarkHot()
		st, b := git.Force(m[1])
		sendJSON(w, st, b)
		return
	}

	switch {
	case pathname == "/api/update/local" && method == "POST":
		if !isTailnet(r) {
			forbidden(w)
			return
		}
		sendJSON(w, 202, map[string]any{"status": "started"})
		go update.RunLocalUpdate()
		return
	case pathname == "/api/update/check" && method == "GET":
		if !isLocalOrPeer(r) {
			forbidden(w)
			return
		}
		_, fresh := q["fresh"]
		sendJSON(w, 200, update.Check(fresh))
		return
	case pathname == "/api/update/chain" && method == "POST":
		if !isBrowser(r) {
			forbidden(w)
			return
		}
		onJSON(w, r, 1024, false, func(p map[string]any) (int, any) {
			clock.MarkHot()
			s := users.Of(r)
			admin := (s != nil && s.Admin) || (adminPass == "" && isLoopback(r))
			return chainAction(str(p["action"]), str(p["password"]), admin)
		})
		return
	case pathname == "/api/join-key" && method == "POST":
		if !isBrowser(r) {
			forbidden(w)
			return
		}
		st, b := mintGuestKey()
		sendJSON(w, st, b)
		return
	case pathname == "/api/projects" && method == "GET":
		if !isLocalOrPeer(r) {
			forbidden(w)
			return
		}
		sendJSON(w, 200, map[string]any{"self": selfHost, "projects": append(project.Summaries(), mesh.PeerProjects()...)})
		return
	case pathname == "/api/projects" && method == "POST":
		_, hop := q["hop"]
		if hop && !isLocalOrPeer(r) || !hop && !isBrowser(r) {
			forbidden(w)
			return
		}
		onJSON(w, r, maxJSONBody, true, func(p map[string]any) (int, any) {
			if !project.Enabled {
				return project.Soon()
			}
			host := selfHost
			if h, ok := p["host"]; ok && util.Truthy(h) {
				host = util.JSString(h)
			} else if st, out := project.Check(p); st != 0 {
				return st, out
			} else if !model.HarnessHere() {
				// projects run where opencode does: the model host
				mh := model.HarnessHost(model.ProjectHost())
				if mh == nil {
					return 409, map[string]any{"error": "projects run on the model host, and none has opencode up yet"}
				}
				host = util.JSString(mh["host"])
			}
			if host != selfHost {
				if hop {
					return hopErr(host)
				}
				ip := util.TailnetIP(host)
				if ip == "" {
					return 502, map[string]any{"error": "can't find " + host + " on the tailnet"}
				}
				return util.PeerCall(host, util.Req{Host: ip, Method: "POST", Path: "/api/projects?hop=1", Body: p, Timeout: 15 * time.Second})
			}
			st, out := project.Start(p)
			if st == 200 {
				clock.MarkHot()
			}
			return st, out
		})
		return
	}

	if m := projectRe.FindStringSubmatch(pathname); m != nil {
		host, id, op := m[1], m[2], m[3]
		post := op != "" && op != "events"
		if (post && method == "POST") || (!post && method == "GET") {
			if !isLocalOrPeer(r) {
				forbidden(w)
				return
			}
			run := func(p map[string]any) (int, any) {
				if host != selfHost {
					if _, hop := q["hop"]; hop {
						return hopErr(host)
					}
					ip := util.TailnetIP(host)
					if ip == "" {
						return 502, map[string]any{"error": "can't find " + host + " on the tailnet"}
					}
					qq := url.Values{}
					for k, v := range q {
						qq[k] = v
					}
					qq.Set("hop", "1")
					var body any
					if method == "POST" {
						body = p
					}
					return util.PeerCall(host, util.Req{Host: ip, Method: method, Path: pathname + "?" + qq.Encode(), Body: body, Timeout: 15 * time.Second})
				}
				var st int
				var out any
				switch op {
				case "stop":
					st, out = project.Stop(id, p["by"])
				case "note":
					st, out = project.Note(id, p["by"], p["text"])
				case "delete":
					st, out = project.Remove(id)
				case "extend":
					st, out = project.Extend(id, p)
				case "restart":
					st, out = project.Restart(id, p)
				case "events":
					st, out = project.Events(id, q.Get("since"))
				default:
					st, out = project.Detail(id)
				}
				if method == "POST" && st == 200 {
					clock.MarkHot()
				}
				return st, out
			}
			if method == "POST" {
				onJSON(w, r, maxJSONBody, true, run)
			} else {
				st, out := run(map[string]any{})
				sendJSON(w, st, out)
			}
			return
		}
	}

	if m := gameRe.FindStringSubmatch(pathname); m != nil && method == "POST" {
		if !isLocalOrPeer(r) {
			forbidden(w)
			return
		}
		host, name, action := m[1], m[2], m[3]
		var st int
		var b any
		if host == selfHost {
			st, b = runGameLocally(name, action)
		} else if _, hop := q["hop"]; hop {
			st, b = 421, map[string]any{"error": fmt.Sprintf("%s was sent to %s, which isn't %s", name, selfHost, host)}
		} else {
			st, b = forwardGame(host, name, action)
		}
		sendJSON(w, st, b)
		return
	}

	if pathname == "/api/chat/upload" && method == "POST" {
		if !isBrowser(r) {
			forbidden(w)
			return
		}
		st, b := chatmedia.Save(selfHost, r, q.Get("name"), q.Get("type"))
		sendJSON(w, st, b)
		return
	}

	if m := mediaRe.FindStringSubmatch(pathname); m != nil && method == "GET" {
		if !isLocalOrPeer(r) {
			forbidden(w)
			return
		}
		host, id := m[1], m[2]
		_, dl := q["dl"]
		if chatmedia.Serve(w, host, id, dl) {
			return
		}
		if _, hop := q["hop"]; host == selfHost || hop {
			sendJSON(w, 404, map[string]any{"error": "no such attachment"})
			return
		}
		ip := util.TailnetIP(host)
		if ip == "" || !chatmedia.Pull(host, id, ip, port) || !chatmedia.Serve(w, host, id, dl) {
			sendJSON(w, 502, map[string]any{"error": host + " has it and isn't answering"})
		}
		return
	}

	if m := runRe.FindStringSubmatch(pathname); m != nil && method == "GET" {
		if !isLocalOrPeer(r) {
			forbidden(w)
			return
		}
		_, hop := q["hop"]
		serveRun(w, r, m[1], m[2], m[3], hop)
		return
	}

	if m := mirrorRe.FindStringSubmatch(pathname); m != nil && method == "GET" {
		if !isTailnet(r) && !isLoopback(r) {
			forbidden(w)
			return
		}
		mirror.Serve(m[1], w)
		return
	}

	if m := filesRe.FindStringSubmatch(pathname); m != nil {
		filesRoute(w, r, m[1], m[2], q)
		return
	}

	// a client's ping to a host: answered here, or relayed once to that host,
	// the client timing the whole round trip itself
	if m := pingRe.FindStringSubmatch(pathname); m != nil && method == "GET" {
		if !isLocalOrPeer(r) {
			forbidden(w)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		host := m[1]
		if host != selfHost {
			if _, hop := q["hop"]; hop {
				st, b := hopErr(host)
				sendJSON(w, st, b)
				return
			}
			if err := pingPeer(r.Context(), host); err != nil {
				sendJSON(w, 502, map[string]any{"error": err.Error()})
				return
			}
		}
		w.WriteHeader(204)
		return
	}

	// a host joining with only TS_AUTHKEY: the rest from here, tailnet peers alone
	if pathname == "/internal/keys" && method == "GET" {
		if !isTailnet(r) {
			forbidden(w)
			return
		}
		keys := map[string]string{}
		for _, k := range envfile.Keys {
			if k.Mesh {
				keys[k.Name] = os.Getenv(k.Name)
			}
		}
		w.Header().Set("Cache-Control", "no-store")
		sendJSON(w, 200, keys)
		return
	}

	if pathname == "/internal/status/updating" && method == "POST" {
		if !isLoopback(r) {
			forbidden(w)
			return
		}
		onJSON(w, r, 1024, true, func(map[string]any) (int, any) {
			updating.Store(true)
			return 200, map[string]any{"ok": true}
		})
		return
	}

	if m := faviconRe.FindStringSubmatch(pathname); m != nil && method == "GET" {
		if !isLocalOrPeer(r) {
			forbidden(w)
			return
		}
		if _, why := q["why"]; why {
			sendJSON(w, 200, proxy.FaviconWhy(m[1], m[2]))
			return
		}
		v := proxy.Favicon(m[1], m[2])
		if v == nil {
			w.Header().Set("Cache-Control", "max-age=600")
			w.WriteHeader(204)
			return
		}
		h := w.Header()
		h.Set("Content-Type", v.Type)
		h.Set("Cache-Control", "max-age=3600")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
		w.WriteHeader(200)
		w.Write(v.Body)
		return
	}

	if strings.HasPrefix(pathname, "/api/") || strings.HasPrefix(pathname, "/internal/") {
		sendJSON(w, 404, map[string]any{"error": "not found"})
		return
	}
	web.ServeStatic(w, r)
}

func filesRoute(w http.ResponseWriter, r *http.Request, host, op string, q url.Values) {
	if !isLocalOrPeer(r) {
		forbidden(w)
		return
	}
	if host != selfHost {
		if _, hop := q["hop"]; hop {
			st, b := hopErr(host)
			sendJSON(w, st, b)
			return
		}
		forwardFiles(host, w, r, withHop(r.RequestURI))
		return
	}
	if op == "info" {
		sendJSON(w, 200, filesInfo())
		return
	}
	if !files.Enabled() {
		sendJSON(w, 503, map[string]any{"error": selfHost + " publishes no files directory"})
		return
	}
	sh := files.ShareOf(q.Get("share"))
	if sh == nil {
		sendJSON(w, 404, map[string]any{"error": selfHost + " has no such share"})
		return
	}
	rel := q.Get("path")
	var who *files.Who
	if sh.ID == "home" {
		who = homeWho(r)
	}
	gate := func(rels ...string) (int, any) {
		if sh.ID != "home" {
			return 0, nil
		}
		for _, x := range rels {
			if why := files.HomeGate(who, x, users.Exists); why != "" {
				if who == nil {
					return 401, map[string]any{"error": why}
				}
				return 403, map[string]any{"error": why}
			}
		}
		return 0, nil
	}
	barred := func(rels ...string) bool {
		if st, b := gate(rels...); st != 0 {
			sendJSON(w, st, b)
			return true
		}
		return false
	}
	m := r.Method
	if m == "GET" && (op == "list" || op == "tree" || op == "read" || op == "download") && barred(rel) {
		return
	}
	switch {
	case m == "GET" && op == "list":
		st, b := files.List(sh, rel)
		if sh.ID == "home" && st == 200 {
			out := b.(map[string]any)
			ents := files.HomeFilterList(who, rel, out["entries"].([]files.Entry), users.Exists)
			for i := range ents {
				p := ents[i].Name
				if rel != "" {
					p = rel + "/" + ents[i].Name
				}
				if !ents[i].Dir && mirror.IsMirrored(p) {
					ents[i].All = true
				}
			}
			out["entries"] = ents
		}
		sendJSON(w, st, b)
		return
	case m == "GET" && op == "tree":
		st, b := files.Tree(sh, rel, q.Get("depth"), q.Get("match"))
		if sh.ID == "home" && st == 200 {
			out := b.(map[string]any)
			out["entries"] = files.HomeFilterTree(who, out["entries"].([]map[string]any), users.Exists)
		}
		sendJSON(w, st, b)
		return
	case m == "GET" && op == "read":
		st, b := files.Read(sh, rel)
		sendJSON(w, st, b)
		return
	case m == "GET" && op == "download":
		abs := files.DownloadPath(sh, rel)
		if abs == "" {
			sendJSON(w, 404, map[string]any{"error": "no such file"})
			return
		}
		_, inline := q["inline"]
		sendFile(w, abs, !inline, nil)
		return
	case m == "POST" && op == "upload":
		if barred(rel) {
			io.Copy(io.Discard, r.Body)
			return
		}
		qv := func(k string) any {
			if v, ok := q[k]; ok {
				return v[0]
			}
			return nil
		}
		st, b := files.Write(sh, rel, r.Body, files.UploadQ{ID: q.Get("id"), Offset: qv("offset"), Total: qv("total")})
		sendJSON(w, st, b)
		return
	case m == "POST" && op == "save":
		onJSON(w, r, maxSaveBody, true, func(p map[string]any) (int, any) {
			if st, b := gate(str(p["path"])); st != 0 {
				return st, b
			}
			return collab.Write(*sh, str(p["path"]), writeP(p))
		})
		return
	case m == "POST" && op == "mirror":
		onJSON(w, r, maxJSONBody, false, func(p map[string]any) (int, any) {
			if sh.ID != "home" {
				return 400, map[string]any{"error": "only home files go to every host"}
			}
			if st, b := gate(str(p["path"])); st != 0 {
				return st, b
			}
			if util.Truthy(p["on"]) {
				return mirror.Mark(str(p["path"]))
			}
			return mirror.Unmark(str(p["path"]))
		})
		return
	case m == "POST" && op == "run":
		onJSON(w, r, maxJSONBody, false, func(p map[string]any) (int, any) {
			if st, b := gate(str(p["path"])); st != 0 {
				return st, b
			}
			return runGrant(sh, str(p["path"]), who)
		})
		return
	case m == "POST":
		onJSON(w, r, maxJSONBody, false, func(p map[string]any) (int, any) {
			if op == "rename" {
				if st, b := gate(str(p["from"]), str(p["to"])); st != 0 {
					return st, b
				}
			} else if st, b := gate(str(p["path"])); st != 0 {
				return st, b
			}
			switch op {
			case "mkdir":
				return files.Mkdir(sh, str(p["path"]))
			case "rename":
				return files.Rename(sh, str(p["from"]), str(p["to"]))
			case "delete":
				return files.Remove(sh, str(p["path"]))
			}
			return 405, map[string]any{"error": "method not allowed"}
		})
		return
	}
	sendJSON(w, 405, map[string]any{"error": "method not allowed"})
}

func anyList(v any) []any {
	a, _ := v.([]any)
	return a
}
