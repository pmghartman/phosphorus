//go:build (darwin && cgo) || windows

package main

// the keys form in the browser, served by the tray on this machine alone behind
// a random path: which keys are set, never their values; the typed ones into .env

import (
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/theme"
)

//go:embed assets/keys.html
var keysHTML string

// the form in the theme library's colors, the mesh's own, light or dark as the system is
var keysPage = []byte(strings.Replace(keysHTML, "/*theme*/", keysTheme(), 1))

func keysTheme() string {
	l := theme.Load()
	vars := func(t theme.Tokens) string {
		return fmt.Sprintf("--bg: %s; --fg: %s; --muted: %s; --line: %s; --field: %s; --accent: %s; --ok: %s; --bad: %s;",
			t["--bg"], t["--fg"], t["--muted"], t["--border"], t["--card"], t["--accent"], t["--online"], t["--offmesh"])
	}
	return ":root { " + vars(l.Tokens(theme.Default, "light")) + " }\n  @media (prefers-color-scheme: dark) { :root { " + vars(l.Tokens(theme.Default, "dark")) + " } }"
}

var keysSrv struct {
	sync.Mutex
	base string
	// the start the last save began: done, and its error
	done bool
	err  string
}

func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// the form's address, its server started on first use
func keysURL() (string, error) {
	keysSrv.Lock()
	defer keysSrv.Unlock()
	if keysSrv.base != "" {
		return keysSrv.base, nil
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	b := make([]byte, 16)
	rand.Read(b)
	tok := "/" + hex.EncodeToString(b) + "/"
	mux := http.NewServeMux()
	host := ln.Addr().String()
	mux.HandleFunc(tok, func(w http.ResponseWriter, r *http.Request) {
		// by this address alone, never a rebound name, and never posted to by a page elsewhere
		if o := r.Header.Get("Origin"); r.Host != host || (o != "" && o != "http://"+host) {
			http.Error(w, "forbidden", 403)
			return
		}
		switch strings.TrimPrefix(r.URL.Path, tok) {
		case "":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Write(keysPage)
		case "status":
			reply(w, 200, keyStatus())
		case "save":
			saveKeys(w, r)
		case "started":
			keysSrv.Lock()
			st := map[string]any{}
			if keysSrv.done && keysSrv.err != "" {
				st["error"] = keysSrv.err
			} else if keysSrv.done {
				_, d := keyState()
				st["url"] = frontendURL(d)
			}
			keysSrv.Unlock()
			reply(w, 200, st)
		default:
			http.NotFound(w, r)
		}
	})
	go http.Serve(ln, mux)
	keysSrv.base = "http://" + host + tok
	return keysSrv.base, nil
}

// the typed keys into .env, blanks keeping what's there, then phosphorus started on them
func saveKeys(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		reply(w, 405, map[string]any{"error": "post"})
		return
	}
	var in struct{ Values map[string]string }
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in) != nil {
		reply(w, 400, map[string]any{"error": "bad request"})
		return
	}
	var body strings.Builder
	for k, v := range in.Values {
		v = strings.Join(strings.Fields(v), "")
		if v == "" || strings.Trim(k, "ABCDEFGHIJKLMNOPQRSTUVWXYZ_") != "" {
			continue
		}
		body.WriteString(k + "=" + v + "\n")
	}
	if body.Len() == 0 {
		if keysMissing() {
			reply(w, 400, map[string]any{"error": "the Tailscale auth key is needed"})
			return
		}
		reply(w, 200, map[string]any{"starting": false})
		return
	}
	c := hostCmd("keys", "--stdin")
	c.Stdin = strings.NewReader(body.String())
	if out, err := c.CombinedOutput(); err != nil {
		e := strings.TrimSpace(string(out))
		if e == "" {
			e = err.Error()
		}
		reply(w, 400, map[string]any{"error": e})
		return
	}
	if keysMissing() {
		reply(w, 400, map[string]any{"error": "the Tailscale auth key is needed"})
		return
	}
	keysSrv.Lock()
	keysSrv.done, keysSrv.err = false, ""
	keysSrv.Unlock()
	go func() {
		e := startForKeys()
		keysSrv.Lock()
		keysSrv.done, keysSrv.err = true, e
		keysSrv.Unlock()
	}()
	reply(w, 200, map[string]any{"starting": true})
}

// phosphorus (re)started on new keys, the tray following; its error, "" when up
func startForKeys() string {
	for busy.Swap(true) {
		time.Sleep(500 * time.Millisecond)
	}
	defer func() { busy.Store(false); refresh() }()
	adminSetup()
	setTip("Phosphorus starting…")
	ok, out := hostRun("start", "start")
	if ok {
		return ""
	}
	if e := lastError(out); e != "" {
		return e
	}
	return "see state/ in the Phosphorus folder"
}

// the keys form opened in the browser
func openKeys() {
	u, err := keysURL()
	if err != nil {
		alert("couldn't open the keys form: " + err.Error())
		return
	}
	openURL(u)
}
