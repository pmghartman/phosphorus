package cli

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/pmghartman/phosphorus/internal/services"
	"github.com/pmghartman/phosphorus/internal/util"
)

type view struct {
	lines  []string
	keys   []key
	scroll bool
	// the window title, the tab's name when blank
	title string
}

func k(label string, kind ...string) key {
	if len(kind) > 0 {
		return key{label, kind[0]}
	}
	return key{label: label}
}

// kif the key when cond holds, else nothing
func kif(cond bool, label string, kind ...string) key {
	if !cond {
		return key{}
	}
	return k(label, kind...)
}

func clampSel(i, n int) int {
	if i > n-1 {
		i = n - 1
	}
	if i < 0 {
		i = 0
	}
	return i
}

func selfHost() string { return str(get(ui.state, "self", "host")) }

// the domain, else this host's name on the tailnet
func meshAddr() string {
	if baseDomain != "" {
		return baseDomain
	}
	return selfHost()
}

// topBar .dk-bar at the top: the wordmark, the apps as tabs, the hosts and
// the version right, narrowed by dropping the hosts, then the tab names
func topBar(cols int) string {
	mark := " " + gradient("phosphorus", 0) + "  "
	if ui.keysOnly {
		return surface(pal["tabbar"])(mark + c("muted")("· ") + c("sage")("keys") + strings.Repeat(" ", max0(cols-vlen(mark)-6)))
	}
	tasks := func(short bool) string {
		parts := []string{}
		for i, t := range tabs[:shown] {
			label := fmt.Sprintf(" %d %s ", i+1, t)
			if short {
				label = fmt.Sprintf(" %d ", i+1)
			}
			if i == ui.tab {
				parts = append(parts, surface(pal["border"])(bold(fg(pal["accent"])+label[:2]+fg(pal["fg"])+label[2:])))
				continue
			}
			parts = append(parts, c("muted")(label))
		}
		return strings.Join(parts, "")
	}
	ver := ""
	if ui.state != nil {
		ver = c("dim")("v"+str(get(ui.state, "self", "version"))) + " "
	}
	// a mesh update running, lit from any tab; the update view's own name when open
	upd := ""
	switch {
	case ui.tab == updateTab:
		upd = surface(pal["border"])(bold(c("accent")(" mesh update "))) + "  "
	case obj(get(ui.state, "lock")) != nil:
		upd = c("accent")("● updating") + "  "
	}
	chips := hostChips()
	if chips != "" {
		chips += "  "
	}
	t := tasks(false)
	for _, right := range []string{upd + chips + ver, upd + ver} {
		if vlen(mark)+vlen(t)+vlen(right) <= cols {
			return surface(pal["tabbar"])(mark + t + strings.Repeat(" ", cols-vlen(mark)-vlen(t)-vlen(right)) + right)
		}
	}
	t = tasks(true)
	right := upd + ver
	if vlen(mark)+vlen(t)+vlen(right) > cols {
		right = upd
	}
	return surface(pal["tabbar"])(mark + t + strings.Repeat(" ", max0(cols-vlen(mark)-vlen(t)-vlen(right))) + right)
}

// .dk-chip: this host purple, the rest green, one not answering red
func hostChips() string {
	if ui.state == nil {
		return ""
	}
	self := selfHost()
	chips := []string{c("accent")("■") + " " + self}
	for _, d := range objs(ui.state["tailnet"]) {
		n := str(d["name"])
		switch {
		case n == self || n == "":
		case truthy(d["phosphorus"]):
			chips = append(chips, c("online")("■")+" "+c("muted")(n))
		case truthy(d["phosphorusSeen"]):
			chips = append(chips, c("offmesh")("■")+" "+c("offmesh")(n))
		}
	}
	return strings.Join(chips, "  ")
}

// hints one line: a view's keys left, the global ones right, the key letter
// in its kind's colour, the rest muted
func hints(keys, global []key, cols int) string {
	one := func(ks []key) string {
		parts := []string{}
		for _, x := range ks {
			if x.label == "" {
				continue
			}
			tok := map[string]string{"primary": "accent", "danger": "offmesh", "quiet": "muted"}[x.kind]
			if tok == "" {
				tok = "fg"
			}
			key, rest, _ := strings.Cut(x.label, " ")
			parts = append(parts, bold(c(tok)(key))+" "+c("muted")(rest))
		}
		return strings.Join(parts, "   ")
	}
	left, right := " "+one(keys), one(global)+" "
	return left + strings.Repeat(" ", max0(cols-vlen(left)-vlen(right))) + right
}

// .is-self and .mesh-stat-dot: the square before a host's name
func selfMark(name string) string { return c("accent")("■") + " " + name }

func dot(d J) string {
	tok := "dim"
	if truthy(d["phosphorus"]) {
		tok = "teal"
	}
	return c(tok)("■") + " " + str(d["name"])
}

func servicesView() view {
	st := ui.state
	text := readText(servicesFile)
	d := splitSections(text)
	_, perr := services.Parse(text)
	own := map[string]J{}
	for _, r := range objs(st["routes"]) {
		if str(r["host"]) == selfHost() {
			own[str(r["name"])] = r
		}
	}
	ui.sel[servicesTab] = clampSel(ui.sel[servicesTab], len(d.secs))
	rows := [][]string{}
	for _, s := range d.secs {
		f := fieldsOf(s)
		live, ok := own[s.name]
		var status string
		switch {
		case f["type"] == "game" && ok && str(live["status"]) == "online":
			status = c("online")(str(live["status"]))
		case f["type"] == "game" && ok:
			status = c("warn")(str(live["status"]))
		case f["type"] == "game":
			status = c("muted")("not published")
		case ok:
			status = c("online")("published")
		default:
			status = c("warn")("not answering")
		}
		where := fmt.Sprintf("%s/%s/%s/", meshAddr(), selfHost(), s.name)
		if f["type"] == "game" {
			where = fmt.Sprintf("%s.%s:%s", s.name, str(st["gameZone"]), f["port"])
		} else if f["mode"] == "subdomain" && baseDomain != "" {
			where = s.name + "." + baseDomain
		}
		scheme := f["scheme"]
		if scheme == "" && f["type"] == "" {
			scheme = "http"
		}
		access := c("muted")("login")
		switch {
		case f["type"] == "game":
			access = c("muted")("-")
		case f["public"] == "true":
			access = c("warn")("public")
		}
		rows = append(rows, []string{s.name, f["port"], c("teal")(or(f["type"], f["mode"], "path")), c("muted")(scheme), c("muted")(where), access, status})
	}
	var rejected *card
	room := ui.room - 3
	if perr != "" {
		rejected = &card{"rejected", plainRows(c("offmesh")(perr), c("offmesh")("the frontend keeps publishing the last good version until it is fixed"))}
		room = ui.room - 8
	}
	body := plainRows(c("muted")("no services declared"))
	if len(rows) > 0 {
		body = table([]string{"name", "port", "mode", "scheme", "address", "access", "live"}, rows, ui.sel[servicesTab], room)
	}
	n := len(rows) > 0
	return view{lines: panels(rejected, &card{"services.export", body}),
		keys: []key{k("a add", "primary"), kif(n, "e edit"), kif(n, "d delete", "danger")}}
}

func or(xs ...string) string {
	for _, x := range xs {
		if x != "" {
			return x
		}
	}
	return ""
}

func star(on bool) string {
	if on {
		return c("accent")("★")
	}
	return " "
}

func filesView() view {
	shares := readShares()
	info := ui.filesInfo
	home := readHomeDir()
	ui.sel[filesTab] = clampSel(ui.sel[filesTab], len(shares))
	var published *card
	if info != nil && info["shares"] != nil {
		ls := []string{}
		for _, s := range objs(info["shares"]) {
			ls = append(ls, fmt.Sprintf("%s %s  %s", star(truthy(s["home"])), str(s["label"]), c("teal")(str(s["perms"]))))
		}
		if len(ls) == 0 {
			ls = append(ls, c("muted")("nothing"))
		}
		if w := str(info["wantDir"]); w != "" {
			ls = append(ls, "", c("warn")(rebuilding+" to publish "+w))
		}
		published = &card{"published now", plainRows(ls...)}
	}
	fallback := "the home's files/"
	if info != nil && str(info["home"]) != "" {
		fallback = str(info["home"])
	}
	lines := []row{}
	anyHome := false
	if len(shares) > 0 {
		rs := [][]string{}
		for _, s := range shares {
			h := isHomeDir(s.dir)
			anyHome = anyHome || h
			rs = append(rs, []string{star(h), s.dir, c("teal")(s.perms)})
		}
		lines = table([]string{"", "dir", "perms"}, rs, ui.sel[filesTab], 0)
	}
	if home == "" || !anyHome {
		lead := ""
		if len(shares) > 0 {
			lead = "  "
		}
		lines = append(lines, row{text: lead + star(true) + " " + c("muted")(fallback) + " " + c("muted")("(default)")})
	}
	lines = append(lines, plainRows("", c("muted")("★ holds home/: each user's folder, shared/ and .sys/"))...)
	n := len(shares) > 0
	return view{lines: panels(&card{"phosphorus.ini [files]", lines}, published),
		keys: []key{k("a add", "primary"), kif(n, "e edit"), kif(n, "d delete", "danger"), kif(n, "h home")}}
}

const gib = 1 << 30

func gb(bytes float64) string { return fmt.Sprintf("%.1fGB", bytes/gib) }

func ago(sec float64) string {
	s := int(sec)
	switch {
	case s < 60:
		return fmt.Sprintf("%ds", s)
	case s < 3600:
		return fmt.Sprintf("%dm", s/60)
	case s < 86400:
		return fmt.Sprintf("%dh", s/3600)
	}
	return fmt.Sprintf("%dd", s/86400)
}

// the git card's transfer bar: five cells a band, green to 8s, yellow to 15s, red to 60s
func lagMeter(age float64) string {
	out := ""
	empty := 0
	for _, b := range []struct {
		tok      string
		from, to float64
	}{{"online", 0, 8}, {"warn", 8, 15}, {"offmesh", 15, 60}} {
		full := int(math.Round(math.Max(0, math.Min(1, (age-b.from)/(b.to-b.from))) * 5))
		if full > 0 {
			out += c(b.tok)(strings.Repeat("█", full))
		}
		empty += 5 - full
	}
	return out + fg(off) + strings.Repeat("░", empty) + fg(pal["fg"])
}

// the card's glyphs: ● master, ○ servant ready, ◌ catching up, × unreachable
func gitRow(h J, masterGen any) []string {
	master := str(h["role"]) == "master"
	reach := truthy(h["reachable"])
	var glyph string
	switch {
	case !reach:
		glyph = c("offmesh")("×")
	case master:
		glyph = c("accent")("●")
	case !truthy(h["eligible"]):
		glyph = c("sand")("◌")
	default:
		glyph = c("sage")("○")
	}
	name := str(h["host"])
	if !reach {
		name = c("muted")(strike(name))
	}
	var backup string
	switch {
	case !reach:
		backup = "unreachable"
	case (h["gen"] == nil || h["ageSec"] == nil) && masterGen != nil && !master:
		backup = c("sand")("downloading…")
	case h["gen"] == nil || h["ageSec"] == nil:
		backup = "no data yet"
	default:
		first := ago(num(h["ageSec"])) + " behind"
		if master {
			first = "live"
		} else if masterGen != nil && num(h["gen"]) < num(masterGen) {
			first = "older lineage"
		}
		parts := []string{first}
		if !master && !truthy(h["eligible"]) {
			parts = append(parts, "catching up")
		}
		if truthy(h["updating"]) {
			parts = append(parts, "updating")
		}
		backup = strings.Join(parts, " · ")
	}
	meter := ""
	if reach && !master && h["ageSec"] != nil {
		meter = lagMeter(num(h["ageSec"]))
	}
	return []string{glyph + " " + name, c("muted")(backup), meter}
}

// .mesh-stat-ping: green to 40ms, yellow to 150, red past it
func ping(ms any) string {
	v, ok := ms.(float64)
	if !ok {
		return c("muted")("–")
	}
	n := int(math.Round(v))
	tok := "offmesh"
	if n <= 40 {
		tok = "online"
	} else if n <= 150 {
		tok = "warn"
	}
	return c(tok)(fmt.Sprintf("%dms", n))
}

func statsView() view {
	st := ui.state
	self := selfHost()
	var lockCard *card
	if lock := obj(st["lock"]); lock != nil {
		lockCard = &card{"mesh update", plainRows(c("accent")("running, started by " + str(lock["initiator"])))}
	}
	tail := objs(st["tailnet"])
	has := false
	for _, d := range tail {
		has = has || str(d["name"]) == self
	}
	if !has {
		tail = append([]J{{"name": self, "phosphorus": true}}, tail...)
	}
	trows := [][]string{}
	for _, d := range tail {
		isSelf := str(d["name"]) == self
		name, os, ver, p := dot(d), str(d["os"]), str(d["version"]), ""
		if isSelf {
			name, os, ver = selfMark(self), str(get(st, "self", "platform")), str(get(st, "self", "version"))
		}
		if isSelf || truthy(d["phosphorus"]) {
			p = ping(ui.rtt[str(d["name"])])
		}
		trows = append(trows, []string{name, c("teal")(os), c("muted")(ver), p})
	}
	routes := objs(st["routes"])
	rbody := plainRows(c("muted")("nothing published"))
	if len(routes) > 0 {
		rrows := [][]string{}
		for _, r := range routes {
			game := str(r["type"]) == "game"
			mode, addr, status := str(r["mode"]), "", c("online")("up")
			switch {
			case game:
				mode, addr = "game", fmt.Sprintf("%s.%s:%s", str(r["name"]), str(st["gameZone"]), str(r["port"]))
			case mode == "subdomain" && baseDomain != "":
				addr = str(r["name"]) + "." + baseDomain
				if bp := str(r["base_path"]); bp != "" {
					addr += "/" + bp
				}
			default:
				addr = fmt.Sprintf("%s/%s/%s/", meshAddr(), str(r["host"]), str(r["name"]))
			}
			if game {
				tok := "muted"
				if str(r["status"]) == "online" {
					tok = "online"
				}
				status = c(tok)(str(r["status"]))
			}
			access := c("muted")("login")
			if r["public"] == true || r["master"] != nil {
				access = c("warn")("public")
			}
			if game {
				access = c("muted")("-")
			}
			rrows = append(rrows, []string{c("sky")(str(r["host"])), str(r["name"]), c("teal")(mode), c("muted")(addr), c("muted")(str(r["port"])), access, status})
		}
		rbody = table([]string{"host", "name", "mode", "address", "port", "access", "status"}, rrows, -1, 0)
	}
	return view{lines: panels(lockCard, overview(tail), &card{"tailnet", table([]string{"host", "os", "version", "ping"}, trows, -1, 0)}, &card{"routes", rbody}),
		keys: []key{k("↑↓ scroll", "quiet")}, scroll: true}
}

// overview where to open the desktop and how many hosts answer
func overview(tail []J) *card {
	up, seen := 0, 0
	for _, d := range tail {
		if truthy(d["phosphorus"]) {
			up++
		}
		if truthy(d["phosphorus"]) || truthy(d["phosphorusSeen"]) {
			seen++
		}
	}
	addr := "http://" + selfHost()
	if baseDomain != "" {
		addr = "https://" + baseDomain
	}
	tok := "online"
	if up < seen {
		tok = "warn"
	}
	lbl := func(s string) string { return c("muted")(fmt.Sprintf("%-6s", s)) }
	return &card{"this mesh", plainRows(
		lbl("open")+c("accent")(addr)+c("muted")("  in a browser on the tailnet"),
		lbl("hosts")+c(tok)(fmt.Sprintf("%d of %d", up, seen))+c("muted")(" answering"),
	)}
}

// phosphorus.ini's flag against what the mesh sees, the election as the git card draws it
func gitView() view {
	st := ui.state
	want := readGitHost()
	hosts := objs(st["gitHosts"])
	live := false
	var masterGen any
	for _, h := range hosts {
		live = live || str(h["host"]) == selfHost()
		if masterGen == nil && str(h["role"]) == "master" {
			masterGen = h["gen"]
		}
	}
	ui.sel[gitTab] = clampSel(ui.sel[gitTab], len(hosts))
	on := c("muted")("off")
	if want {
		on = c("online")("on")
	}
	here := plainRows(selfMark(selfHost()) + "  git host " + on)
	if want != live {
		w := "still a git host"
		if want {
			w = "not a git host yet"
		}
		here = append(here, row{text: c("warn")(w + "; " + rebuilding)})
	}
	body := plainRows(c("muted")("none"))
	if len(hosts) > 0 {
		rs := [][]string{}
		for _, h := range hosts {
			rs = append(rs, gitRow(h, masterGen))
		}
		body = table([]string{"host", "state", "behind"}, rs, ui.sel[gitTab], 0)
	}
	var target J
	if ui.sel[gitTab] < len(hosts) {
		target = hosts[ui.sel[gitTab]]
	}
	return view{lines: panels(&card{"this host", here}, &card{"git hosts", body}),
		keys: []key{k("h toggle host", "primary"), kif(target != nil && truthy(target["reachable"]) && str(target["role"]) != "master", "p make master")}}
}

// a model host's roles, as each now answers
func rolesOf(x, model J) []string {
	out := []string{}
	for _, r := range roles {
		if str(x["host"]) == str(model[r]) {
			out = append(out, r)
		}
	}
	return out
}

func modelView() view {
	st := ui.state
	model := obj(st["model"])
	all := objs(model["models"])
	var m J
	mi := -1
	for i, x := range all {
		if m == nil && str(x["host"]) == selfHost() {
			m, mi = x, i
		}
	}
	cfg := readModel()
	// starts on this host's own row
	if !ui.modelPicked && m != nil {
		ui.sel[modelTab] = mi
		ui.modelPicked = true
	}
	ui.sel[modelTab] = clampSel(ui.sel[modelTab], len(all))
	rows := [][]string{}
	for _, x := range all {
		name := c("teal")("■") + " " + str(x["host"])
		if str(x["host"]) == selfHost() {
			name = selfMark(str(x["host"]))
		}
		role := c("dim")("-")
		if rs := rolesOf(x, model); len(rs) > 0 {
			role = c("accent")(strings.Join(rs, " + "))
		}
		dl := obj(x["download"])
		var state string
		switch {
		case truthy(x["ready"]):
			state = c("online")("loaded")
		case dl != nil && truthy(dl["total"]):
			state = c("sand")(fmt.Sprintf("%d%%", int(math.Floor(100*num(dl["done"])/num(dl["total"])))))
		case truthy(x["loading"]):
			state = c("sand")("loading")
		default:
			state = c("warn")("down")
		}
		speed := c("dim")("-")
		if tps := get(x, "use", "tps"); truthy(x["ready"]) && truthy(tps) {
			speed = str(tps) + " tok/s"
		}
		file := c("dim")("no link")
		if f := str(x["file"]); f != "" {
			file = c("muted")(f)
		}
		rows = append(rows, []string{name, role, state, speed, file})
	}
	hostOn := cfg["host"] == "true"
	first := selfMark(selfHost()) + "  model host "
	if hostOn {
		slots := or(cfg["slots"], "4")
		first += c("online")("on") + "  " + c("muted")("gpu "+cfg["gpu"]+" · slots "+slots)
	} else {
		first += c("muted")("off")
	}
	here := []string{first}
	if hostOn {
		if cfg["url"] != "" {
			here = append(here, c("muted")(cfg["url"]))
		} else {
			here = append(here, c("warn")("no link yet, e to enter one"))
		}
	}
	if m != nil {
		if dl := obj(m["download"]); dl != nil && truthy(dl["total"]) {
			here = append(here, bar(num(dl["done"])/num(dl["total"]), "")+"  "+c("muted")(gb(num(dl["done"]))+" of "+gb(num(dl["total"]))))
		}
		if !truthy(m["ready"]) && str(m["why"]) != "" {
			here = append(here, c("warn")(str(m["why"])))
		}
	}
	var picked J
	if ui.sel[modelTab] < len(all) {
		picked = all[ui.sel[modelTab]]
	}
	rl := []string{}
	for _, r := range roles {
		x := obj(get(model, "roles", r))
		name := c("dim")("none")
		if s := str(x["model"]); s != "" {
			name = s
		}
		why := ""
		if !truthy(x["ready"]) && str(x["why"]) != "" {
			why = "  " + c("warn")(str(x["why"]))
		}
		rl = append(rl, c("accent")(fmt.Sprintf("%-10s", r))+name+why)
	}
	models := plainRows(c("muted")("no host runs a model"))
	if len(all) > 0 {
		models = table([]string{"host", "role", "state", "speed", "file"}, rows, ui.sel[modelTab], 0)
		if picked != nil && mi != ui.sel[modelTab] && !truthy(picked["ready"]) && str(picked["why"]) != "" {
			models = append(models, row{text: c("warn")(str(picked["why"]))})
		}
	}
	return view{lines: panels(&card{"roles", plainRows(rl...)}, &card{"this host", plainRows(here...)}, &card{"models", models}),
		keys: []key{k("e edit", "primary")}}
}

// the chain this host can see
func liveChain(st J) (J, bool) {
	if ch := obj(st["chain"]); ch != nil && !truthy(ch["done"]) {
		return ch, truthy(st["chainMine"])
	}
	return nil, false
}

// block cells in brackets, as the files transfer bar, narrower on a narrow terminal
func bar(frac float64, tok string) string {
	n := inner() - 40
	if n > 30 {
		n = 30
	}
	if n < 10 {
		n = 10
	}
	full := int(math.Round(frac * float64(n)))
	if full > n {
		full = n
	}
	if full < 0 {
		full = 0
	}
	p := c(or(tok, "accent"))
	return p("["+strings.Repeat("█", full)) + fg(off) + strings.Repeat("░", n-full) + p("]")
}

// a running host's stage, every peer updating at once, and how far along it is
var (
	stageLabel = map[string]string{"asked": "starting", "installing": "installing", "restarting": "restarting"}
	stageDone  = map[string]float64{"asked": 0.15, "installing": 0.45, "restarting": 0.8}
)

func stageOf(chain J, host string) string { return str(get(chain, "versions", host, "stage")) }

// the mesh's progress, each host weighed by its stage, so the bar moves as
// the hosts do, not in one jump per host
func progress(chain J) string {
	order := strs(chain["order"])
	res := obj(chain["results"])
	done, finished := 0.0, 0
	for _, m := range order {
		switch or(str(res[m]), "pending") {
		case "running":
			if d, ok := stageDone[stageOf(chain, m)]; ok {
				done += d
			} else {
				done += 0.05
			}
		case "pending":
		default:
			done++
			finished++
		}
	}
	return bar(done/float64(len(order)), "") + "  " + c("muted")(fmt.Sprintf("%d/%d hosts", finished, len(order)))
}

var stepLabel = map[string]string{
	"pending": "waiting", "running": "updating", "ok": "success", "current": "up to date",
	"fail": "failed", "unreachable": "unreachable", "skipped": "skipped",
}

func updateView() view {
	st := ui.state
	self := selfHost()
	chain, mine := liveChain(st)
	var last J
	if ch := obj(st["chain"]); ch != nil && truthy(ch["done"]) {
		last = ch
	}
	shown := chain
	if shown == nil {
		shown = last
	}
	title := "mesh update"
	switch {
	case chain == nil && last != nil:
		title = "mesh update finished"
	case chain != nil:
		title = "updating the mesh"
	}
	tail := objs(st["tailnet"])
	byName := map[string]J{}
	// one that answered before listed too, as not answering
	names := []string{}
	for _, d := range tail {
		byName[str(d["name"])] = d
		if truthy(d["phosphorus"]) || truthy(d["phosphorusSeen"]) {
			names = append(names, str(d["name"]))
		}
	}
	if indexOf(names, self) < 0 {
		names = append(names, self)
	}
	quiet := func(m string) bool {
		d := byName[m]
		return m != self && d != nil && truthy(d["phosphorusSeen"]) && !truthy(d["phosphorus"])
	}
	var order []string
	if shown != nil {
		order = strs(shown["order"])
		for _, n := range names {
			if indexOf(order, n) < 0 {
				order = append(order, n)
			}
		}
	} else {
		order = names
		sort.Strings(order)
	}
	selfVer := str(get(st, "self", "version"))
	rows := [][]string{}
	why := []string{}
	for _, m := range order {
		d := byName[m]
		isSelf := m == self
		version, osName := str(d["version"]), str(d["os"])
		if isSelf {
			version, osName = selfVer, str(get(st, "self", "platform"))
		}
		step := ""
		if shown != nil {
			step = str(get(shown, "results", m))
		}
		os := c("teal")(osName)
		paint := func(s string) string { return s }
		switch step {
		case "pending", "skipped":
			paint = c("muted")
		case "running":
			paint = c("accent")
		case "fail", "unreachable":
			paint = c("offmesh")
		}
		bare := m
		if step == "skipped" {
			bare = strike(m)
		}
		if step != "fail" && step != "unreachable" {
			bare = paint(bare)
		}
		name := bare
		if isSelf {
			name = c("accent")("■") + " " + bare
		}
		ver := "?"
		if version != "" {
			ver = "v" + version
		}
		verText := ver
		if step != "" {
			verText = c("muted")(ver)
		} else if shown == nil && version != selfVer {
			verText = c("warn")(ver)
		}
		label := or(stepLabel[step], step)
		if step == "running" && stageLabel[stageOf(shown, m)] != "" {
			label = stageLabel[stageOf(shown, m)]
		}
		if step == "fail" || step == "unreachable" {
			label = or(str(get(shown, "errors", m)), label)
			if d := str(get(shown, "details", m)); d != "" {
				why = append(why, c("sky")(m)+" "+c("muted")(d))
			}
		}
		if step == "" && quiet(m) {
			rows = append(rows, []string{name + " " + os, c("muted")(ver), c("offmesh")("not answering")})
			continue
		}
		state := paint(label)
		if step == "ok" || step == "current" {
			state = c("online")(label)
		}
		rows = append(rows, []string{name + " " + os, verText, state})
	}
	var prog *card
	if chain != nil {
		ls := []string{progress(chain)}
		if !mine {
			ls = append(ls, c("muted")("started by "+str(chain["initiator"])))
		}
		prog = &card{"progress", plainRows(ls...)}
	}
	keys := []key{k("enter update", "primary")}
	if chain != nil {
		keys = nil
		if mine {
			keys = []key{k("x cancel", "danger")}
		}
	}
	var failed *card
	if len(why) > 0 {
		failed = &card{"why", plainRows(why...)}
	}
	return view{lines: panels(prog, &card{title, table([]string{"host", "version", ""}, rows, -1, 0)}, failed), keys: keys, title: "mesh update"}
}

func offlineView() []string {
	return panels(&card{"offline", plainRows(
		c("offmesh")(fmt.Sprintf("the frontend is not answering on :%d", util.FrontendPort)), "",
		c("muted")("phosphorus is down or restarting, start it with"), "", "  "+c("accent")("phos start"), "",
		c("muted")("this screen clears on its own once it answers"),
	)})
}

// every service by name, the edited one on the accent, widened out from it
// until the screen is full, … marking what's cut
func serviceStrip(f *form) string {
	names := []string{}
	for _, s := range splitSections(readText(servicesFile)).secs {
		names = append(names, s.name)
	}
	cur := f.orig
	if f.isNew {
		names = append(names, "+ new")
		cur = "+ new"
	}
	at := indexOf(names, cur)
	if at < 0 {
		at = 0
	}
	if len(names) == 0 {
		return ""
	}
	room := inner() - 4
	cell := func(n string) int { return vlen(n) + 3 }
	lo, hi, used := at, at, cell(names[at])
	for grew := true; grew; {
		grew = false
		if hi+1 < len(names) && used+cell(names[hi+1]) <= room {
			hi++
			used += cell(names[hi])
			grew = true
		}
		if lo > 0 && used+cell(names[lo-1]) <= room {
			lo--
			used += cell(names[lo])
			grew = true
		}
	}
	cells := []string{}
	for i := lo; i <= hi; i++ {
		if i == at {
			cells = append(cells, bold(surface(pal["accent"], pal["bg"])(" "+names[i]+" ")))
		} else {
			cells = append(cells, c("muted")(" "+names[i]+" "))
		}
	}
	out := strings.Join(cells, " ")
	if lo > 0 {
		out = c("muted")("… ") + out
	}
	if hi < len(names)-1 {
		out += c("muted")(" …")
	}
	return out
}

// .update-pass: the value on the card surface, the accent marking focus
func formView(f *form) view {
	w, widest := 0, 0
	for _, x := range f.fields {
		if len(x.key) > w {
			w = len(x.key)
		}
		if vlen(x.value)+1 > widest {
			widest = vlen(x.value) + 1
		}
		if x.secret && widest < 24 {
			widest = 24
		}
	}
	hint := func(x *field) string {
		if x.choices != nil {
			return x.hint + "  space cycles"
		}
		return x.hint
	}
	// values clipped to leave the hints a column of 24 where there's room
	vw := inner() - 7 - w - 24
	if widest < vw {
		vw = widest
	}
	if vw < 12 {
		vw = 12
	}
	left := 7 + w + vw
	beside := inner()-left >= 36
	fields := []string{}
	for i, x := range f.fields {
		on := i == f.idx
		shown := x.value
		if x.secret {
			shown = strings.Repeat("•", min(len([]rune(x.value)), vw-2))
		}
		chars := []rune(shown)
		if len(chars) >= vw {
			if on {
				shown = "…" + string(chars[len(chars)-vw+2:])
			} else {
				shown = string(chars[:vw-1]) + "…"
			}
		}
		var value string
		if on {
			value = surface(pal["card"])(" " + pad(shown+caret()+bg(pal["card"]), vw) + " ")
		} else {
			if shown == "" {
				shown = c("dim")("-")
			}
			value = " " + pad(shown, vw) + " "
		}
		mark := " "
		if on {
			mark = c("accent")("›")
		}
		head := mark + " " + c("accent2")(pad(x.key, w)) + " " + value
		if !beside {
			fields = append(fields, head)
			for _, l := range wrap(c("muted")(hint(x)), inner()-4, 0) {
				fields = append(fields, "    "+l)
			}
			continue
		}
		hs := wrap(c("muted")(hint(x)), inner()-left, 0)
		fields = append(fields, head+"  "+hs[0])
		for _, l := range hs[1:] {
			fields = append(fields, strings.Repeat(" ", left)+l)
		}
	}
	notes := []string{}
	if f.kind == "share" {
		notes = append(notes, c("muted")(iniNote))
	}
	if f.kind == "model" {
		notes = append(notes, c("muted")(modelNote))
	}
	if f.kind == "keys" {
		notes = append(notes, c("muted")(keysNote))
		if f.first {
			notes = append(notes, c("muted")(joinNote))
		} else if !ui.keysOnly {
			notes = append(notes, c("muted")(keysNoteApply))
		}
	}
	if f.err != "" {
		notes = append(notes, c("offmesh")(f.err))
	}
	var strip, notesCard *card
	if f.kind == "service" {
		strip = &card{"services", plainRows(serviceStrip(f))}
	}
	if len(notes) > 0 {
		notesCard = &card{"notes", plainRows(notes...)}
	}
	return view{title: f.title, lines: panels(strip, &card{f.title, plainRows(fields...)}, notesCard),
		keys: []key{k("enter save", "primary"), k("esc cancel"), k("↑↓ field", "quiet"), kif(strip != nil, "←→ service", "quiet")}}
}

func currentView() view {
	if ui.form != nil && (ui.keysOnly || ui.offline) {
		return formView(ui.form)
	}
	if ui.offline || ui.state == nil {
		if ui.offline {
			return view{lines: offlineView()}
		}
		return view{lines: []string{c("muted")(" reaching the frontend...")}}
	}
	if ui.form != nil {
		return formView(ui.form)
	}
	return []func() view{statsView, servicesView, filesView, modelView, gitView, updateView}[ui.tab]()
}
