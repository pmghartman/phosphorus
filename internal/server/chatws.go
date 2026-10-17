package server

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/chatmedia"
	"github.com/pmghartman/phosphorus/internal/harness"
	"github.com/pmghartman/phosphorus/internal/mesh"
	"github.com/pmghartman/phosphorus/internal/model"
	"github.com/pmghartman/phosphorus/internal/update"
	"github.com/pmghartman/phosphorus/internal/users"
	"github.com/pmghartman/phosphorus/internal/util"
	"github.com/pmghartman/phosphorus/internal/web"
	"github.com/pmghartman/phosphorus/internal/wsock"
)

const (
	modelColor        = "#d2a8ff"
	modelContext      = 30
	modelContextSlack = 20
	maxAsks           = 8
	openTextMax       = 24000
	dmTurns           = 200
	credsWait         = 2 * time.Minute
	apeGap            = 700 * time.Millisecond
)

var (
	askRe   = regexp.MustCompile(`(?i)^/(chimp)(\s|$)`)
	apeCall = regexp.MustCompile(`(?i)^\s*apes? together strong\W*$`)
	busy    = fmt.Sprintf("already chewing on %d questions from this host, ask again once one lands", maxAsks)

	askMu       sync.Mutex
	asking      int
	contextFrom = map[string]float64{}
	askers      = map[string]*chatClient{}
	directAsks  = map[string]*directAsk{}
	credPrompts = map[string]*credPrompt{}
	clockSkew   time.Duration
	skewMu      sync.Mutex
)

type directAsk struct {
	c    *chatClient
	stop context.CancelFunc
}

type credPrompt struct {
	c   *chatClient
	end func(any)
}

func groupSystem() string {
	return strings.ReplaceAll(strings.ReplaceAll(groupSystemT, "\x01SELF\x01", hostOr()), "\x01REPO\x01", util.RepoDir)
}
func directSystem(who string) string {
	return strings.NewReplacer("\x01SELF\x01", hostOr(), "\x01WHO\x01", who, "\x01REPO\x01", util.RepoDir).Replace(directSystemT)
}
func hostOr() string {
	if selfHost != "" {
		return selfHost
	}
	return "this host"
}

// --- today, the internet's --------------------------------------------------

func syncDate() {
	c := &http.Client{Timeout: 8 * time.Second}
	for _, u := range []string{"https://www.cloudflare.com", "https://www.google.com", "https://www.wikipedia.org"} {
		t0 := time.Now()
		res, err := c.Head(u)
		if err != nil {
			continue
		}
		res.Body.Close()
		at, err := http.ParseTime(res.Header.Get("Date"))
		if err != nil {
			continue
		}
		mid := t0.Add(time.Since(t0) / 2)
		skewMu.Lock()
		clockSkew = at.Sub(mid)
		skewMu.Unlock()
		return
	}
}

func today() string {
	skewMu.Lock()
	d := time.Now().Add(clockSkew).UTC()
	skewMu.Unlock()
	return fmt.Sprintf("Today is %s, %s UTC. This is the real date: your training data is older, ", d.Format("Monday, January 2, 2006"), d.Format("15:04")) +
		"so never assume an earlier year, and for anything current, latest or recent go by today and say what you know may be out of date."
}

func meshNames() string {
	hosts := []string{}
	for _, h := range mesh.Tailnet() {
		if n := str(h["name"]); n != "" {
			hosts = append(hosts, n)
		}
	}
	seen := map[string]bool{}
	svcs := []string{}
	for _, r := range mesh.Routes() {
		if n := str(r["name"]); n != "" && !seen[n] {
			seen[n] = true
			svcs = append(svcs, n)
		}
	}
	h, s := strings.Join(hosts, ", "), strings.Join(svcs, ", ")
	if h == "" {
		h = "none seen yet"
	}
	if s == "" {
		s = "none"
	}
	return fmt.Sprintf("The mesh right now. Hosts: %s. Services: %s. ", h, s) + "These names are the mesh's own, whatever else shares them."
}

func openNote(who string, o any) string {
	f := fileOf(o)
	if f == nil {
		return ""
	}
	om := util.Obj(o)
	t := ""
	if v, ok := om["text"]; ok && v != nil {
		t = util.JSString(v)
	}
	t = clipU(t, openTextMax)
	cut := ""
	if num(om["size"]) > float64(len([]rune(t))) {
		cut = fmt.Sprintf(", the first %d characters (files_read for the rest)", len([]rune(t)))
	}
	return fmt.Sprintf("%s has %s open in an editor tab (host %s, share \"%s\", path %s). ", who, f["label"], f["host"], f["share"], f["path"]) +
		"When they say \"this file\", \"this\", \"it\" or \"here\" without naming another, they mean that file; " +
		"files_write edits it, typed into their tab live. " +
		fmt.Sprintf("Its text as they see it now%s:\n", cut) +
		fmt.Sprintf("<file path=\"%s\">\n%s\n</file>", f["path"], t)
}

func situated(text, who string, o any) string {
	parts := []string{today(), meshNames()}
	if n := openNote(who, o); n != "" {
		parts = append(parts, n)
	}
	return model.WithContext(strings.Join(parts, "\n\n"), text)
}

func modelMessages(ask Msg, open any) []harness.Msg {
	cmu.Lock()
	gone := map[string]bool{}
	edits := map[string]Msg{}
	for _, m := range mergedChat {
		if m["kind"] == "delete" {
			gone[str(m["ref"])] = true
		}
		if m["kind"] == "edit" {
			edits[str(m["ref"])] = m
		}
	}
	before := []Msg{}
	ach := str(ask["ch"])
	for _, m := range mergedChat {
		k := str(m["kind"])
		if (k == "" || k == "model") && str(m["ch"]) == ach && !isDm(m) && num(m["timestamp"]) <= num(ask["timestamp"]) && keyOf(m) != keyOf(ask) && !gone[keyOf(m)] {
			before = append(before, m)
		}
	}
	from := contextFrom[ach]
	at := -1
	for i, m := range before {
		if num(m["timestamp"]) >= from {
			at = i
			break
		}
	}
	kept := 0
	if at >= 0 {
		kept = len(before) - at
	}
	if kept < modelContext-1 || kept > modelContext-1+modelContextSlack {
		at = len(before) - (modelContext - 1)
		if at < 0 {
			at = 0
		}
	}
	if at < len(before) && at >= 0 {
		contextFrom[ach] = num(before[at]["timestamp"])
	} else {
		contextFrom[ach] = 0
	}
	cmu.Unlock()
	lines := append(append([]Msg{}, before[at:]...), ask)
	said := func(m Msg) string {
		text := str(m["text"])
		if e := edits[keyOf(m)]; e != nil && e["name"] == m["name"] {
			text = str(e["text"])
		}
		if fs, ok := m["files"].([]any); ok && len(fs) > 0 {
			names := []string{}
			for _, f := range fs {
				names = append(names, str(util.Obj(f)["name"]))
			}
			sep := ""
			if text != "" {
				sep = " "
			}
			text = fmt.Sprintf("%s%s[attached: %s]", text, sep, strings.Join(names, ", "))
		}
		return text
	}
	turns := []harness.Msg{}
	for _, m := range lines {
		if m["kind"] == "model" {
			turns = append(turns, harness.Msg{Role: "assistant", Content: str(m["text"])})
		} else {
			turns = append(turns, harness.Msg{Role: "user", Content: str(m["name"]) + ": " + askRe.ReplaceAllString(said(m), "")})
		}
	}
	last := &turns[len(turns)-1]
	last.Content = situated(last.Content, str(ask["name"]), open)
	return append([]harness.Msg{{Role: "system", Content: groupSystem()}}, turns...)
}

func addAsker(c *chatClient) string {
	id := update.UUID()
	askMu.Lock()
	askers[id] = c
	askMu.Unlock()
	return id
}

func askModel(ask Msg, c *chatClient, open any) {
	role := "chimp"
	who := Msg{"name": role, "color": modelColor, "to": ask["name"], "re": keyOf(ask)}
	if ch := str(ask["ch"]); ch != "" {
		who["ch"] = ch
	}
	with := func(extra Msg) Msg {
		out := Msg{}
		for k, v := range who {
			out[k] = v
		}
		for k, v := range extra {
			out[k] = v
		}
		return out
	}
	askMu.Lock()
	if asking >= maxAsks {
		askMu.Unlock()
		postOwn(with(Msg{"kind": "notice", "text": busy}))
		return
	}
	asking++
	askMu.Unlock()
	pending := postOwn(with(Msg{"kind": "pending", "text": "writing"}))
	id := addAsker(c)
	defer func() {
		askMu.Lock()
		delete(askers, id)
		asking--
		askMu.Unlock()
	}()
	r, err := model.Ask(modelMessages(ask, open), role, id, false, nil)
	kind, text, by := "model", "", role
	if err != nil {
		kind, text = "notice", err.Error()
	} else {
		text, by = clipU(r.Text, maxModelTextLen), r.By
	}
	retractOwn(num(pending["seq"]))
	if by == "" {
		by = role
	}
	postOwn(with(Msg{"name": by, "kind": kind, "text": text}))
}

func apesAnswer() {
	for i, name := range model.Roles {
		name := name
		time.AfterFunc(time.Duration(i+1)*apeGap, func() {
			postOwn(Msg{"name": name, "color": modelColor, "kind": "model", "text": "apes together strong!"})
		})
	}
}

func askDirect(c *chatClient, msg Msg) {
	id := clipU(str(msg["id"]), 40)
	text := strings.TrimSpace(clipU(str(msg["text"]), maxTextLen))
	role := ""
	if msg["to"] == "chimp" {
		role = "chimp"
	}
	if id == "" || text == "" || role == "" {
		return
	}
	send := func(body Msg) {
		if c.ws.Open() {
			out := Msg{"id": id}
			for k, v := range body {
				out[k] = v
			}
			c.ws.JSON(out)
		}
	}
	askMu.Lock()
	if asking >= maxAsks {
		askMu.Unlock()
		send(Msg{"type": "agent-reply", "error": busy})
		return
	}
	asking++
	askMu.Unlock()
	turns := []harness.Msg{}
	hist, _ := msg["history"].([]any)
	filtered := []Msg{}
	for _, x := range hist {
		t := util.Obj(x)
		r, _ := t["role"].(string)
		_, ok := t["text"].(string)
		if t != nil && (r == "user" || r == "assistant") && ok {
			filtered = append(filtered, t)
		}
	}
	if len(filtered) > dmTurns {
		filtered = filtered[len(filtered)-dmTurns:]
	}
	for _, t := range filtered {
		n := maxModelTextLen
		if t["role"] == "user" {
			n = maxTextLen
		}
		turns = append(turns, harness.Msg{Role: str(t["role"]), Content: clipU(str(t["text"]), n)})
	}
	aid := addAsker(c)
	ctx, cancel := context.WithCancel(context.Background())
	askMu.Lock()
	directAsks[id] = &directAsk{c, cancel}
	askMu.Unlock()
	defer func() {
		cancel()
		askMu.Lock()
		delete(askers, aid)
		delete(directAsks, id)
		asking--
		askMu.Unlock()
	}()
	msgs := append(append([]harness.Msg{{Role: "system", Content: directSystem(c.name)}}, turns...), harness.Msg{Role: "user", Content: situated(text, c.name, msg["open"])})
	r, err := model.Ask(msgs, role, aid, true, ctx)
	if err != nil {
		send(Msg{"type": "agent-reply", "error": err.Error()})
		return
	}
	t := clipU(r.Text, maxModelTextLen)
	send(Msg{"type": "agent-reply", "by": r.By, "text": t, "html": web.Markdown(t, true), "askHtml": web.Markdown(text, true)})
}

func uiFor(c *chatClient, action map[string]any) bool {
	if c == nil || !c.ws.Open() {
		return false
	}
	c.ws.JSON(Msg{"type": "phosphorus-ui", "action": action})
	return true
}

func askCreds(c *chatClient, action, why string) any {
	id := update.UUID()
	if !uiFor(c, map[string]any{"kind": "creds", "id": id, "action": action, "why": why}) {
		return Msg{"done": false, "note": "their page is gone"}
	}
	got := make(chan any, 1)
	var once sync.Once
	end := func(out any) {
		once.Do(func() {
			askMu.Lock()
			delete(credPrompts, id)
			askMu.Unlock()
			got <- out
		})
	}
	askMu.Lock()
	credPrompts[id] = &credPrompt{c, end}
	askMu.Unlock()
	c.ws.OnClose(func() { end(Msg{"done": false, "note": "their page closed"}) })
	select {
	case out := <-got:
		return out
	case <-time.After(credsWait):
		uiFor(c, map[string]any{"kind": "creds-close", "id": id})
		end(Msg{"done": false, "note": "they never entered it"})
		return <-got
	}
}

// --- the socket ---------------------------------------------------------------

func onChat(ws *wsock.Conn, s *users.Session) {
	user := ""
	if s != nil && !s.Boot {
		user = s.User
	}
	c := &chatClient{ws: ws}
	cmu.Lock()
	clients[c] = true
	people := allPresenceLocked()
	cmu.Unlock()
	ws.JSON(Msg{"type": "presence", "people": presenceFor(c, people)})
	defer func() {
		cmu.Lock()
		delete(clients, c)
		cmu.Unlock()
		if c.name != "" {
			announceLeave(c.name)
			broadcastPresence()
		}
	}()
	for {
		raw, _, err := ws.Read()
		if err != nil {
			return
		}
		var msg Msg
		if json.Unmarshal(raw, &msg) != nil || msg == nil {
			continue
		}
		onChatMessage(c, user, msg)
	}
}

func onChatMessage(c *chatClient, user string, msg Msg) {
	t := str(msg["type"])
	if t == "ping" {
		c.ws.JSON(Msg{"type": "pong"})
		return
	}
	if t == "join" {
		name := user
		if name == "" {
			name = clipU(strings.TrimSpace(str(msg["name"])), maxNameLen)
			if msg["name"] == nil || name == "" {
				name = "anon"
			}
		}
		col, _ := msg["color"].(string)
		if !validColors[col] {
			col = colorForName(name)
		}
		cmu.Lock()
		c.name, c.color = name, col
		cmu.Unlock()
		sendHistory(c)
		announceJoin(name)
		broadcastPresence()
		c.ws.JSON(Msg{"type": "presence", "people": presenceFor(c, allPresence())})
		return
	}
	if c.name == "" {
		return
	}
	switch t {
	case "agent":
		go askDirect(c, msg)
		return
	case "agent-stop":
		askMu.Lock()
		a := directAsks[str(msg["id"])]
		askMu.Unlock()
		if a != nil && a.c == c {
			a.stop()
		}
		return
	case "agent-purge":
		id := clipU(str(msg["id"]), 40)
		go func() {
			out, err := model.Purge(str(msg["to"]))
			body := Msg{"type": "agent-purged", "id": id}
			if err != nil {
				body["error"] = err.Error()
			} else {
				for k, v := range util.Obj(util.Decode(util.Marshal(out))) {
					body[k] = v
				}
			}
			if c.ws.Open() {
				c.ws.JSON(body)
			}
		}()
		return
	case "creds-done":
		askMu.Lock()
		p := credPrompts[str(msg["id"])]
		askMu.Unlock()
		if p != nil && p.c == c {
			if util.Truthy(msg["ok"]) {
				p.end(Msg{"done": true})
			} else {
				e := clipU(str(msg["error"]), 200)
				if !util.Truthy(msg["error"]) {
					e = "they cancelled"
				}
				p.end(Msg{"done": false, "note": e})
			}
		}
		return
	case "rename":
		n := clipU(strings.TrimSpace(str(msg["name"])), maxNameLen)
		if n == "" || n == c.name || user != "" {
			return
		}
		broadcast(Msg{"type": "system", "text": c.name + " renamed to " + n}, nil)
		cmu.Lock()
		c.name = n
		cmu.Unlock()
		sendHistory(c)
		broadcastPresence()
		return
	case "recolor":
		col, _ := msg["color"].(string)
		if !validColors[col] {
			return
		}
		cmu.Lock()
		c.color = col
		cmu.Unlock()
		broadcastPresence()
		return
	case "clear":
		setClear(nextClearTimestamp(), c.name)
		return
	case "close":
		if ch := channelOf(msg["ch"]); ch != "" {
			setChannel(ch, map[string]any{"closedAt": nextClearTimestamp(), "closedBy": c.name})
		}
		return
	case "typing":
		where := ""
		if s, ok := msg["conv"].(string); ok && typingRe.MatchString(s) {
			where = s
		}
		cmu.Lock()
		if where == c.typing && where != "" {
			c.typingAt = util.Now()
			cmu.Unlock()
			return
		}
		c.typing, c.typingAt = where, util.Now()
		cmu.Unlock()
		broadcastPresence()
		return
	case "show":
		to := clipU(strings.TrimSpace(str(msg["to"])), maxNameLen)
		if file := fileOf(msg["file"]); to != "" && to != c.name && file != nil {
			postOwn(Msg{"name": c.name, "color": c.color, "kind": "show", "dm": to, "text": file["label"], "file": file})
		}
		return
	case "react", "edit", "delete":
		markLine(c, msg)
		return
	}
	text := clipU(str(msg["text"]), maxTextLen)
	fs := chatmedia.Clean(msg["files"])
	ch := channelOf(msg["ch"])
	if t == "topic" {
		if ch == "" {
			return
		}
		topic := clipU(strings.TrimSpace(text), 200)
		m := chMeta(ch)
		fresh := !util.Truthy(m["created"]) || num(m["closedAt"]) >= num(m["created"])
		fields := map[string]any{}
		if fresh {
			fields["created"], fields["createdBy"] = float64(util.Now()), c.name
		}
		if topic != "" || fresh {
			fields["topic"], fields["topicBy"] = topic, c.name
		}
		setChannel(ch, fields)
		postOwn(Msg{"name": c.name, "color": c.color, "kind": "topic", "ch": ch, "text": topic})
		return
	}
	if strings.TrimSpace(text) == "" && fs == nil {
		return
	}
	extra := Msg{}
	if fs != nil {
		files := []any{}
		for _, f := range fs {
			files = append(files, f)
		}
		extra["files"] = files
	}
	if re, ok := msg["re"].(string); ok && refRe.MatchString(re) {
		extra["re"] = re
	}
	cmu.Lock()
	wasTyping := c.typing != ""
	c.typing = ""
	cmu.Unlock()
	if wasTyping {
		broadcastPresence()
	}
	if t == "dm" {
		to := clipU(strings.TrimSpace(str(msg["to"])), maxNameLen)
		if to != "" && to != c.name {
			e := Msg{"name": c.name, "color": c.color, "kind": "dm", "dm": to, "text": text}
			for k, v := range extra {
				e[k] = v
			}
			postOwn(e)
		}
		return
	}
	if t != "message" {
		return
	}
	e := Msg{"name": c.name, "color": c.color, "text": text}
	for k, v := range extra {
		e[k] = v
	}
	if ch != "" {
		e["ch"] = ch
	}
	entry := postOwn(e)
	if askRe.MatchString(text) {
		go askModel(entry, c, msg["open"])
	} else if apeCall.MatchString(text) {
		apesAnswer()
	}
}

func markLine(c *chatClient, msg Msg) {
	ref, _ := msg["ref"].(string)
	if !refRe.MatchString(ref) {
		return
	}
	cmu.Lock()
	var line Msg
	for _, m := range mergedChat {
		if keyOf(m) == ref && !isMark(m) {
			line = m
			break
		}
	}
	cmu.Unlock()
	if line == nil || !sees(c, line) {
		return
	}
	own := line["name"] == c.name
	t := str(msg["type"])
	base := Msg{"name": c.name, "color": c.color, "kind": t, "ref": ref, "text": ""}
	if isDm(line) {
		if own {
			base["dm"] = line["dm"]
		} else {
			base["dm"] = line["name"]
		}
	}
	if ch := str(line["ch"]); ch != "" {
		base["ch"] = ch
	}
	switch t {
	case "react":
		e, _ := msg["emoji"].(string)
		ok := false
		for _, r := range reactions {
			ok = ok || e == r
		}
		if !ok {
			return
		}
		base["emoji"] = e
		base["on"] = msg["on"] != false
		postOwn(base)
	case "edit":
		text := clipU(str(msg["text"]), maxTextLen)
		k := str(line["kind"])
		if own && strings.TrimSpace(text) != "" && (k == "" || k == "dm") {
			base["text"] = text
			postOwn(base)
		}
	default:
		if own {
			postOwn(base)
		}
	}
}

func askerFor(id string) *chatClient {
	askMu.Lock()
	defer askMu.Unlock()
	return askers[id]
}

var _ = log.Printf
