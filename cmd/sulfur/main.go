// sulfur: Sulfur's own server on this computer, started by its desktop app.
// It serves this computer's files, terminals, builds and compilers at all times.
// A remembered mesh is reachable beside them under /api/mesh/, for its machines,
// agents, models and Forgejo. Only on 127.0.0.1, and only to its own page: every request's
// Host and Origin held to it, so no other site in a browser reaches it.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/code"
	"github.com/pmghartman/phosphorus/internal/collab"
	"github.com/pmghartman/phosphorus/internal/files"
	"github.com/pmghartman/phosphorus/internal/sulfur"
	"github.com/pmghartman/phosphorus/internal/util"
	"github.com/pmghartman/phosphorus/internal/web"
	"github.com/pmghartman/phosphorus/internal/wsock"
)

// version set by the build
var version = "dev"

var (
	headless = flag.Bool("headless", false, "serve only, with no window; for a browser or a test")
	addr     = flag.String("addr", "127.0.0.1:47615", "where to listen; loopback only")
	cfgAt    = flag.String("config", "", "the app's settings file; the user's config folder's Sulfur/sulfur.json if empty")
	origin   string
	me       local
)

// local this computer as Sulfur sees it: one host, its user's home and its drives
type local struct {
	User   string         `json:"user"`
	Host   string         `json:"host"`
	OS     string         `json:"platform"`
	Shell  string         `json:"shell"`
	Shares []files.Share  `json:"-"`
	Info   map[string]any `json:"-"`
}

func main() {
	trace("launched")
	flag.Parse()
	log.SetFlags(0)
	log.SetPrefix("[sulfur] ")
	host, port, err := net.SplitHostPort(*addr)
	if err != nil || (host != "127.0.0.1" && host != "localhost" && host != "::1") {
		log.Fatal("-addr must be a loopback address and port")
	}
	origin = "http://" + net.JoinHostPort(host, port)
	me = whoAmI()
	trace("this computer read")
	// one user's own machine: a big project's whole tree, for quick open
	files.TreeMax = 60000
	loadConfig()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/sidecar/", sidecar)
	mux.HandleFunc("/api/", api)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.Redirect(w, r, "/sulfur/", http.StatusFound)
			return
		}
		web.ServeStatic(w, r)
	})
	srv := &http.Server{Addr: *addr, Handler: guard(mux), ReadHeaderTimeout: 10 * time.Second}
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		// another Sulfur already serving this computer: this window opens on it
		if c, e := net.DialTimeout("tcp", *addr, 250*time.Millisecond); e == nil && !*headless {
			c.Close()
			window()
			return
		}
		log.Fatal(err)
	}
	trace("listening")
	log.Printf("Sulfur %s on %s, %s", version, origin, me.Host)
	if *headless {
		log.Fatal(srv.Serve(ln))
	}
	go func() { log.Fatal(srv.Serve(ln)) }()
	window()
}

// window Sulfur's own, until it's closed
func window() {
	if err := runWindow(origin + "/sulfur/"); err != nil {
		showError(err.Error())
		log.Fatal(err)
	}
}

// guard every request to this server's own name, every write and socket to its own page
func guard(next http.Handler) http.Handler {
	self := strings.TrimPrefix(origin, "http://")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != self {
			http.Error(w, "not this server", http.StatusMisdirectedRequest)
			return
		}
		o := r.Header.Get("Origin")
		upgrade := strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
		if (upgrade || (r.Method != "GET" && r.Method != "HEAD")) && o != origin {
			http.Error(w, "not from Sulfur's page", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// --- this computer ---------------------------------------------------------------

var hostRe = regexp.MustCompile(`[^a-z0-9-]+`)

func whoAmI() local {
	home, err := os.UserHomeDir()
	if err != nil {
		log.Fatal("no home folder: ", err)
	}
	name, _ := os.Hostname()
	host := strings.Trim(hostRe.ReplaceAllString(strings.ToLower(strings.Split(name, ".")[0]), "-"), "-")
	if host == "" {
		host = "this-computer"
	}
	l := local{User: filepath.Base(home), Host: host, OS: runtime.GOOS, Shell: "sh"}
	if runtime.GOOS == "windows" {
		l.Shell = "powershell"
	}
	// the home share the folder holding the user's home, so its top is the
	// user's own as on a mesh; every drive, or the root, a share beside it
	files.HomeRoot = filepath.Dir(home)
	os.Setenv("PHOSPHORUS_FILES_DIRS", strings.Join(drives(), ","))
	l.Shares = files.Shares()
	shares := []map[string]any{}
	for _, s := range l.Shares {
		x := map[string]any{"id": s.ID, "label": s.Label, "perms": s.Perms}
		if s.Home {
			x["home"] = true
		}
		shares = append(shares, x)
	}
	l.Info = map[string]any{"platform": runtime.GOOS, "shell": l.Shell, "files": map[string]any{"shares": shares}}
	return l
}

// --- the app's own settings: offline or which server ------------------------------

type config struct {
	Mode    string   `json:"mode"`
	Server  string   `json:"server"`
	Servers []string `json:"servers"`
}

var (
	cfgMu sync.Mutex
	cfg   config
	// the remembered mesh's proxy under /api/mesh/: its machines, agents and
	// Forgejo beside this computer's own, never instead of them
	link *httputil.ReverseProxy
)

func configPath() string {
	if *cfgAt != "" {
		return *cfgAt
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "Sulfur", "sulfur.json")
}

func loadConfig() {
	b, err := os.ReadFile(configPath())
	if err == nil {
		json.Unmarshal(b, &cfg)
	}
	// one mode: this computer always, a mesh beside it (an older "mesh" pick so too)
	cfg.Mode = "local"
	if cfg.Server != "" {
		link = meshProxy(cfg.Server, "/api/mesh")
	}
}

func saveConfig() error {
	p := configPath()
	os.MkdirAll(filepath.Dir(p), 0o755)
	return os.WriteFile(p, util.Marshal(cfg), 0o600)
}

func sidecar(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/api/sidecar/update":
		update(w, r)
	case r.URL.Path == "/api/sidecar/info" && r.Method == "GET":
		cfgMu.Lock()
		c := cfg
		cfgMu.Unlock()
		send(w, 200, map[string]any{"app": "sulfur", "version": version, "mode": c.Mode, "server": c.Server, "servers": c.Servers,
			"user": me.User, "host": me.Host, "platform": me.OS, "shell": me.Shell, "info": me.Info})
	case r.URL.Path == "/api/sidecar/mode" && r.Method == "POST":
		var p struct{ Mode, Server string }
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&p) != nil {
			send(w, 400, errB("bad request"))
			return
		}
		switch p.Mode {
		case "local", "":
			send(w, 200, map[string]any{"mode": "local"})
		case "mesh", "link":
			u, err := serverURL(p.Server)
			if err != nil {
				send(w, 400, errB(err.Error()))
				return
			}
			if err := reach(u); err != nil {
				send(w, 502, errB(err.Error()))
				return
			}
			cfgMu.Lock()
			// the mesh remembered and reachable under /api/mesh/
			cfg.Server = u.String()
			list := []string{cfg.Server}
			for _, s := range cfg.Servers {
				if s != cfg.Server && len(list) < 8 {
					list = append(list, s)
				}
			}
			cfg.Servers = list
			link = meshProxy(cfg.Server, "/api/mesh")
			err = saveConfig()
			cfgMu.Unlock()
			if err != nil {
				send(w, 500, errB(err.Error()))
				return
			}
			send(w, 200, map[string]any{"mode": cfg.Mode, "server": u.String()})
		default:
			send(w, 400, errB("use link to connect a mesh"))
		}
	case r.URL.Path == "/api/sidecar/forget" && r.Method == "POST":
		var p struct{ Server string }
		json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&p)
		cfgMu.Lock()
		out := []string{}
		for _, s := range cfg.Servers {
			if s != p.Server {
				out = append(out, s)
			}
		}
		cfg.Servers = out
		if cfg.Server == p.Server {
			cfg.Server, link = "", nil
		}
		saveConfig()
		cfgMu.Unlock()
		send(w, 200, map[string]any{"servers": out})
	case r.URL.Path == "/api/sidecar/reveal" && r.Method == "POST":
		var p struct{ Path string }
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&p) != nil || !filepath.IsAbs(p.Path) {
			send(w, 400, errB("a full path"))
			return
		}
		if err := reveal(p.Path); err != nil {
			send(w, 500, errB(err.Error()))
			return
		}
		send(w, 200, map[string]any{"ok": true})
	default:
		send(w, 404, errB("no such call"))
	}
}

// serverURL what's typed as a server: a bare tailnet name or address taken as
// http, a bare domain (mulab.dev) as https, through the mesh's public side
func serverURL(s string) (*url.URL, error) {
	s = strings.TrimSpace(s)
	if !strings.Contains(s, "://") {
		host := s
		if h, _, err := net.SplitHostPort(s); err == nil {
			host = h
		}
		if strings.Contains(host, ".") && net.ParseIP(host) == nil && !strings.HasSuffix(strings.ToLower(host), ".ts.net") {
			s = "https://" + s
		} else {
			s = "http://" + s
		}
	}
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return nil, errors.New("that isn't a host name or address")
	}
	return &url.URL{Scheme: u.Scheme, Host: u.Host}, nil
}

// reach whether the server answers at all, said plainly when it doesn't
func reach(u *url.URL) error {
	port := u.Port()
	if port == "" {
		port = map[string]string{"http": "80", "https": "443"}[u.Scheme]
	}
	c, err := net.DialTimeout("tcp", net.JoinHostPort(u.Hostname(), port), 5*time.Second)
	if err != nil {
		if u.Scheme == "https" {
			return errors.New(u.Host + " didn't answer: is the address right, and this computer online?")
		}
		return errors.New(u.Host + " didn't answer: is this computer on your tailnet, and Phosphorus running there? Off the tailnet, use your mesh's own address, like https://mulab.dev")
	}
	c.Close()
	return nil
}

func reveal(p string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer.exe", "/select,"+p)
	case "darwin":
		cmd = exec.Command("open", "-R", p)
	default:
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			p = filepath.Dir(p)
		}
		cmd = exec.Command("xdg-open", p)
	}
	return cmd.Start()
}

// --- a mesh behind the page --------------------------------------------------------

// meshProxy the server's API as if it were this page's: its name and origin
// said for it, its cookies kept by this origin; strip a prefix it's under here
func meshProxy(server, strip string) *httputil.ReverseProxy {
	u, _ := url.Parse(server)
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			if strip != "" {
				pr.Out.URL.Path = strings.TrimPrefix(pr.Out.URL.Path, strip)
				pr.Out.URL.RawPath = ""
			}
			pr.SetURL(u)
			pr.Out.Host = u.Host
			if pr.In.Header.Get("Origin") != "" {
				pr.Out.Header.Set("Origin", server)
			}
			if ref := pr.In.Header.Get("Referer"); strings.HasPrefix(ref, origin) {
				pr.Out.Header.Set("Referer", server+strings.TrimPrefix(ref, origin))
			}
		},
		ModifyResponse: func(res *http.Response) error {
			if cs := res.Header.Values("Set-Cookie"); len(cs) > 0 {
				res.Header.Del("Set-Cookie")
				for _, c := range cs {
					res.Header.Add("Set-Cookie", localCookie(c))
				}
			}
			if loc := res.Header.Get("Location"); strings.HasPrefix(loc, server) {
				res.Header.Set("Location", strings.TrimPrefix(loc, server))
			}
			return nil
		},
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			send(w, 502, errB(u.Host+" didn't answer: "+err.Error()))
		},
	}
}

var cookieAttrRe = regexp.MustCompile(`(?i);\s*(secure|domain=[^;]*|partitioned)\s*`)

// localCookie a server's cookie as plain http on 127.0.0.1 keeps it
func localCookie(c string) string {
	c = cookieAttrRe.ReplaceAllString(c, "")
	return regexp.MustCompile(`(?i)samesite=none`).ReplaceAllString(c, "SameSite=Lax")
}

// --- the API: proxied for a mesh, answered here offline ----------------------------

var (
	filesRe = regexp.MustCompile(`^/api/files/([a-z0-9][a-z0-9-]*)/(info|list|tree|search|read|download|upload|save|mkdir|rename|delete)$`)
	codeRe  = regexp.MustCompile(`^/api/code/([a-z0-9][a-z0-9-]*)$`)
	termRe  = regexp.MustCompile(`^/api/term/([a-z0-9][a-z0-9-]*)$`)
)

func api(w http.ResponseWriter, r *http.Request) {
	cfgMu.Lock()
	l := link
	cfgMu.Unlock()
	if strings.HasPrefix(r.URL.Path, "/api/mesh/") {
		if l == nil {
			send(w, 404, errB("no mesh to reach: connect to one once"))
			return
		}
		l.ServeHTTP(w, r)
		return
	}
	// this computer itself, whichever the mode: a mesh's page reaches its files,
	// terminals and builds here, beside the mesh's machines
	if strings.HasPrefix(r.URL.Path, "/api/local/") {
		r2 := r.Clone(r.Context())
		r2.URL.Path, r2.URL.RawPath = strings.TrimPrefix(r.URL.Path, "/api/local"), ""
		localAPI(w, r2)
		return
	}
	localAPI(w, r)
}

// localAPI this computer's own answers: offline, and under /api/local/ always
func localAPI(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	q := r.URL.Query()
	switch {
	case path == "/api/me":
		send(w, 200, map[string]any{"user": me.User, "admin": true, "boot": false, "local": true})
	case path == "/api/md" && r.Method == "POST":
		markdown(w, r)
	case path == "/api/model/v1/models":
		send(w, 200, map[string]any{"data": []any{}})
	case path == "/api/sulfur/toolchains":
		t, err := sulfur.ProbeLocal(q.Get("fresh") != "")
		if err != nil {
			send(w, 502, errB(err.Error()))
			return
		}
		t.Host = me.Host
		send(w, 200, t)
	case path == "/api/sulfur/languages":
		if ws := accept(w, r); ws != nil {
			sulfur.LanguageSocket(ws, "", code.Creds{})
		}
	case path == "/api/sulfur/vsx/search" || path == "/api/sulfur/vsx/convert":
		sulfur.VSXServe(w, r)
	case path == "/api/sulfur/git" && r.Method == "POST":
		var p struct {
			Dir   string           `json:"dir"`
			Args  []string         `json:"args"`
			Creds *sulfur.GitCreds `json:"creds"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&p) != nil {
			send(w, 400, errB("bad request"))
			return
		}
		if !filepath.IsAbs(p.Dir) {
			send(w, 400, errB("a full path to the folder"))
			return
		}
		res, err := sulfur.GitLocal(p.Dir, p.Args, p.Creds)
		if err != nil {
			send(w, 502, map[string]any{"error": err.Error(), "out": res.Out, "err": res.Err})
			return
		}
		send(w, 200, res)
	case path == "/api/sulfur/run":
		if ws := accept(w, r); ws != nil {
			runTask(ws)
		}
	case filesRe.MatchString(path):
		m := filesRe.FindStringSubmatch(path)
		if m[1] != me.Host {
			send(w, 404, errB(m[1]+" isn't this computer: use the linked mesh API for its machines"))
			return
		}
		filesOp(w, r, m[2], q)
	case codeRe.MatchString(path):
		if ws := accept(w, r); ws != nil {
			collab.Attach(ws, q.Get("share"), q.Get("path"), &files.Who{User: me.User, Admin: true})
		}
	case termRe.MatchString(path):
		if ws := accept(w, r); ws != nil {
			terminal(ws, q.Get("sid"), atoi(q.Get("since")))
		}
	case strings.HasPrefix(path, "/api/code/"):
		send(w, 503, errB("The chat's agents work through a linked Phosphorus mesh"))
	default:
		send(w, 404, errB("This computer has no "+path))
	}
}

func accept(w http.ResponseWriter, r *http.Request) *wsock.Conn {
	ws, err := wsock.Accept(w, r)
	if err != nil {
		return nil
	}
	return ws
}

// --- files: the home and the drives, as a host's files API ------------------------

func filesOp(w http.ResponseWriter, r *http.Request, op string, q url.Values) {
	if op == "info" {
		send(w, 200, me.Info["files"])
		return
	}
	sh := files.ShareOf(q.Get("share"))
	if sh == nil {
		send(w, 404, errB("no such folder here"))
		return
	}
	rel := q.Get("path")
	who := &files.Who{User: me.User, Admin: true}
	if sh.Home && r.Method == "GET" {
		if why := files.HomeGate(who, rel, func(string) bool { return false }); why != "" {
			send(w, 403, errB(why))
			return
		}
	}
	switch {
	case r.Method == "GET" && op == "list":
		st, b := files.List(sh, rel)
		out(w)(files.Quiet(q, st, b))
	case r.Method == "GET" && op == "tree":
		out(w)(files.Tree(sh, rel, q.Get("depth"), q.Get("match"), q.Get("skip")))
	case r.Method == "GET" && op == "search":
		out(w)(files.Search(sh, rel, q.Get("query"), q.Get("content") == "true", q.Get("glob"), q.Get("skip")))
	case r.Method == "GET" && op == "read":
		st, b := files.Read(sh, rel)
		out(w)(files.Quiet(q, st, b))
	case r.Method == "GET" && op == "download":
		abs := files.DownloadPath(sh, rel)
		if abs == "" {
			send(w, 404, errB("no such file"))
			return
		}
		if _, inline := q["inline"]; !inline {
			w.Header().Set("Content-Disposition", `attachment; filename="`+strings.ReplaceAll(filepath.Base(abs), `"`, "")+`"`)
		}
		http.ServeFile(w, r, abs)
	case r.Method == "POST" && op == "upload":
		qv := func(k string) any {
			if v, ok := q[k]; ok {
				return v[0]
			}
			return nil
		}
		out(w)(files.Write(sh, rel, http.MaxBytesReader(w, r.Body, files.MaxUpload), files.UploadQ{ID: q.Get("id"), Offset: qv("offset"), Total: qv("total")}))
	case r.Method == "POST":
		var p map[string]any
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<20)).Decode(&p) != nil {
			send(w, 400, errB("invalid json"))
			return
		}
		str := func(k string) string { s, _ := p[k].(string); return s }
		switch op {
		case "save":
			by, _ := p["by"].(map[string]any)
			name, _ := by["name"].(string)
			out(w)(collab.Write(*sh, str("path"), collab.WriteP{Text: strPtr(p["text"]), Old: strPtr(p["old"]), New: strPtr(p["new"]), ByName: name}))
		case "mkdir":
			out(w)(files.Mkdir(sh, str("path")))
		case "rename":
			out(w)(files.Rename(sh, str("from"), str("to")))
		case "delete":
			out(w)(files.Remove(sh, str("path")))
		default:
			send(w, 405, errB("method not allowed"))
		}
	default:
		send(w, 405, errB("method not allowed"))
	}
}

func strPtr(v any) *string {
	s, ok := v.(string)
	if !ok {
		return nil
	}
	return &s
}

func markdown(w http.ResponseWriter, r *http.Request) {
	var p map[string]any
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&p) != nil {
		send(w, 400, errB("invalid json"))
		return
	}
	text, _ := p["text"].(string)
	if items, ok := p["items"].([]any); ok {
		out := make([]string, 0, len(items))
		for _, x := range items {
			it, _ := x.(map[string]any)
			t, _ := it["text"].(string)
			out = append(out, web.Markdown(t, it["breaks"] != false))
		}
		send(w, 200, map[string]any{"html": out})
		return
	}
	if lang, ok := p["highlight"].(string); ok {
		send(w, 200, map[string]any{"html": web.Highlight(text, lang)})
		return
	}
	if p["blocks"] == true {
		send(w, 200, map[string]any{"blocks": web.Blocks(text)})
		return
	}
	send(w, 200, map[string]any{"html": web.Markdown(text, p["breaks"] != false)})
}

func send(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	w.Write(util.Marshal(body))
}

// out a files call's status and body sent as they are
func out(w http.ResponseWriter) func(int, any) { return func(st int, b any) { send(w, st, b) } }

func errB(s string) map[string]any { return map[string]any{"error": s} }

func atoi(s string) int64 {
	var n int64
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int64(c-'0')
	}
	return n
}
