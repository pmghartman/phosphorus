package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"

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
	return !proxy.IsIngress(r) && proxy.IsTailnetAddr(proxy.RemoteIP(r))
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
