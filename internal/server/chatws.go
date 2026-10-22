package server

import (
	"encoding/json"
	"strings"

	"github.com/pmghartman/phosphorus/internal/chatmedia"
	"github.com/pmghartman/phosphorus/internal/model"
	"github.com/pmghartman/phosphorus/internal/users"
	"github.com/pmghartman/phosphorus/internal/util"
	"github.com/pmghartman/phosphorus/internal/wsock"
)

// modelColor the colour of lines a key's agent posts
const modelColor = "#d2a8ff"

func uiFor(c *chatClient, action map[string]any) bool {
	if c == nil || !c.ws.Open() {
		return false
	}
	c.ws.JSON(Msg{"type": "phosphorus-ui", "action": action})
	return true
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
	case "model-purge":
		// the status card's clear context: the role's idle llama-server slots erased
		id := clipU(str(msg["id"]), 40)
		go func() {
			out, err := model.Purge(str(msg["to"]))
			body := Msg{"type": "model-purged", "id": id}
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
	case "hide-dm":
		if with := clipU(strings.TrimSpace(str(msg["with"])), maxNameLen); with != "" && with != c.name {
			hideDm(c.name, with)
		}
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
	postOwn(e)
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
