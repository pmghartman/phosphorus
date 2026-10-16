// Package model: the mesh's models, every host's claim, which is the chimp and
// which the orangutan, opencode's calls passed to them
package model

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/pmghartman/phosphorus/internal/harness"
	"github.com/pmghartman/phosphorus/internal/mesh"
	"github.com/pmghartman/phosphorus/internal/sysfs"
	"github.com/pmghartman/phosphorus/internal/tools"
	"github.com/pmghartman/phosphorus/internal/util"
)

var (
	selfHost   = os.Getenv("SELF_HOST")
	stateDir   = util.Env("STATE_DIR", "/state")
	claimFile  = filepath.Join(stateDir, "model-claim.json")
	serverPort = util.EnvInt("MODEL_SERVER_PORT", 8791)
	nameRe     = regexp.MustCompile(`^[A-Za-z0-9-]{1,63}$`)
	providerRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	modelRe    = regexp.MustCompile(`(?i)^[a-z0-9][a-z0-9._-]{0,63}/[^\s/]\S{0,199}$`)
	contextRe  = regexp.MustCompile(`<context>\n[\s\S]*?\n</context>\n\n`)
	// Roles the roles a model is asked as
	Roles = []string{"chimp", "orangutan"}
)

const (
	claimMaxAge = 5 * time.Second
	defaultCtx  = 65536
	askTimeout  = 5 * time.Minute
	gib         = 1 << 30
	sentinel    = "\u0000ask\u0000"
)

func roleFile(r string) string { return "etc/model/roles/" + r + ".json" }
func keyFile(p string) string  { return "etc/model/keys/" + p + ".json" }

var identity = map[string]string{
	"chimp": "You are chimp, a chimpanzee: " + harness.Handle + "'s small, fast model, asked with /chimp. Your tools come first: " +
		"reach for them before answering from memory, several at once when that is quicker, and when asked to do " +
		"something, do it yourself with them (files, editors, terminals, views, games, models, messages). Then a short answer.",
	"orangutan": "You are orangutan, an orangutan: " + harness.Handle + "'s big model, kept for long projects alone in a sandbox, " +
		"days at a time, never for chat.",
}

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
	if strings.HasPrefix(m, harness.Mesh+"/") {
		return m[len(harness.Mesh)+1:]
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
		if sysfs.ReadInto(roleFile(r), &c) && c.Model != nil && (*c.Model == "" || modelRe.MatchString(*c.Model)) {
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
	if m != "" && !modelRe.MatchString(m) {
		return 400, map[string]any{"error": "model is provider/model, as anthropic/claude-sonnet-5-5"}
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
	own := roles()[r].Model
	if own != "" && meshHost(own) == "" {
		return own, nil
	}
	s := pick(states, r)
	if s == nil {
		return "", nil
	}
	return harness.Mesh + "/" + util.JSString(s["host"]), s
}

// --- api keys -----------------------------------------------------------------

func keyOf(p string) string {
	var k struct {
		Key string `json:"key"`
	}
	sysfs.ReadInto(keyFile(p), &k)
	return k.Key
}

func keyList() []string {
	out := []string{}
	for _, f := range sysfs.List("etc/model/keys") {
		p := strings.TrimSuffix(f, ".json")
		if providerRe.MatchString(p) && keyOf(p) != "" {
			out = append(out, p)
		}
	}
	sort.Strings(out)
	return out
}

func pullKeys() { sysfs.Pull() }

// SetKey a provider's key, ” clearing it
func SetKey(p map[string]any) (int, any) {
	provider := strings.ToLower(strings.TrimSpace(util.Str(p["provider"])))
	key := strings.TrimSpace(util.Str(p["key"]))
	if !providerRe.MatchString(provider) || provider == harness.Mesh {
		return 400, map[string]any{"error": "provider is its id as models.dev has it, as anthropic"}
	}
	if len(key) > 512 || strings.IndexFunc(key, unicode.IsSpace) >= 0 {
		return 400, map[string]any{"error": "bad key"}
	}
	sysfs.Write(keyFile(provider), map[string]any{"key": key})
	return 200, map[string]any{"provider": provider, "set": key != ""}
}

func setup(states []map[string]any) harness.Setup {
	s := harness.Setup{Mesh: []harness.MeshModel{}, Keys: map[string]string{}}
	for _, r := range runners(states) {
		ctx := int(n(r["ctx"]))
		if ctx == 0 {
			ctx = defaultCtx
		}
		s.Mesh = append(s.Mesh, harness.MeshModel{Host: util.JSString(r["host"]), Ctx: ctx})
	}
	for _, p := range keyList() {
		s.Keys[p] = keyOf(p)
	}
	return s
}

// Catalog every provider opencode knows, asked of the model host when
// opencode isn't here; hop: already passed on once
func Catalog(hop bool) (any, error) {
	if HarnessHere() || hop {
		return harness.Catalog(setup(view()))
	}
	h := HarnessHost("")
	if h == nil {
		return nil, noHarness()
	}
	res, err := util.RequestJSON(util.Req{Host: util.JSString(h["ip"]), Port: util.FrontendPort, Path: "/api/model/catalog?hop=1", Timeout: 40 * time.Second})
	if err != nil {
		return nil, fmt.Errorf("%s didn't answer: %v", util.JSString(h["host"]), err)
	}
	b := util.Decode(res.Body)
	if res.Status != 200 {
		e := util.Str(util.Obj(b)["error"])
		if e == "" {
			e = fmt.Sprintf("%s answered %d", util.JSString(h["host"]), res.Status)
		}
		return nil, errors.New(e)
	}
	return b, nil
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
		"why": why, "use": u, "download": dl, "harness": harnessReady(s), "tools": s["tools"],
	}
}

// Summary every model, each role's choice, what it answers with and why not
func Summary() map[string]any {
	states := view()
	models := []any{}
	for _, s := range runners(states) {
		models = append(models, row(s, states))
	}
	out := map[string]any{"handle": harness.Handle, "roles": map[string]any{}, "models": models, "keys": keyList()}
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

// WithContext the ask's date, mesh and open file ahead of its text
func WithContext(note, text string) string { return "<context>\n" + note + "\n</context>\n\n" + text }

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

// ServeChat opencode's calls to a mesh model, answered here or passed on
func ServeChat(r *http.Request, p map[string]any, w http.ResponseWriter, isLocal bool, ask string) {
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
	if isLocal && ask != "" {
		r := ""
		if a := harness.Context(ask, ""); a != nil {
			r = a.Role
		}
		p = profiled(p, r)
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

var emojiRe = regexp.MustCompile(`[\x{1F1E6}-\x{1F1FF}\x{1F3FB}-\x{1F3FF}\x{FE0F}\x{200D}\x{20E3}]`)

func extPict(r rune) bool {
	if r == 0xA9 || r == 0xAE || r == 0x2122 {
		return false
	}
	i := sort.Search(len(extPictRanges), func(i int) bool { return extPictRanges[i][1] >= r })
	return i < len(extPictRanges) && extPictRanges[i][0] <= r
}

// Plain no emoji ever reaching the chat
func Plain(t string) string {
	t = emojiRe.ReplaceAllString(t, "")
	return strings.Map(func(r rune) rune {
		if extPict(r) {
			return -1
		}
		return r
	}, t)
}

// Reply a role's answer
type Reply struct {
	Text string
	By   string
}

// Ask the role's model through opencode, emoji stripped, passed to a model
// host when opencode isn't here
func Ask(messages []harness.Msg, r, asker string, direct bool, ctx context.Context) (Reply, error) {
	if !HarnessHere() {
		return askRemote(messages, r, asker, direct, ctx)
	}
	return AskHere(messages, r, asker, direct, ctx)
}

// AskHere the ask answered by this host's own opencode
func AskHere(messages []harness.Msg, r, asker string, direct bool, ctx context.Context) (Reply, error) {
	if r != "chimp" {
		r = "chimp"
	}
	pullKeys()
	states := view()
	m, s := resolve(states, r)
	if m == "" || (s != nil && s["server"] != "ready") {
		return Reply{}, errors.New(excuse(states, s))
	}
	cast := append([]harness.Msg{{Role: messages[0].Role, Content: identity[r] + "\n\n" + messages[0].Content}}, messages[1:]...)
	text, err := harness.AskModel(cast, harness.AskOpts{Model: m, Role: r, Asker: asker, Direct: direct, Ctx: ctx, Setup: setup(states)})
	if err != nil {
		return Reply{}, err
	}
	return Reply{strings.TrimSpace(Plain(text)), r}, nil
}

// HarnessHere opencode fetched and runnable on this host
func HarnessHere() bool { return tools.OpencodeReady() }

// opencode ready on a model host's claim
func harnessReady(s map[string]any) bool { return util.Obj(s["tools"])["opencode"] == "ready" }

// HarnessHost the model host answering asks and running projects, the one
// running prefer's model first, nil when none has opencode up
func HarnessHost(prefer string) map[string]any {
	all := runners(view())
	for _, s := range all {
		if s["host"] == prefer && harnessReady(s) {
			return s
		}
	}
	for _, s := range all {
		if harnessReady(s) {
			return s
		}
	}
	return nil
}

// why no host can take an ask, for the asker
func noHarness() error {
	all := runners(view())
	if len(all) == 0 {
		return errors.New("no host is the model host, set [model] host = true on one")
	}
	return errors.New("the model host is still fetching opencode")
}

// AskerRef an asker on this host as a model host names it
func AskerRef(id string) string { return selfHost + "|" + id }

func askRemote(messages []harness.Msg, r, asker string, direct bool, ctx context.Context) (Reply, error) {
	_, rs := resolve(view(), r)
	prefer := ""
	if rs != nil {
		prefer = util.JSString(rs["host"])
	}
	h := HarnessHost(prefer)
	if h == nil {
		return Reply{}, noHarness()
	}
	if ctx == nil {
		ctx = context.Background()
	}
	res, err := util.RequestJSON(util.Req{
		Host: util.JSString(h["ip"]), Port: util.FrontendPort, Method: "POST", Path: "/api/model/ask", Ctx: ctx, Timeout: time.Hour,
		Body: map[string]any{"messages": messages, "role": r, "asker": AskerRef(asker), "direct": direct},
	})
	if ctx.Err() != nil {
		return Reply{}, errors.New("stopped")
	}
	if err != nil {
		return Reply{}, fmt.Errorf("%s didn't answer: %v", util.JSString(h["host"]), err)
	}
	b := util.Obj(util.Decode(res.Body))
	if res.Status != 200 {
		e := util.Str(b["error"])
		if e == "" {
			e = fmt.Sprintf("%s answered %d", util.JSString(h["host"]), res.Status)
		}
		return Reply{}, errors.New(e)
	}
	return Reply{util.Str(b["text"]), util.Str(b["by"])}, nil
}

// ProjectModel the orangutan's model for a round
type ProjectModel struct {
	Model    string
	Identity string
	Setup    harness.Setup
}

// ErrWaiting the model away, a project paused rather than failed
type ErrWaiting struct{ Msg string }

func (e ErrWaiting) Error() string { return e.Msg }

// ProjectHost the host running the orangutan's mesh model, blank for none
func ProjectHost() string {
	if _, s := resolve(view(), "orangutan"); s != nil {
		return util.JSString(s["host"])
	}
	return ""
}

// ForProject a mesh host chosen, or the one the project ran on, waited for
func ForProject(prefer string) (ProjectModel, error) {
	if !HarnessHere() {
		return ProjectModel{}, ErrWaiting{"projects run on the model host, " + selfHost + " isn't it"}
	}
	pullKeys()
	states := view()
	own := roles()["orangutan"].Model
	host := meshHost(own)
	if host == "" && own == "" {
		host = meshHost(prefer)
	}
	if host != "" {
		var s map[string]any
		for _, x := range runners(states) {
			if x["host"] == host {
				s = x
			}
		}
		if s == nil {
			return ProjectModel{}, ErrWaiting{host + " is offline"}
		}
		if s["server"] != "ready" {
			return ProjectModel{}, ErrWaiting{excuse(states, s)}
		}
		return ProjectModel{harness.Mesh + "/" + host, identity["orangutan"], setup(states)}, nil
	}
	m, s := resolve(states, "orangutan")
	if m == "" || (s != nil && s["server"] != "ready") {
		return ProjectModel{}, ErrWaiting{excuse(states, s)}
	}
	return ProjectModel{m, identity["orangutan"], setup(states)}, nil
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

var _ = io.Discard
var _ = json.Marshal
