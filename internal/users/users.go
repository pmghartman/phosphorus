// Package users: the mesh's people, scrypt hashes, each one's vault of host
// and page logins sealed with a key from their own password
package users

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/scrypt"

	"github.com/pmghartman/phosphorus/internal/sysfs"
	"github.com/pmghartman/phosphorus/internal/util"
)

const (
	secretRel     = "etc/secret.json"
	admin         = "admin"
	Cookie        = "phosphorus-user"
	sessionMS     = 30 * 24 * 3600 * 1000
	bootSessionMS = 3600 * 1000
	maxVault      = 64 * 1024
	maxPass       = 256
	triesMS       = 15 * 60 * 1000
	maxPrefs      = 32 * 1024
	MaxWall       = 3 * 1024 * 1024
	pullWait      = 3 * time.Second
)

func passwd(n string) string    { return "etc/passwd/" + n + ".json" }
func shadow(n string) string    { return "etc/shadow/" + n + ".json" }
func vaultFile(n string) string { return "home/" + n + "/vault.json" }
func prefsFile(n string) string { return "home/" + n + "/prefs.json" }
func wallFile(n string) string  { return "home/" + n + "/wallpaper.json" }

var (
	adminPass  = util.Env("ADMIN_PASS", os.Getenv("PHOSPHORUS_UPDATE_PASSWORD"))
	nameRe     = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,31}$`)
	reserved   = []string{admin, "shared", "sys", "usr"}
	baseDomain = strings.ToLower(os.Getenv("BASE_DOMAIN"))
	selfHost   = os.Getenv("SELF_HOST")
	triesMax   = map[string]int{"ip": 5, "user": 20}
	triesMu    sync.Mutex
	tries      = map[string][]int64{}
	triesOrder []string
	prefKeys   = []string{"icons", "theme", "recent", "color"}
	wallTypes  = []string{"image/png", "image/jpeg", "image/webp", "image/gif"}
)

// Init the mesh secret's oldest-wins rule
func Init() { sysfs.OldestWins(secretRel) }

type shadowRec struct {
	Salt string `json:"salt"`
	Hash string `json:"hash"`
	PwAt string `json:"pwAt"`
}

type liveUser struct {
	Admin bool
	shadowRec
}

func live(name string) *liveUser {
	if !nameRe.MatchString(name) {
		return nil
	}
	pwRaw := sysfs.Read(passwd(name))
	if pwRaw == nil {
		return nil
	}
	var pw map[string]any
	json.Unmarshal(pwRaw, &pw)
	var sh shadowRec
	if !sysfs.ReadInto(shadow(name), &sh) {
		return nil
	}
	return &liveUser{Admin: truthy(pw["admin"]), shadowRec: sh}
}

func truthy(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case nil:
		return false
	case float64:
		return x != 0
	case string:
		return x != ""
	}
	return true
}

func names() []string {
	out := []string{}
	for _, f := range sysfs.List("etc/passwd") {
		n := strings.TrimSuffix(f, ".json")
		if live(n) != nil {
			out = append(out, n)
		}
	}
	sort.Strings(out)
	return out
}

func anyAdmin() bool {
	for _, n := range names() {
		if u := live(n); u != nil && u.Admin {
			return true
		}
	}
	return false
}

// --- crypto ---------------------------------------------------------------

// Derive 64 bytes, Node's scrypt defaults: the hash's half stored, the key's never
func Derive(pass, saltHex string) []byte {
	salt, _ := hex.DecodeString(saltHex)
	out, err := scrypt.Key([]byte(pass), salt, 16384, 8, 1, 64)
	if err != nil {
		panic(err)
	}
	return out
}

// Box an aes-256-gcm sealed text
type Box struct {
	IV   string `json:"iv"`
	Tag  string `json:"tag"`
	Data string `json:"data"`
}

// Seal text under key
func Seal(key []byte, text string) Box {
	iv := make([]byte, 12)
	rand.Read(iv)
	block, _ := aes.NewCipher(key)
	g, _ := cipher.NewGCM(block)
	ct := g.Seal(nil, iv, []byte(text), nil)
	n := len(ct) - 16
	return Box{IV: hex.EncodeToString(iv), Tag: hex.EncodeToString(ct[n:]), Data: base64.StdEncoding.EncodeToString(ct[:n])}
}

// Open a box, ok false on any failure
func Open(key []byte, b Box) (string, bool) {
	iv, err1 := hex.DecodeString(b.IV)
	tag, err2 := hex.DecodeString(b.Tag)
	data, err3 := base64.StdEncoding.DecodeString(b.Data)
	if err3 != nil {
		data, err3 = base64.RawStdEncoding.DecodeString(strings.TrimRight(b.Data, "="))
	}
	if err1 != nil || err2 != nil || err3 != nil || len(key) != 32 || len(iv) == 0 || len(tag) != 16 {
		return "", false
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", false
	}
	g, err := cipher.NewGCMWithNonceSize(block, len(iv))
	if err != nil {
		return "", false
	}
	pt, err := g.Open(nil, iv, append(data, tag...), nil)
	if err != nil {
		return "", false
	}
	return util.UTF8(pt), true
}

// MeshKey one per mesh, the oldest winning
func MeshKey() []byte {
	var s struct {
		V string `json:"v"`
	}
	if !sysfs.ReadInto(secretRel, &s) {
		b := make([]byte, 32)
		rand.Read(b)
		sysfs.Write(secretRel, map[string]string{"v": hex.EncodeToString(b)})
		sysfs.ReadInto(secretRel, &s)
	}
	h := sha256.Sum256([]byte(s.V))
	return h[:]
}

// B64URL decode, padding or standard alphabet tolerated as Node's
func B64URL(s string) ([]byte, error) {
	s = strings.TrimRight(s, "=")
	s = strings.NewReplacer("+", "-", "/", "_").Replace(s)
	return base64.RawURLEncoding.DecodeString(s)
}

// --- sessions -------------------------------------------------------------

// Session a logged in browser
type Session struct {
	User  string
	Admin bool
	Boot  bool
	Key   []byte
	Token string
	E     float64
}

var cookieRe = regexp.MustCompile(`(?:^|;\s*)phosphorus-user=([A-Za-z0-9_-]+)`)

func cookiesOf(r *http.Request) []string {
	out := []string{}
	for _, m := range cookieRe.FindAllStringSubmatch(strings.Join(r.Header.Values("Cookie"), "; "), -1) {
		out = append(out, m[1])
	}
	return out
}

var portRe = regexp.MustCompile(`:\d+$`)

func attrs(r *http.Request) string {
	host := portRe.ReplaceAllString(strings.ToLower(r.Host), "")
	domain := ""
	if baseDomain != "" && (host == baseDomain || strings.HasSuffix(host, "."+baseDomain)) {
		domain = "; Domain=" + baseDomain
	}
	secure := ""
	if r.Header.Get("X-Forwarded-Proto") == "https" {
		secure = "; Secure"
	}
	return "; Path=/" + domain + "; SameSite=Lax; HttpOnly" + secure
}

func issue(r *http.Request, payload map[string]any, ms int64) string {
	payload["e"] = util.Now() + ms
	b := Seal(MeshKey(), string(util.Marshal(payload)))
	box := map[string]string{"iv": b.IV, "tag": b.Tag, "data": b.Data, "h": selfHost}
	token := base64.RawURLEncoding.EncodeToString(util.Marshal(box))
	return fmt.Sprintf("%s=%s; Max-Age=%d%s", Cookie, token, int64(math.Round(float64(ms)/1000)), attrs(r))
}

// ClearCookie the domain's and any older host-only one
func ClearCookie(r *http.Request) []string {
	return []string{Cookie + "=; Max-Age=0" + attrs(r), Cookie + "=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly"}
}

// IPOf the browser's address as cloudflared saw it, else the socket's
func IPOf(r *http.Request) string {
	v := r.Header.Get("Cf-Connecting-Ip")
	if v == "" {
		v = r.Header.Get("X-Forwarded-For")
	}
	if v == "" {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		v = host
	}
	return strings.TrimSpace(strings.Split(v, ",")[0])
}

func locked(keys []string) int64 {
	triesMu.Lock()
	defer triesMu.Unlock()
	now := util.Now()
	var until int64
	for _, k := range keys {
		t := []int64{}
		for _, at := range tries[k] {
			if now-at < triesMS {
				t = append(t, at)
			}
		}
		if len(t) > 0 {
			tries[k] = t
		} else {
			delete(tries, k)
		}
		max := triesMax[strings.SplitN(k, ":", 2)[0]]
		if len(t) >= max {
			if u := t[len(t)-max] + triesMS; u > until {
				until = u
			}
		}
	}
	return until
}

func failed(keys []string) {
	triesMu.Lock()
	defer triesMu.Unlock()
	for _, k := range keys {
		if _, ok := tries[k]; !ok {
			triesOrder = append(triesOrder, k)
		}
		tries[k] = append(tries[k], util.Now())
	}
	for len(tries) > 10000 && len(triesOrder) > 0 {
		delete(tries, triesOrder[0])
		triesOrder = triesOrder[1:]
	}
}

func openToken(token string) map[string]any {
	raw, err := B64URL(token)
	if err != nil {
		return nil
	}
	var b Box
	if json.Unmarshal(raw, &b) != nil {
		return nil
	}
	text, ok := Open(MeshKey(), b)
	if !ok {
		return nil
	}
	var s map[string]any
	if json.Unmarshal([]byte(text), &s) != nil {
		return nil
	}
	return s
}

func sessionOf(token string) *Session {
	s := openToken(token)
	if s == nil {
		return nil
	}
	e, _ := s["e"].(float64)
	if !(e > float64(util.Now())) {
		return nil
	}
	if truthy(s["b"]) {
		if anyAdmin() {
			return nil
		}
		return &Session{User: admin, Admin: true, Boot: true, Token: token, E: e}
	}
	u, _ := s["u"].(string)
	lu := live(u)
	p, _ := s["p"].(string)
	if lu == nil || lu.PwAt != p {
		return nil
	}
	k, _ := s["k"].(string)
	key, _ := hex.DecodeString(k)
	return &Session{User: u, Admin: lu.Admin, Key: key, Token: token, E: e}
}

// Of the first valid cookie's session, a user's before a boot one
func Of(r *http.Request) *Session {
	if sysfs.Read(secretRel) == nil {
		return nil
	}
	var boot *Session
	for _, t := range cookiesOf(r) {
		s := sessionOf(t)
		if s != nil && !s.Boot {
			return s
		}
		if boot == nil {
			boot = s
		}
	}
	return boot
}

// Soon a login this host can't read yet: the mesh's sys pulled first
func Soon(r *http.Request) *Session {
	s := Of(r)
	if s != nil || len(cookiesOf(r)) == 0 {
		return s
	}
	done := make(chan struct{})
	go func() { sysfs.Pull(); close(done) }()
	select {
	case <-done:
	case <-time.After(pullWait):
	}
	return Of(r)
}

// Pass any valid session
func Pass(r *http.Request) bool { return Of(r) != nil }

// Issuers the hosts that issued the cookies sent, this one aside
func Issuers(r *http.Request) []string {
	out := []string{}
	for _, t := range cookiesOf(r) {
		raw, err := B64URL(t)
		if err != nil {
			continue
		}
		var o map[string]any
		if json.Unmarshal(raw, &o) != nil {
			continue
		}
		h := fmt.Sprint(o["h"])
		if o["h"] == nil {
			h = ""
		}
		dup := false
		for _, x := range out {
			dup = dup || x == h
		}
		if h != "" && h != selfHost && !dup {
			out = append(out, h)
		}
	}
	return out
}

// Refresh a host-only cookie moved onto the base domain
func Refresh(r *http.Request, s *Session) []string {
	if s == nil || !strings.Contains(attrs(r), "Domain=") {
		return nil
	}
	left := int64(math.Round((s.E - float64(util.Now())) / 1000))
	return []string{Cookie + "=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly", fmt.Sprintf("%s=%s; Max-Age=%d%s", Cookie, s.Token, left, attrs(r))}
}

func vaultOf(s *Session) map[string]any {
	if s == nil || s.Boot {
		return nil
	}
	var b Box
	if !sysfs.ReadInto(vaultFile(s.User), &b) {
		return map[string]any{}
	}
	text, ok := Open(s.Key, b)
	if !ok {
		return map[string]any{}
	}
	var v map[string]any
	if json.Unmarshal([]byte(text), &v) != nil || v == nil {
		return map[string]any{}
	}
	return v
}

// Me what the page gets about its user
func Me(s *Session) map[string]any {
	vault := vaultOf(s)
	if vault == nil {
		vault = map[string]any{"hosts": map[string]any{}, "pages": map[string]any{}}
	}
	var prefs any = map[string]any{}
	var prefsAt, wall float64
	if !s.Boot {
		if p := sysfs.Read(prefsFile(s.User)); p != nil {
			prefs = json.RawMessage(p)
		}
		prefsAt = sysfs.Stamp(prefsFile(s.User))
		if sysfs.Read(wallFile(s.User)) != nil {
			wall = sysfs.Stamp(wallFile(s.User))
		}
	}
	return map[string]any{"user": s.User, "admin": s.Admin, "boot": s.Boot, "vault": vault, "prefs": prefs, "prefsAt": prefsAt, "wallpaper": wall}
}

// Wallpaper the user's desktop picture
func Wallpaper(s *Session) (string, []byte) {
	if s == nil || s.Boot {
		return "", nil
	}
	var w struct {
		Type string `json:"type"`
		Data any    `json:"data"`
	}
	if !sysfs.ReadInto(wallFile(s.User), &w) || !contains(wallTypes, w.Type) {
		return "", nil
	}
	d, _ := w.Data.(string)
	b, _ := base64.StdEncoding.DecodeString(d)
	return w.Type, b
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

var dataURLRe = regexp.MustCompile(`^data:([a-z/]+);base64,([A-Za-z0-9+/=]+)$`)

// R a call's answer
type R struct {
	Status int
	Body   any
	Cookie []string
}

func errR(status int, msg string) R { return R{Status: status, Body: map[string]any{"error": msg}} }

func str(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return util.JSNum(x)
	}
	return string(util.Marshal(v))
}

// SetWallpaper a data: url, ” dropping it
func SetWallpaper(s *Session, p map[string]any) R {
	if s == nil || s.Boot {
		return errR(403, "the setup admin keeps no settings")
	}
	u := str(p["data"])
	if u == "" {
		sysfs.Remove(wallFile(s.User))
		return R{Status: 200, Body: map[string]any{"wallpaper": 0}}
	}
	m := dataURLRe.FindStringSubmatch(u)
	if m == nil || !contains(wallTypes, m[1]) {
		return errR(400, "png, jpeg, webp or gif only")
	}
	if float64(len(m[2]))*0.75 > MaxWall {
		return errR(413, "picture too large")
	}
	sysfs.Write(wallFile(s.User), map[string]string{"type": m[1], "data": m[2]})
	return R{Status: 200, Body: map[string]any{"wallpaper": sysfs.Stamp(wallFile(s.User))}}
}

// SetPrefs each a string as the page's localStorage held it
func SetPrefs(s *Session, p map[string]any) R {
	if s == nil || s.Boot {
		return errR(403, "the setup admin keeps no settings")
	}
	prefs := map[string]any{}
	sysfs.ReadInto(prefsFile(s.User), &prefs)
	if prefs == nil {
		prefs = map[string]any{}
	}
	in, _ := p["prefs"].(map[string]any)
	for _, k := range prefKeys {
		v, ok := in[k]
		if in == nil || !ok {
			continue
		}
		if sv := str(v); sv != "" {
			prefs[k] = sv
		} else {
			delete(prefs, k)
		}
	}
	if len(util.Marshal(prefs)) > maxPrefs {
		return errR(413, "settings too large")
	}
	sysfs.Write(prefsFile(s.User), prefs)
	return R{Status: 200, Body: map[string]any{"prefs": prefs, "prefsAt": sysfs.Stamp(prefsFile(s.User))}}
}

func hashOK(out []byte, hashHex string) bool {
	h, err := hex.DecodeString(hashHex)
	return err == nil && len(h) == 32 && subtle.ConstantTimeCompare(out[:32], h) == 1
}

// Login a user, or the setup admin while there's no admin user
func Login(p map[string]any, r *http.Request) R {
	name := strings.ToLower(strings.TrimSpace(str(p["user"])))
	pass := str(p["pass"])
	keys := []string{"ip:" + IPOf(r), "user:" + name}
	if until := locked(keys); until > 0 {
		mins := int64(math.Ceil(float64(until-util.Now()) / 60000))
		return errR(429, fmt.Sprintf("too many wrong passwords, try again in %d min", mins))
	}
	fail := func() R {
		failed(keys)
		time.Sleep(400 * time.Millisecond)
		return errR(401, "wrong user or password")
	}
	if name == admin {
		if anyAdmin() {
			return errR(403, "the setup admin is off once an admin user exists")
		}
		if pass != adminPass {
			return fail()
		}
		return R{Status: 200, Body: Me(&Session{User: admin, Admin: true, Boot: true}), Cookie: []string{issue(r, map[string]any{"b": 1}, bootSessionMS)}}
	}
	u := live(name)
	if u == nil || len([]rune(pass)) > maxPass {
		return fail()
	}
	out := Derive(pass, u.Salt)
	if !hashOK(out, u.Hash) {
		return fail()
	}
	key := out[32:]
	s := &Session{User: name, Admin: u.Admin, Key: key}
	return R{Status: 200, Body: Me(s), Cookie: []string{issue(r, map[string]any{"u": name, "p": u.PwAt, "k": hex.EncodeToString(key)}, sessionMS)}}
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func setPass(name, pass string, vault any, adminFlag *bool) []byte {
	salt := randHex(16)
	out := Derive(pass, salt)
	pwAt := randHex(8)
	if adminFlag != nil {
		sysfs.Write(passwd(name), map[string]bool{"admin": *adminFlag})
	}
	sysfs.Write(shadow(name), shadowRec{Salt: salt, Hash: hex.EncodeToString(out[:32]), PwAt: pwAt})
	sysfs.Write(vaultFile(name), Seal(out[32:], string(util.Marshal(vault))))
	return out[32:]
}

var hostKeyRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

func clip(v any, n int) string {
	s := ""
	if v != nil {
		s = str(v)
	}
	r := []rune(s)
	// JS slices UTF-16 units, close enough for these caps
	if len(r) > n {
		r = r[:n]
	}
	return string(r)
}

func cleanVault(v any) map[string]any {
	hosts := map[string]any{}
	pages := map[string]any{}
	o, _ := v.(map[string]any)
	if hs, ok := o["hosts"].(map[string]any); ok {
		for h, c := range hs {
			cm, ok := c.(map[string]any)
			if hostKeyRe.MatchString(h) && ok && truthy(cm["user"]) {
				hosts[h] = map[string]any{"user": clip(cm["user"], 64), "pass": clip(cm["pass"], maxPass)}
			}
		}
	}
	if ps, ok := o["pages"].(map[string]any); ok {
		for k, c := range ps {
			cm, ok := c.(map[string]any)
			if k != "" && len(k) <= 128 && ok && c != nil {
				pages[clip(k, 128)] = map[string]any{"url": clip(cm["url"], 512), "user": clip(cm["user"], 128), "pass": clip(cm["pass"], maxPass)}
			}
		}
	}
	return map[string]any{"hosts": hosts, "pages": pages}
}

// SetVault the page's saved logins, sealed
func SetVault(s *Session, p map[string]any) R {
	if s == nil || s.Boot {
		return errR(403, "the setup admin keeps no logins")
	}
	vault := cleanVault(p["vault"])
	text := string(util.Marshal(vault))
	if len(text) > maxVault {
		return errR(413, "too many saved logins")
	}
	sysfs.Write(vaultFile(s.User), Seal(s.Key, text))
	return R{Status: 200, Body: map[string]any{"vault": vault}}
}

// ChangePass the vault resealed under the new password
func ChangePass(s *Session, p map[string]any, r *http.Request) R {
	if s == nil || s.Boot {
		return errR(403, "the setup admin's password is ADMIN_PASS in .env")
	}
	pass := str(p["pass"])
	n := len([]rune(pass))
	if n < 4 || n > maxPass {
		return errR(400, "password: 4 to 256 characters")
	}
	u := live(s.User)
	if u == nil || !hashOK(Derive(str(p["old"]), u.Salt), u.Hash) {
		return errR(401, "wrong current password")
	}
	v := vaultOf(s)
	if v == nil {
		v = map[string]any{}
	}
	key := setPass(s.User, pass, v, nil)
	return R{Status: 200, Body: map[string]any{"ok": true}, Cookie: []string{issue(r, map[string]any{"u": s.User, "p": live(s.User).PwAt, "k": hex.EncodeToString(key)}, sessionMS)}}
}

func needAdmin(s *Session) *R {
	if s != nil && s.Admin {
		return nil
	}
	r := errR(403, "admins only")
	return &r
}

// List the users, admins only
func List(s *Session) R {
	if no := needAdmin(s); no != nil {
		return *no
	}
	out := []map[string]any{}
	for _, n := range names() {
		out = append(out, map[string]any{"name": n, "admin": live(n).Admin})
	}
	return R{Status: 200, Body: map[string]any{"users": out}}
}

// Create a user
func Create(s *Session, p map[string]any) R {
	if no := needAdmin(s); no != nil {
		return *no
	}
	name := strings.ToLower(strings.TrimSpace(str(p["name"])))
	pass := str(p["pass"])
	if !nameRe.MatchString(name) || contains(reserved, name) {
		return errR(400, "name: letters, digits, . _ -, up to 32, never "+strings.Join(reserved, ", "))
	}
	if live(name) != nil {
		return errR(409, name+" already exists")
	}
	n := len([]rune(pass))
	if n < 4 || n > maxPass {
		return errR(400, "password: 4 to 256 characters")
	}
	a := truthy(p["admin"])
	setPass(name, pass, map[string]any{"hosts": map[string]any{}, "pages": map[string]any{}}, &a)
	return List(s)
}

// SetAdmin flips a user's admin
func SetAdmin(s *Session, p map[string]any) R {
	if no := needAdmin(s); no != nil {
		return *no
	}
	name := str(p["name"])
	if live(name) == nil {
		return errR(404, "no such user")
	}
	if name == s.User && !truthy(p["admin"]) {
		return errR(400, "your own admin stays, another admin can take it")
	}
	sysfs.Write(passwd(name), map[string]bool{"admin": truthy(p["admin"])})
	return List(s)
}

// Remove a user and their files
func Remove(s *Session, p map[string]any) R {
	if no := needAdmin(s); no != nil {
		return *no
	}
	name := str(p["name"])
	if live(name) == nil {
		return errR(404, "no such user")
	}
	if name == s.User {
		return errR(400, "another admin can delete you, not yourself")
	}
	for _, f := range []string{passwd(name), shadow(name), vaultFile(name), prefsFile(name), wallFile(name)} {
		sysfs.Remove(f)
	}
	return List(s)
}

// SealGrant a short lived grant any host reads
func SealGrant(o map[string]any, ms int64) string {
	o["e"] = util.Now() + ms
	b := Seal(MeshKey(), string(util.Marshal(o)))
	return base64.RawURLEncoding.EncodeToString(util.Marshal(b))
}

// OpenGrant nil when bad or expired
func OpenGrant(token string) map[string]any {
	o := openToken(token)
	if o == nil {
		return nil
	}
	e, _ := o["e"].(float64)
	if !(e > float64(util.Now())) {
		return nil
	}
	return o
}

// Exists a live user
func Exists(name string) bool { return live(name) != nil }

// IsAdmin a live admin user
func IsAdmin(name string) bool {
	u := live(name)
	return u != nil && u.Admin
}

// Setup true while no admin user exists
func Setup() bool { return !anyAdmin() }
