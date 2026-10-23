package server

import (
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/clock"
	"github.com/pmghartman/phosphorus/internal/collab"
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
	case "/api/chat":
		s := users.Of(r)
		if ws := accept(w, r); ws != nil {
			onChat(ws, s)
		}
		return
	case "/api/me/mcp":
		s := users.Of(r)
		if s == nil || s.Boot || !sameOrigin(r) {
			refuse(w, 403)
			return
		}
		if ws := accept(w, r); ws != nil {
			mcpSocket(ws, s.User)
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
	if codeSocket(w, r, pathname, q) {
		return
	}
	if sulfurSocket(w, r, pathname, q) {
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
		term.Attach(ws, term.Opts{Host: host, SID: q.Get("sid"), Since: since, Resume: resume, SSHHost: hostSSHHost, Port: p, Shell: shell, Auto: q.Get("auto") == "1"})
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
}
