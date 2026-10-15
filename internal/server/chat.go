package server

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/chatmedia"
	"github.com/pmghartman/phosphorus/internal/clock"
	"github.com/pmghartman/phosphorus/internal/sysfs"
	"github.com/pmghartman/phosphorus/internal/util"
	"github.com/pmghartman/phosphorus/internal/web"
	"github.com/pmghartman/phosphorus/internal/wsock"
)

// Msg one chat entry, as JSON
type Msg = map[string]any

const (
	maxMessages     = 1000
	maxTextLen      = 2000
	maxModelTextLen = 8000
	maxNameLen      = 32
	clearRel        = "etc/chat/clear.json"
	typingMS        = 6000
	rejoinGrace     = 20 * time.Second
	bootQuiet       = 20 * time.Second
)

var (
	nameColors = []string{"#4f9eff", "#3fb950", "#f0883e", "#d2a8ff", "#ff7b72", "#79c0ff", "#ffa657",
		"#e3b341", "#ff9bce", "#39c5cf", "#db61a2", "#7ee787", "#d4a72c", "#ffa198"}
	validColors = func() map[string]bool {
		m := map[string]bool{}
		for _, c := range nameColors {
			m[c] = true
		}
		return m
	}()
	reactions = []string{"+1", "✓", "✗", "?", "!", "♡"}
	channelRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,23}$`)
	refRe     = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}:\d+$`)
	typingRe  = regexp.MustCompile(`^(mesh|ch:[a-z0-9][a-z0-9-]{0,23}|dm:.{1,32})$`)
	chHostRe  = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	chFileRe  = regexp.MustCompile(`^etc/chat/ch/([a-z0-9-]+)\.json$`)
)

func colorForName(n string) string {
	var h uint32
	for _, c := range utf16Units(n) {
		h = h*31 + uint32(c)
	}
	return nameColors[h%uint32(len(nameColors))]
}

func utf16Units(s string) []uint16 {
	out := []uint16{}
	for _, r := range s {
		if r >= 0x10000 {
			r -= 0x10000
			out = append(out, uint16(0xD800+(r>>10)), uint16(0xDC00+(r&0x3FF)))
		} else {
			out = append(out, uint16(r))
		}
	}
	return out
}

func clipU(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

type chatClient struct {
	ws       *wsock.Conn
	name     string
	color    string
	typing   string
	typingAt int64
}

var (
	cmu          sync.Mutex
	ownChatFile  string
	chatFile     string
	clearFile    string
	ownChat      []Msg
	ownSeq       float64
	mergedChat   []Msg
	clients      = map[*chatClient]bool{}
	peerPresence = map[string][]Msg{}
	shownClear   float64
	shownClose   = map[string]float64{}
	shownMeta    = map[string]string{}
	pendingLeave = map[string]*time.Timer{}
	bootQuietEnd time.Time
	lastPresSent string
)

func num(v any) float64 {
	f, _ := v.(float64)
	return f
}

func str(v any) string { return util.Str(v) }

func chRel(ch string) string { return "etc/chat/ch/" + ch + ".json" }

func chMeta(ch string) map[string]any {
	m := map[string]any{}
	sysfs.ReadInto(chRel(ch), &m)
	if m == nil {
		m = map[string]any{}
	}
	return m
}

func clearedAt() float64 {
	var c map[string]any
	sysfs.ReadInto(clearRel, &c)
	return num(c["at"])
}

func closedOf(ch string) float64 { return num(chMeta(ch)["closedAt"]) }

func channels() map[string]any {
	out := map[string]any{}
	for _, f := range sysfs.List("etc/chat/ch") {
		ch := strings.TrimSuffix(f, ".json")
		out[ch] = chMeta(ch)
	}
	return out
}

func closedAll() map[string]any {
	out := map[string]any{}
	for ch, m := range channels() {
		if at := util.Obj(m)["closedAt"]; util.Truthy(at) {
			out[ch] = at
		}
	}
	return out
}

func setClear(at float64, by string) {
	if !math.IsNaN(at) && !math.IsInf(at, 0) && at > clearedAt() {
		sysfs.Write(clearRel, map[string]any{"at": at, "by": by})
	}
}

func setChannel(ch string, fields map[string]any) {
	m := chMeta(ch)
	for k, v := range fields {
		m[k] = v
	}
	sysfs.Write(chRel(ch), m)
}

func isDm(m Msg) bool { s, ok := m["dm"].(string); return ok && s != "" }

func survives(m Msg) bool {
	if isDm(m) {
		return true
	}
	if ch := str(m["ch"]); ch != "" {
		return num(m["timestamp"]) > closedOf(ch)
	}
	return num(m["timestamp"]) > clearedAt()
}

func sees(c *chatClient, m Msg) bool {
	return !isDm(m) || (c.name != "" && (c.name == m["name"] || c.name == m["dm"]))
}

func filterMsgs(log []Msg, keep func(Msg) bool) []Msg {
	out := []Msg{}
	for _, m := range log {
		if keep(m) {
			out = append(out, m)
		}
	}
	return out
}

func refill(log *[]Msg, kept []Msg, file string) {
	if len(kept) == len(*log) {
		return
	}
	*log = kept
	util.WriteJSONSoon(file, *log)
}

func pushOwnLocked(e Msg) {
	ownChat = append(ownChat, e)
	if len(ownChat) > maxMessages {
		ownChat = ownChat[len(ownChat)-maxMessages:]
	}
	util.WriteJSONSoon(ownChatFile, ownChat)
}

func dropUnderLocked() {
	refill(&mergedChat, filterMsgs(mergedChat, survives), chatFile)
	refill(&ownChat, filterMsgs(ownChat, survives), ownChatFile)
}

func onSysChange(rel string) {
	if rel == clearRel {
		var c map[string]any
		sysfs.ReadInto(clearRel, &c)
		at := num(c["at"])
		cmu.Lock()
		if c == nil || !(at > shownClear) {
			cmu.Unlock()
			return
		}
		shownClear = at
		dropUnderLocked()
		cmu.Unlock()
		broadcast(Msg{"type": "clear", "by": str(c["by"]), "at": at}, nil)
		by := ""
		if b := str(c["by"]); b != "" {
			by = " by " + b
		}
		log.Printf("[frontend] chat cleared up to %s%s", time.UnixMilli(int64(at)).UTC().Format("2006-01-02T15:04:05.000Z"), by)
		return
	}
	mm := chFileRe.FindStringSubmatch(rel)
	if mm == nil {
		return
	}
	ch := mm[1]
	m := chMeta(ch)
	j := string(util.Marshal(m))
	cmu.Lock()
	if j == shownMeta[ch] {
		cmu.Unlock()
		return
	}
	shownMeta[ch] = j
	closed := num(m["closedAt"]) > shownClose[ch]
	if closed {
		shownClose[ch] = num(m["closedAt"])
		dropUnderLocked()
	}
	cmu.Unlock()
	if closed {
		broadcast(Msg{"type": "close", "ch": ch, "by": str(m["closedBy"]), "at": m["closedAt"]}, nil)
		by := ""
		if b := str(m["closedBy"]); b != "" {
			by = " by " + b
		}
		log.Printf("[frontend] #%s closed%s", ch, by)
	}
	broadcast(Msg{"type": "channel", "ch": ch, "meta": m}, nil)
}

func isClearEntry(m Msg) bool { return m != nil && m["kind"] == "clear" }
func isClose(m Msg) bool      { return m != nil && m["kind"] == "close" }
func isRetract(m Msg) bool    { return m != nil && m["kind"] == "retract" }
func isMark(m Msg) bool {
	k, _ := m["kind"].(string)
	return k == "react" || k == "edit" || k == "delete"
}

func channelOf(v any) string {
	s, ok := v.(string)
	if ok && channelRe.MatchString(s) && s != "mesh" {
		return s
	}
	return ""
}

func keyOf(m Msg) string { return util.JSString(m["host"]) + ":" + util.JSString(m["seq"]) }

func dropOrphanMarksLocked() {
	lines := filterMsgs(mergedChat, func(m Msg) bool { return !isMark(m) })
	if len(lines) == 0 {
		return
	}
	held := map[string]bool{}
	for _, m := range lines {
		held[keyOf(m)] = true
	}
	oldest := num(lines[0]["timestamp"])
	kept := filterMsgs(mergedChat, func(m Msg) bool { return !isMark(m) || held[str(m["ref"])] || num(m["timestamp"]) >= oldest })
	if len(kept) != len(mergedChat) {
		refill(&mergedChat, kept, chatFile)
	}
}

func mergeChatMessages(newMsgs []Msg) []Msg {
	for _, m := range newMsgs {
		if isClearEntry(m) {
			setClear(num(m["timestamp"]), str(m["name"]))
		} else if isClose(m) && num(m["timestamp"]) > closedOf(str(m["ch"])) {
			setChannel(str(m["ch"]), map[string]any{"closedAt": m["timestamp"], "closedBy": m["name"]})
		}
	}
	gone := map[string]bool{}
	goneOrder := []string{}
	for _, m := range newMsgs {
		if isRetract(m) {
			k := util.JSString(m["host"]) + ":" + util.JSString(m["target"])
			if !gone[k] {
				gone[k] = true
				goneOrder = append(goneOrder, k)
			}
		}
	}
	cmu.Lock()
	seen := map[string]bool{}
	for _, m := range mergedChat {
		seen[keyOf(m)] = true
	}
	added := []Msg{}
	for _, m := range newMsgs {
		if isClearEntry(m) || isClose(m) || isRetract(m) || !survives(m) {
			continue
		}
		k := keyOf(m)
		if seen[k] || gone[k] {
			continue
		}
		seen[k] = true
		mergedChat = append(mergedChat, m)
		added = append(added, m)
	}
	kept := filterMsgs(mergedChat, func(m Msg) bool { return !gone[keyOf(m)] })
	pulled := len(kept) != len(mergedChat)
	if len(added) == 0 && !pulled {
		cmu.Unlock()
		return added
	}
	if pulled {
		refill(&mergedChat, kept, chatFile)
	}
	sort.SliceStable(mergedChat, func(i, j int) bool { return num(mergedChat[i]["timestamp"]) < num(mergedChat[j]["timestamp"]) })
	if len(mergedChat) > maxMessages {
		mergedChat = mergedChat[len(mergedChat)-maxMessages:]
	}
	dropOrphanMarksLocked()
	util.WriteJSONSoon(chatFile, mergedChat)
	cmu.Unlock()
	for _, m := range added {
		m := m
		out := forBrowser(m)
		out["type"] = "message"
		broadcast(out, func(c *chatClient) bool { return sees(c, m) })
	}
	for _, k := range goneOrder {
		i := strings.LastIndex(k, ":")
		var seq float64
		fmt.Sscan(k[i+1:], &seq)
		broadcast(Msg{"type": "retract", "host": k[:i], "seq": seq}, nil)
	}
	return added
}

func postOwn(fields Msg) Msg {
	cmu.Lock()
	ownSeq++
	e := Msg{"host": selfHost, "seq": ownSeq, "timestamp": float64(util.Now())}
	for k, v := range fields {
		e[k] = v
	}
	pushOwnLocked(e)
	cmu.Unlock()
	mergeChatMessages([]Msg{e})
	clock.MarkHot()
	return e
}

func retractOwn(seq float64) {
	postOwn(Msg{"kind": "retract", "name": "", "color": "", "text": "", "target": seq})
}

func nextClearTimestamp() float64 {
	cmu.Lock()
	defer cmu.Unlock()
	newest := float64(util.Now())
	for _, m := range mergedChat {
		if t := num(m["timestamp"]); t >= newest {
			newest = t + 1
		}
	}
	return newest
}

func isFinite(v any) bool {
	f, ok := v.(float64)
	return ok && !math.IsInf(f, 0) && !math.IsNaN(f)
}

func validChatMessage(m Msg) bool {
	h, _ := m["host"].(string)
	_, nameOK := m["name"].(string)
	if m == nil || h == "" || !isFinite(m["seq"]) || !nameOK || !isFinite(m["timestamp"]) {
		return false
	}
	if isClearEntry(m) {
		return true
	}
	if isClose(m) {
		return channelOf(m["ch"]) != ""
	}
	if isRetract(m) && !isFinite(m["target"]) {
		return false
	}
	if (m["kind"] == "dm" || m["kind"] == "show") && !isDm(m) {
		return false
	}
	if isMark(m) && !refRe.MatchString(str(m["ref"])) {
		return false
	}
	_, cOK := m["color"].(string)
	_, tOK := m["text"].(string)
	return cOK && tOK
}

func fileOf(v any) map[string]any {
	f := util.Obj(v)
	h, _ := f["host"].(string)
	if f == nil || !chHostRe.MatchString(h) {
		return nil
	}
	share := ""
	if s, ok := f["share"]; ok && s != nil {
		share = clipU(util.JSString(s), 64)
	}
	p := clipU(str(f["path"]), 1024)
	if p == "" {
		return nil
	}
	label := str(f["label"])
	if label == "" {
		label = p
	}
	return map[string]any{"host": h, "share": share, "path": p, "label": clipU(label, 300)}
}

func cleanChatMessage(m Msg) Msg {
	out := Msg{}
	for k, v := range m {
		out[k] = v
	}
	if fs := chatmedia.Clean(m["files"]); fs != nil {
		out["files"] = fs
	} else {
		delete(out, "files")
	}
	if ch := channelOf(m["ch"]); ch != "" {
		out["ch"] = ch
	} else {
		delete(out, "ch")
	}
	if f := fileOf(m["file"]); f != nil {
		out["file"] = f
	} else {
		delete(out, "file")
	}
	if re, ok := m["re"].(string); !ok || !refRe.MatchString(re) {
		delete(out, "re")
	}
	if m["kind"] == "react" {
		ok := false
		for _, r := range reactions {
			ok = ok || m["emoji"] == r
		}
		if !ok {
			out["emoji"] = reactions[0]
		}
	}
	return out
}

// --- the html each browser gets beside a line's text ------------------------

var (
	plainFirst = regexp.MustCompile(`^(?:Yes|No|The|It|Its|It's|That|This|There|These|Those|You|Your|A|An|Sure|Done|Here|Nothing|None|All|Both|Not|To|In|On|For|With|From|At|By|Use|Run|Try|Open|Ok|Okay|Each|One|Some|Only|Just)\b`)
	blockFirst = regexp.MustCompile("^\\s*(?:```|[-*+] |\\d+\\. |#|>|\\||\\$\\$|\\\\\\[)")
	cmdRe      = regexp.MustCompile(`(?i)^/chimp(\s|$)`)
)

// addressed a reply opened with who it's for, a plain first word lowered
func addressed(to, text string) string {
	if to == "" || text == "" || strings.HasPrefix(strings.ToLower(text), strings.ToLower(to)+",") {
		return text
	}
	if blockFirst.MatchString(text) {
		return to + ",\n\n" + text
	}
	if plainFirst.MatchString(text) {
		r := []rune(text)
		return to + ", " + strings.ToLower(string(r[0])) + string(r[1:])
	}
	return to + ", " + text
}

func lineKind(ref string) any {
	cmu.Lock()
	defer cmu.Unlock()
	for _, m := range mergedChat {
		if keyOf(m) == ref && !isMark(m) {
			return m["kind"]
		}
	}
	return "?"
}

// forBrowser a line with its markdown rendered, never stored or peered
func forBrowser(m Msg) Msg {
	out := Msg{}
	for k, v := range m {
		out[k] = v
	}
	k, _ := m["kind"].(string)
	text, ok := m["text"].(string)
	if !ok || text == "" {
		return out
	}
	switch k {
	case "", "dm", "model", "notice", "pending", "edit":
	default:
		return out
	}
	plainLine := k == ""
	if k == "edit" {
		plainLine = lineKind(str(m["ref"])) == nil
	}
	if plainLine && cmdRe.MatchString(text) {
		text = strings.TrimLeft(text[len("/chimp"):], " \t\n\r")
	}
	if to, ok := m["to"].(string); ok && (k == "model" || k == "pending") {
		text = addressed(to, text)
	}
	out["html"] = web.Markdown(text, true)
	return out
}

// --- presence ---------------------------------------------------------------

func typingOf(c *chatClient) string {
	if c.typing != "" && util.Now()-c.typingAt < typingMS {
		return c.typing
	}
	return ""
}

func presenceLocked() []Msg {
	people := []Msg{}
	for c := range clients {
		if !c.ws.Open() || c.name == "" {
			continue
		}
		p := Msg{"name": c.name, "color": c.color, "host": selfHost}
		if t := typingOf(c); t != "" {
			p["typing"] = t
		}
		people = append(people, p)
	}
	sort.SliceStable(people, func(i, j int) bool { return str(people[i]["name"]) < str(people[j]["name"]) })
	return people
}

func presence() []Msg {
	cmu.Lock()
	defer cmu.Unlock()
	return presenceLocked()
}

func mergePeerPresence(peers map[string][]any) {
	cmu.Lock()
	peerPresence = map[string][]Msg{}
	for host, people := range peers {
		list := []Msg{}
		for _, x := range people {
			p := util.Obj(x)
			n, _ := p["name"].(string)
			if p == nil || n == "" {
				continue
			}
			col, _ := p["color"].(string)
			if !validColors[col] {
				col = colorForName(n)
			}
			row := Msg{"name": clipU(n, maxNameLen), "color": col}
			if t, ok := p["typing"].(string); ok && typingRe.MatchString(t) {
				row["typing"] = t
			}
			list = append(list, row)
		}
		peerPresence[host] = list
	}
	cmu.Unlock()
	broadcastPresence()
}

func allPresenceLocked() []Msg {
	people := presenceLocked()
	hosts := []string{}
	for h := range peerPresence {
		hosts = append(hosts, h)
	}
	sort.Strings(hosts)
	for _, h := range hosts {
		for _, p := range peerPresence[h] {
			x := Msg{}
			for k, v := range p {
				x[k] = v
			}
			x["host"] = h
			people = append(people, x)
		}
	}
	return people
}

func allPresence() []Msg {
	cmu.Lock()
	defer cmu.Unlock()
	return allPresenceLocked()
}

func presenceFor(c *chatClient, people []Msg) []Msg {
	out := []Msg{}
	for _, p := range people {
		t := str(p["typing"])
		if t != "" && strings.HasPrefix(t, "dm:") && t[3:] != c.name {
			out = append(out, Msg{"name": p["name"], "color": p["color"], "host": p["host"]})
		} else {
			out = append(out, p)
		}
	}
	return out
}

func broadcast(payload Msg, to func(*chatClient) bool) {
	data := util.Marshal(payload)
	cmu.Lock()
	cs := []*chatClient{}
	for c := range clients {
		if c.ws.Open() && (to == nil || to(c)) {
			cs = append(cs, c)
		}
	}
	cmu.Unlock()
	for _, c := range cs {
		c.ws.TextBytes(data)
	}
}

func broadcastPresence() {
	cmu.Lock()
	people := allPresenceLocked()
	j := string(util.Marshal(people))
	if j == lastPresSent {
		cmu.Unlock()
		return
	}
	lastPresSent = j
	cs := []*chatClient{}
	for c := range clients {
		cs = append(cs, c)
	}
	cmu.Unlock()
	for _, c := range cs {
		if c.ws.Open() {
			c.ws.JSON(Msg{"type": "presence", "people": presenceFor(c, people)})
		}
	}
}

func sendHistory(c *chatClient) {
	cmu.Lock()
	msgs := []Msg{}
	for _, m := range mergedChat {
		if sees(c, m) {
			msgs = append(msgs, m)
		}
	}
	cmu.Unlock()
	out := make([]Msg, len(msgs))
	for i, m := range msgs {
		out[i] = forBrowser(m)
	}
	c.ws.JSON(Msg{"type": "history", "messages": out, "closed": closedAll(), "channels": channels()})
}

func postAs(by, to, text string) (int, any) {
	body := strings.TrimSpace(clipU(text, maxModelTextLen))
	if body == "" {
		return 400, Msg{"error": "nothing to send"}
	}
	dm := clipU(strings.TrimSpace(to), maxNameLen)
	who := Msg{"name": by, "color": modelColor, "text": body}
	if dm != "" {
		who["kind"], who["dm"] = "dm", dm
	} else {
		who["kind"] = "model"
	}
	m := postOwn(who)
	online := dm == ""
	for _, p := range allPresence() {
		online = online || p["name"] == dm
	}
	sent := "to the group chat"
	if dm != "" {
		sent = "to " + dm
	}
	out := Msg{"sent": sent, "seq": m["seq"]}
	if !online {
		out["note"] = dm + " isn't online, it waits in their chat tab"
	}
	return 200, out
}

func showAs(by, to string, f map[string]any) (int, any) {
	dm := clipU(strings.TrimSpace(to), maxNameLen)
	file := fileOf(f)
	if dm == "" || file == nil {
		return 400, Msg{"error": "a person and a file"}
	}
	postOwn(Msg{"name": by, "color": modelColor, "kind": "show", "dm": dm, "text": file["label"], "file": file})
	online := false
	for _, p := range allPresence() {
		online = online || p["name"] == dm
	}
	out := Msg{"invited": dm, "file": file["label"]}
	if !online {
		out["note"] = dm + " isn't online, they're asked when they come back"
	}
	return 200, out
}

func announceJoin(name string) {
	cmu.Lock()
	if t := pendingLeave[name]; t != nil {
		t.Stop()
		delete(pendingLeave, name)
		cmu.Unlock()
		return
	}
	cmu.Unlock()
	if time.Now().Before(bootQuietEnd) {
		return
	}
	broadcast(Msg{"type": "system", "text": name + " joined"}, nil)
}

func announceLeave(name string) {
	cmu.Lock()
	defer cmu.Unlock()
	if pendingLeave[name] != nil {
		return
	}
	for _, p := range presenceLocked() {
		if p["name"] == name {
			return
		}
	}
	pendingLeave[name] = time.AfterFunc(rejoinGrace, func() {
		cmu.Lock()
		delete(pendingLeave, name)
		cmu.Unlock()
		broadcast(Msg{"type": "system", "text": name + " left"}, nil)
	})
}

// --- startup ----------------------------------------------------------------

func initChat() {
	ownChatFile = sysfs.Local("chat/own.json", filepath.Join(stateDir, "own-chat.json"))
	chatFile = sysfs.Local("chat/merged.json", filepath.Join(stateDir, "chat.json"))
	clearFile = sysfs.Local("chat/clear.json", filepath.Join(stateDir, "chat-clear.json"))
	ownChat = readLog(ownChatFile)
	if n := len(ownChat); n > 0 {
		ownSeq = num(ownChat[n-1]["seq"])
	}
	mergedChat = readLog(chatFile)
	if old := util.ReadJSONMap(clearFile); old != nil {
		setClear(num(old["at"]), "")
		for ch, at := range util.Obj(old["ch"]) {
			if channelRe.MatchString(ch) && num(at) > closedOf(ch) {
				setChannel(ch, map[string]any{"closedAt": at, "closedBy": ""})
			}
		}
		os.Remove(clearFile)
	}
	shownClear = clearedAt()
	for ch, at := range closedAll() {
		shownClose[ch] = num(at)
	}
	for ch, m := range channels() {
		shownMeta[ch] = string(util.Marshal(m))
	}
	sysfs.Watch(onSysChange)
	bootQuietEnd = time.Now().Add(bootQuiet)
	go func() {
		for range time.Tick(time.Second) {
			changed := false
			cmu.Lock()
			for c := range clients {
				if c.typing != "" && typingOf(c) == "" {
					c.typing = ""
					changed = true
				}
			}
			cmu.Unlock()
			if changed {
				broadcastPresence()
			}
		}
	}()
}

func readLog(file string) []Msg {
	var raw []json.RawMessage
	if !util.ReadJSON(file, &raw) {
		return []Msg{}
	}
	out := []Msg{}
	for _, r := range raw {
		if m := util.Obj(util.Decode(r)); m != nil {
			out = append(out, m)
		}
	}
	return out
}

// retractStaleAlerts own warnings and "writing" lines a crash left up
func retractStaleAlerts() {
	cmu.Lock()
	gone := map[float64]bool{}
	for _, m := range ownChat {
		if isRetract(m) {
			gone[num(m["target"])] = true
		}
	}
	stale := []float64{}
	for _, m := range ownChat {
		if (m["kind"] == "alert" || m["kind"] == "pending") && !gone[num(m["seq"])] {
			stale = append(stale, num(m["seq"]))
		}
	}
	cmu.Unlock()
	for _, s := range stale {
		retractOwn(s)
	}
}

// mergeFromPeers peers' chat, straight from the mesh loop
func mergeFromPeers(messages []any) {
	valid := []Msg{}
	for _, x := range messages {
		if m := util.Obj(x); validChatMessage(m) {
			valid = append(valid, cleanChatMessage(m))
		}
	}
	if len(valid) != len(messages) {
		log.Printf("[frontend] dropped %d of %d incoming chat messages, wrong shape", len(messages)-len(valid), len(messages))
	}
	mergeChatMessages(valid)
}
