package mcp

// the tools for an agent outside the mesh, on a user's key, and every tool's
// description written for one: what it does, what it returns, what to use next

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/pmghartman/phosphorus/internal/util"
)

const chatWaitMax = 300

var loc = func(what string) map[string]any {
	return object(map[string]any{
		"host":  map[string]any{"type": "string", "description": what + " host, as mesh_hosts lists it"},
		"share": map[string]any{"type": "string", "description": "share id, from files_list"},
		"path":  map[string]any{"type": "string", "description": "the file, relative to the share's root"},
	}, "host", "share", "path")
}

func locOf(v any) ([3]string, error) {
	o := util.Obj(v)
	l := [3]string{str(o["host"]), str(o["share"]), str(o["path"])}
	if !nameRe.MatchString(l[0]) || l[1] == "" || l[2] == "" {
		return l, errors.New("each of from and to needs host, share and path")
	}
	return l, nil
}

// chatRows the chat as a caller may read it: channels, and a key's own direct messages
func chatRows(m Meta, want string) []map[string]any {
	me := ""
	if m.Caller != nil {
		me = m.Caller.User
	}
	out := []map[string]any{}
	for _, x := range src.Chat() {
		k := str(x["kind"])
		if k != "" && k != "model" && k != "dm" {
			continue
		}
		ch := str(x["ch"])
		if ch == "" {
			ch = "mesh"
		}
		if dm := str(x["dm"]); dm != "" {
			if me == "" || (dm != me && str(x["name"]) != me) {
				continue
			}
			other := dm
			if dm == me {
				other = str(x["name"])
			}
			ch = "dm:" + other
		}
		if want != "" && ch != want {
			continue
		}
		ts, _ := x["timestamp"].(float64)
		row := map[string]any{"at": time.UnixMilli(int64(ts)).UTC().Format("2006-01-02T15:04:05.000Z"), "ms": int64(ts), "channel": ch, "name": x["name"], "text": x["text"]}
		if fs, ok := x["files"].([]any); ok {
			names := []any{}
			for _, f := range fs {
				names = append(names, util.Obj(f)["name"])
			}
			row["files"] = names
		}
		out = append(out, row)
	}
	return out
}

func agentTools() []tool {
	return []tool{
		{name: "files_search", read: true,
			description: "Find files by name, or by text inside them, across every host's shares at once or one host and share. " +
				"Case-insensitive; content searches read text files up to 1MB and return each file's first matching lines. " +
				"Use it before files_read when you don't know where something lives. Home (the merged per-user share) only on a key, and only your own part.",
			schema: object(map[string]any{
				"query":   map[string]any{"type": "string", "description": "text to find in names, or in contents with content"},
				"content": map[string]any{"type": "boolean", "description": "search inside files, not names", "default": false},
				"glob":    map[string]any{"type": "string", "description": "only names matching, like *.go or *.md"},
				"host":    map[string]any{"type": "string", "description": "one host, blank for every host"},
				"share":   map[string]any{"type": "string", "description": "one share id, blank for all of the host's"},
				"path":    map[string]any{"type": "string", "description": "a folder to search under, with share"},
			}),
			run: func(a map[string]any, m Meta) (any, error) {
				hosts := []string{}
				if h := str(a["host"]); h != "" {
					if !nameRe.MatchString(h) {
						return nil, errors.New("bad host")
					}
					hosts = append(hosts, h)
				} else {
					for _, x := range meshHosts() {
						hosts = append(hosts, x)
					}
				}
				body := map[string]any{"query": a["query"], "content": a["content"] == true, "glob": a["glob"], "path": a["path"]}
				out := []any{}
				for _, h := range hosts {
					shares := []string{}
					if sh := str(a["share"]); sh != "" {
						shares = append(shares, sh)
					} else {
						st, b := src.Actions.Files(m.Caller, h, "info", "", map[string]any{})
						if st >= 300 {
							continue
						}
						for _, x := range arr(util.Obj(toAny(b))["shares"]) {
							id := str(util.Obj(x)["id"])
							if id == "home" && m.Caller == nil {
								continue
							}
							shares = append(shares, id)
						}
					}
					for _, sh := range shares {
						st, b := src.Actions.Files(m.Caller, h, "search", sh, body)
						r := util.Obj(toAny(b))
						if st >= 300 {
							out = append(out, map[string]any{"host": h, "share": sh, "error": r["error"]})
							continue
						}
						if rs := arr(r["results"]); len(rs) > 0 || r["truncated"] == true {
							row := map[string]any{"host": h, "share": sh, "results": rs}
							if r["truncated"] == true {
								row["truncated"] = true
							}
							out = append(out, row)
						}
					}
				}
				return map[string]any{"found": out}, nil
			}},
		{name: "files_copy", destructive: true,
			description: "Copy one file from a share to a share, on the same host or across hosts, any size and any kind " +
				"(binary too), streamed host to host. move deletes the original once the copy lands. An existing file at to is replaced. Folders aren't copied: copy each file.",
			schema: object(map[string]any{"from": loc("source"), "to": loc("target"),
				"move": map[string]any{"type": "boolean", "default": false}}, "from", "to"),
			run: func(a map[string]any, m Meta) (any, error) {
				if _, err := askerOf(m); err != nil {
					return nil, err
				}
				from, err := locOf(a["from"])
				if err != nil {
					return nil, err
				}
				to, err := locOf(a["to"])
				if err != nil {
					return nil, err
				}
				return pressed(src.Actions.Copy(m.Caller, from, to, a["move"] == true))
			}},
		{name: "host_logs", read: true, scope: "key",
			description: "A host's phosphorus log (systemd's journal on Linux, phosphorus.log on macOS and Windows): its last lines, " +
				"or the last ones holding match. The first stop when a host, service, update or git replica misbehaves. Admins only.",
			schema: object(map[string]any{"host": name,
				"lines": map[string]any{"type": "integer", "description": "how many, up to 2000", "default": 200},
				"match": map[string]any{"type": "string", "description": "only lines holding this, case-insensitive"}}, "host"),
			run: func(a map[string]any, m Meta) (any, error) {
				if err := adminOf(m); err != nil {
					return nil, err
				}
				h, err := hostOf(a)
				if err != nil {
					return nil, err
				}
				return pressed(src.Actions.Logs(h, int(numOr(a["lines"], 200)), str(a["match"])))
			}},
		{name: "host_config", read: true, scope: "key",
			description: "A host's two config files as they stand: phosphorus.ini (shares in [files], [git], [model], [home]) and " +
				"services.export (each [service]: port, scheme, mode, base_path, public, type game with start/stop). Read before service_edit or config_set. Admins only.",
			schema: object(map[string]any{"host": name}, "host"),
			run: func(a map[string]any, m Meta) (any, error) {
				if err := adminOf(m); err != nil {
					return nil, err
				}
				h, err := hostOf(a)
				if err != nil {
					return nil, err
				}
				return pressed(src.Actions.Config(h, map[string]any{"op": "get"}))
			}},
		{name: "service_edit", scope: "key", destructive: true,
			description: "Publish, change or remove a service in a host's services.export, as the terminal UI's form does, the whole file " +
				"checked before it's written and live within seconds. fields only change the keys given; a blank value drops one. " +
				"Web: port (required), scheme http|https, mode path|subdomain, base_path, public true. Game: type game, port, start and stop commands. Admins only.",
			schema: object(map[string]any{"host": name,
				"name":   map[string]any{"type": "string", "description": "the service, lowercase letters, digits and -"},
				"fields": map[string]any{"type": "object", "description": "keys to set, e.g. {\"port\":\"8096\",\"public\":\"true\"}", "additionalProperties": map[string]any{"type": "string"}},
				"remove": map[string]any{"type": "boolean", "default": false}}, "host", "name"),
			run: func(a map[string]any, m Meta) (any, error) {
				if err := adminOf(m); err != nil {
					return nil, err
				}
				h, err := hostOf(a)
				if err != nil {
					return nil, err
				}
				return pressed(src.Actions.Config(h, map[string]any{"op": "service", "name": a["name"], "fields": a["fields"], "remove": a["remove"]}))
			}},
		{name: "config_set", scope: "key", destructive: true,
			description: "Set one key of a host's phosphorus.ini, blank value to drop it; phosphorus applies it within seconds. " +
				"[files] dir and priv list the shares and their rwd perms, comma-separated in step; [git] host, [model] host/gpu/url, [home] are the rest. " +
				"Read host_config first and keep the other values. Admins only.",
			schema: object(map[string]any{"host": name,
				"section": map[string]any{"type": "string"}, "key": map[string]any{"type": "string"}, "value": map[string]any{"type": "string"}}, "host", "section", "key", "value"),
			run: func(a map[string]any, m Meta) (any, error) {
				if err := adminOf(m); err != nil {
					return nil, err
				}
				h, err := hostOf(a)
				if err != nil {
					return nil, err
				}
				return pressed(src.Actions.Config(h, map[string]any{"op": "ini", "section": a["section"], "key": a["key"], "value": a["value"]}))
			}},
		{name: "chat_wait", read: true, scope: "key",
			description: "Wait for new chat lines: in a channel, a direct message with someone (dm:<name>), or anywhere you can read, " +
				"returning as soon as one lands or after wait_s with none. Pass since (the ms of the last line you saw) to never miss one. " +
				"For waiting on a reply after send_message.",
			schema: object(map[string]any{
				"channel": map[string]any{"type": "string", "description": "mesh, a channel, or dm:<name>; blank for all"},
				"since":   map[string]any{"type": "integer", "description": "only lines after this ms, default now"},
				"wait_s":  map[string]any{"type": "integer", "description": fmt.Sprintf("seconds to wait, up to %d", chatWaitMax), "default": 60}}),
			run: func(a map[string]any, m Meta) (any, error) {
				want := strings.TrimPrefix(str(a["channel"]), "#")
				since := int64(numOr(a["since"], float64(time.Now().UnixMilli())))
				end := time.Now().Add(time.Duration(math.Min(chatWaitMax, math.Max(1, numOr(a["wait_s"], 60)))) * time.Second)
				for {
					fresh := []map[string]any{}
					for _, r := range chatRows(m, want) {
						if r["ms"].(int64) > since {
							fresh = append(fresh, r)
						}
					}
					if len(fresh) > 0 || time.Now().After(end) {
						return map[string]any{"lines": fresh, "now": time.Now().UnixMilli()}, nil
					}
					time.Sleep(time.Second)
				}
			}},
		{name: "notify", scope: "key",
			description: "A notification on your own open Phosphorus windows: the client's native one, or the browser's when allowed. " +
				"For telling the person something finished or needs them while they're elsewhere.",
			schema: object(map[string]any{"title": map[string]any{"type": "string"}, "body": map[string]any{"type": "string"}}, "title"),
			run: func(a map[string]any, m Meta) (any, error) {
				as, err := askerOf(m)
				if err != nil {
					return nil, err
				}
				if !as.UI(map[string]any{"kind": "notify", "title": clip(str(a["title"]), 120), "body": clip(str(a["body"]), 400)}) {
					return nil, errors.New("no Phosphorus window of yours is open")
				}
				return map[string]any{"sent": true}, nil
			}},
		{name: "service_request", scope: "key", open: true,
			description: "One HTTP request to a web service published on the mesh, straight to it over the tailnet, past phosphorus's login: " +
				"its API by path. headers carry the service's own auth when it wants one (e.g. an API token the person gave you). " +
				"Returns status, content type and the body as json or text, up to 512KB.",
			schema: object(map[string]any{
				"service": map[string]any{"type": "string", "description": "the service's name, from services"},
				"host":    map[string]any{"type": "string", "description": "its host, when several publish the name"},
				"method":  map[string]any{"type": "string", "default": "GET"},
				"path":    map[string]any{"type": "string", "description": "under the service's root, with any query"},
				"headers": map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "string"}},
				"body":    map[string]any{"type": "string", "description": "the request body, JSON as text"}}, "service", "path"),
			run: func(a map[string]any, m Meta) (any, error) {
				if _, err := askerOf(m); err != nil {
					return nil, err
				}
				hs := map[string]string{}
				for k, v := range util.Obj(a["headers"]) {
					hs[k] = util.JSString(v)
				}
				return pressed(src.Actions.Service(str(a["host"]), str(a["service"]), str(a["method"]), str(a["path"]), hs, str(a["body"])))
			}},
	}
}

// meshHosts this host then every phosphorus peer
func meshHosts() []string {
	hosts := []string{str(src.Self()["host"])}
	seen := map[string]bool{hosts[0]: true}
	for _, h := range src.Tailnet() {
		n := str(h["name"])
		if h["phosphorus"] == true && !seen[n] {
			seen[n] = true
			hosts = append(hosts, n)
		}
	}
	return hosts
}

// describe every tool's text, written for an agent
func describe() {
	d := map[string]string{
		"mesh_hosts": "Start here. Every device on the mesh's tailnet: name, OS, whether it runs phosphorus (only those are hosts you can act on), " +
			"plus this host and the mesh's domain. Host names from here are what every other tool's host takes.",
		"services": "Every web service and game server published on the mesh: host, name, port, mode, public, and the URL a person opens. " +
			"service_request calls one's API; game_power starts or stops a game.",
		"host_stats": "One host right now: cpu, memory, disk, gpu, network, containers and the top processes. For a slow or full host.",
		"git":        "The git (Forgejo) hosts: which is master, which are replicas, how far behind each is, reachable or not.",
		"files_list": "Browse files shared to the mesh. No host: every host's shares and their rwd perms. A host: its shares. A host and share: " +
			"entries to depth levels (folders end in /), match a name glob like *.jpg. files_search finds things across everything at once.",
		"files_read": "Read a text file from a share, 12000 characters a page; from is the next page's offset when there's more. Binary and over-512KB files are only described.",
		"files_write": "Write a text file in a share with w perm: text for the whole file (made if missing), or old and new to replace one exact passage " +
			"found once in it (read it first). If someone has it open in an editor, the change shows there live.",
		"files_change": "Organize a share within its perms: mkdir, rename or move (to ending in / moves into that folder), delete (permanent). " +
			"Several in steps run in order and stop at the first failure.",
		"chat_history": "The last chat lines, oldest first: channels (mesh is the main one), and on a key your own direct messages as dm:<name>. " +
			"Each line has its ms for chat_wait's since.",
		"send_message": "Post to the mesh chat, or a direct message to one person by their chat name. On a key it's posted as you.",
		"open_file": "Open a share's text or code file in an editor tab on the person's Phosphorus window (on a key, every window of yours that's open). " +
			"Highlighted, syntax errors marked; nothing in it runs.",
		"open_view":       "Bring a view up on the person's Phosphorus window: home, files, status, about, chat, projects or update.",
		"open_terminal":   "Open a terminal tab to a host on the person's Phosphorus window; they log in themselves. terminal_screen then reads it.",
		"switch_host":     "Move the person's Phosphorus window to be served by another host.",
		"show_file":       "Invite a person into a share's file in the shared editor: they get a dialog and a notification, and it opens in a tab on accepting.",
		"terminal_screen": "Read the screen and recent scrollback of the person's terminal tabs that are shared with phosphorus on one host. wait_s waits for new output first.",
		"terminal_type": "Type one command into the person's shared, logged-in terminal and leave it for them: they press Enter to run it or Ctrl-C to refuse. " +
			"Returns the screen once it runs and settles. Read each result before the next. " + noCreds,
		"game_power":      "Start or stop a game server, running only the start or stop command its service declares.",
		"update_status":   "The mesh update: whether one runs, who started it, each host's step and result.",
		"update_control":  "Continue a paused mesh update or cancel the running one. Starting one isn't possible here. Admins only.",
		"make_git_master": "Make a git host the master: the live one hands off, or with none it's force-promoted. Returns once it leads (up to 30s); never press it twice. Admins only.",
		"set_model_role":  "Pick the chimp's (chat) or orangutan's (projects) model mesh-wide: provider/model, phosphorus/<host> for a mesh host's own, blank for the default. Admins only.",
		"models":          "The models: each role's model chosen and answering, providers with a key, each mesh model host's file, state and memory, and the last ask's context use.",
		"projects":        "The long projects the mesh's own model works on, on every host: title, who set it, status, phase, progress and deadline.",
		"people":          "Who is on phosphorus right now: each person, the host serving them, and whether they are typing.",
		"fetch_page":      "A public web page's readable text, for a link someone gave or an address known for sure.",
	}
	for i := range tools {
		if t, ok := d[tools[i].name]; ok {
			tools[i].description = t
		}
	}
	for i := range tools {
		switch tools[i].name {
		case "files_change", "game_power", "update_control", "make_git_master":
			tools[i].destructive = true
		case "fetch_page":
			tools[i].open = true
		}
	}
}

// arr any list as []any, typed or decoded
func arr(v any) []any {
	var out []any
	json.Unmarshal(util.Marshal(v), &out)
	return out
}
