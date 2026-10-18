package mcp

// the mesh's health and control past the files and chat: versions, tunnels,
// services, power, containers, update history, terminals, the audit

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"path"
	"sort"
	"strings"

	"github.com/pmghartman/phosphorus/internal/files"
	"github.com/pmghartman/phosphorus/internal/util"
)

// schemaHash the tools a caller sees, names and schemas, short
func schemaHash(local bool, caller *Caller) (string, int) {
	h := sha256.New()
	n := 0
	for i := range tools {
		if visible(&tools[i], local, caller) {
			h.Write([]byte(tools[i].name))
			h.Write(util.Marshal(tools[i].schema))
			n++
		}
	}
	return hex.EncodeToString(h.Sum(nil))[:12], n
}

// hiddenWhy why a tool isn't on a caller's list
func hiddenWhy(t *tool, caller *Caller) string {
	switch {
	case t.project:
		return "the orangutan's, inside a project"
	case t.scope == "ask":
		return "for the mesh's own model answering in the chat"
	case t.admin && caller != nil && !caller.Admin:
		return "admins only"
	case t.scope == "key":
		return "on a user's key only"
	}
	return "read-only callers see read tools alone"
}

func controlTools(local func(m Meta) bool) []tool {
	pathArg := map[string]any{"type": "string", "description": "the file or folder, relative to the share's root"}
	return []tool{
		{name: "version", read: true,
			description: "This server's version and its tool list's: the schema hash changes whenever the tools you see do. " +
				"Also which tools are kept off your list and why, so a missing one is never a mystery.",
			schema: object(nil),
			run: func(_ map[string]any, m Meta) (any, error) {
				isLocal := local(m)
				hash, n := schemaHash(isLocal, m.Caller)
				hidden := map[string]string{}
				for i := range tools {
					if !visible(&tools[i], isLocal, m.Caller) {
						hidden[tools[i].name] = hiddenWhy(&tools[i], m.Caller)
					}
				}
				who := "an unkeyed peer"
				switch {
				case m.Caller != nil && m.Caller.Admin:
					who = m.Caller.User + ", admin"
				case m.Caller != nil:
					who = m.Caller.User
				case isLocal:
					who = "the mesh's own model"
				}
				return map[string]any{"server": src.Self()["version"], "host": src.Self()["host"], "protocol": protocol,
					"schema": hash, "tools": n, "caller": who, "hidden": hidden}, nil
			}},
		{name: "mesh_health", read: true, scope: "key",
			description: "Every phosphorus host's health at once: answering or not, its version, round trip from this host in ms, " +
				"and its Cloudflare tunnel (up with its edge connections, down and why, or off on a tailnet-only host). For a slow or flaky mesh.",
			schema: object(nil),
			run: func(_ map[string]any, m Meta) (any, error) {
				return pressed(src.Actions.Op("", "mesh_health", nil))
			}},
		{name: "service_health", read: true, scope: "key",
			description: "One declared service checked right now on its host: listening on its port or not, its HTTP status, whether " +
				"it's published, and why not when it isn't. After service_edit, or when a service has gone missing.",
			schema: object(map[string]any{"host": name, "name": map[string]any{"type": "string"}}, "host", "name"),
			run: func(a map[string]any, m Meta) (any, error) {
				h, err := knownHost(a)
				if err != nil {
					return nil, err
				}
				return pressed(src.Actions.Op(h, "service_health", map[string]any{"name": str(a["name"])}))
			}},
		{name: "host_power", scope: "key", admin: true, destructive: true,
			description: "Restart phosphorus on a host, or reboot the machine. Its terminals and services drop until it's back. " +
				"confirm must repeat the host's name. Admins only.",
			schema: object(map[string]any{"host": name, "action": map[string]any{"type": "string", "enum": []any{"restart", "reboot"}},
				"confirm": map[string]any{"type": "string", "description": "the host's name again"}}, "host", "action", "confirm"),
			run: func(a map[string]any, m Meta) (any, error) {
				if err := adminOf(m); err != nil {
					return nil, err
				}
				h, err := knownHost(a)
				if err != nil {
					return nil, err
				}
				if str(a["confirm"]) != h {
					return nil, errc("bad_input", "confirm must be %s", h)
				}
				return pressed(src.Actions.Op(h, "power", map[string]any{"action": str(a["action"])}))
			}},
		{name: "containers", read: true, scope: "key", admin: true,
			description: "A host's docker containers, running or stopped: name, image, state, status and ports. host_logs with " +
				"source container:<name> reads one's log. Admins only.",
			schema: object(map[string]any{"host": name}, "host"),
			run: func(a map[string]any, m Meta) (any, error) {
				if err := adminOf(m); err != nil {
					return nil, err
				}
				h, err := knownHost(a)
				if err != nil {
					return nil, err
				}
				return pressed(src.Actions.Op(h, "containers", nil))
			}},
		{name: "container_control", scope: "key", admin: true, destructive: true,
			description: "Start, stop or restart one docker container on a host; returns its state after. Admins only.",
			schema: object(map[string]any{"host": name, "name": map[string]any{"type": "string"},
				"action": map[string]any{"type": "string", "enum": []any{"start", "stop", "restart"}}}, "host", "name", "action"),
			run: func(a map[string]any, m Meta) (any, error) {
				if err := adminOf(m); err != nil {
					return nil, err
				}
				h, err := knownHost(a)
				if err != nil {
					return nil, err
				}
				return pressed(src.Actions.Op(h, "container", map[string]any{"name": str(a["name"]), "action": str(a["action"])}))
			}},
		{name: "update_history", read: true, scope: "key",
			description: "The mesh updates started from this host, the last fifty, newest last: when, each host's result and the error " +
				"text of any that failed. update_control start with hosts retries the failed ones.",
			schema: object(nil),
			run: func(_ map[string]any, m Meta) (any, error) {
				return pressed(src.Actions.Op("", "update_history", nil))
			}},
		{name: "chat_edit", scope: "key",
			description: "Edit or delete one of your own chat lines by its ref from chat_history; deleting an invite from show_file withdraws it.",
			schema: object(map[string]any{"ref": map[string]any{"type": "string", "description": "host:seq, from chat_history"},
				"action": map[string]any{"type": "string", "enum": []any{"edit", "delete"}},
				"text":   map[string]any{"type": "string", "description": "edit only: the new text"}}, "ref", "action"),
			run: func(a map[string]any, m Meta) (any, error) {
				if m.Caller == nil {
					return nil, errc("forbidden", "on a user's key only")
				}
				return pressed(src.Actions.ChatEdit(m.Caller.User, str(a["ref"]), str(a["action"]), str(a["text"])))
			}},
		{name: "terminal_run", scope: "key", destructive: true,
			description: "Run a command as you in your own shared, logged-in terminal on a host, with exactly the rights that login has, " +
				"and return the screen once its output settles. open_terminal first opens one there, logged in with your saved login for " +
				"that host (none saved: nothing opens). Read each result before the next command. Never types a password: a prompt " +
				"asking for one is left for you. " + noCreds,
			schema: object(map[string]any{"host": name,
				"command": map[string]any{"type": "string", "description": "one line, run as typed"},
				"id":      map[string]any{"type": "string", "description": "terminal id from terminal_screen, if several are shared"},
				"wait_s":  map[string]any{"type": "integer", "description": "seconds to wait for output to settle, up to 120", "default": 30}}, "host", "command"),
			run: func(a map[string]any, m Meta) (any, error) {
				if m.Caller == nil {
					return nil, errc("forbidden", "on a user's key only; the chat's model uses terminal_type")
				}
				h, err := knownHost(a)
				if err != nil {
					return nil, err
				}
				cmd := str(a["command"])
				if strings.ContainsAny(cmd, "\r\n") {
					return nil, errc("bad_input", "one line only")
				}
				w := int(numOr(a["wait_s"], 30))
				if w < 1 || w > waitMaxS {
					return nil, errc("bad_input", "wait_s is 1 to %d", waitMaxS)
				}
				out, err := typeTerminal(h, cmd, str(a["id"]), w, m.Caller.User, true)
				if err != nil {
					return nil, errc("not_found", "%s; open_terminal opens one logged in with your saved login", err.Error())
				}
				return out, nil
			}},
		{name: "terminal_close", scope: "key",
			description: "Close one of your shared terminal tabs on a host by its id from terminal_screen; it ends for every window on it.",
			schema:      object(map[string]any{"host": name, "id": map[string]any{"type": "string"}}, "host", "id"),
			run: func(a map[string]any, m Meta) (any, error) {
				as, err := askerOf(m)
				if err != nil {
					return nil, err
				}
				h, err := knownHost(a)
				if err != nil {
					return nil, err
				}
				return pressed(src.Actions.Op(h, "term_close", map[string]any{"by": as.Name, "id": str(a["id"])}))
			}},
		{name: "files_stat", read: true,
			description: "One file or folder in a share: whether it exists, file or folder, size and modified time. Cheaper than reading it.",
			schema:      object(map[string]any{"host": name, "share": map[string]any{"type": "string"}, "path": pathArg}, "host", "share", "path"),
			run: func(a map[string]any, m Meta) (any, error) {
				h, err := knownHost(a)
				if err != nil {
					return nil, err
				}
				p := strings.Trim(str(a["path"]), "/")
				if p == "" {
					return map[string]any{"path": "", "exists": true, "folder": true}, nil
				}
				dir, base := path.Split(p)
				v, err := pressed(src.Actions.Files(m.Caller, h, "list", str(a["share"]), map[string]any{"path": dir}))
				if err != nil {
					var te *toolError
					if errors.As(err, &te) && te.code == "not_found" {
						return map[string]any{"path": p, "exists": false}, nil
					}
					return nil, err
				}
				for _, e := range arr(util.Obj(toAny(v))["entries"]) {
					x := util.Obj(e)
					if str(x["name"]) != base {
						continue
					}
					out := map[string]any{"path": p, "exists": true, "folder": x["dir"] == true, "mtime": x["mtime"]}
					if x["dir"] != true {
						out["size"] = x["size"]
					}
					return out, nil
				}
				return map[string]any{"path": p, "exists": false}, nil
			}},
		{name: "audit_log", read: true, scope: "key",
			description: "Every write made through a key on this host, newest last: when, who, through which agent, the tool, its " +
				"arguments and whether it went through. Your own; an admin may ask for everyone's.",
			schema: object(map[string]any{"all": map[string]any{"type": "boolean", "default": false},
				"limit": map[string]any{"type": "integer", "description": "up to 500", "default": 100}}),
			run: func(a map[string]any, m Meta) (any, error) {
				if m.Caller == nil {
					return nil, errc("forbidden", "on a user's key only")
				}
				all := a["all"] == true
				if all && !m.Caller.Admin {
					return nil, errc("forbidden", "everyone's is for admins")
				}
				n := int(numOr(a["limit"], 100))
				if n < 1 || n > 500 {
					return nil, errc("bad_input", "limit is 1 to 500")
				}
				rows := auditRows(m.Caller.User, all, n)
				sort.SliceStable(rows, func(i, j int) bool { return str(rows[i]["at"]) < str(rows[j]["at"]) })
				return map[string]any{"host": src.Self()["host"], "rows": rows}, nil
			}},
	}
}

var _ = files.JSNumber
