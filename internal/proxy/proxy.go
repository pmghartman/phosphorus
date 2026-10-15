// Package proxy: the ingress cloudflared points at, every published service
// by path or subdomain, the frontend itself for everything else
package proxy

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pmghartman/phosphorus/internal/util"
)

var (
	baseDomain  = os.Getenv("BASE_DOMAIN")
	selfHost    = os.Getenv("SELF_HOST")
	ingressPort = util.EnvInt("INGRESS_PORT", 80)
	notes       = util.NewNotes("ingress")
)

// --- validation ------------------------------------------------------------

var (
	nameRe     = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
	baseRe     = regexp.MustCompile(`^[a-z0-9]([a-z0-9/_-]*[a-z0-9])?$`)
	sizeRe     = regexp.MustCompile(`^([0-9]+)(KB|MB|GB)?$`)
	intStrRe   = regexp.MustCompile(`^-?[0-9]+$`)
	unit       = map[string]float64{"": 1, "KB": 1e3, "MB": 1e6, "GB": 1e9}
	gameStatus = map[string]bool{"online": true, "offline": true, "starting": true, "stopping": true}
)

// ExtraKeys services.export `extras`, spread onto the published row
var ExtraKeys = []string{"flush_interval", "max_body", "forwarded_proto"}

func extraOK(k string, v any) bool {
	switch k {
	case "flush_interval":
		s := util.JSString(v)
		n := jsNumber(v)
		return n == float64(int64(n)) && intStrRe.MatchString(s)
	case "max_body":
		return sizeRe.MatchString(util.JSString(v))
	case "forwarded_proto":
		return v == "http" || v == "https"
	}
	return true
}

func jsNumber(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		if err != nil {
			if strings.TrimSpace(x) == "" {
				return 0
			}
			return 0.5
		}
		return f
	case bool:
		if x {
			return 1
		}
		return 0
	case nil:
		return 0
	}
	return 0.5
}

func validPort(p any) bool {
	f, ok := p.(float64)
	return ok && f == float64(int64(f)) && f >= 1 && f <= 65535
}

func tpl(v any, has bool) string {
	if !has {
		return "undefined"
	}
	return util.JSString(v)
}

// RowError why a published row can't be routed, "" when it can
func RowError(r map[string]any) string {
	if r == nil {
		return "not an object"
	}
	name, hasName := r["name"]
	if !hasName || !util.Truthy(name) || !nameRe.MatchString(util.JSString(name)) {
		return fmt.Sprintf("'%s' is not a valid name", tpl(name, hasName))
	}
	port, hasPort := r["port"]
	if !validPort(port) {
		return fmt.Sprintf("'%s' is not a valid port", tpl(port, hasPort))
	}
	typ, hasType := r["type"]
	if typ == "game" {
		st, has := r["status"]
		if !has {
			return ""
		}
		if s, ok := st.(string); ok && gameStatus[s] {
			return ""
		}
		return fmt.Sprintf("'%s' is not a game status", tpl(st, has))
	}
	if hasType && typ != "" {
		return fmt.Sprintf("'%s' is not a service type", tpl(typ, true))
	}
	if s, has := r["scheme"]; s != "http" && s != "https" {
		return fmt.Sprintf("'%s' is not http or https", tpl(s, has))
	}
	if m, has := r["mode"]; m != "path" && m != "subdomain" {
		return fmt.Sprintf("'%s' is not path or subdomain", tpl(m, has))
	}
	if bp, has := r["base_path"]; has && util.Truthy(bp) {
		s, ok := bp.(string)
		if !ok || strings.Contains(s, "..") || !baseRe.MatchString(s) {
			return fmt.Sprintf("'%s' is not a valid base_path", util.JSString(bp))
		}
	}
	for _, k := range ExtraKeys {
		if v, has := r[k]; has && !extraOK(k, v) {
			return fmt.Sprintf("'%s' is not a valid %s", util.JSString(v), k)
		}
	}
	return ""
}

// --- routing table ---------------------------------------------------------

// Route one served destination
type Route struct {
	Host    string  `json:"host"`
	Name    string  `json:"name"`
	Master  bool    `json:"master"`
	Git     bool    `json:"git"`
	Domain  string  `json:"domain"`
	Prefix  string  `json:"prefix"`
	Scheme  string  `json:"scheme"`
	IP      string  `json:"ip"`
	Port    int     `json:"port"`
	MaxBody float64 `json:"maxBody"`
	Proto   string  `json:"proto"`
	Pin     bool    `json:"-"`
}

type table struct {
	domains map[string]*Route
	paths   []*Route
}

var (
	tableV  atomic.Pointer[table]
	everyMu sync.RWMutex
	every   []*Route
	tableFp = "[]"
	swapMu  sync.Mutex
	pinIPs  atomic.Pointer[map[string]string]
)

func init() {
	tableV.Store(&table{domains: map[string]*Route{}})
	m := map[string]string{}
	pinIPs.Store(&m)
}

func toRoute(r map[string]any, ip string) *Route {
	bp, _ := r["base_path"].(string)
	base := ""
	if bp != "" {
		base = "/" + bp
	}
	sub := r["mode"] == "subdomain"
	host, _ := r["host"].(string)
	name := util.JSString(r["name"])
	rt := &Route{Host: host, Name: name, Scheme: util.JSString(r["scheme"]), IP: ip, Proto: "http"}
	rt.Port = int(r["port"].(float64))
	if m, ok := r["master"].(bool); ok {
		rt.Git = true
		rt.Master = m
	}
	if sub {
		rt.Domain = name + "." + baseDomain
		rt.Prefix = base
	} else {
		rt.Prefix = "/" + host + "/" + name + base
	}
	if mb, has := r["max_body"]; has && util.Truthy(mb) {
		if m := sizeRe.FindStringSubmatch(util.JSString(mb)); m != nil {
			n, _ := strconv.ParseFloat(m[1], 64)
			rt.MaxBody = n * unit[m[2]]
		}
	}
	if fp, ok := r["forwarded_proto"].(string); ok && fp != "" {
		rt.Proto = fp
	}
	return rt
}

// Swap validate then swap, the live table untouched on any failure
func Swap(rows []map[string]any, ipOf func(string) string) bool {
	swapMu.Lock()
	defer swapMu.Unlock()
	domains := map[string]*Route{}
	paths := []*Route{}
	all := []*Route{}
	for _, r := range rows {
		if r["type"] == "game" {
			continue
		}
		host, _ := r["host"].(string)
		why := ""
		if !nameRe.MatchString(host) {
			why = fmt.Sprintf("'%s' is not a valid host", util.JSString(r["host"]))
		} else {
			why = RowError(r)
		}
		if why != "" {
			notes.Note("table", fmt.Sprintf("routes rejected, still serving the previous ones: %s's %s: %s", util.JSString(r["host"]), util.JSString(r["name"]), why))
			return false
		}
		ip := ipOf(host)
		if ip == "" {
			ip = host
		}
		rt := toRoute(r, ip)
		all = append(all, rt)
		if rt.Domain == "" {
			paths = append(paths, rt)
			continue
		}
		if held := domains[rt.Domain]; held != nil && !(rt.Master && !held.Master) {
			notes.Note("dup:"+rt.Domain, fmt.Sprintf("%s is published by %s and %s; serving %s's", rt.Domain, held.Host, rt.Host, held.Host))
			continue
		}
		domains[rt.Domain] = rt
	}
	sort.SliceStable(paths, func(i, j int) bool { return len(paths[i].Prefix) > len(paths[j].Prefix) })
	notes.Clear("table")
	everyMu.Lock()
	every = all
	everyMu.Unlock()
	// JS's Map order: insertion, kept by the rows' own order
	served := []*Route{}
	seen := map[string]bool{}
	for _, rt := range all {
		if rt.Domain != "" && domains[rt.Domain] == rt && !seen[rt.Domain] {
			seen[rt.Domain] = true
			served = append(served, rt)
		}
	}
	served = append(served, paths...)
	fp := string(util.Marshal(served))
	if fp == tableFp {
		return false
	}
	tableV.Store(&table{domains: domains, paths: paths})
	tableFp = fp
	hosts := map[string]bool{}
	for _, r := range served {
		hosts[r.Host] = true
	}
	s := func(n int, w string) string {
		if n == 1 {
			return fmt.Sprintf("%d %s", n, w)
		}
		return fmt.Sprintf("%d %ss", n, w)
	}
	notes.Log(fmt.Sprintf("routes updated, now serving %s across %s", s(len(served), "service"), s(len(hosts), "host")))
	return true
}

// --- matching --------------------------------------------------------------

func under(p, prefix string) bool { return p == prefix || strings.HasPrefix(p, prefix+"/") }
func strip(p, prefix string) string {
	s := p[len(prefix):]
	if s == "" {
		return "/"
	}
	return s
}

// RemoteIP the socket's address, ::ffff: dropped
func RemoteIP(r *http.Request) string {
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		h = r.RemoteAddr
	}
	return strings.TrimPrefix(h, "::ffff:")
}

// IsLoopbackAddr 127.0.0.1 or ::1
func IsLoopbackAddr(a string) bool { return a == "127.0.0.1" || a == "::1" }

// IsTailnetAddr 100.64.0.0/10
func IsTailnetAddr(a string) bool {
	if !strings.HasPrefix(a, "100.") {
		return false
	}
	parts := strings.Split(a, ".")
	if len(parts) < 2 {
		return false
	}
	n, err := strconv.Atoi(parts[1])
	return err == nil && n >= 64 && n <= 127
}

func onMesh(r *http.Request) bool {
	a := RemoteIP(r)
	return IsLoopbackAddr(a) || IsTailnetAddr(a)
}

type hit struct {
	route    *Route
	path     string
	frontend bool
	status   int
	text     string
}

var portRe = regexp.MustCompile(`:\d+$`)

func reqHost(r *http.Request) string { return portRe.ReplaceAllString(strings.ToLower(r.Host), "") }

func resolve(r *http.Request) hit {
	host := reqHost(r)
	raw := r.RequestURI
	pathname, search := raw, ""
	if q := strings.Index(raw, "?"); q >= 0 {
		pathname, search = raw[:q], raw[q:]
	}
	t := tableV.Load()
	if host == baseDomain {
		for _, x := range t.paths {
			if under(pathname, x.Prefix) {
				return hit{route: x, path: strip(pathname, x.Prefix) + search}
			}
		}
		if pathname == "/api/update/local" {
			return hit{status: 404, text: "not found"}
		}
		if onMesh(r) {
			return hit{frontend: true}
		}
		return hit{status: 403, text: "forbidden"}
	}
	if x := t.domains[host]; x != nil {
		if x.Prefix == "" {
			return hit{route: x, path: raw}
		}
		if under(pathname, x.Prefix) {
			return hit{route: x, path: strip(pathname, x.Prefix) + search}
		}
		return hit{status: 404, text: "not found"}
	}
	if pathname == "/healthz" {
		return hit{status: 200, text: "ok"}
	}
	return hit{status: 404, text: "no route for this hostname"}
}

// --- proxying --------------------------------------------------------------

const (
	loginCookie = "phosphorus-user"
	pinCookie   = "phosphorus-host"
	pinHop      = "X-Forwarded-Phosphorus-Host"
)

var transports = map[string]*http.Transport{
	"http": {Proxy: nil, MaxIdleConnsPerHost: 32, IdleConnTimeout: 90 * time.Second, DialContext: (&net.Dialer{Timeout: 30 * time.Second}).DialContext},
	"https": {Proxy: nil, MaxIdleConnsPerHost: 32, IdleConnTimeout: 90 * time.Second,
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true}},
}

func pinHopped(r *http.Request) bool { return r.Header.Get(pinHop) != "" }

var pinRe = regexp.MustCompile(`(?:^|;\s*)phosphorus-host=([a-z0-9-]+)`)

func pinnedTo(r *http.Request) string {
	m := pinRe.FindStringSubmatch(strings.Join(r.Header.Values("Cookie"), "; "))
	if m == nil {
		return ""
	}
	return m[1]
}

func pinCookieFor(host string) string {
	return pinCookie + "=" + host + "; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly"
}

// PinTargets live phosphorus peers, name -> tailnet IP
func PinTargets(ips map[string]string) {
	m := map[string]string{}
	for k, v := range ips {
		m[k] = v
	}
	pinIPs.Store(&m)
}

func peerIngress(host string) *Route {
	ip := (*pinIPs.Load())[host]
	if ip == "" {
		return nil
	}
	return &Route{Pin: true, Host: host, Name: "frontend", Scheme: "http", IP: ip, Port: ingressPort, Proto: "https"}
}

func pinRoute(r *http.Request) *Route {
	if selfHost == "" || pinHopped(r) {
		return nil
	}
	h := pinnedTo(r)
	if h != "" && h != selfHost {
		return peerIngress(h)
	}
	return nil
}

func refuse(w http.ResponseWriter, status int, text string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	io.WriteString(w, text)
}

var frameAncRe = regexp.MustCompile(`(?i)^frame-ancestors(\s|$)`)

func frameable(csp string) string {
	kept := []string{}
	for _, d := range strings.Split(csp, ";") {
		d = strings.TrimSpace(d)
		if d != "" && !frameAncRe.MatchString(d) {
			kept = append(kept, d)
		}
	}
	return strings.Join(append(kept, "frame-ancestors 'self' https://"+baseDomain), "; ")
}

var errTooLarge = errors.New("request body too large")

type capped struct {
	rc   io.ReadCloser
	max  float64
	seen float64
}

func (c *capped) Read(p []byte) (int, error) {
	n, err := c.rc.Read(p)
	c.seen += float64(n)
	if c.seen > c.max {
		return n, errTooLarge
	}
	return n, err
}
func (c *capped) Close() error { return c.rc.Close() }

// IsUpgrade an Upgrade request, as Node's 'upgrade' event
func IsUpgrade(r *http.Request) bool {
	return r.Header.Get("Upgrade") != "" && headerHas(r.Header, "Connection", "upgrade")
}

func headerHas(h http.Header, k, token string) bool {
	for _, v := range h.Values(k) {
		for _, t := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(t), token) {
				return true
			}
		}
	}
	return false
}

func forward(rt *Route, w http.ResponseWriter, r *http.Request, p string) {
	upgrade := IsUpgrade(r)
	if !upgrade && rt.MaxBody > 0 {
		if cl, err := strconv.ParseFloat(r.Header.Get("Content-Length"), 64); err == nil && cl > rt.MaxBody {
			refuse(w, 413, "request body too large")
			return
		}
		if r.Body != nil {
			r.Body = &capped{rc: r.Body, max: rt.MaxBody}
		}
	}
	rp := &httputil.ReverseProxy{
		Transport:     transports[rt.Scheme],
		FlushInterval: -1,
		ErrorLog:      log.New(io.Discard, "", 0),
		Rewrite: func(pr *httputil.ProxyRequest) {
			out := pr.Out
			u := &url.URL{Scheme: rt.Scheme, Host: net.JoinHostPort(rt.IP, strconv.Itoa(rt.Port))}
			pathPart, q := p, ""
			if i := strings.Index(p, "?"); i >= 0 {
				pathPart, q = p[:i], p[i+1:]
			}
			if dec, err := url.PathUnescape(pathPart); err == nil {
				u.Path = dec
				u.RawPath = pathPart
			} else {
				u.Opaque = pathPart
			}
			u.RawQuery = q
			out.URL = u
			out.Host = r.Host
			for k := range out.Header {
				if strings.HasPrefix(strings.ToLower(k), "x-forwarded-") {
					out.Header.Del(k)
				}
			}
			if !rt.Pin {
				kept := []string{}
				for _, v := range r.Header.Values("Cookie") {
					for _, c := range regexp.MustCompile(`;\s*`).Split(v, -1) {
						if c != "" && !strings.HasPrefix(c, loginCookie+"=") {
							kept = append(kept, c)
						}
					}
				}
				out.Header.Del("Cookie")
				if len(kept) > 0 {
					out.Header.Set("Cookie", strings.Join(kept, "; "))
				}
			}
			out.Header.Set("X-Forwarded-For", RemoteIP(r))
			out.Header.Set("X-Forwarded-Proto", rt.Proto)
			out.Header.Set("X-Forwarded-Host", r.Host)
			if rt.Pin {
				out.Header.Set(pinHop, selfHost)
			}
			// Node's http never added one, so none
			if _, ok := out.Header["User-Agent"]; !ok {
				out.Header["User-Agent"] = nil
			}
		},
		ModifyResponse: func(res *http.Response) error {
			for k, vs := range res.Header {
				lk := strings.ToLower(k)
				if rt.Domain != "" && lk == "x-frame-options" {
					res.Header.Del(k)
					continue
				}
				if rt.Domain != "" && lk == "content-security-policy" {
					for i := range vs {
						vs[i] = frameable(vs[i])
					}
				}
				kept := vs[:0]
				for _, v := range vs {
					if v != "" {
						kept = append(kept, v)
					}
				}
				if len(kept) == 0 {
					res.Header.Del(k)
				}
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			if errors.Is(err, errTooLarge) {
				refuse(w, 413, "request body too large")
				return
			}
			if rt.Pin {
				w.Header().Add("Set-Cookie", pinCookieFor(selfHost))
			}
			refuse(w, 502, fmt.Sprintf("%s's %s didn't answer", rt.Host, rt.Name))
		},
	}
	rp.ServeHTTP(w, r)
}

// --- the login ------------------------------------------------------------

// Gate the login's checks, users.Pass and users.Issuers
type Gate struct {
	Pass    func(*http.Request) bool
	Issuers func(*http.Request) []string
}

var openAPI = regexp.MustCompile(`^/api/(me|login|logout|users|run)(/|$)`)

func gated(h hit) bool {
	if h.route != nil {
		return !h.route.Git
	}
	return h.frontend
}

func isOpen(r *http.Request, h hit) bool {
	if !h.frontend {
		return false
	}
	p := strings.SplitN(r.RequestURI, "?", 2)[0]
	if !strings.HasPrefix(p, "/api/") && !strings.HasPrefix(p, "/internal/") {
		return true
	}
	return openAPI.MatchString(p)
}

var loginCookieRe = regexp.MustCompile(`(?:^|;\s*)phosphorus-user=`)

func deny(w http.ResponseWriter, r *http.Request) {
	host := strings.ToLower(r.Host)
	page := r.Method == "GET" && strings.Contains(r.Header.Get("Accept"), "text/html")
	if page && baseDomain != "" {
		why := "none"
		if loginCookieRe.MatchString(strings.Join(r.Header.Values("Cookie"), "; ")) {
			why = "refused"
		}
		q := url.Values{}
		q.Set("next", "https://"+host+r.RequestURI)
		q.Set("why", why)
		q.Set("by", selfHost)
		w.Header().Set("Location", "https://"+baseDomain+"/?"+jsQuery(q))
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(302)
		return
	}
	by := ""
	if selfHost != "" {
		by = " (" + selfHost + ")"
	}
	refuse(w, 401, "log in first"+by)
}

// jsQuery URLSearchParams' order and encoding: next, why, by
func jsQuery(q url.Values) string {
	parts := []string{}
	for _, k := range []string{"next", "why", "by"} {
		parts = append(parts, k+"="+strings.ReplaceAll(url.QueryEscape(q.Get(k)), "%7E", "~"))
	}
	return strings.Join(parts, "&")
}

func pinSwitch(w http.ResponseWriter, r *http.Request) {
	u, _ := url.Parse(r.RequestURI)
	host := ""
	if u != nil {
		host = u.Query().Get("host")
	}
	origin := true
	if o := r.Header.Get("Origin"); o != "" {
		ou, err := url.Parse(o)
		origin = err == nil && ou.Host == r.Host
	}
	if !origin {
		refuse(w, 403, "forbidden")
		return
	}
	if selfHost == "" || (host != selfHost && (*pinIPs.Load())[host] == "") {
		h := host
		if h == "" {
			h = "that host"
		}
		refuse(w, 409, h+" isn't serving")
		return
	}
	w.Header().Set("Set-Cookie", pinCookieFor(host))
	w.WriteHeader(204)
}

type ingressKey struct{}

// IsIngress a request the ingress handed the frontend
func IsIngress(r *http.Request) bool { v, _ := r.Context().Value(ingressKey{}).(bool); return v }

// Handler the ingress itself, the frontend app for whatever no route claims
func Handler(app http.Handler, gate Gate) http.Handler {
	issuerRoute := func(r *http.Request) *Route {
		if pinHopped(r) {
			return nil
		}
		ips := *pinIPs.Load()
		for _, h := range gate.Issuers(r) {
			if ips[h] != "" {
				return peerIngress(h)
			}
		}
		return nil
	}
	var hostSwitchRe = regexp.MustCompile(`^/api/host(\?|$)`)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r = r.WithContext(context.WithValue(r.Context(), ingressKey{}, true))
		h := resolve(r)
		if IsUpgrade(r) {
			var pin *Route
			if h.frontend {
				pin = pinRoute(r)
			}
			if gated(h) && pin == nil && !gate.Pass(r) {
				if via := issuerRoute(r); via != nil {
					forward(via, w, r, r.RequestURI)
				} else {
					w.WriteHeader(401)
				}
				return
			}
			switch {
			case h.route != nil:
				forward(h.route, w, r, h.path)
			case pin != nil:
				forward(pin, w, r, r.RequestURI)
			case h.frontend:
				app.ServeHTTP(w, r)
			default:
				w.WriteHeader(h.status)
			}
			return
		}
		hopReq := h.frontend && r.Method == "POST" && hostSwitchRe.MatchString(r.RequestURI)
		var pin *Route
		if h.frontend && !hopReq {
			pin = pinRoute(r)
		}
		if gated(h) && pin == nil && !isOpen(r, h) && !gate.Pass(r) {
			if via := issuerRoute(r); via != nil {
				forward(via, w, r, r.RequestURI)
			} else {
				deny(w, r)
			}
			return
		}
		if hopReq {
			pinSwitch(w, r)
			return
		}
		switch {
		case h.route != nil:
			forward(h.route, w, r, h.path)
		case pin != nil:
			forward(pin, w, r, r.RequestURI)
		case h.frontend:
			if selfHost != "" && !pinHopped(r) && pinnedTo(r) != selfHost {
				w.Header().Set("Set-Cookie", pinCookieFor(selfHost))
			}
			app.ServeHTTP(w, r)
		default:
			refuse(w, h.status, h.text)
		}
	})
}

// Listen the ingress, exiting the process when it can't bind
func Listen(port int, app http.Handler, gate Gate) {
	srv := &http.Server{
		Addr:              ":" + strconv.Itoa(port),
		Handler:           Handler(app, gate),
		IdleTimeout:       120 * time.Second,
		ReadHeaderTimeout: 125 * time.Second,
		ErrorLog:          log.New(io.Discard, "", 0),
	}
	ln, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		notes.Log(fmt.Sprintf("can't serve on port %d: %v", port, err))
		os.Exit(1)
	}
	notes.Log(fmt.Sprintf("serving %s on port %d", baseDomain, port))
	go func() {
		if err := srv.Serve(ln); err != nil {
			notes.Log(fmt.Sprintf("can't serve on port %d: %v", port, err))
			os.Exit(1)
		}
	}()
}

// EveryRoute every route, a subdomain's shadowed duplicate too
func EveryRoute() []*Route {
	everyMu.RLock()
	defer everyMu.RUnlock()
	return every
}
