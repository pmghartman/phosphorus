package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/clock"
	"github.com/pmghartman/phosphorus/internal/collab"
	"github.com/pmghartman/phosphorus/internal/mesh"
	"github.com/pmghartman/phosphorus/internal/project"
	"github.com/pmghartman/phosphorus/internal/stats"
	"github.com/pmghartman/phosphorus/internal/term"
	"github.com/pmghartman/phosphorus/internal/users"
	"github.com/pmghartman/phosphorus/internal/util"
	"github.com/pmghartman/phosphorus/internal/wsock"
)

var (
	termPathRe = regexp.MustCompile(`^/api/term/([a-z0-9][a-z0-9-]*)$`)
	codePathRe = regexp.MustCompile(`^/api/code/([a-z0-9][a-z0-9-]*)$`)
	sidRe      = regexp.MustCompile(`^[0-9a-f]{32}$`)

	hubMu     sync.Mutex
	termConns int
	stateWS   = map[*wsock.Conn]bool{}
	projectWS = map[*wsock.Conn]*pjState{}
)

func refuse(w http.ResponseWriter, status int) { w.WriteHeader(status) }

func accept(w http.ResponseWriter, r *http.Request) *wsock.Conn {
	ws, err := wsock.Accept(w, r)
	if err != nil {
		return nil
	}
	ws.KeepAlive()
	return ws
}

func drainWS(ws *wsock.Conn) {
	for {
		if _, _, err := ws.Read(); err != nil {
			return
		}
	}
}

func onUpgrade(w http.ResponseWriter, r *http.Request, pathname string, q url.Values) {
	if !isLocalOrPeer(r) {
		refuse(w, 403)
		return
	}
	switch pathname {
	case "/ws":
		s := users.Of(r)
		if ws := accept(w, r); ws != nil {
			onChat(ws, s)
		}
		return
	case "/api/state":
		if ws := accept(w, r); ws != nil {
			s := buildState()
			noteState(s)
			ws.JSON(s)
			hubMu.Lock()
			stateWS[ws] = true
			hubMu.Unlock()
			drainWS(ws)
			hubMu.Lock()
			delete(stateWS, ws)
			hubMu.Unlock()
		}
		return
	case "/api/projects/ws":
		if ws := accept(w, r); ws != nil {
			onProjects(ws)
		}
		return
	case "/api/stats":
		_, own := q["own"]
		if own && !isTailnet(r) && !isLoopback(r) {
			refuse(w, 403)
			return
		}
		if ws := accept(w, r); ws != nil {
			stats.Attach(ws, own)
		}
		return
	}
	if m := codePathRe.FindStringSubmatch(pathname); m != nil {
		if !sameOrigin(r) {
			refuse(w, 403)
			return
		}
		host := m[1]
		if _, hop := q["hop"]; host != selfHost && hop {
			refuse(w, 421)
			return
		}
		who := homeWho(r)
		ws := accept(w, r)
		if ws == nil {
			return
		}
		if host == selfHost {
			collab.Attach(ws, q.Get("share"), q.Get("path"), who)
			return
		}
		q.Set("hop", "1")
		cookie := r.Header.Get("Cookie")
		collab.Forward(ws, func() string {
			ip := util.TailnetIP(host)
			if ip == "" {
				return ""
			}
			return fmt.Sprintf("ws://%s:%d/api/code/%s?%s", ip, port, host, q.Encode())
		}, cookie)
		return
	}
	m := termPathRe.FindStringSubmatch(pathname)
	if m == nil {
		refuse(w, 404)
		return
	}
	host := m[1]
	if !sameOrigin(r) {
		refuse(w, 403)
		return
	}
	if _, hop := q["hop"]; host != selfHost && hop {
		refuse(w, 421)
		return
	}
	if !sidRe.MatchString(q.Get("sid")) {
		refuse(w, 400)
		return
	}
	_, resume := q["resume"]
	hubMu.Lock()
	n := termConns
	if s := term.SessionCount(); s > n {
		n = s
	}
	if !resume && n >= maxTerms {
		hubMu.Unlock()
		refuse(w, 503)
		return
	}
	hubMu.Unlock()
	ws := accept(w, r)
	if ws == nil {
		return
	}
	hubMu.Lock()
	termConns++
	hubMu.Unlock()
	ws.OnClose(func() {
		hubMu.Lock()
		termConns--
		hubMu.Unlock()
	})
	if host == selfHost {
		since, _ := strconv.ParseInt(q.Get("since"), 10, 64)
		if since < 0 {
			since = 0
		}
		shell := ""
		switch getPlatform() {
		case "windows":
			shell = "powershell.exe -NoLogo"
		case "":
		default:
			shell = `exec "$SHELL" -l`
		}
		p, _ := strconv.Atoi(hostSSHPort)
		term.Attach(ws, term.Opts{Host: host, SID: q.Get("sid"), Since: since, Resume: resume, SSHHost: hostSSHHost, Port: p, Shell: shell})
		<-ws.Done()
		return
	}
	q.Set("hop", "1")
	term.Forward(ws, host, func() string {
		ip := util.TailnetIP(host)
		if ip == "" {
			return ""
		}
		return fmt.Sprintf("ws://%s:%d/api/term/%s?%s", ip, port, host, q.Encode())
	}, resume)
	<-ws.Done()
}

// --- the state push ----------------------------------------------------------

const rttPush = 2 * time.Second

var (
	pushMu     sync.Mutex
	pushedFp   string
	pushedAt   time.Time
	pushQueued bool
)

func pushState() {
	hubMu.Lock()
	conns := []*wsock.Conn{}
	for c := range stateWS {
		conns = append(conns, c)
	}
	hubMu.Unlock()
	if len(conns) == 0 {
		return
	}
	s := buildState()
	fp := noteState(s)
	pushMu.Lock()
	if fp == pushedFp && time.Since(pushedAt) < rttPush {
		pushMu.Unlock()
		return
	}
	pushedFp, pushedAt = fp, time.Now()
	pushMu.Unlock()
	text := util.Marshal(s)
	for _, c := range conns {
		c.TextBytes(text)
	}
}

// --- the projects push ---------------------------------------------------------

type pjState struct {
	mu     sync.Mutex
	pick   string
	listFp string
	oneFp  string
}

type pjDetail struct {
	fp   string
	done chan struct{}
	st   int
	body any
}

var (
	pjMu      sync.Mutex
	pjDetails = map[string]*pjDetail{}
)

func allProjects() []any { return append(project.Summaries(), mesh.PeerProjects()...) }

func pjFp(x any) string {
	var walk func(v any) any
	walk = func(v any) any {
		switch t := v.(type) {
		case map[string]any:
			out := map[string]any{}
			for k, x := range t {
				if k == "deadline" {
					if f, ok := x.(float64); ok {
						out[k] = float64(int64(f/60000 + 0.5))
						continue
					}
				}
				out[k] = walk(x)
			}
			return out
		case []any:
			out := make([]any, len(t))
			for i, x := range t {
				out[i] = walk(x)
			}
			return out
		}
		return v
	}
	return string(util.Marshal(walk(util.Decode(util.Marshal(x)))))
}

func detailOf(s map[string]any) *pjDetail {
	key := str(s["host"]) + "/" + str(s["id"])
	fp := pjFp(s)
	pjMu.Lock()
	if d := pjDetails[key]; d != nil && d.fp == fp {
		pjMu.Unlock()
		return d
	}
	d := &pjDetail{fp: fp, done: make(chan struct{})}
	pjDetails[key] = d
	pjMu.Unlock()
	go func() {
		host, id := str(s["host"]), str(s["id"])
		if host == selfHost {
			d.st, d.body = project.Detail(id)
		} else if ip := util.TailnetIP(host); ip != "" {
			d.st, d.body = util.PeerCall(host, util.Req{Host: ip, Path: fmt.Sprintf("/api/projects/%s/%s?hop=1", host, id), Timeout: 15 * time.Second})
		} else {
			d.st, d.body = 502, map[string]any{"error": "can't find " + host}
		}
		close(d.done)
	}()
	return d
}

func pushProjects(ws *wsock.Conn, st *pjState, list []any, listFp string) {
	if !ws.Open() {
		return
	}
	st.mu.Lock()
	if st.listFp != listFp {
		st.listFp = listFp
		ws.JSON(map[string]any{"type": "list", "self": selfHost, "projects": list})
	}
	var s map[string]any
	for _, x := range list {
		m := util.Obj(x)
		if str(m["host"])+"/"+str(m["id"]) == st.pick {
			s = m
			break
		}
	}
	if s == nil {
		st.mu.Unlock()
		return
	}
	fp := pjFp(s)
	if fp == st.oneFp {
		st.mu.Unlock()
		return
	}
	st.oneFp = fp
	st.mu.Unlock()
	d := detailOf(s)
	go func() {
		<-d.done
		st.mu.Lock()
		defer st.mu.Unlock()
		if !ws.Open() || st.oneFp != fp {
			return
		}
		if d.st == 200 {
			ws.JSON(map[string]any{"type": "one", "project": d.body})
		} else {
			st.oneFp = ""
		}
	}()
}

func pushAllProjects() {
	hubMu.Lock()
	n := len(projectWS)
	conns := map[*wsock.Conn]*pjState{}
	for k, v := range projectWS {
		conns[k] = v
	}
	hubMu.Unlock()
	if n == 0 {
		pjMu.Lock()
		pjDetails = map[string]*pjDetail{}
		pjMu.Unlock()
		return
	}
	list := allProjects()
	listFp := pjFp(list)
	live := map[string]bool{}
	for _, x := range list {
		m := util.Obj(x)
		live[str(m["host"])+"/"+str(m["id"])] = true
	}
	pjMu.Lock()
	for k := range pjDetails {
		if !live[k] {
			delete(pjDetails, k)
		}
	}
	pjMu.Unlock()
	for ws, st := range conns {
		pushProjects(ws, st, list, listFp)
	}
}

func onProjects(ws *wsock.Conn) {
	st := &pjState{}
	hubMu.Lock()
	projectWS[ws] = st
	hubMu.Unlock()
	defer func() {
		hubMu.Lock()
		delete(projectWS, ws)
		hubMu.Unlock()
	}()
	list := allProjects()
	pushProjects(ws, st, list, pjFp(list))
	for {
		b, _, err := ws.Read()
		if err != nil {
			return
		}
		var m map[string]any
		if json.Unmarshal(b, &m) != nil || m == nil {
			continue
		}
		pick, ok := m["pick"].(string)
		if !ok {
			continue
		}
		st.mu.Lock()
		st.pick = clipU(pick, 100)
		st.oneFp = ""
		if util.Truthy(m["fresh"]) {
			st.listFp = ""
			pjMu.Lock()
			delete(pjDetails, st.pick)
			pjMu.Unlock()
		}
		st.mu.Unlock()
		list := allProjects()
		pushProjects(ws, st, list, pjFp(list))
	}
}

func startPushes() {
	clock.OnHot(func() {
		pushMu.Lock()
		if pushQueued {
			pushMu.Unlock()
			return
		}
		pushQueued = true
		pushMu.Unlock()
		go func() {
			pushMu.Lock()
			pushQueued = false
			pushMu.Unlock()
			pushState()
		}()
	})
	go func() {
		for {
			pushState()
			time.Sleep(clock.Interval())
		}
	}()
	go func() {
		for range time.Tick(500 * time.Millisecond) {
			pushAllProjects()
		}
	}()
}
