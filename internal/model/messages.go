package model

// the Anthropic Messages API on the mesh's models, for claude code: a user's
// key, a role or a host as the model, llama-server's own /v1/messages answering

import (
	"net/http"
	"strings"
	"time"

	"github.com/pmghartman/phosphorus/internal/users"
	"github.com/pmghartman/phosphorus/internal/util"
)

// anthErr an error as the Anthropic API words it
func anthErr(w http.ResponseWriter, status int, typ, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(util.Marshal(map[string]any{"type": "error", "error": map[string]any{"type": typ, "message": msg}}))
}

// keyOf the caller's key: a bearer token or x-api-key, as claude sends either
func keyOf(r *http.Request) string {
	if k, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok {
		return strings.TrimSpace(k)
	}
	return strings.TrimSpace(r.Header.Get("X-Api-Key"))
}

// gate a live user key, or none at all where open: a mesh peer's hop naming a
// host, a peer listing the models; else a written refusal
func gate(r *http.Request, w http.ResponseWriter, open bool) bool {
	k := keyOf(r)
	if k == "" && open {
		return true
	}
	if k == "" {
		anthErr(w, 401, "authentication_error", "a phosphorus key as the bearer token or x-api-key")
		return false
	}
	if s, why := users.CheckMCPKey(k); s == nil && !open {
		anthErr(w, 401, "authentication_error", "key refused: "+why)
		return false
	}
	return true
}

// Target the model asked for as a role or a pinned host: chimp, orangutan,
// phosphorus/<host>; any other name (claude's own) its nearest role
func Target(m string) (host, role string) {
	m = strings.TrimSpace(strings.ToLower(m))
	if h := meshHost(m); h != "" {
		return h, ""
	}
	for _, r := range Roles {
		if m == r {
			return "", r
		}
	}
	if strings.Contains(m, "haiku") || strings.Contains(m, "small") || strings.Contains(m, "fast") {
		return "", "chimp"
	}
	return "", "orangutan"
}

// anthUsage the Anthropic usage as measure reads chat's
func anthUsage(u map[string]any) map[string]any {
	if u == nil {
		return nil
	}
	in := n(u["input_tokens"]) + n(u["cache_read_input_tokens"]) + n(u["cache_creation_input_tokens"])
	return map[string]any{"prompt_tokens": in, "completion_tokens": n(u["output_tokens"])}
}

// chatShaped the system and messages as measure reads a chat's
func chatShaped(p map[string]any) []any {
	out := []any{}
	if s := textOf(p["system"]); s != "" {
		out = append(out, map[string]any{"role": "system", "content": s})
	}
	if ms, ok := p["messages"].([]any); ok {
		out = append(out, ms...)
	}
	return out
}

// ServeMessages POST /api/model/v1/messages[/count_tokens]: sub "" or
// "/count_tokens", peer a tailnet or loopback caller
func ServeMessages(r *http.Request, p map[string]any, w http.ResponseWriter, sub string, peer bool) {
	if sub != "" && sub != "/count_tokens" {
		anthErr(w, 404, "not_found_error", "no such endpoint")
		return
	}
	host, role := Target(util.Str(p["model"]))
	if !gate(r, w, peer && host != "") {
		return
	}
	if _, ok := p["messages"].([]any); !ok {
		anthErr(w, 400, "invalid_request_error", "messages: an array")
		return
	}
	states := view()
	var s map[string]any
	if role != "" {
		_, s = resolve(states, role)
	} else {
		for _, x := range runners(states) {
			if x["host"] == host {
				s = x
			}
		}
	}
	if s == nil || s["server"] != "ready" {
		anthErr(w, 529, "overloaded_error", excuse(states, s))
		return
	}
	h := util.JSString(s["host"])
	body := p
	if sub == "" && role != "" {
		body = profiled(p, role)
	}
	if h != selfHost {
		hop := map[string]any{}
		for k, v := range body {
			hop[k] = v
		}
		hop["model"] = Mesh + "/" + h
		forward(r, util.JSString(s["ip"]), util.FrontendPort, "/api/model/v1/messages"+sub, hop, h, w)
		return
	}
	out := forward(r, "127.0.0.1", serverPort, "/v1/messages"+sub, body, "llama-server on "+h, w)
	if out.ok && sub == "" {
		msgs := chatShaped(p)
		go func() {
			defer func() { recover() }()
			measure(msgs, p["tools"], anthUsage(out.usage), out.genMS)
		}()
	}
}

// ServeModels GET /api/model/v1/models: the roles, as the Anthropic API lists models
func ServeModels(r *http.Request, w http.ResponseWriter, peer bool) {
	if !gate(r, w, peer) {
		return
	}
	states := view()
	data := []any{}
	at := time.Now().UTC().Format(time.RFC3339)
	for _, ro := range Roles {
		_, s := resolve(states, ro)
		data = append(data, map[string]any{"type": "model", "id": ro, "display_name": ro, "created_at": at,
			"ready": s != nil && s["server"] == "ready"})
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(200)
	w.Write(util.Marshal(map[string]any{"data": data, "has_more": false, "first_id": Roles[0], "last_id": Roles[len(Roles)-1]}))
}
