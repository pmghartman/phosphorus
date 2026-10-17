package proxy

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	iconMax  = 256 * 1024
	iconKeep = time.Hour
	iconMiss = 10 * time.Minute
)

// Icon a service's own icon
type Icon struct {
	Type string
	Body []byte
}

type grabbed struct {
	typ  string
	body []byte
	path string
}

type heldIcon struct {
	done  chan struct{}
	icon  *Icon
	until time.Time
}

var (
	iconsMu sync.Mutex
	icons   = map[string]*heldIcon{}
)

func iconClient(rt *Route, servername string) *http.Client {
	tr := &http.Transport{Proxy: nil, DisableCompression: true}
	if rt.Scheme == "https" {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true, ServerName: servername}
	}
	return &http.Client{
		Transport:     tr,
		Timeout:       4 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func unpack(body []byte, enc string) []byte {
	var r io.Reader
	l := strings.ToLower(enc)
	switch {
	case regexp.MustCompile(`\bgzip\b`).MatchString(l):
		g, err := gzip.NewReader(bytes.NewReader(body))
		if err != nil {
			return nil
		}
		r = g
	case regexp.MustCompile(`\bdeflate\b`).MatchString(l):
		z, err := zlib.NewReader(bytes.NewReader(body))
		if err != nil {
			r = flate.NewReader(bytes.NewReader(body))
		} else {
			r = z
		}
	default:
		return body
	}
	out, err := io.ReadAll(r)
	if err != nil {
		return nil
	}
	return out
}

type grabOpts struct {
	page  bool
	hops  int
	trace *[]string
}

func grab(rt *Route, p string, max int, o grabOpts) *grabbed {
	say := func(what string) {
		if o.trace != nil {
			*o.trace = append(*o.trace, p+" "+what)
		}
	}
	host := rt.Domain
	if host == "" {
		host = baseDomain
	}
	servername := ""
	if rt.Scheme == "https" && host != "" && net.ParseIP(host) == nil {
		servername = host
	}
	u := rt.Scheme + "://" + net.JoinHostPort(rt.IP, strconv.Itoa(rt.Port)) + p
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		say(err.Error())
		return nil
	}
	req.Host = host
	accept := "image/*,*/*;q=0.8"
	if o.page {
		accept = "text/html,*/*;q=0.8"
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("Accept-Encoding", "identity")
	req.Header.Set("User-Agent", "Mozilla/5.0 (phosphorus icons)")
	req.Header.Set("X-Forwarded-Host", host)
	req.Header.Set("X-Forwarded-Proto", rt.Proto)
	req.Header.Set("X-Forwarded-Prefix", rt.Prefix)
	res, err := iconClient(rt, servername).Do(req)
	if err != nil {
		if ctx.Err() != nil {
			say("timed out")
		} else {
			say(err.Error())
		}
		return nil
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 && res.StatusCode < 400 && res.Header.Get("Location") != "" {
		to := res.Header.Get("Location")
		next := ""
		if o.hops > 0 {
			next = iconPath(rt, to, p)
		}
		extra := ""
		if next == "" {
			extra = ", not followed"
		}
		say(fmt.Sprintf("%d to %s%s", res.StatusCode, to, extra))
		if next != "" && next != p {
			return grab(rt, next, max, grabOpts{o.page, o.hops - 1, o.trace})
		}
		return nil
	}
	ct := res.Header.Get("Content-Type")
	if ct == "" {
		ct = "no type"
	}
	enc := res.Header.Get("Content-Encoding")
	if enc != "" {
		say(fmt.Sprintf("%d %s %s", res.StatusCode, ct, enc))
	} else {
		say(fmt.Sprintf("%d %s", res.StatusCode, ct))
	}
	if res.StatusCode != 200 && !(o.page && res.StatusCode >= 400 && res.StatusCode < 500) {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, int64(max)+1))
	if err != nil && len(body) == 0 {
		return nil
	}
	if len(body) > max {
		if !o.page {
			return nil
		}
		body = body[:max]
	}
	b := unpack(body, enc)
	if b == nil {
		return nil
	}
	return &grabbed{typ: res.Header.Get("Content-Type"), body: b, path: p}
}

func iconPath(rt *Route, href, from string) string {
	base, _ := url.Parse("http://upstream/")
	f, err := base.Parse(from)
	if err != nil {
		return ""
	}
	u, err := f.Parse(strings.ReplaceAll(href, "&amp;", "&"))
	if err != nil {
		return ""
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return ""
	}
	own := []string{rt.Domain, rt.IP, "localhost", "127.0.0.1"}
	if rt.Domain == "" {
		own[0] = baseDomain
	}
	if u.Host != "upstream" {
		ok := false
		for _, h := range own {
			ok = ok || u.Hostname() == h
		}
		if !ok {
			return ""
		}
	}
	p := u.EscapedPath()
	if rt.Prefix != "" && under(p, rt.Prefix) {
		p = strip(p, rt.Prefix)
	}
	q := ""
	if u.RawQuery != "" {
		q = "?" + u.RawQuery
	}
	return p + q
}

var svgRe = regexp.MustCompile(`(?is)^\x{FEFF}?\s*(<\?xml[^>]*>\s*)?(<!--.*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]`)

func sniff(b []byte) string {
	switch {
	case len(b) >= 4 && b[0] == 0x89 && string(b[1:4]) == "PNG":
		return "image/png"
	case len(b) >= 4 && b[0] == 0 && b[1] == 0 && b[2] == 1 && b[3] == 0:
		return "image/x-icon"
	case len(b) >= 3 && string(b[:3]) == "GIF":
		return "image/gif"
	case len(b) >= 2 && b[0] == 0xff && b[1] == 0xd8:
		return "image/jpeg"
	case len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return "image/webp"
	}
	head := b
	if len(head) > 1024 {
		head = head[:1024]
	}
	if svgRe.Match(head) {
		return "image/svg+xml"
	}
	return ""
}

func asImage(g *grabbed) *Icon {
	if g == nil || len(g.body) < 4 {
		return nil
	}
	named := strings.ToLower(strings.TrimSpace(strings.Split(g.typ, ";")[0]))
	t := sniff(g.body)
	if t == "" && strings.HasPrefix(named, "image/") {
		t = named
	}
	if t == "" {
		return nil
	}
	return &Icon{t, g.body}
}

var dataRe = regexp.MustCompile(`(?is)^data:(image/[a-z0-9.+-]+)(;base64)?,(.*)$`)

func fromData(href string) *Icon {
	m := dataRe.FindStringSubmatch(href)
	if m == nil {
		return nil
	}
	if m[2] != "" {
		b, err := base64.StdEncoding.DecodeString(m[3])
		if err != nil {
			return nil
		}
		return &Icon{strings.ToLower(m[1]), b}
	}
	s, err := url.PathUnescape(m[3])
	if err != nil {
		return nil
	}
	return &Icon{strings.ToLower(m[1]), []byte(s)}
}

func manifestIcons(rt *Route, href, from string, trace *[]string) []string {
	p := iconPath(rt, href, from)
	if p == "" {
		return nil
	}
	g := grab(rt, p, iconMax, grabOpts{hops: 4, trace: trace})
	if g == nil {
		return nil
	}
	var m struct {
		Icons []map[string]any `json:"icons"`
	}
	if json.Unmarshal(g.body, &m) != nil {
		return nil
	}
	size := func(i map[string]any) int {
		best := 0
		s, _ := i["sizes"].(string)
		for _, x := range strings.Fields(s) {
			n, _ := strconv.Atoi(strings.SplitN(strings.ToLower(x), "x", 2)[0])
			if n == 0 && x == "any" {
				n = 1024
			}
			if n > best {
				best = n
			}
		}
		return best
	}
	list := []map[string]any{}
	for _, i := range m.Icons {
		if _, ok := i["src"].(string); ok {
			list = append(list, i)
		}
	}
	sort.SliceStable(list, func(a, b int) bool { return size(list[a]) > size(list[b]) })
	out := []string{}
	for _, i := range list {
		if q := iconPath(rt, i["src"].(string), p); q != "" {
			out = append(out, q)
		}
	}
	return out
}

var usualIcons = []string{"/favicon.ico", "/favicon.png", "/favicon.svg", "/apple-touch-icon.png", "/static/favicon.ico", "/static/favicon.png",
	"/assets/favicon.ico", "/.client/favicon.png", "/.client/logo.png", "/logo.png", "/icon.png"}

var (
	baseTagRe = regexp.MustCompile(`(?i)<base\b[^>]*\bhref\s*=\s*(["'])([^"']*)["']`)
	linkRe    = regexp.MustCompile(`(?i)<link\b[^>]*>`)
	relAttrRe = regexp.MustCompile(`(?i)\brel\s*=\s*["']?([^"'>]*)`)
	hrefDQ    = regexp.MustCompile(`(?is)\bhref\s*=\s*"(.*?)"`)
	hrefSQ    = regexp.MustCompile(`(?is)\bhref\s*=\s*'(.*?)'`)
	hrefBare  = regexp.MustCompile(`(?i)\bhref\s*=\s*([^\s"'>]+)`)
	htmlRe    = regexp.MustCompile(`html`)
	startTag  = regexp.MustCompile(`^\s*<`)
)

func hrefOf(tag string) string {
	d := hrefDQ.FindStringSubmatchIndex(tag)
	s := hrefSQ.FindStringSubmatchIndex(tag)
	switch {
	case d != nil && (s == nil || d[0] < s[0]):
		return tag[d[2]:d[3]]
	case s != nil:
		return tag[s[2]:s[3]]
	}
	if m := hrefBare.FindStringSubmatch(tag); m != nil {
		return m[1]
	}
	return ""
}

func lookIcon(rt *Route, trace *[]string) *Icon {
	page := grab(rt, "/", iconMax*4, grabOpts{page: true, hops: 4, trace: trace})
	html := ""
	if page != nil {
		head := page.body
		if len(head) > 64 {
			head = head[:64]
		}
		if htmlRe.MatchString(page.typ) || startTag.Match(head) {
			html = string(page.body)
		}
	}
	from := "/"
	if page != nil {
		from = page.path
	}
	if m := baseTagRe.FindStringSubmatch(html); m != nil && m[2] != "" {
		b := m[2]
		if strings.HasSuffix(b, "/") {
			b += "_"
		}
		pp := "/"
		if page != nil {
			pp = page.path
		}
		if x := iconPath(rt, b, pp); x != "" {
			from = x
		}
	}
	icons, touch := []string{}, []string{}
	manifest := ""
	for _, tag := range linkRe.FindAllString(html, -1) {
		rel := ""
		if m := relAttrRe.FindStringSubmatch(tag); m != nil {
			rel = m[1]
		}
		href := hrefOf(tag)
		lr := strings.ToLower(rel)
		if href != "" && regexp.MustCompile(`\bmanifest\b`).MatchString(lr) && manifest == "" {
			manifest = strings.TrimSpace(href)
		}
		if !strings.Contains(lr, "icon") || strings.Contains(lr, "mask-icon") {
			continue
		}
		if href != "" {
			if strings.Contains(lr, "apple-touch") {
				touch = append(touch, strings.TrimSpace(href))
			} else {
				icons = append(icons, strings.TrimSpace(href))
			}
		}
	}
	all := append(append([]string{}, icons...), touch...)
	for _, h := range all {
		if strings.HasPrefix(h, "data:") {
			if d := fromData(h); d != nil {
				return d
			}
		}
	}
	paths := []string{}
	for _, h := range all {
		if !strings.HasPrefix(h, "data:") {
			if p := iconPath(rt, h, from); p != "" {
				paths = append(paths, p)
			}
		}
	}
	if trace != nil {
		named := "no icons"
		if len(paths) > 0 {
			named = strings.Join(paths, ", ")
		}
		if manifest != "" {
			named += ", manifest " + manifest
		}
		*trace = append(*trace, "page names "+named)
	}
	if manifest != "" {
		paths = append(paths, manifestIcons(rt, manifest, from, trace)...)
	}
	seen := map[string]bool{}
	for _, p := range append(paths, usualIcons...) {
		if seen[p] {
			continue
		}
		seen[p] = true
		if r := asImage(grab(rt, p, iconMax, grabOpts{hops: 4, trace: trace})); r != nil {
			return r
		}
	}
	return nil
}

func findRoute(host, name string) *Route {
	for _, r := range EveryRoute() {
		if r.Host == host && r.Name == name {
			return r
		}
	}
	return nil
}

// Favicon a service's icon, nil when it has none, kept a while
func Favicon(host, name string) *Icon {
	key := host + "/" + name
	iconsMu.Lock()
	if h := icons[key]; h != nil && time.Now().Before(h.until) {
		iconsMu.Unlock()
		<-h.done
		return h.icon
	}
	rt := findRoute(host, name)
	if rt == nil {
		iconsMu.Unlock()
		return nil
	}
	h := &heldIcon{done: make(chan struct{}), until: time.Now().Add(iconKeep)}
	icons[key] = h
	iconsMu.Unlock()
	func() {
		defer func() { recover() }()
		h.icon = lookIcon(rt, nil)
	}()
	if h.icon == nil {
		iconsMu.Lock()
		h.until = time.Now().Add(iconMiss)
		iconsMu.Unlock()
		notes.Log(fmt.Sprintf("no icon found for %s at %s://%s:%d, its page and the usual paths tried", key, rt.Scheme, rt.IP, rt.Port))
	}
	close(h.done)
	return h.icon
}

// FaviconWhy every step of a fresh lookup
func FaviconWhy(host, name string) map[string]any {
	rt := findRoute(host, name)
	if rt == nil {
		return map[string]any{"route": nil, "steps": []string{"no route for " + host + "/" + name}}
	}
	steps := []string{}
	icon := lookIcon(rt, &steps)
	d := rt.Domain
	if d == "" {
		d = baseDomain
	}
	pre := rt.Prefix
	if pre == "" {
		pre = "/"
	}
	var found any
	if icon != nil {
		found = fmt.Sprintf("%s, %d bytes", icon.Type, len(icon.Body))
	}
	return map[string]any{
		"route": fmt.Sprintf("%s://%s:%d, host %s, prefix %s", rt.Scheme, rt.IP, rt.Port, d, pre),
		"found": found, "steps": steps,
	}
}
