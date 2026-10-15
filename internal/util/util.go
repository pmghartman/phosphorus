// Package util: env, JSON files on disk, JSON over HTTP, phosphorus.ini,
// tailnet name lookups and change-only logging, as util.js
package util

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/pmghartman/phosphorus/internal/ini"
)

// Env reads k, def when unset or empty, as process.env.X || def
func Env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// EnvInt as Number(process.env.X || def), def on a bad number
func EnvInt(k string, def int) int {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	n, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return def
	}
	return int(n)
}

var (
	FrontendPort = EnvInt("FRONTEND_PORT", 8090)
	StateDir     = Env("STATE_DIR", "/state")
	SelfHost     = os.Getenv("SELF_HOST")
	iniFile      = &ini.File{Path: Env("PHOSPHORUS_INI_FILE", "/etc/phosphorus/phosphorus.ini")}
)

// Now in ms, Date.now()
func Now() int64 { return time.Now().UnixMilli() }

// Ini one key of phosphorus.ini, blank when unset
func Ini(section, key string) string { return iniFile.Get(section, key) }

// ReadJSON into v, false on any failure
func ReadJSON(file string, v any) bool {
	b, err := os.ReadFile(file)
	if err != nil {
		return false
	}
	return json.Unmarshal(b, v) == nil
}

// ReadJSONMap a file as a generic object, nil on failure
func ReadJSONMap(file string) map[string]any {
	var m map[string]any
	if !ReadJSON(file, &m) {
		return nil
	}
	return m
}

type freshEntry struct {
	sig   string
	value json.RawMessage
}

var (
	freshMu sync.Mutex
	fresh   = map[string]freshEntry{}
)

// ReadFresh a daemon's json while refreshed within maxAge, else nil
func ReadFresh(file string, maxAge time.Duration) json.RawMessage {
	st, err := os.Stat(file)
	if err != nil {
		return nil
	}
	if time.Since(st.ModTime()) > maxAge {
		return nil
	}
	sig := fmt.Sprintf("%d:%d", inodeOf(st), st.ModTime().UnixNano())
	freshMu.Lock()
	defer freshMu.Unlock()
	if hit, ok := fresh[file]; ok && hit.sig == sig {
		return hit.value
	}
	b, err := os.ReadFile(file)
	var v json.RawMessage
	if err == nil && json.Valid(b) {
		v = json.RawMessage(bytes.TrimSpace(b))
		if string(v) == "null" {
			v = nil
		}
	}
	fresh[file] = freshEntry{sig, v}
	return v
}

// Marshal JSON without HTML escaping, as JSON.stringify
func Marshal(v any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return []byte("null")
	}
	return bytes.TrimRight(buf.Bytes(), "\n")
}

// WriteJSONAtomic temp then rename, a reader never sees half a file
func WriteJSONAtomic(file string, v any) error {
	return WriteFileAtomic(file, Marshal(v))
}

// WriteFileAtomic temp then rename
func WriteFileAtomic(file string, b []byte) error {
	tmp := fmt.Sprintf("%s.%d.tmp", file, os.Getpid())
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

var (
	soonMu   sync.Mutex
	soonDue  = map[string]any{}
	soonBusy = map[string]bool{}
)

// WriteJSONSoon off the hot path, one write in flight per file, latest next
func WriteJSONSoon(file string, v any) {
	b := Marshal(v)
	soonMu.Lock()
	soonDue[file] = b
	if soonBusy[file] {
		soonMu.Unlock()
		return
	}
	soonBusy[file] = true
	soonMu.Unlock()
	go func() {
		for {
			soonMu.Lock()
			d, ok := soonDue[file]
			if !ok {
				delete(soonBusy, file)
				soonMu.Unlock()
				return
			}
			delete(soonDue, file)
			soonMu.Unlock()
			tmp := fmt.Sprintf("%s.%d.soon.tmp", file, os.Getpid())
			err := os.WriteFile(tmp, d.([]byte), 0o644)
			if err == nil {
				err = os.Rename(tmp, file)
			}
			if err != nil {
				log.Printf("[frontend] couldn't write %s: %v", file, err)
			}
		}
	}()
}

// FlushWrites waits for every pending WriteJSONSoon, for shutdown
func FlushWrites() {
	for i := 0; i < 200; i++ {
		soonMu.Lock()
		n := len(soonBusy)
		soonMu.Unlock()
		if n == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

var (
	ipsMu    sync.RWMutex
	knownIPs = map[string]string{}
	ipv4Re   = regexp.MustCompile(`^\d+\.\d+\.\d+\.\d+$`)
)

// IsIPv4 as /^\d+\.\d+\.\d+\.\d+$/
func IsIPv4(s string) bool { return ipv4Re.MatchString(s) }

// NoteTailnetIPs host -> IPv4, as mesh's discovery last listed them
func NoteTailnetIPs(ips map[string]string) {
	m := map[string]string{}
	for h, ip := range ips {
		if IsIPv4(ip) {
			m[h] = ip
		}
	}
	ipsMu.Lock()
	knownIPs = m
	ipsMu.Unlock()
}

// TailnetIP a host's tailnet IPv4, blank when unknown
func TailnetIP(name string) string {
	ipsMu.RLock()
	ip := knownIPs[name]
	ipsMu.RUnlock()
	if ip != "" {
		return ip
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "tailscale", "ip", "-4", name).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// Response of RequestJSON: Body nil for non-JSON
type Response struct {
	Status int
	Body   json.RawMessage
	Text   string
}

// Req for RequestJSON
type Req struct {
	Host           string
	Port           int
	Method         string
	Path           string
	Body           any // nil: none
	Timeout        time.Duration
	ConnectTimeout time.Duration
}

var plainTransport = &http.Transport{
	Proxy:               nil,
	MaxIdleConnsPerHost: 16,
	IdleConnTimeout:     90 * time.Second,
}

// HTTPClient a client ignoring any proxy env, for mesh hops
var HTTPClient = &http.Client{Transport: plainTransport}

// RequestJSON one request, rejects only on a failed request; Timeout an
// idle/overall cap, ConnectTimeout for a peer that never picks up
func RequestJSON(r Req) (Response, error) {
	method := r.Method
	if method == "" {
		method = "GET"
	}
	var body io.Reader
	if r.Body != nil {
		body = bytes.NewReader(Marshal(r.Body))
	}
	host := r.Host
	if host == "" {
		host = "127.0.0.1"
	}
	url := "http://" + net.JoinHostPort(host, strconv.Itoa(r.Port)) + r.Path
	ctx := context.Background()
	var cancel context.CancelFunc
	if r.Timeout > 0 {
		ctx, cancel = context.WithTimeout(ctx, r.Timeout)
		defer cancel()
	}
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return Response{}, err
	}
	if r.Body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := HTTPClient
	if r.ConnectTimeout > 0 {
		client = &http.Client{Transport: &http.Transport{
			Proxy:       nil,
			DialContext: (&net.Dialer{Timeout: r.ConnectTimeout}).DialContext,
		}}
		defer client.CloseIdleConnections()
	}
	res, err := client.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return Response{}, errors.New("timed out")
		}
		return Response{}, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		return Response{}, err
	}
	out := Response{Status: res.StatusCode, Text: string(b)}
	if json.Valid(b) {
		out.Body = json.RawMessage(b)
	}
	return out, nil
}

// PeerCall [status, body] from a peer's frontend, never fails, a non-JSON
// answer as the error text
func PeerCall(host string, r Req) (int, any) {
	r.Port = FrontendPort
	res, err := RequestJSON(r)
	if err != nil {
		return 502, map[string]any{"error": fmt.Sprintf("%s didn't answer: %s", host, err.Error())}
	}
	if res.Body != nil && string(res.Body) != "null" {
		return res.Status, res.Body
	}
	t := strings.TrimSpace(res.Text)
	if t == "" {
		t = fmt.Sprintf("status %d", res.Status)
	}
	return res.Status, map[string]any{"error": t}
}

// Notes re-run every tick, logged only when a key's message changes
type Notes struct {
	tag  string
	mu   sync.Mutex
	last map[string]string
}

// NewNotes for one tag
func NewNotes(tag string) *Notes { return &Notes{tag: tag, last: map[string]string{}} }

// Log always
func (n *Notes) Log(msg string) { log.Printf("[%s] %s", n.tag, msg) }

// Note logged on a change
func (n *Notes) Note(key, msg string) {
	n.mu.Lock()
	if n.last[key] == msg {
		n.mu.Unlock()
		return
	}
	n.last[key] = msg
	n.mu.Unlock()
	n.Log(msg)
}

// Clear one key
func (n *Notes) Clear(key string) {
	n.mu.Lock()
	delete(n.last, key)
	n.mu.Unlock()
}

// Reset every key under a prefix
func (n *Notes) Reset(prefix string) {
	n.mu.Lock()
	for k := range n.last {
		if strings.HasPrefix(k, prefix) {
			delete(n.last, k)
		}
	}
	n.mu.Unlock()
}

// JSNum formats a number as JS's String(n) does for the common range
func JSNum(f float64) string {
	if f == math.Trunc(f) && math.Abs(f) < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}

// MkdirAll for a file's parent
func MkdirParent(file string, mode os.FileMode) error {
	return os.MkdirAll(filepath.Dir(file), mode)
}

// UTF8 bytes as text, each invalid byte a U+FFFD, as Buffer.toString
func UTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	for len(b) > 0 {
		r, n := utf8.DecodeRune(b)
		if r == utf8.RuneError && n <= 1 {
			sb.WriteRune('�')
			b = b[1:]
			continue
		}
		sb.Write(b[:n])
		b = b[n:]
	}
	return sb.String()
}

// JSString as a JS template literal renders a JSON value
func JSString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return JSNum(x)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e == nil {
				continue
			}
			parts[i] = JSString(e)
		}
		return strings.Join(parts, ",")
	case map[string]any:
		return "[object Object]"
	}
	return fmt.Sprint(v)
}

// Truthy JS truthiness of a JSON value
func Truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0 && !math.IsNaN(x)
	case int:
		return x != 0
	case int64:
		return x != 0
	}
	return true
}

// Str as String(v || ”) for JSON values
func Str(v any) string {
	if !Truthy(v) {
		if f, ok := v.(float64); ok && f == 0 {
			return ""
		}
		return ""
	}
	return JSString(v)
}

// Obj a JSON value as an object, nil when it isn't one
func Obj(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// Decode raw JSON into a generic value
func Decode(raw []byte) any {
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return nil
	}
	return v
}
