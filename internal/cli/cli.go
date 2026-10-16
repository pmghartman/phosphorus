// Package cli: the terminal ui, run by the host's phosphorus on the service's env,
// reading this host's /api/state and writing straight to config/
package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/term"

	"github.com/pmghartman/phosphorus/internal/util"
)

var (
	api = fmt.Sprintf("http://127.0.0.1:%d", util.FrontendPort)
	// the home's config/, read-write, /etc/phosphorus a read-only mount
	configDir    = util.Env("PHOSPHORUS_CONFIG_DIR", filepath.Join(util.RepoDir, "config"))
	servicesFile = filepath.Join(configDir, "services.export")
	iniFile      = filepath.Join(configDir, "phosphorus.ini")
	baseDomain   = os.Getenv("BASE_DOMAIN")
	client       = &http.Client{Timeout: 2 * time.Second}
)

// the frontend's apps, the mesh update a popup as its tray's
var tabs = []string{"status", "services", "files", "git", "model", "projects"}

const (
	statsTab = iota
	servicesTab
	filesTab
	gitTab
	modelTab
	projectsTab
)

const (
	// [files] and [git] host: rebuilt by the frontend on its own once saved
	iniNote    = "saving rebuilds phosphorus, terminals drop for a moment"
	rebuilding = "rebuilding phosphorus"
	// [model]: only gpu baked into the image
	modelNote = "all but gpu apply on the next tick, gpu rebuilds phosphorus"
)

// --- json as the api sends it -----------------------------------------------------

type J = map[string]any

func get(v any, path ...string) any {
	for _, p := range path {
		m, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = m[p]
	}
	return v
}

func obj(v any) J {
	m, _ := v.(map[string]any)
	return m
}

func objs(v any) []J {
	out := []J{}
	if a, ok := v.([]any); ok {
		for _, x := range a {
			if m, ok := x.(map[string]any); ok {
				out = append(out, m)
			}
		}
	}
	return out
}

func strs(v any) []string {
	out := []string{}
	if a, ok := v.([]any); ok {
		for _, x := range a {
			out = append(out, str(x))
		}
	}
	return out
}

// str as a template literal would print it, nothing for null
func str(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		if x == math.Trunc(x) && math.Abs(x) < 1e21 {
			return strconv.FormatInt(int64(x), 10)
		}
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	}
	return fmt.Sprint(v)
}

func num(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case bool:
		if x {
			return 1
		}
	case string:
		n, _ := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return n
	}
	return 0
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case string:
		return x != ""
	}
	return true
}

// --- the api ----------------------------------------------------------------------

type reply struct {
	status int
	body   J
}

func call(method, path string, body any) reply {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, api+path, rd)
	if err != nil {
		return reply{0, J{"error": err.Error()}}
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := client.Do(req)
	if err != nil {
		return reply{0, J{"error": err.Error()}}
	}
	defer res.Body.Close()
	out := J{}
	json.NewDecoder(res.Body).Decode(&out)
	return reply{res.StatusCode, out}
}

func post(path string, body any) reply { return call("POST", path, body) }

func chainPost(action string, password *string) reply {
	b := J{"action": action}
	if password != nil {
		b["password"] = *password
	}
	return post("/api/update/chain", b)
}

// --- ui state -----------------------------------------------------------------------

type confirm struct {
	text   string
	danger bool
	onYes  func()
}

type prompt struct {
	label, value, err string
	onSubmit          func(string)
}

var ui = struct {
	tab int
	// the mesh update popup over the tab
	update    bool
	state     J
	offline   bool
	filesInfo J
	// each list tab's selected row, the model tab's set to this host once
	sel         []int
	modelPicked bool
	// the orangutan's projects, every host's, and the picked one's whole record
	projects []J
	project  J
	room     int
	scroll   int
	form     *form
	confirm  *confirm
	prompt   *prompt
	flash    string
	flashAt  time.Time
	// the key form alone, before phosphorus runs
	keysOnly bool
	// this terminal's round trip to each host, timed here
	rtt map[string]any
}{sel: make([]int, len(tabs)), room: 20, projects: []J{}, rtt: map[string]any{}}

// everything touching ui runs on the loop, other goroutines handing it work here
var (
	loop   = make(chan func(), 64)
	poke   = make(chan struct{}, 1)
	quitCh = make(chan int, 1)
	out    = os.Stdout
)

func onLoop(f func()) { loop <- f }

func flash(msg string) {
	ui.flash = msg
	ui.flashAt = time.Now()
	render()
}

// a request asked of the poller, one in flight at a time, a poll asked for
// mid-flight run right after
func poll() {
	select {
	case poke <- struct{}{}:
	default:
	}
}

func poller() {
	for {
		every := pollOnce()
		select {
		case <-poke:
		case <-time.After(every):
		}
	}
}

func pollOnce() time.Duration {
	type snap struct {
		tab, projSel int
	}
	ch := make(chan snap, 1)
	onLoop(func() { ch <- snap{ui.tab, ui.sel[projectsTab]} })
	s := <-ch
	r := call("GET", "/api/state", nil)
	if r.status != 200 {
		onLoop(func() { ui.offline = true; render() })
		return 500 * time.Millisecond
	}
	st := r.body
	if time.Since(pingedAt) >= 2*time.Second {
		pingedAt = time.Now()
		go pingHosts(st)
	}
	var info J
	if s.tab == filesTab {
		host := str(get(st, "self", "host"))
		if info = obj(get(st, "hosts", strings.ToLower(host), "files")); info == nil {
			if x := call("GET", "/api/files/"+host+"/info", nil); x.status != 0 {
				info = x.body
			}
		}
	}
	var projects []J
	var project J
	if s.tab == projectsTab {
		if x := call("GET", "/api/projects", nil); x.status == 200 {
			projects = objs(x.body["projects"])
			sortProjects(projects)
			if i := clampSel(s.projSel, len(projects)); i < len(projects) {
				p := projects[i]
				if y := call("GET", "/api/projects/"+url.PathEscape(str(p["host"]))+"/"+str(p["id"]), nil); y.status == 200 {
					project = y.body
				}
			}
		}
	}
	onLoop(func() {
		ui.state = st
		ui.offline = false
		if s.tab == filesTab {
			ui.filesInfo = info
		}
		if projects != nil {
			ui.projects = projects
			ui.sel[projectsTab] = clampSel(ui.sel[projectsTab], len(projects))
			ui.project = project
		}
		render()
	})
	if ms := num(st["pollMs"]); ms > 0 {
		return time.Duration(ms) * time.Millisecond
	}
	return 500 * time.Millisecond
}

// the poller's alone, pings every 2s at most
var pingedAt time.Time

// pingHosts every host timed from this terminal, as the page times its own,
// nil for one that didn't answer
func pingHosts(st J) {
	hosts := []string{str(get(st, "self", "host"))}
	for _, d := range objs(st["tailnet"]) {
		if truthy(d["phosphorus"]) && str(d["name"]) != hosts[0] {
			hosts = append(hosts, str(d["name"]))
		}
	}
	got := map[string]any{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, h := range hosts {
		wg.Add(1)
		go func(h string) {
			defer wg.Done()
			t := time.Now()
			r := call("GET", "/api/ping/"+url.PathEscape(h), nil)
			var v any
			if r.status == 204 {
				v = float64(time.Since(t).Milliseconds())
			}
			mu.Lock()
			got[h] = v
			mu.Unlock()
		}(h)
	}
	wg.Wait()
	onLoop(func() { ui.rtt = got; render() })
}

// said a request's outcome on the flash line, back on the loop
func said(r reply, ok string) {
	onLoop(func() {
		if r.status == 200 {
			flash(c("online")(ok))
		} else {
			flash(c("offmesh")(or(str(r.body["error"]), fmt.Sprintf("status %d", r.status))))
		}
		poll()
	})
}

// --- render ---------------------------------------------------------------------------

func size() (int, int) {
	cols, rows, err := term.GetSize(int(out.Fd()))
	if err != nil || cols <= 0 || rows <= 0 {
		return 80, 24
	}
	return cols, rows
}

func render() {
	cols, rows := size()
	var global []key
	if ui.form == nil && !ui.keysOnly {
		u := "u update"
		if ui.update {
			u = "u close"
		}
		global = []key{k(u, "quiet"), k("k keys", "quiet"), k("q quit", "quiet")}
	}
	status := ""
	var hint []key
	switch {
	case ui.prompt != nil:
		p := ui.prompt
		label := c("muted")(p.label)
		if p.err != "" {
			label = c("offmesh")(p.err)
		}
		status = " " + label + " " + surface(pal["card"])(" "+strings.Repeat("•", len([]rune(p.value)))+caret()+bg(pal["card"])+" ")
		hint = []key{k("enter send", "primary"), k("esc cancel")}
	case ui.confirm != nil:
		status = " " + ui.confirm.text
		kind := "primary"
		if ui.confirm.danger {
			kind = "danger"
		}
		hint = []key{k("y yes", kind), k("n no")}
	case ui.flash != "" && time.Since(ui.flashAt) < 8*time.Second:
		status = " " + ui.flash
	}
	// a view drawn again if the footer's rows moved its room
	v := currentView()
	footer := func() []string {
		f := wrap(status, cols, 1)
		if hint != nil {
			f = append(f, hints(hint, nil, cols))
		} else {
			f = append(f, hints(v.keys, global, cols))
		}
		if !ui.keysOnly {
			f = append(f, taskBar(cols))
		}
		return f
	}
	foot := footer()
	head := []string{header(cols, v.title), ""}
	room := rows - len(head) - len(foot) - 1
	if room < 1 {
		room = 1
	}
	if room != ui.room {
		ui.room = room
		v = currentView()
		foot = footer()
	}
	body := make([]string, len(v.lines))
	for i, l := range v.lines {
		body[i] = " " + l
	}
	if v.scroll {
		ui.scroll = max0(min(ui.scroll, len(body)-room))
		body = body[ui.scroll:]
	}
	if len(body) > room {
		body = body[:room]
	}
	lines := append(head, body...)
	for len(lines) < rows-len(foot) {
		lines = append(lines, "")
	}
	lines = append(lines, foot...)
	if len(lines) > rows {
		lines = lines[:rows]
	}
	var b strings.Builder
	b.WriteString("\x1b[H")
	for i, l := range lines {
		if i > 0 {
			b.WriteString("\x1b[K\r\n")
		}
		b.WriteString(base + fit(l, cols))
	}
	b.WriteString("\x1b[K\x1b[J")
	io.WriteString(out, b.String())
}

// --- keys ---------------------------------------------------------------------------

// keyEv as node's readline names it, a paste whole as name paste
type keyEv struct {
	name, str         string
	ctrl, shift, meta bool
}

func formKey(s string, e keyEv) {
	f := ui.form
	if e.name == "escape" {
		ui.form = nil
		if ui.keysOnly {
			quit(1)
		}
		return
	}
	if f.kind == "service" && (e.name == "left" || e.name == "right") {
		dir := -1
		if e.name == "right" {
			dir = 1
		}
		switchService(dir)
		return
	}
	if e.name == "return" {
		f.err = map[string]func(*form) string{"service": saveService, "share": saveShare, "model": saveModel, "project": saveProject, "note": saveNote, "keys": saveKeys}[f.kind](f)
		if f.err != "" {
			return
		}
		ui.form = nil
		if f.kind == "service" {
			name := strings.TrimSpace(f.fields[0].value)
			for i, x := range splitSections(readText(servicesFile)).secs {
				if x.name == name {
					ui.sel[servicesTab] = i
					break
				}
			}
		}
		if f.kind == "project" || f.kind == "note" {
			return
		}
		if f.kind == "keys" {
			if ui.keysOnly {
				quit(0)
			} else {
				flash(c("online")(keysSaved))
				applyKeys()
			}
			return
		}
		// only a share, or [model] gpu, changing what phosphorus was started with
		rebuilds := f.kind == "share"
		for _, x := range f.fields {
			if f.kind == "model" && x.key == "gpu" && strings.TrimSpace(x.value) != f.gpuWas {
				rebuilds = true
			}
		}
		if rebuilds {
			flash(c("online")("saved, " + rebuilding))
		} else {
			flash(c("online")("saved, live on the next tick"))
		}
		poll()
		return
	}
	fieldKey(f, s, e)
}

// moving between fields, cycling choices and typing, any form
func fieldKey(f *form, s string, e keyEv) {
	x := f.fields[f.idx]
	n := len(f.fields)
	if e.name == "up" || (e.name == "tab" && e.shift) {
		f.idx = (f.idx + n - 1) % n
		return
	}
	if e.name == "down" || e.name == "tab" {
		f.idx = (f.idx + 1) % n
		return
	}
	// space cycling choices, never typed into a field that has them
	if s == " " && x.choices != nil {
		x.value = x.choices[(indexOf(x.choices, x.value)+1)%len(x.choices)]
		return
	}
	// the model's choices only ever cycled
	if x.choices != nil && f.kind == "model" {
		return
	}
	if e.name == "backspace" {
		if r := []rune(x.value); len(r) > 0 {
			x.value = string(r[:len(r)-1])
		}
		return
	}
	if s != "" && !e.ctrl && !e.meta && s >= " " && s != "\x7f" {
		x.value += s
	}
}

func saveProject(f *form) string {
	v := f.vals()
	if v["title"] == "" || v["brief"] == "" {
		return "a project needs a title and a brief"
	}
	hours, err := strconv.ParseFloat(v["hours"], 64)
	if err != nil || !(hours > 0) {
		return "hours is a number above 0"
	}
	go said(post("/api/projects", J{"title": v["title"], "brief": v["brief"], "hours": hours, "by": user()}), "started, the orangutan is on it")
	return ""
}

func saveNote(f *form) string {
	text := strings.TrimSpace(f.fields[0].value)
	if text == "" {
		return "empty note"
	}
	p := f.target
	go func() {
		r := post(projectPath(p)+"/note", J{"by": user(), "text": text})
		onLoop(func() {
			if r.status == 200 {
				flash(c("online")("noted, read next round"))
			} else {
				flash(c("offmesh")(or(str(r.body["error"]), fmt.Sprintf("status %d", r.status))))
			}
		})
	}()
	return ""
}

func projectPath(p J) string {
	return "/api/projects/" + url.PathEscape(str(p["host"])) + "/" + str(p["id"])
}

func projectsKey(s string, e keyEv) {
	p := pickedProject()
	switch {
	case e.name == "up":
		ui.sel[projectsTab] = max0(ui.sel[projectsTab] - 1)
	case e.name == "down":
		ui.sel[projectsTab] = max0(min(len(ui.projects)-1, ui.sel[projectsTab]+1))
	case s == "n":
		openForm(projectForm())
	case p == nil:
		if s == "o" || s == "s" || s == "d" {
			flash(c("offmesh")("no project picked"))
		}
		return
	case s == "o" || s == "s":
		if str(p["status"]) != "running" {
			flash(c("offmesh")(str(p["title"]) + " isn't running"))
			return
		}
		if s == "o" {
			openForm(noteForm(p))
		} else {
			ui.confirm = &confirm{text: "stop " + str(p["title"]) + "? the orangutan's work so far stays in its workspace", danger: true,
				onYes: func() { go said(post(projectPath(p)+"/stop", J{"by": user()}), "stopped") }}
		}
	case s == "d":
		if str(p["status"]) == "running" {
			flash(c("offmesh")("stop it first"))
			return
		}
		ui.confirm = &confirm{text: "delete " + str(p["title"]) + " and its workspace?", danger: true,
			onYes: func() { go said(post(projectPath(p)+"/delete", J{}), "deleted") }}
	}
	if e.name == "up" || e.name == "down" {
		poll()
	}
}

func modelKey(s string, e keyEv) {
	all := objs(get(ui.state, "model", "models"))
	switch {
	case e.name == "up":
		ui.sel[modelTab] = max0(ui.sel[modelTab] - 1)
	case e.name == "down":
		ui.sel[modelTab] = max0(min(len(all)-1, ui.sel[modelTab]+1))
	case s == "e" || e.name == "return":
		openForm(modelForm())
	}
}

var crlfRe = regexp.MustCompile(`[\r\n]+`)
var linkRe = regexp.MustCompile(`^https?://`)

// a paste whole: a link on the model tab opening [model] with it as url,
// anything else where typing goes
func onPaste(text string) {
	clean := crlfRe.ReplaceAllString(text, "")
	if ui.prompt != nil {
		ui.prompt.value += clean
		return
	}
	link := linkRe.MatchString(strings.TrimSpace(clean))
	if ui.form == nil && ui.tab == modelTab && link && !ui.offline && ui.state != nil && ui.confirm == nil {
		openForm(modelForm())
	}
	f := ui.form
	if f == nil {
		return
	}
	if f.kind == "model" && link {
		for i, x := range f.fields {
			if x.key == "url" {
				f.idx = i
				x.value = strings.TrimSpace(clean)
				return
			}
		}
	}
	if x := f.fields[f.idx]; x.choices == nil {
		x.value += clean
	}
}

func listKey(s string, e keyEv) {
	switch ui.tab {
	case servicesTab:
		secs := splitSections(readText(servicesFile)).secs
		var sec *section
		if ui.sel[servicesTab] < len(secs) {
			sec = secs[ui.sel[servicesTab]]
		}
		switch {
		case e.name == "up":
			ui.sel[servicesTab] = max0(ui.sel[servicesTab] - 1)
		case e.name == "down":
			ui.sel[servicesTab] = max0(min(len(secs)-1, ui.sel[servicesTab]+1))
		case s == "a":
			openForm(serviceForm(nil))
		case (s == "e" || e.name == "return") && sec != nil:
			openForm(serviceForm(sec))
		case s == "d" && sec != nil:
			name := sec.name
			ui.confirm = &confirm{text: "delete [" + name + "]?", danger: true, onYes: func() {
				if err := deleteService(name); err != "" {
					flash(c("offmesh")(err))
				} else {
					flash(c("online")("[" + name + "] deleted"))
				}
				poll()
			}}
		}
	case filesTab:
		shares := readShares()
		i := ui.sel[filesTab]
		has := i < len(shares)
		switch {
		case e.name == "up":
			ui.sel[filesTab] = max0(i - 1)
		case e.name == "down":
			ui.sel[filesTab] = max0(min(len(shares)-1, i+1))
		case s == "a":
			openForm(shareForm(-1))
		case s == "h" && has:
			dir := shares[i].dir
			isOff := isHomeDir(dir)
			what := "home/ into " + dir
			if isOff {
				what = "home/ back to the default files/"
			}
			ui.confirm = &confirm{text: what + "? it moves with everything in it, " + iniNote, onYes: func() {
				to := dir
				if isOff {
					to = ""
				}
				if err := writeHomeDir(to); err != "" {
					flash(c("offmesh")(err))
				} else {
					flash(c("online")("saved, " + rebuilding))
				}
				poll()
			}}
		case (s == "e" || e.name == "return") && has:
			openForm(shareForm(i))
		case s == "d" && has:
			ui.confirm = &confirm{text: "stop publishing " + shares[i].dir + "? " + iniNote, danger: true, onYes: func() {
				kept := append(append([]share{}, shares[:i]...), shares[i+1:]...)
				err := writeShares(kept)
				// the home's own dir dropped: home back to the default
				if err == "" && isHomeDir(shares[i].dir) {
					err = writeHomeDir("")
				}
				if err != "" {
					flash(c("offmesh")(err))
				} else {
					flash(c("online")("removed, " + rebuilding))
				}
			}}
		}
	case gitTab:
		gitKey(s, e)
	case statsTab:
		if e.name == "up" {
			ui.scroll = max0(ui.scroll - 1)
		} else if e.name == "down" {
			ui.scroll++
		}
	case modelTab:
		modelKey(s, e)
	case projectsTab:
		projectsKey(s, e)
	}
}

// --- git: the flag in phosphorus.ini, and the git card's make master ---------------

func gitKey(s string, e keyEv) {
	hosts := objs(ui.state["gitHosts"])
	switch {
	case e.name == "up":
		ui.sel[gitTab] = max0(ui.sel[gitTab] - 1)
	case e.name == "down":
		ui.sel[gitTab] = max0(min(len(hosts)-1, ui.sel[gitTab]+1))
	case s == "h":
		on := !readGitHost()
		text := "stop being a git host? phosphorus-git is removed, " + iniNote
		if on {
			text = "make this host a git host (forgejo)? " + iniNote
		}
		ui.confirm = &confirm{text: text, danger: !on, onYes: func() {
			if err := writeGitHost(on); err != "" {
				flash(c("offmesh")(err))
			} else if on {
				flash(c("online")("git host on; " + rebuilding))
			} else {
				flash(c("online")("git host off; " + rebuilding))
			}
		}}
	case s == "p" && ui.sel[gitTab] < len(hosts):
		askGitSwitch(hosts[ui.sel[gitTab]])
	}
}

// the card's dialog: a live master handing off, none force-promoting
func askGitSwitch(target J) {
	if target == nil || !truthy(target["reachable"]) || str(target["role"]) == "master" {
		return
	}
	var master J
	for _, h := range objs(ui.state["gitHosts"]) {
		if str(h["role"]) == "master" && truthy(h["reachable"]) {
			master = h
			break
		}
	}
	name := str(target["host"])
	text := name + " force-promoted, roster reset to the hosts in view, only if the old master is gone. force-promote?"
	if master != nil {
		text = fmt.Sprintf("%s hands off to %s, git.%s down a few seconds. make master?", str(master["host"]), name, baseDomain)
	}
	ui.confirm = &confirm{text: text, danger: master == nil, onYes: func() {
		go func() {
			r := post("/api/githosts/"+url.PathEscape(name)+"/force", nil)
			onLoop(func() {
				if r.status == 200 {
					flash(c("online")(name + " is taking over"))
				} else {
					flash(c("offmesh")("make master failed: " + or(str(r.body["error"]), fmt.Sprintf("status %d", r.status))))
				}
				poll()
			})
		}()
	}}
}

// --- the mesh update: a thin client over /api/update/chain -----------------------

func askStart() {
	if lock := obj(get(ui.state, "lock")); lock != nil {
		flash(c("warn")("already updating, started by " + str(lock["initiator"])))
		return
	}
	ui.confirm = &confirm{text: "network down for a while. continue?", onYes: func() { askPassword("") }}
}

func askPassword(err string) {
	ui.prompt = &prompt{label: "admin password", err: err, onSubmit: func(pw string) { go startChain(pw) }}
	render()
}

func startChain(password string) {
	r := chainPost("start", &password)
	onLoop(func() {
		switch {
		case r.status == 401:
			askPassword("wrong password")
		case r.status == 409:
			flash(c("warn")("already updating, started by " + or(str(r.body["by"]), "another host")))
		case r.status != 202:
			flash(c("offmesh")(or(str(r.body["error"]), fmt.Sprintf("update didn't start (status %d)", r.status))))
		}
		poll()
	})
}

func updateKey(s string) {
	chain, mine := liveChain(ui.state)
	if s == "c" && mine && truthy(chain["paused"]) {
		go func() { chainPost("continue", nil); poll() }()
	} else if s == "x" && mine {
		ui.confirm = &confirm{danger: true, text: "cancel the mesh update? hosts already updating still finish",
			onYes: func() { go func() { chainPost("cancel", nil); poll() }() }}
	}
}

func onKey(e keyEv) {
	s := e.str
	if e.ctrl && e.name == "c" {
		quit(0)
		return
	}
	if e.name == "paste" {
		onPaste(s)
		render()
		return
	}
	switch {
	case ui.prompt != nil:
		p := ui.prompt
		switch {
		case e.name == "escape":
			ui.prompt = nil
		case e.name == "return":
			ui.prompt = nil
			p.onSubmit(p.value)
		case e.name == "backspace":
			if r := []rune(p.value); len(r) > 0 {
				p.value = string(r[:len(r)-1])
			}
		case s != "" && !e.ctrl && s >= " ":
			p.value += s
		}
	case ui.confirm != nil:
		cf := ui.confirm
		ui.confirm = nil
		if s == "y" || s == "Y" {
			cf.onYes()
		}
	case ui.form != nil:
		if !ui.offline {
			formKey(s, e)
		}
	case s == "q":
		quit(0)
		return
	case s == "k":
		openForm(keysForm(false))
	case s == "u" || (ui.update && e.name == "escape"):
		ui.update = !ui.update
	case ui.update && (e.name == "return" || s == "U"):
		if ch, _ := liveChain(ui.state); ui.state != nil && ch == nil {
			askStart()
		}
	case ui.update:
		updateKey(s)
	case len(s) == 1 && s >= "1" && s <= "9" && int(s[0]-'0') <= len(tabs):
		switchTab(int(s[0] - '1'))
	case e.name == "tab" || e.name == "right" || e.name == "left":
		step := 1
		if e.shift || e.name == "left" {
			step = len(tabs) - 1
		}
		switchTab((ui.tab + step) % len(tabs))
	case !ui.offline && ui.state != nil:
		listKey(s, e)
	}
	render()
}

func openForm(f *form) {
	f.initial = f.values()
	ui.form = f
	ui.flash = ""
}

func switchTab(i int) {
	ui.update = false
	ui.tab = i
	ui.scroll = 0
	if i == filesTab || i == projectsTab {
		poll()
	}
}

// --- startup ------------------------------------------------------------------------

func quit(code int) {
	select {
	case quitCh <- code:
	default:
	}
}

// Main runs the ui: update-all opens on the start prompt, --tab keeps a reconnect's place
func Main(args []string) int {
	for i, a := range args {
		if a == "--tab" && i+1 < len(args) {
			t := strings.ToLower(args[i+1])
			ui.tab = max0(indexOf(tabs, t))
			ui.update = t == "update"
		}
	}
	updateAll := len(args) > 0 && args[0] == "update-all"
	if updateAll {
		ui.update = true
	}
	var later func()
	if updateAll {
		// the start prompt once the first poll says whether a chain already runs
		later = func() {
			for {
				ch := make(chan bool, 1)
				onLoop(func() { ch <- ui.state != nil || ui.offline })
				if <-ch {
					break
				}
				time.Sleep(50 * time.Millisecond)
			}
			onLoop(func() {
				if !ui.offline {
					askStart()
					render()
				}
			})
		}
	}
	return run(later, nil)
}

// run the terminal loop: later off the loop, first on it before the first frame,
// polling the frontend unless only the keys are asked for
func run(later, first func()) int {
	in := int(os.Stdin.Fd())
	if !term.IsTerminal(in) {
		fmt.Fprintln(os.Stderr, "phosphorus needs a terminal; run it as plain `phosphorus`")
		return 2
	}
	old, err := term.MakeRaw(in)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	restore := func() {
		io.WriteString(out, "\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1049l")
		term.Restore(in, old)
	}
	defer func() {
		if r := recover(); r != nil {
			restore()
			panic(r)
		}
	}()
	io.WriteString(out, "\x1b[?1049h\x1b[?25l\x1b[?2004h")

	chunks := make(chan string, 16)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				chunks <- string(buf[:n])
			}
			if err != nil {
				close(chunks)
				return
			}
		}
	}()
	rest := pickTheme(chunks)

	sigs := make(chan os.Signal, 4)
	signal.Notify(sigs, notifySignals...)
	if !ui.keysOnly {
		go poller()
	}
	if later != nil {
		go later()
	}
	if first != nil {
		first()
	}
	render()

	var p parser
	feed := func(s string) {
		for _, e := range p.feed(s) {
			onKey(e)
		}
	}
	feed(rest)
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	cols, rows := size()
	minute := time.Now().Minute()
	for {
		select {
		case code := <-quitCh:
			restore()
			return code
		case s, ok := <-chunks:
			if !ok {
				restore()
				return 0
			}
			feed(s)
		case f := <-loop:
			f()
		case sig := <-sigs:
			if sig == sigResize {
				render()
			} else {
				restore()
				return 0
			}
		case <-tick.C:
			// the flash line cleared once stale, a resize caught where no signal tells
			c, r := size()
			if m := time.Now().Minute(); m != minute {
				minute = m
				render()
			}
			if (c != cols || r != rows) || ui.flash != "" && time.Since(ui.flashAt) >= 8*time.Second && time.Since(ui.flashAt) < 10*time.Second {
				cols, rows = c, r
				render()
			}
		}
	}
}

// OSC 11: the terminal's own background, answered nearly everywhere, then DA1,
// answered everywhere, its reply the end of the wait; what came after it handed back
var (
	da1Re   = regexp.MustCompile(`\x1b\[\?[\d;]*c`)
	osc11Re = regexp.MustCompile(`(?i)\x1b\]11;rgb:([0-9a-f]+)/([0-9a-f]+)/([0-9a-f]+)(\x1b\\|\x07)?`)
)

func pickTheme(chunks <-chan string) string {
	io.WriteString(out, "\x1b]11;?\x1b\\\x1b[c")
	got := ""
	timeout := time.After(600 * time.Millisecond)
wait:
	for !da1Re.MatchString(got) {
		select {
		case s, ok := <-chunks:
			if !ok {
				break wait
			}
			got += s
		case <-timeout:
			break wait
		}
	}
	light := false
	if m := osc11Re.FindStringSubmatch(got); m != nil {
		var v [3]float64
		for i := range v {
			n, _ := strconv.ParseUint(m[i+1], 16, 64)
			v[i] = float64(n) / (math.Pow(16, float64(len(m[i+1]))) - 1)
		}
		light = 0.2126*v[0]+0.7152*v[1]+0.0722*v[2] > 0.5
	} else {
		parts := strings.Split(os.Getenv("COLORFGBG"), ";")
		bgv := parts[len(parts)-1]
		light = bgv == "7" || bgv == "15"
	}
	setTheme(light)
	got = osc11Re.ReplaceAllString(got, "")
	return da1Re.ReplaceAllString(got, "")
}

// --- key parsing ------------------------------------------------------------------

// parser stdin into node readline's key events, a bracketed paste whole
type parser struct {
	buf     string
	pasting bool
	paste   strings.Builder
}

const (
	pasteStart = "\x1b[200~"
	pasteEnd   = "\x1b[201~"
)

var csiRe = regexp.MustCompile(`^\x1b(\[|O)([0-9;]*)([A-Za-z~])`)

func (p *parser) feed(s string) []keyEv {
	p.buf += s
	out := []keyEv{}
	for p.buf != "" {
		if p.pasting {
			i := strings.Index(p.buf, pasteEnd)
			if i < 0 {
				// a split end marker left for the next read
				keep := 0
				for n := len(pasteEnd) - 1; n > 0; n-- {
					if strings.HasSuffix(p.buf, pasteEnd[:n]) {
						keep = n
						break
					}
				}
				p.paste.WriteString(p.buf[:len(p.buf)-keep])
				p.buf = p.buf[len(p.buf)-keep:]
				return out
			}
			p.paste.WriteString(p.buf[:i])
			p.buf = p.buf[i+len(pasteEnd):]
			p.pasting = false
			out = append(out, keyEv{name: "paste", str: p.paste.String()})
			p.paste.Reset()
			continue
		}
		if strings.HasPrefix(p.buf, pasteStart) {
			p.buf = p.buf[len(pasteStart):]
			p.pasting = true
			continue
		}
		b := p.buf[0]
		if b == 0x1b {
			if len(p.buf) == 1 {
				out = append(out, keyEv{name: "escape"})
				p.buf = ""
				continue
			}
			if m := csiRe.FindStringSubmatch(p.buf); m != nil {
				p.buf = p.buf[len(m[0]):]
				e := keyEv{shift: strings.HasSuffix(m[2], ";2")}
				switch m[3] {
				case "A":
					e.name = "up"
				case "B":
					e.name = "down"
				case "C":
					e.name = "right"
				case "D":
					e.name = "left"
				case "Z":
					e.name, e.shift = "tab", true
				case "~":
					if strings.HasPrefix(m[2], "3") {
						e.name = "delete"
					}
				}
				out = append(out, e)
				continue
			}
			if p.buf[1] == '[' || p.buf[1] == 'O' {
				// an unfinished sequence waits for the rest, junk dropped
				if len(p.buf) < 16 {
					return out
				}
				p.buf = p.buf[2:]
				continue
			}
			if p.buf[1] == 0x1b {
				out = append(out, keyEv{name: "escape"})
				p.buf = p.buf[1:]
				continue
			}
			r, n := firstRune(p.buf[1:])
			out = append(out, keyEv{name: strings.ToLower(r), str: r, meta: true})
			p.buf = p.buf[1+n:]
			continue
		}
		p.buf = p.buf[1:]
		switch {
		case b == '\r':
			out = append(out, keyEv{name: "return", str: "\r"})
		case b == '\n':
			out = append(out, keyEv{name: "enter", str: "\n"})
		case b == '\t':
			out = append(out, keyEv{name: "tab", str: "\t"})
		case b == 0x7f || b == 0x08:
			out = append(out, keyEv{name: "backspace", str: string(b)})
		case b < 0x20:
			out = append(out, keyEv{name: string(rune('a' + b - 1)), str: string(b), ctrl: true})
		default:
			r, n := firstRune(string(b) + p.buf)
			p.buf = p.buf[n-1:]
			e := keyEv{str: r, name: strings.ToLower(r)}
			if r == " " {
				e.name = "space"
			}
			if r != strings.ToLower(r) {
				e.shift = true
			}
			out = append(out, e)
		}
	}
	return out
}

func firstRune(s string) (string, int) {
	r, n := utf8.DecodeRuneInString(s)
	return string(r), n
}
