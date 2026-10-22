// Package model: the mesh's models, every host's claim, which is the chimp and
// which the orangutan, the calls made to them passed to the host running them
package model

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/mesh"
	"github.com/pmghartman/phosphorus/internal/sysfs"
	"github.com/pmghartman/phosphorus/internal/util"
)

var (
	selfHost   = os.Getenv("SELF_HOST")
	stateDir   = util.StateDir
	claimFile  = filepath.Join(stateDir, "model-claim.json")
	serverPort = util.EnvInt("MODEL_SERVER_PORT", 8791)
	nameRe     = regexp.MustCompile(`^[A-Za-z0-9-]{1,63}$`)
	contextRe  = regexp.MustCompile(`<context>\n[\s\S]*?\n</context>\n\n`)
	// Roles the roles a model is asked as
	Roles = []string{"chimp", "orangutan"}
)

const (
	claimMaxAge = 5 * time.Second
	askTimeout  = 5 * time.Minute
	gib         = 1 << 30
	sentinel    = "\u0000ask\u0000"
	// Mesh the prefix of a mesh host's own model, as phosphorus/<host>
	Mesh = "phosphorus"
)

func roleFile(r string) string { return "etc/model/roles/" + r + ".json" }

type profile struct {
	maxTokens int
	thinking  bool
	effort    string
	sampling  map[string]any
}

var profiles = map[string]profile{
	"chimp":     {4096, false, "low", map[string]any{"temperature": 0.7, "top_p": 0.8, "top_k": 20, "min_p": 0, "presence_penalty": 1.5}},
	"orangutan": {32768, true, "high", nil},
}

// --- claims ----------------------------------------------------------------

var (
	useMu sync.Mutex
	use   map[string]any
)

// State the daemon's own claim, the last ask's use carried along
func State() map[string]any {
	raw := util.ReadFresh(claimFile, claimMaxAge)
	if raw == nil {
		return nil
	}
	c := util.Obj(util.Decode(raw))
	if c == nil {
		return nil
	}
	useMu.Lock()
	defer useMu.Unlock()
	if use != nil && util.Truthy(c["runs"]) && c["serverSince"] == use["since"] {
		out := map[string]any{}
		for k, v := range c {
			out[k] = v
		}
		out["use"] = use
		return out
	}
	return c
}

func view() []map[string]any {
	out := []map[string]any{}
	all := []any{}
	if s := State(); s != nil {
		all = append(all, s)
	}
	all = append(all, mesh.PeerModel()...)
	for _, x := range all {
		m := util.Obj(x)
		h, _ := m["host"].(string)
		if m != nil && nameRe.MatchString(h) {
			out = append(out, m)
		}
	}
	return out
}

func runners(states []map[string]any) []map[string]any {
	out := []map[string]any{}
	for _, s := range states {
		if util.Truthy(s["runs"]) {
			out = append(out, s)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		return util.LocaleCompare(util.JSString(out[i]["host"]), util.JSString(out[j]["host"])) < 0
	})
	return out
}

func n(v any) float64 {
	switch x := v.(type) {
	case float64:
		if math.IsNaN(x) {
			return 0
		}
		return x
	case string:
		var f float64
		if _, err := fmt.Sscan(x, &f); err == nil {
			return f
		}
	case bool:
		if x {
			return 1
		}
	}
	return 0
}

// --- roles ------------------------------------------------------------------

func meshHost(m string) string {
	if h, ok := strings.CutPrefix(m, Mesh+"/"); ok && nameRe.MatchString(h) {
		return h
	}
	return ""
}

type role struct {
	Model string  `json:"model"`
	At    float64 `json:"at"`
}

func roles() map[string]role {
	out := map[string]role{}
	for _, r := range Roles {
		var c struct {
			Model *string `json:"model"`
		}
		m := ""
		// a provider's model chosen before, none here to ask now: the default
		if sysfs.ReadInto(roleFile(r), &c) && c.Model != nil && meshHost(*c.Model) != "" {
			m = *c.Model
		}
		out[r] = role{m, sysfs.Stamp(roleFile(r))}
	}
	return out
}

// Choose a model as a role, mesh-wide
func Choose(p map[string]any) (int, any) {
	r, _ := p["role"].(string)
	ok := false
	for _, x := range Roles {
		ok = ok || x == r
	}
	if !ok {
		return 400, map[string]any{"error": "role is " + strings.Join(Roles, " or ")}
	}
	m := strings.TrimSpace(util.Str(p["model"]))
	if m != "" && !strings.Contains(m, "/") {
		m = Mesh + "/" + m
	}
	if m != "" && meshHost(m) == "" {
		return 400, map[string]any{"error": "model is a mesh host running one, as " + Mesh + "/<host>, blank for the default"}
	}
	if h := meshHost(m); h != "" {
		found := false
		for _, s := range runners(view()) {
			found = found || s["host"] == h
		}
		if !found {
			return 409, map[string]any{"error": h + " runs no model"}
		}
	}
	sysfs.Write(roleFile(r), map[string]any{"model": m})
	return 200, roles()[r]
}

func pick(states []map[string]any, r string) map[string]any {
	all := runners(states)
	var want map[string]any
	for _, s := range all {
		if s["host"] == meshHost(roles()[r].Model) {
			want = s
			break
		}
	}
	if want != nil && want["server"] == "ready" {
		return want
	}
	up := []map[string]any{}
	for _, s := range all {
		if s["server"] == "ready" {
			up = append(up, s)
		}
	}
	sort.SliceStable(up, func(i, j int) bool { return n(up[i]["size"]) < n(up[j]["size"]) })
	if len(up) > 0 {
		if r == "chimp" {
			return up[0]
		}
		return up[len(up)-1]
	}
	if want != nil {
		return want
	}
	sorted := append([]map[string]any{}, all...)
	sort.SliceStable(sorted, func(i, j int) bool { return n(sorted[i]["size"]) < n(sorted[j]["size"]) })
	if len(sorted) > 0 {
		return sorted[0]
	}
	return nil
}

func resolve(states []map[string]any, r string) (string, map[string]any) {
	s := pick(states, r)
	if s == nil {
		return "", nil
	}
	return Mesh + "/" + util.JSString(s["host"]), s
}

var useKeys = []string{"system", "chat", "ask", "reply", "tps", "at"}

func useOf(s map[string]any) any {
	u := util.Obj(s["use"])
	if u == nil {
		return nil
	}
	out := map[string]any{}
	for _, k := range useKeys {
		out[k] = math.Max(0, n(u[k]))
	}
	return out
}

func row(s map[string]any, states []map[string]any) map[string]any {
	ready := s["server"] == "ready"
	var dl any
	if d := util.Obj(s["download"]); d != nil {
		dl = map[string]any{"done": n(d["done"]), "total": n(d["total"])}
	}
	why := ""
	var u any
	if !ready {
		why = excuse(states, s)
	} else {
		u = useOf(s)
	}
	return map[string]any{
		"host": s["host"], "file": util.Str(s["file"]), "size": n(s["size"]),
		"ctx": n(s["ctx"]), "slots": n(s["slots"]), "ready": ready, "loading": s["server"] == "loading",
		"gpu": util.Truthy(s["gpu"]), "vram": n(s["vram"]), "total": n(s["total"]), "machine": n(s["machine"]), "need": n(s["need"]),
		"why": why, "use": u, "download": dl, "tools": s["tools"],
	}
}

// Summary every model, each role's choice, what it answers with and why not
func Summary() map[string]any {
	states := view()
	models := []any{}
	for _, s := range runners(states) {
		models = append(models, row(s, states))
	}
	out := map[string]any{"roles": map[string]any{}, "models": models}
	rs := roles()
	for _, r := range Roles {
		m, s := resolve(states, r)
		ready := m != "" && (s == nil || s["server"] == "ready")
		host := ""
		if s != nil {
			host = util.JSString(s["host"])
		}
		why := ""
		if !ready {
			why = excuse(states, s)
		}
		out["roles"].(map[string]any)[r] = map[string]any{"chosen": rs[r].Model, "model": m, "host": host, "ready": ready, "why": why}
		out[r] = host
	}
	return out
}

func excuse(states []map[string]any, s map[string]any) string {
	if len(states) == 0 {
		return "not loaded: no host is running the model daemon"
	}
	if s == nil {
		return "not loaded: no host has host = true under [model] in its phosphorus.ini"
	}
	if why := util.Str(s["why"]); why != "" {
		return "not loaded: " + why
	}
	if util.Truthy(s["oom"]) && s["server"] != "ready" {
		return "out of vram, lower ctx or slots"
	}
	times := func(k int) string {
		if k == 1 {
			return "1 time"
		}
		return fmt.Sprintf("%d times", k)
	}
	crashed := ""
	if e := int(n(s["exits"])); e > 0 {
		crashed = fmt.Sprintf("llama-server has exited %s since it was last up (%s), the phosphorus log on %s says why", times(e), util.JSString(s["lastExit"]), util.JSString(s["host"]))
	}
	if crashed != "" && s["server"] != "loading" {
		return "not loaded: " + crashed
	}
	if s["server"] == "loading" {
		mins := 0
		if since := n(s["serverSince"]); since > 0 {
			mins = int(math.Floor((float64(util.Now()) - since) / 60000))
		}
		extra := ""
		if crashed != "" {
			extra = "; " + crashed
		}
		return fmt.Sprintf("still loading %s on %s, %dm in%s", util.JSString(s["file"]), util.JSString(s["host"]), mins, extra)
	}
	if d := util.Obj(s["download"]); d != nil {
		pct := ""
		if t := n(d["total"]); t > 0 {
			pct = fmt.Sprintf(" %d%%", int(math.Floor(100*n(d["done"])/t)))
		}
		return fmt.Sprintf("not loaded: %s is still downloading %s%s (%.1fGB so far)", util.JSString(s["host"]), util.JSString(s["file"]), pct, n(d["done"])/gib)
	}
	return "not loaded: starting llama-server on " + util.JSString(s["host"])
}

// --- asking ----------------------------------------------------------------

func local(method, p string, body any, timeout time.Duration) (util.Response, error) {
	return util.RequestJSON(util.Req{Host: "127.0.0.1", Port: serverPort, Method: method, Path: p, Body: body, Timeout: timeout})
}

func tokens(content string) float64 {
	r, err := local("POST", "/tokenize", map[string]any{"content": content}, 5*time.Second)
	if err != nil || r.Status != 200 {
		return 0
	}
	arr, ok := util.Obj(util.Decode(r.Body))["tokens"].([]any)
	if !ok {
		return 0
	}
	return float64(len(arr))
}

func textOf(c any) string {
	switch x := c.(type) {
	case string:
		return x
	case []any:
		var b strings.Builder
		for _, p := range x {
			if t, ok := util.Obj(p)["text"].(string); ok {
				b.WriteString(t)
			}
		}
		return b.String()
	}
	return ""
}

var (
	framedMu  sync.Mutex
	framedKey string
	framedN   float64
)

func frameTokens(systems []any, tools any) float64 {
	key := string(util.Marshal([]any{systems, orEmpty(tools)}))
	framedMu.Lock()
	if framedKey == key {
		defer framedMu.Unlock()
		return framedN
	}
	framedMu.Unlock()
	body := map[string]any{"messages": append(append([]any{}, systems...), map[string]any{"role": "user", "content": sentinel}), "add_generation_prompt": false}
	if arr, ok := tools.([]any); ok && len(arr) > 0 {
		body["tools"] = tools
	}
	r, err := local("POST", "/apply-template", body, 5*time.Second)
	at := -1
	prompt := ""
	if err == nil && r.Status == 200 {
		prompt, _ = util.Obj(util.Decode(r.Body))["prompt"].(string)
		at = strings.Index(prompt, sentinel)
	}
	var cnt float64
	if at > 0 {
		cnt = tokens(prompt[:at])
	} else {
		parts := []string{}
		for _, m := range systems {
			parts = append(parts, textOf(util.Obj(m)["content"]))
		}
		cnt = tokens(strings.Join(parts, "\n"))
	}
	framedMu.Lock()
	framedKey, framedN = key, cnt
	framedMu.Unlock()
	return cnt
}

func orEmpty(v any) any {
	if v == nil {
		return []any{}
	}
	return v
}

func measure(messages []any, tools any, usage map[string]any, genMS float64) {
	prompt := n(usage["prompt_tokens"])
	claim := State()
	if prompt == 0 || claim == nil {
		return
	}
	reply := n(usage["completion_tokens"])
	first := len(messages)
	for i, m := range messages {
		if util.Obj(m)["role"] != "system" {
			first = i
			break
		}
	}
	systems := messages[:first]
	text := ""
	for i := len(messages) - 1; i >= 0; i-- {
		m := util.Obj(messages[i])
		if m["role"] == "user" && contextRe.MatchString(textOf(m["content"])) {
			text = textOf(m["content"])
			break
		}
	}
	loc := contextRe.FindStringIndex(text)
	var frame, note, said float64
	if len(systems) > 0 {
		frame = frameTokens(systems, tools)
	}
	if loc != nil {
		note = tokens(text[loc[0]:loc[1]])
		said = tokens(text[loc[1]:])
	}
	system := math.Min(prompt, frame+note)
	ask := math.Min(prompt-system, said)
	useMu.Lock()
	defer useMu.Unlock()
	tps := 0.0
	if genMS > 0 && reply > 1 {
		tps = math.Round((reply - 1) * 1000 / genMS)
	} else if use != nil {
		tps = n(use["tps"])
	}
	use = map[string]any{"since": orZero(claim["serverSince"]), "at": util.Now(), "system": system, "ask": ask,
		"chat": math.Max(0, prompt-system-ask), "reply": reply, "tps": tps}
}

func orZero(v any) any {
	if !util.Truthy(v) {
		return 0
	}
	return v
}

func profiled(p map[string]any, r string) map[string]any {
	f, ok := profiles[r]
	if !ok {
		return p
	}
	out := map[string]any{}
	for k, v := range p {
		out[k] = v
	}
	for k, v := range f.sampling {
		out[k] = v
	}
	mt := n(p["max_tokens"])
	if mt == 0 || mt > float64(f.maxTokens) {
		mt = float64(f.maxTokens)
	}
	out["max_tokens"] = mt
	kw := map[string]any{}
	for k, v := range util.Obj(p["chat_template_kwargs"]) {
		kw[k] = v
	}
	kw["enable_thinking"] = f.thinking
	kw["reasoning_effort"] = f.effort
	out["chat_template_kwargs"] = kw
	return out
}

func completion(p map[string]any) map[string]any {
	if !util.Truthy(p["stream"]) {
		return p
	}
	out := map[string]any{}
	for k, v := range p {
		out[k] = v
	}
	so := map[string]any{}
	for k, v := range util.Obj(p["stream_options"]) {
		so[k] = v
	}
	so["include_usage"] = true
	out["stream_options"] = so
	return out
}

type fwdOut struct {
	ok    bool
	usage map[string]any
	genMS float64
}

func forward(r *http.Request, host string, port int, p string, body any, who string, w http.ResponseWriter) fwdOut {
	data := util.Marshal(body)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", fmt.Sprintf("http://%s:%d%s", host, port, p), bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	c := &http.Client{Transport: &http.Transport{Proxy: nil, ResponseHeaderTimeout: askTimeout}}
	res, err := c.Do(req)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(502)
		w.Write(util.Marshal(map[string]any{"error": map[string]any{"message": fmt.Sprintf("%s didn't answer: %v", who, err)}}))
		return fwdOut{}
	}
	defer res.Body.Close()
	ct := res.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/json"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(res.StatusCode)
	fl, _ := w.(http.Flusher)
	sse := strings.Contains(ct, "event-stream")
	var buf bytes.Buffer
	var usage map[string]any
	var first time.Time
	rd := bufio.NewReader(res.Body)
	chunk := make([]byte, 32*1024)
	idle := time.AfterFunc(askTimeout, cancel)
	for {
		k, err := rd.Read(chunk)
		if k > 0 {
			idle.Reset(askTimeout)
			if first.IsZero() {
				first = time.Now()
			}
			w.Write(chunk[:k])
			if fl != nil {
				fl.Flush()
			}
			buf.Write(chunk[:k])
			if sse {
				for {
					i := bytes.IndexByte(buf.Bytes(), '\n')
					if i < 0 {
						break
					}
					line := string(buf.Next(i + 1))
					line = strings.TrimSuffix(line, "\n")
					if strings.HasPrefix(line, "data: ") {
						d := strings.TrimSpace(line[6:])
						if d != "" && d != "[DONE]" {
							if u := util.Obj(util.Obj(util.Decode([]byte(d)))["usage"]); u != nil {
								usage = u
							}
						}
					}
				}
			}
		}
		if err != nil {
			break
		}
	}
	idle.Stop()
	if !sse {
		usage = util.Obj(util.Obj(util.Decode(buf.Bytes()))["usage"])
	}
	g := 0.0
	if sse && !first.IsZero() {
		g = float64(time.Since(first).Milliseconds())
	}
	return fwdOut{res.StatusCode == 200, usage, g}
}

// ServeChat a call to a mesh model, answered here or passed on
func ServeChat(r *http.Request, p map[string]any, w http.ResponseWriter, isLocal bool) {
	fail := func(status int, msg string) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		w.Write(util.Marshal(map[string]any{"error": map[string]any{"message": msg}}))
	}
	msgs, ok := p["messages"].([]any)
	if p == nil || !ok {
		fail(400, "bad messages")
		return
	}
	host := util.Str(p["model"])
	states := view()
	var s map[string]any
	for _, x := range runners(states) {
		if x["host"] == host {
			s = x
		}
	}
	if s == nil || s["server"] != "ready" {
		fail(503, excuse(states, s))
		return
	}
	if host != selfHost {
		if !isLocal {
			fail(409, host+" isn't this host")
			return
		}
		forward(r, util.JSString(s["ip"]), util.FrontendPort, "/api/model/v1/chat/completions", p, host, w)
		return
	}
	out := forward(r, "127.0.0.1", serverPort, "/v1/chat/completions", completion(p), "llama-server on "+host, w)
	if out.ok {
		go func() {
			defer func() { recover() }()
			measure(msgs, p["tools"], out.usage, out.genMS)
		}()
	}
}

// Purge the role's idle slots erased, asked of the host running it
func Purge(r string) (any, error) {
	if r != "orangutan" {
		r = "chimp"
	}
	_, s := resolve(view(), r)
	if s == nil {
		return nil, fmt.Errorf("the %s isn't a mesh model, nothing here to purge", r)
	}
	if s["server"] != "ready" {
		return nil, fmt.Errorf("no %s loaded", r)
	}
	if s["host"] == selfHost {
		return EraseSlots()
	}
	res, err := util.RequestJSON(util.Req{Host: util.JSString(s["ip"]), Port: util.FrontendPort, Method: "POST", Path: "/api/model/purge", Timeout: 10 * time.Second})
	if err != nil {
		return nil, err
	}
	b := util.Decode(res.Body)
	if res.Status != 200 || b == nil {
		e := util.Str(util.Obj(b)["error"])
		if e == "" {
			e = util.JSString(s["host"]) + " would not purge"
		}
		return nil, errors.New(e)
	}
	return b, nil
}

// EraseSlots the slots not mid-answer erased here
func EraseSlots() (any, error) {
	r, err := local("GET", "/slots", nil, 5*time.Second)
	slots, ok := util.Decode(r.Body).([]any)
	if err != nil || r.Status != 200 || !ok {
		return nil, errors.New("llama-server would not list its slots")
	}
	idle := []map[string]any{}
	for _, x := range slots {
		if m := util.Obj(x); !util.Truthy(m["is_processing"]) {
			idle = append(idle, m)
		}
	}
	erased := 0
	var wg sync.WaitGroup
	var emu sync.Mutex
	for _, x := range idle {
		wg.Add(1)
		go func(id any) {
			defer wg.Done()
			res, err := local("POST", fmt.Sprintf("/slots/%s?action=erase", util.JSString(id)), map[string]any{}, 5*time.Second)
			if err == nil && res.Status == 200 {
				emu.Lock()
				erased++
				emu.Unlock()
			}
		}(x["id"])
	}
	wg.Wait()
	if len(idle) == len(slots) {
		useMu.Lock()
		use = nil
		useMu.Unlock()
	}
	return map[string]any{"host": selfHost, "erased": erased, "busy": len(slots) - len(idle)}, nil
}
