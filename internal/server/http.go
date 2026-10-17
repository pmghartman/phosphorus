package server

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/pmghartman/phosphorus/internal/mesh"
	"github.com/pmghartman/phosphorus/internal/proxy"
	"github.com/pmghartman/phosphorus/internal/util"
)

const (
	maxJSONBody = 64 * 1024
	maxSaveBody = 2 * 1024 * 1024
)

func sendJSON(w http.ResponseWriter, status int, body any) {
	if r, ok := body.(json.RawMessage); ok {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", strconv.Itoa(len(r)))
		w.WriteHeader(status)
		w.Write(r)
		return
	}
	b := util.Marshal(body)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(b)))
	w.WriteHeader(status)
	w.Write(b)
}

func plain(w http.ResponseWriter, status int, text string) {
	w.WriteHeader(status)
	io.WriteString(w, text)
}

func forbidden(w http.ResponseWriter) { plain(w, 403, "forbidden") }

func isLoopback(r *http.Request) bool {
	return !proxy.IsIngress(r) && proxy.IsLoopbackAddr(proxy.RemoteIP(r))
}

func isTailnet(r *http.Request) bool {
	a := proxy.RemoteIP(r)
	return !proxy.IsIngress(r) && proxy.IsTailnetAddr(a) && mesh.Trusted(a)
}

// meshOnly the frontend port: loopback and tailnet sockets alone, by a Host
// no page can rebind
func meshOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		remote, local := proxy.RemoteIP(r), ""
		if a, ok := r.Context().Value(http.LocalAddrContextKey).(net.Addr); ok {
			if h, _, err := net.SplitHostPort(a.String()); err == nil {
				local = strings.TrimPrefix(h, "::ffff:")
			}
		}
		lo := proxy.IsLoopbackAddr(remote) && proxy.IsLoopbackAddr(local)
		tail := proxy.IsTailnetAddr(remote) && proxy.IsTailnetAddr(local)
		if !(lo || tail) || !unrebindable(r.Host) {
			forbidden(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// unrebindable an address, a bare name or a tailnet one
func unrebindable(host string) bool {
	h := host
	if x, _, err := net.SplitHostPort(host); err == nil {
		h = x
	}
	h = strings.TrimSuffix(strings.ToLower(strings.Trim(h, "[]")), ".")
	return net.ParseIP(h) != nil || !strings.Contains(h, ".") || strings.HasSuffix(h, ".ts.net")
}

// crossSite a write or socket from another site's page
func crossSite(r *http.Request) bool {
	switch r.Method {
	case "GET", "HEAD", "OPTIONS":
		return proxy.IsUpgrade(r) && !sameOrigin(r)
	}
	return !sameOrigin(r)
}

func isBrowser(r *http.Request) bool     { return proxy.IsIngress(r) || isLoopback(r) }
func isLocalOrPeer(r *http.Request) bool { return isBrowser(r) || isTailnet(r) }

var errTooLarge = errors.New("body too large")

func readRaw(r *http.Request, max int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r.Body, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, errTooLarge
	}
	return b, nil
}

// onJSON a JSON body in, status and body out, bad JSON {} or a strict 400
func onJSON(w http.ResponseWriter, r *http.Request, max int64, strict bool, handle func(p map[string]any) (int, any)) {
	b, err := readRaw(r, max)
	if err != nil {
		plain(w, 400, "bad request")
		return
	}
	if len(b) == 0 {
		b = []byte("{}")
	}
	var v any
	if json.Unmarshal(b, &v) != nil {
		if strict {
			sendJSON(w, 400, map[string]any{"error": "invalid json"})
			return
		}
		v = map[string]any{}
	}
	p, ok := v.(map[string]any)
	if !ok {
		// JS's `|| {}` keeps arrays and other truthy values; handlers read keys off them as undefined
		p = map[string]any{}
	}
	status, body := handle(p)
	sendJSON(w, status, body)
}

func sameOrigin(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return true
	}
	u, err := url.Parse(o)
	return err == nil && u.Host == r.Host
}
