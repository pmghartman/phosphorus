// Package server: phosphorus in one process, the ingress, the mesh loop, the
// page, this host's state for peers, chat and terminal websockets
package server

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/pmghartman/phosphorus/internal/chatmedia"
	"github.com/pmghartman/phosphorus/internal/clock"
	"github.com/pmghartman/phosphorus/internal/collab"
	"github.com/pmghartman/phosphorus/internal/files"
	"github.com/pmghartman/phosphorus/internal/gamedns"
	"github.com/pmghartman/phosphorus/internal/git"
	"github.com/pmghartman/phosphorus/internal/harness"
	"github.com/pmghartman/phosphorus/internal/mcp"
	"github.com/pmghartman/phosphorus/internal/mesh"
	"github.com/pmghartman/phosphorus/internal/mirror"
	"github.com/pmghartman/phosphorus/internal/model"
	"github.com/pmghartman/phosphorus/internal/project"
	"github.com/pmghartman/phosphorus/internal/proxy"
	"github.com/pmghartman/phosphorus/internal/reconfig"
	"github.com/pmghartman/phosphorus/internal/services"
	"github.com/pmghartman/phosphorus/internal/stats"
	"github.com/pmghartman/phosphorus/internal/sysfs"
	"github.com/pmghartman/phosphorus/internal/term"
	"github.com/pmghartman/phosphorus/internal/update"
	"github.com/pmghartman/phosphorus/internal/users"
	"github.com/pmghartman/phosphorus/internal/util"
	"github.com/pmghartman/phosphorus/internal/web"
)

var (
	port        = util.EnvInt("FRONTEND_PORT", 8090)
	ingressPort = util.EnvInt("INGRESS_PORT", 80)
	stateDir    = util.Env("STATE_DIR", "/state")
	selfHost    = os.Getenv("SELF_HOST")
	baseDomain  = os.Getenv("BASE_DOMAIN")
	hostSSHHost = util.Env("HOST_SSH_HOST", "127.0.0.1")
	hostSSHPort = util.Env("HOST_SSH_PORT", "22")
	adminPass   = util.Env("ADMIN_PASS", os.Getenv("PHOSPHORUS_UPDATE_PASSWORD"))
	tsAPIKey    = os.Getenv("TS_API_KEY")

	updateResultFile = filepath.Join(stateDir, "update-result.json")
	platformFile     = filepath.Join(stateDir, "platform.json")
	gameKeyDir       = filepath.Join(stateDir, "game-control")
	bootID           = update.UUID()
	updating         atomic.Bool
	platformMu       sync.RWMutex
	platform         string
)

const (
	alertColor    = "#f85149"
	updateWarning = "phosphorus updating"
	gameKey       = "/root/.ssh/game-control"
	runMS         = 12 * 3600 * 1000
	runSandbox    = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads"
	maxTerms      = 16
)

// Version this binary's release, the image's VERSION
func Version() string {
	if v := update.ReadVersion(update.VersionFile); v != "" {
		return v
	}
	return "0.0.0"
}

func getPlatform() string {
	platformMu.RLock()
	defer platformMu.RUnlock()
	return platform
}

func selfInfo() map[string]any {
	return map[string]any{"host": selfHost, "version": Version(), "platform": getPlatform(), "bootId": bootID}
}

// --- host platform ---------------------------------------------------------

func dockerOut(args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", args...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func detectPlatform() string {
	src := dockerOut("inspect", "phosphorus", "--format", `{{range .Mounts}}{{if eq .Destination "/repo"}}{{.Source}}{{end}}{{end}}`)
	if regexp.MustCompile(`^[A-Za-z]:`).MatchString(src) || regexp.MustCompile(`^/run/desktop/mnt/host/[a-z]/`).MatchString(src) {
		return "windows"
	}
	if strings.HasPrefix(src, "/Users/") {
		return "macOS"
	}
	info := dockerOut("info", "--format", "{{.OperatingSystem}}\t{{.KernelVersion}}")
	if info == "" {
		return ""
	}
	parts := strings.SplitN(info, "\t", 2)
	if len(parts) == 2 && regexp.MustCompile(`(?i)WSL`).MatchString(parts[1]) {
		return "windows"
	}
	if regexp.MustCompile(`(?i)OrbStack|Docker Desktop`).MatchString(parts[0]) {
		return "macOS"
	}
	return "linux"
}

func recordPlatform() {
	found := detectPlatform()
	if found == "" {
		keep := ""
		if p := getPlatform(); p != "" {
			keep = " keeping " + p
		}
		log.Printf("[frontend] can't see the host's OS; is the docker socket mounted?%s", keep)
		return
	}
	platformMu.Lock()
	platform = found
	platformMu.Unlock()
	util.WriteJSONAtomic(platformFile, map[string]any{"platform": found})
	log.Printf("[frontend] running on %s", found)
}

// --- game servers ------------------------------------------------------------

var gameUserRe = regexp.MustCompile(`^[A-Za-z0-9._\\-]+$`)

func runGameLocally(name, action string) (int, any) {
	var game map[string]any
	for _, r := range services.Own() {
		if r["type"] == "game" && r["name"] == name {
			game = r
		}
	}
	if game == nil {
		return 404, map[string]any{"error": fmt.Sprintf("%s hosts no game called %s", selfHost, name)}
	}
	if game["controllable"] != true {
		return 409, map[string]any{"error": name + " has no start/stop commands in services.export"}
	}
	b, err := os.ReadFile(filepath.Join(gameKeyDir, "user"))
	user := strings.TrimSpace(string(b))
	if err == nil && (!gameUserRe.MatchString(user) || strings.HasPrefix(user, "-")) {
		err = fmt.Errorf("bad user")
	}
	if err == nil {
		os.MkdirAll(filepath.Dir(gameKey), 0o700)
		var key []byte
		if key, err = os.ReadFile(filepath.Join(gameKeyDir, "id_ed25519")); err == nil {
			err = os.WriteFile(gameKey, key, 0o600)
			os.Chmod(gameKey, 0o600)
		}
	}
	if err != nil {
		return 503, map[string]any{"error": fmt.Sprintf("play/stop isn't set up on %s; run phos game-control-setup there", selfHost)}
	}
	services.SetPending(name, action)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ssh", "-i", gameKey, "-p", hostSSHPort, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
		"-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
		"-o", "LogLevel=ERROR", user+"@"+hostSSHHost, action+" "+name)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		services.SetPending(name, "")
		why := strings.TrimSpace(stderr.String())
		if why == "" {
			why = err.Error()
		}
		if len(why) > 300 {
			why = why[len(why)-300:]
		}
		if why == "" {
			why = action + " failed"
		}
		log.Printf("[frontend] game %s: %s failed: %s", name, action, why)
		return 502, map[string]any{"error": why}
	}
	log.Printf("[frontend] game %s: %s ran", name, action)
	return 200, map[string]any{"ok": true}
}

func forwardGame(host, name, action string) (int, any) {
	ip := util.TailnetIP(host)
	if ip == "" {
		return 502, map[string]any{"error": "can't find " + host + " on the tailnet"}
	}
	return util.PeerCall(host, util.Req{Host: ip, Method: "POST", Path: fmt.Sprintf("/api/games/%s/%s/%s?hop=1", host, name, action),
		Timeout: 65 * time.Second, ConnectTimeout: 5 * time.Second})
}

// --- files -------------------------------------------------------------------

var mimeByExt = map[string]string{
	".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
	".log": "text/plain; charset=utf-8", ".json": "application/json",
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
	".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm",
}

var runMime = map[string]string{
	".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8", ".wasm": "application/wasm", ".data": "application/octet-stream",
	".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
	".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
}

func sendFile(w http.ResponseWriter, abs string, download bool, extra map[string]string) {
	name := filepath.Base(abs)
	ext := strings.ToLower(filepath.Ext(name))
	f, err := os.Open(abs)
	if err != nil {
		sendJSON(w, 404, map[string]any{"error": "no such file"})
		return
	}
	defer f.Close()
	var size int64
	if st, err := f.Stat(); err == nil {
		size = st.Size()
	}
	disp := "inline"
	if download {
		disp = "attachment"
	}
	h := w.Header()
	ct := mimeByExt[ext]
	if ct == "" {
		ct = "application/octet-stream"
	}
	h.Set("Content-Type", ct)
	h.Set("Content-Length", strconv.FormatInt(size, 10))
	h.Set("Content-Disposition", fmt.Sprintf("%s; filename*=UTF-8''%s", disp, chatmedia.EncodeURIComponent(name)))
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	if !download && ext == ".svg" {
		h.Set("Content-Security-Policy", "sandbox")
	}
	for k, v := range extra {
		h.Set(k, v)
	}
	w.WriteHeader(200)
	io.Copy(w, f)
}

func runKind(rel string, dir bool) string {
	switch {
	case dir:
		return "app"
	case regexp.MustCompile(`(?i)\.html?$`).MatchString(rel):
		return "html"
	case regexp.MustCompile(`(?i)\.wasm$`).MatchString(rel):
		return "wasm"
	}
	return ""
}

func homeWho(r *http.Request) *files.Who {
	s := users.Of(r)
	if s == nil {
		return nil
	}
	u := s.User
	if s.Boot {
		u = ""
	}
	return &files.Who{User: u, Admin: s.Admin}
}

func runGrant(sh *files.Share, rel string, who *files.Who) (int, any) {
	st := files.Stat(sh, rel)
	if st == nil {
		return 404, map[string]any{"error": "no such file"}
	}
	kind := runKind(rel, st.Dir)
	if kind == "" {
		return 400, map[string]any{"error": "not runnable: a page, a .wasm or a folder with an index.html"}
	}
	dir, entry := st.Rel, "index.html"
	if !st.Dir {
		dir = path.Dir(st.Rel)
		if dir == "." {
			dir = ""
		}
		entry = path.Base(st.Rel)
	}
	if st.Dir && files.Stat(sh, st.Rel+"/index.html") == nil {
		return 400, map[string]any{"error": "no index.html in that folder"}
	}
	u := ""
	if who != nil {
		u = who.User
	}
	token := users.SealGrant(map[string]any{"h": selfHost, "s": sh.ID, "d": dir, "u": u}, runMS)
	return 200, map[string]any{"kind": kind, "url": fmt.Sprintf("/api/run/%s/%s/%s", selfHost, token, chatmedia.EncodeURIComponent(entry))}
}

func serveRun(w http.ResponseWriter, r *http.Request, host, token, rest string, hop bool) {
	if host != selfHost {
		if hop {
			sendJSON(w, 421, map[string]any{"error": fmt.Sprintf("sent to %s, which isn't %s", selfHost, host)})
			return
		}
		forwardFiles(host, w, r, withHop(r.RequestURI))
		return
	}
	g := users.OpenGrant(token)
	var sh *files.Share
	if g != nil && g["h"] == selfHost {
		sh = files.ShareOf(str(g["s"]))
	}
	if sh == nil {
		sendJSON(w, 403, map[string]any{"error": "that run link expired"})
		return
	}
	parts := strings.Split(rest, "/")
	for i, p := range parts {
		d, err := urlUnescape(p)
		if err != nil {
			sendJSON(w, 400, map[string]any{"error": "bad path"})
			return
		}
		parts[i] = d
	}
	d := str(g["d"])
	rel := strings.TrimPrefix(path.Clean("/"+d+"/"+strings.Join(parts, "/")), "/")
	if d != "" && rel != d && !strings.HasPrefix(rel, d+"/") {
		sendJSON(w, 403, map[string]any{"error": "outside the app"})
		return
	}
	if sh.ID == "home" {
		var who *files.Who
		if u := str(g["u"]); u != "" && users.Exists(u) {
			who = &files.Who{User: u, Admin: users.IsAdmin(u)}
		}
		if why := files.HomeGate(who, rel, users.Exists); why != "" {
			sendJSON(w, 403, map[string]any{"error": why})
			return
		}
	}
	st := files.Stat(sh, rel)
	abs := ""
	if st != nil {
		p := st.Rel
		if st.Dir {
			p += "/index.html"
		}
		abs = files.DownloadPath(sh, p)
	}
	if abs == "" {
		sendJSON(w, 404, map[string]any{"error": "no such file"})
		return
	}
	extra := map[string]string{"Content-Security-Policy": runSandbox, "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin"}
	if t := runMime[strings.ToLower(filepath.Ext(abs))]; t != "" {
		extra["Content-Type"] = t
	}
	sendFile(w, abs, false, extra)
}

func withHop(u string) string {
	if strings.Contains(u, "?") {
		return u + "&hop=1"
	}
	return u + "?hop=1"
}

var hopTransport = &http.Transport{Proxy: nil, MaxIdleConnsPerHost: 16, IdleConnTimeout: 90 * time.Second}

// pingPeer the client's ping carried on to host over the tailnet
func pingPeer(ctx context.Context, host string) error {
	ip := util.TailnetIP(host)
	if ip == "" {
		return fmt.Errorf("can't find %s on the tailnet", host)
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("http://%s:%d/api/ping/%s?hop=1", ip, port, host), nil)
	if err != nil {
		return err
	}
	res, err := (&http.Client{Transport: hopTransport}).Do(req)
	if err != nil {
		return fmt.Errorf("%s didn't answer", host)
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	if res.StatusCode != 204 {
		return fmt.Errorf("%s answered %d", host, res.StatusCode)
	}
	return nil
}

// forwardFiles streams a request on to the host that owns the share
func forwardFiles(host string, w http.ResponseWriter, r *http.Request, urlPath string) {
	ip := util.TailnetIP(host)
	if ip == "" {
		sendJSON(w, 502, map[string]any{"error": "can't find " + host + " on the tailnet"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, r.Method, fmt.Sprintf("http://%s:%d%s", ip, port, urlPath), r.Body)
	if err != nil {
		sendJSON(w, 502, map[string]any{"error": err.Error()})
		return
	}
	for k, vs := range r.Header {
		lk := strings.ToLower(k)
		if lk == "accept-encoding" || lk == "connection" {
			continue
		}
		req.Header[k] = vs
	}
	req.ContentLength = r.ContentLength
	req.Host = fmt.Sprintf("%s:%d", ip, port)
	res, err := (&http.Client{Transport: hopTransport}).Do(req)
	if err != nil {
		sendJSON(w, 502, map[string]any{"error": fmt.Sprintf("%s didn't answer: %v", host, err)})
		return
	}
	defer res.Body.Close()
	for k, vs := range res.Header {
		w.Header()[k] = vs
	}
	w.WriteHeader(res.StatusCode)
	fl, _ := w.(http.Flusher)
	buf := make([]byte, 32*1024)
	for {
		n, err := res.Body.Read(buf)
		if n > 0 {
			w.Write(buf[:n])
			if fl != nil {
				fl.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}

func filesInfo() map[string]any {
	shares := []any{}
	for _, s := range files.Shares() {
		x := map[string]any{"id": s.ID, "label": s.Label, "perms": s.Perms}
		if s.Home {
			x["home"] = true
		}
		shares = append(shares, x)
	}
	want := ""
	if files.Pending() {
		want = strings.Join(files.ConfiguredDirs(), ", ")
	}
	return map[string]any{"host": selfHost, "enabled": len(shares) > 0, "shares": shares, "home": files.HomeDir(), "wantDir": want}
}

// --- etc/hosts/<host>/ ------------------------------------------------------

func hostRel(h, f string) string { return "etc/hosts/" + strings.ToLower(h) + "/" + f + ".json" }

func publishHost() {
	if selfHost == "" {
		return
	}
	put := func(f string, data any) {
		cur := string(util.Marshal(util.Decode(sysfs.Read(hostRel(selfHost, f)))))
		next := string(util.Marshal(util.Decode(util.Marshal(data))))
		if cur != next {
			sysfs.Write(hostRel(selfHost, f), data)
		}
	}
	put("services", services.Own())
	put("info", map[string]any{"version": Version(), "platform": getPlatform(), "files": filesInfo()})
}

func hostsInfo() map[string]any {
	out := map[string]any{}
	seen := map[string]bool{}
	for _, f := range sysfs.List("etc/hosts") {
		h := strings.SplitN(f, "/", 2)[0]
		if seen[h] {
			continue
		}
		seen[h] = true
		if v := sysfs.Read(hostRel(h, "info")); v != nil {
			out[h] = util.Decode(v)
		}
	}
	return out
}

func hostServices(h string) []map[string]any {
	arr, ok := util.Decode(sysfs.Read(hostRel(h, "services"))).([]any)
	if !ok {
		return nil
	}
	out := []map[string]any{}
	for _, x := range arr {
		out = append(out, util.Obj(x))
	}
	return out
}

// --- state ------------------------------------------------------------------

func gitRowsAny() []any {
	out := []any{}
	for _, r := range git.Rows() {
		out = append(out, map[string]any(r))
	}
	return out
}

func buildState() map[string]any {
	chain := update.ChainStatus()
	mine := chain != nil
	if chain == nil {
		chain = mesh.Chain()
	}
	return map[string]any{
		"domain": baseDomain, "gameZone": gamedns.Zone, "self": selfInfo(), "routes": mesh.Routes(), "tailnet": mesh.Tailnet(),
		"lock": update.MeshLock(), "gitHosts": gitRowsAny(), "model": model.Summary(), "chain": chain, "chainMine": mine, "hosts": hostsInfo(),
	}
}

var (
	stateFpMu   sync.Mutex
	lastStateFp string
)

func stateFp(s map[string]any) string {
	tn := []any{}
	for _, d := range s["tailnet"].([]map[string]any) {
		tn = append(tn, []any{d["name"], d["os"], d["phosphorus"], d["phosphorusSeen"], d["version"]})
	}
	m := s["model"].(map[string]any)
	return string(util.Marshal([]any{s["self"], s["routes"], s["lock"], s["chain"], tn, git.RowsFp(git.Rows()), m["roles"], m["keys"], s["hosts"]}))
}

func noteState(s map[string]any) string {
	fp := stateFp(s)
	stateFpMu.Lock()
	changed := fp != lastStateFp
	lastStateFp = fp
	stateFpMu.Unlock()
	if changed {
		clock.MarkHot()
	}
	return fp
}

func snapshot(q map[string][]string) map[string]any {
	chat := []Msg{}
	if since, ok := q["since"]; ok {
		s := files.JSNumber(since[0])
		if s != s {
			s = 0
		}
		cmu.Lock()
		for _, m := range ownChat {
			if num(m["seq"]) > s {
				chat = append(chat, m)
			}
		}
		cmu.Unlock()
	}
	return map[string]any{
		"self": selfInfo(), "presence": presence(), "lock": update.OwnLock(), "chain": update.SharedChain(),
		"git": git.State(), "model": nilIfEmpty(model.State()), "sysDigest": sysfs.Digest(), "projects": project.Summaries(), "chat": chat,
	}
}

func nilIfEmpty(m map[string]any) any {
	if m == nil {
		return nil
	}
	return m
}

// --- the update chain ------------------------------------------------------------

func chainAction(action, password string, admin bool) (int, any) {
	switch action {
	case "start":
		if !admin && (adminPass == "" || password != adminPass) {
			return 401, map[string]any{"error": "admins only, or the admin password"}
		}
		hosts := []string{}
		for _, h := range git.Rows() {
			hosts = append(hosts, str(h["host"]))
		}
		started := update.Start(hosts)
		if l, ok := started["locked"]; ok {
			return 409, map[string]any{"status": "locked", "by": l}
		}
		alert := postOwn(Msg{"kind": "alert", "name": "system", "color": alertColor, "text": updateWarning, "countdown": update.StartGraceMS / 1000})
		update.Remember(num(alert["seq"]))
		return 202, started
	case "cancel":
		if update.Cancel() {
			return 200, map[string]any{"status": "ok"}
		}
		return 409, map[string]any{"status": "ok"}
	case "continue":
		if update.Proceed() {
			return 200, map[string]any{"status": "ok"}
		}
		return 409, map[string]any{"status": "ok"}
	}
	return 400, map[string]any{"error": "action must be start, cancel or continue"}
}

// --- guest keys --------------------------------------------------------------

const tsTailnet = "https://api.tailscale.com/api/v2/tailnet/-"

var guestTagOwned atomic.Bool

func ownGuestTag() error {
	if guestTagOwned.Load() {
		return nil
	}
	c := &http.Client{Timeout: 10 * time.Second}
	req, _ := http.NewRequest("GET", tsTailnet+"/acl", nil)
	req.Header.Set("Authorization", "Bearer "+tsAPIKey)
	req.Header.Set("Accept", "application/hujson")
	got, err := c.Do(req)
	if err != nil {
		return err
	}
	body, _ := io.ReadAll(got.Body)
	got.Body.Close()
	if got.StatusCode < 200 || got.StatusCode >= 300 {
		return fmt.Errorf("tailscale said %d reading the policy", got.StatusCode)
	}
	lines := strings.Split(string(body), "\n")
	live := func(re *regexp.Regexp) int {
		for i, l := range lines {
			if re.MatchString(l) && !regexp.MustCompile(`^\s*//`).MatchString(l) {
				return i
			}
		}
		return -1
	}
	if live(regexp.MustCompile(`"tag:guest"\s*:`)) == -1 {
		if owners := live(regexp.MustCompile(`^\s*"tagOwners"\s*:\s*\{`)); owners != -1 {
			lines = append(lines[:owners+1], append([]string{"\t\t\"tag:guest\": [\"autogroup:admin\"],"}, lines[owners+1:]...)...)
		} else {
			at := live(regexp.MustCompile(`^\s*\{`)) + 1
			lines = append(lines[:at], append([]string{"\t\"tagOwners\": { \"tag:guest\": [\"autogroup:admin\"] },"}, lines[at:]...)...)
		}
		etag := got.Header.Get("Etag")
		if etag == "" {
			etag = "*"
		}
		req, _ := http.NewRequest("POST", tsTailnet+"/acl", strings.NewReader(strings.Join(lines, "\n")))
		req.Header.Set("Authorization", "Bearer "+tsAPIKey)
		req.Header.Set("Content-Type", "application/hujson")
		req.Header.Set("If-Match", etag)
		put, err := c.Do(req)
		if err != nil {
			return err
		}
		b, _ := io.ReadAll(put.Body)
		put.Body.Close()
		if put.StatusCode < 200 || put.StatusCode >= 300 {
			msg := str(util.Obj(util.Decode(b))["message"])
			if msg == "" {
				msg = "no reason given"
			}
			return fmt.Errorf("tailscale said %d adding tag:guest to the policy: %s", put.StatusCode, msg)
		}
		log.Print("[frontend] added tag:guest to the tailnet policy tagOwners")
	}
	guestTagOwned.Store(true)
	return nil
}

func mintGuestKey() (int, any) {
	if tsAPIKey == "" {
		return 503, map[string]any{"error": "TS_API_KEY unset in .env"}
	}
	if err := ownGuestTag(); err != nil {
		e := err.Error()
		if !strings.HasPrefix(e, "tailscale") {
			e = "couldn't reach tailscale: " + e
		}
		return 500, map[string]any{"error": e}
	}
	body := util.Marshal(map[string]any{
		"capabilities":  map[string]any{"devices": map[string]any{"create": map[string]any{"reusable": false, "ephemeral": true, "preauthorized": true, "tags": []string{"tag:guest"}}}},
		"expirySeconds": 3 * 24 * 3600, "description": "phosphorus guest",
	})
	req, _ := http.NewRequest("POST", tsTailnet+"/keys", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+tsAPIKey)
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return 500, map[string]any{"error": "couldn't reach tailscale: " + err.Error()}
	}
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	out := util.Obj(util.Decode(b))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		msg := str(out["message"])
		if msg == "" {
			msg = "no reason given"
		}
		return 500, map[string]any{"error": fmt.Sprintf("tailscale said %d: %s", res.StatusCode, msg)}
	}
	return 200, map[string]any{"key": out["key"], "expires": out["expires"]}
}

// --- startup -----------------------------------------------------------------

// Main the frontend until SIGTERM
func Main() int {
	var pf map[string]any
	if util.ReadJSON(platformFile, &pf) {
		platform = str(pf["platform"])
	}
	files.Init()
	files.OnChange = mirror.Touched
	users.Init()
	sysfs.PeerIPs = mesh.PeerIPs
	sysfs.Peers = func() []sysfs.PeerSys {
		out := []sysfs.PeerSys{}
		for _, p := range mesh.PeerSys() {
			out = append(out, sysfs.PeerSys{Host: p.Host, Digest: p.Digest})
		}
		return out
	}
	sysfs.Start()
	chatmedia.Init()
	git.Init(updating.Load, bootID)
	update.OnFinish(func(c *update.Chain) {
		if c.AlertSeq != nil {
			retractOwn(*c.AlertSeq)
		}
	})
	update.OnOutcome(func(o map[string]any) {
		o["at"] = util.Now()
		util.WriteJSONAtomic(updateResultFile, o)
		if o["state"] == "failed" {
			updating.Store(false)
		}
	})
	initChat()
	go func() {
		syncDate()
		for range time.Tick(time.Hour) {
			syncDate()
		}
	}()

	ln, err := net.Listen("tcp", ":"+strconv.Itoa(port))
	if err != nil {
		log.Printf("[frontend] can't listen on %d: %v", port, err)
		return 1
	}
	app := http.HandlerFunc(appHandler)
	srv := &http.Server{Handler: app, IdleTimeout: 120 * time.Second, ErrorLog: log.New(io.Discard, "", 0)}
	go srv.Serve(ln)
	h := selfHost
	if h == "" {
		h = "an unnamed host"
	}
	log.Printf("[frontend] listening on port %d as %s, version %s", port, h, Version())
	go recordPlatform()
	util.WriteJSONAtomic(updateResultFile, map[string]any{"state": "ok", "at": util.Now()})
	update.RestoreChain()
	mirror.Start(util.TailnetIP, port)
	retractStaleAlerts()
	harness.Reset()
	project.Init()
	proxy.Listen(ingressPort, app, proxy.Gate{Pass: users.Pass, Issuers: users.Issuers})
	stats.Hooks.Self = func() map[string]any {
		return map[string]any{"host": selfHost, "platform": getPlatform(), "version": Version()}
	}
	stats.Hooks.Peers = mesh.PeerIPs
	stats.Init()
	initMCP()
	mesh.Start(mesh.Hooks{
		MergeChat: mergeFromPeers, MergePresence: mergePeerPresence, Platform: getPlatform, OwnLock: update.OwnLock,
		HostServices: hostServices,
	})
	go func() {
		publishHost()
		for range time.Tick(2 * time.Second) {
			publishHost()
		}
	}()
	reconfig.Start(func() bool {
		return updating.Load() || util.ReadJSONMap(updateResultFile)["state"] == "running"
	})
	startPushes()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	<-sig
	harness.Stop()
	util.FlushWrites()
	return 0
}

func initMCP() {
	mcp.Init(mcp.Src{
		Self: selfInfo, Domain: func() string { return baseDomain }, Tailnet: mesh.Tailnet, Routes: mesh.Routes, PeerIPs: mesh.PeerIPs,
		GitHosts: func() any { return gitRowsAny() }, Model: model.Summary,
		Chat: func() []map[string]any {
			cmu.Lock()
			defer cmu.Unlock()
			return append([]Msg{}, mergedChat...)
		},
		People: allPresence, Lock: update.MeshLock,
		Chain: func() any {
			if c := update.ChainStatus(); c != nil {
				return c
			}
			return mesh.Chain()
		},
		Projects: func() any { return append(project.Summaries(), mesh.PeerProjects()...) },
		Asker:    mcpAsker,
		Actions: mcp.Actions{
			Game: func(host, name, action string) (int, any) {
				if host == selfHost {
					return runGameLocally(name, action)
				}
				return forwardGame(host, name, action)
			},
			GitMaster: func(host string) (int, any) { clock.MarkHot(); return git.MakeMaster(host) },
			ModelRole: func(role, m string) (int, any) {
				st, out := model.Choose(map[string]any{"role": role, "model": m})
				if st == 200 {
					clock.MarkHot()
				}
				return st, out
			},
			Update: func(action string) (int, any) {
				clock.MarkHot()
				st, body := chainAction(action, "", false)
				if st == 409 {
					return 409, map[string]any{"error": "no update started here to " + action}
				}
				return st, body
			},
			Files:      filesCall,
			ModelColor: modelColor,
		},
		Post: postAs, Show: showAs, Locate: files.Locate,
	})
}

// filesCall a files call, here or on its host
func filesCall(host, op, share string, body map[string]any) (int, any) {
	if host == selfHost {
		if op == "info" {
			return 200, filesInfo()
		}
		if !files.Enabled() {
			return 503, map[string]any{"error": selfHost + " publishes no files directory"}
		}
		sh := files.ShareOf(share)
		if sh == nil {
			return 404, map[string]any{"error": selfHost + " has no such share"}
		}
		if sh.ID == "home" {
			return 403, map[string]any{"error": "the homes are for their users only"}
		}
		p := str(body["path"])
		switch op {
		case "list":
			return files.List(sh, p)
		case "tree":
			return files.Tree(sh, p, body["depth"], str(body["match"]))
		case "read":
			return files.Read(sh, p)
		case "save":
			return collab.Write(*sh, p, writeP(body))
		case "mkdir":
			return files.Mkdir(sh, p)
		case "rename":
			return files.Rename(sh, str(body["from"]), str(body["to"]))
		case "delete":
			return files.Remove(sh, p)
		}
		return 400, map[string]any{"error": "no op " + op}
	}
	ip := util.TailnetIP(host)
	if ip == "" {
		return 502, map[string]any{"error": "can't find " + host + " on the tailnet"}
	}
	get := op == "info" || op == "list" || op == "tree" || op == "read"
	q := "share=" + chatmedia.EncodeURIComponent(share)
	params := ""
	if get {
		for _, k := range []string{"path", "depth", "match"} {
			if util.Truthy(body[k]) {
				params += "&" + k + "=" + chatmedia.EncodeURIComponent(util.JSString(body[k]))
			}
		}
	}
	method := "POST"
	var b any = body
	if get {
		method, b = "GET", nil
	}
	return util.PeerCall(host, util.Req{Host: ip, Method: method, Timeout: 15 * time.Second, ConnectTimeout: 5 * time.Second, Body: b,
		Path: fmt.Sprintf("/api/files/%s/%s?%s%s&hop=1", host, op, q, params)})
}

func strPtr(v any) *string {
	s, ok := v.(string)
	if !ok {
		return nil
	}
	return &s
}

func writeP(p map[string]any) collab.WriteP {
	by := util.Obj(p["by"])
	return collab.WriteP{Text: strPtr(p["text"]), Old: strPtr(p["old"]), New: strPtr(p["new"]), ByName: str(by["name"]), ByColor: str(by["color"])}
}

var _ = web.Markdown
var _ = term.SessionCount

// mcpAsker the person behind an ask: on this host, or on the peer that
// passed the ask here, reached back over its frontend
func mcpAsker(id string) *mcp.Asker {
	host, aid, remote := strings.Cut(id, "|")
	if !remote || host == selfHost {
		if remote {
			id = aid
		}
		c := askerFor(id)
		if c == nil {
			return nil
		}
		return &mcp.Asker{Name: c.name, UI: func(a map[string]any) bool { return uiFor(c, a) }, Creds: func(a, why string) any { return askCreds(c, a, why) }}
	}
	ip := util.TailnetIP(host)
	if ip == "" {
		return nil
	}
	ask := func(body map[string]any, wait time.Duration) map[string]any {
		body["id"] = aid
		res, err := util.RequestJSON(util.Req{Host: ip, Port: util.FrontendPort, Method: "POST", Path: "/api/model/asker", Body: body, Timeout: wait})
		if err != nil || res.Status != 200 {
			return nil
		}
		return util.Obj(util.Decode(res.Body))
	}
	who := ask(map[string]any{"op": "name"}, 5*time.Second)
	if who == nil {
		return nil
	}
	return &mcp.Asker{
		Name: util.Str(who["name"]),
		UI: func(a map[string]any) bool {
			return util.Truthy(ask(map[string]any{"op": "ui", "action": a}, 10*time.Second)["ok"])
		},
		Creds: func(a, why string) any {
			got := ask(map[string]any{"op": "creds", "action": a, "why": why}, credsWait+30*time.Second)
			if got == nil {
				return Msg{"done": false, "note": "their page is gone"}
			}
			return got["out"]
		},
	}
}
