package mcp

// the mesh's control past the files and chat: power, chat edits, terminals,
// the audit, and a file's stat for files_list

import (
	"errors"
	"math"
	"path"
	"sort"
	"strings"

	"github.com/pmghartman/phosphorus/internal/files"
	"github.com/pmghartman/phosphorus/internal/util"
)

func controlTools() []tool {
	return []tool{
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
		{name: "terminal_run", destructive: true,
			description: "Without a key (the chat's own model): types one line into the asker's shared, logged-in terminal on the host and " +
				"leaves it for them, Enter to run or Ctrl-C to refuse, returning the screen once it settles. " +
				"On a key: run a command or a whole script on a host as you, with exactly the rights of your saved login, as if you were " +
				"at its shell. With a login saved it signs in over ssh on its own, no window needed, and returns the exit code and the " +
				"combined output. With one saved it defaults to a persistent session: one login shell kept for you on the host, so cd, " +
				"environment variables and background jobs carry from one call to the next, the way your own shell session does; reset " +
				"starts it fresh. mode ssh runs each command in a fresh shell instead (no state kept); mode tab types one line into your " +
				"shared, logged-in terminal tab (open_terminal opens one) and returns its screen. stdin feeds the command's input, e.g. " +
				"cat > file to write any file the login may. git true hands git your forgejo login for clone, fetch and push over https. " +
				"Never types a password. " + noCreds,
			schema: object(map[string]any{"host": name,
				"command": map[string]any{"type": "string", "description": "run as typed by the login's shell; several lines over ssh, one in a tab"},
				"stdin":   map[string]any{"type": "string", "description": "text fed to the command's stdin (not in a tab)"},
				"git":     map[string]any{"type": "boolean", "description": "your forgejo login handed to git for the mesh's forgejo; runs in a fresh shell", "default": false},
				"mode":    map[string]any{"type": "string", "enum": []any{"auto", "session", "ssh", "tab"}, "description": "auto: a persistent session with a saved login, else a shared tab; session: persistent; ssh: fresh shell each call; tab: the shared terminal", "default": "auto"},
				"reset":   map[string]any{"type": "boolean", "description": "session: drop the kept shell and start a fresh one for this call", "default": false},
				"id":      map[string]any{"type": "string", "description": "tab only: terminal id from terminal_screen, if several are shared"},
				"wait_s":  map[string]any{"type": "integer", "description": "ssh/session: seconds before the command is killed, up to 600; tab: seconds to wait for output to settle, up to 120", "default": 60}}, "host", "command"),
			run: func(a map[string]any, m Meta) (any, error) {
				h, err := knownHost(a)
				if err != nil {
					return nil, err
				}
				cmd := str(a["command"])
				if strings.TrimSpace(cmd) == "" {
					return nil, errc("bad_input", "missing 'command'")
				}
				// the chat's model: a line left in the asker's tab for them to run or refuse
				if m.Caller == nil {
					as, err := askerOf(m)
					if err != nil {
						return nil, err
					}
					if strings.ContainsAny(cmd, "\r\n") || str(a["stdin"]) != "" || a["git"] == true {
						return nil, errc("bad_input", "one line, no stdin or git, typed into their shared terminal")
					}
					w := int(math.Min(waitMaxS, math.Max(1, numOr(a["wait_s"], 60))))
					return typeTerminal(h, cmd, str(a["id"]), w, as.Name, false)
				}
				mode := str(a["mode"])
				if mode == "" {
					mode = "auto"
				}
				var user, pass string
				saved := false
				if m.Caller.Login != nil {
					user, pass, saved = m.Caller.Login(h)
				}
				// git is a fresh shell whatever the mode: its credential helper is
				// scoped to that one process
				oneShot := mode == "ssh" || a["git"] == true
				persistent := mode == "session" || (mode == "auto" && saved && !oneShot)
				if oneShot || persistent {
					if !saved {
						return nil, errc("forbidden", "your key carries no saved login for %s: save one in the browser, the key picks it up", h)
					}
					w := int(numOr(a["wait_s"], 60))
					if w < 1 || w > 600 {
						return nil, errc("bad_input", "wait_s is 1 to 600")
					}
					stdin := str(a["stdin"])
					if a["git"] == true {
						pre, creds, err := gitCreds(m.Caller)
						if err != nil {
							return nil, err
						}
						cmd, stdin = pre+cmd, creds+stdin
					}
					if persistent {
						return pressed(src.Actions.Op(h, "shell", map[string]any{"user": user, "pass": pass, "cmd": cmd, "stdin": stdin, "timeout": float64(w), "reset": a["reset"] == true}))
					}
					return pressed(src.Actions.Op(h, "exec", map[string]any{"user": user, "pass": pass, "cmd": cmd, "stdin": stdin, "timeout": float64(w)}))
				}
				if strings.ContainsAny(cmd, "\r\n") {
					return nil, errc("bad_input", "one line only in a tab; save a login for %s to run scripts over ssh", h)
				}
				if str(a["stdin"]) != "" {
					return nil, errc("bad_input", "stdin needs a saved login for %s", h)
				}
				w := int(numOr(a["wait_s"], 30))
				if w < 1 || w > waitMaxS {
					return nil, errc("bad_input", "wait_s is 1 to %d", waitMaxS)
				}
				out, err := typeTerminal(h, cmd, str(a["id"]), w, m.Caller.User, true)
				if err != nil {
					return nil, errc("not_found", "%s; open_terminal opens one logged in with your saved login, or save a login so it runs over ssh", err.Error())
				}
				return out, nil
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

// fileStat one file or folder in a share: exists, folder, size and mtime
func fileStat(a map[string]any, m Meta) (any, error) {
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
}
