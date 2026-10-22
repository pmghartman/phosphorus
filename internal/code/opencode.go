package code

// opencode as a session's harness: one `opencode run --format json` a prompt
// in the session's folder, its own session resumed by id, the mesh's models
// its provider through the same gateway claude's are; its events turned into
// claude's stream-json shapes as they come, so every page draws both alike

import (
	"fmt"
	"strings"
	"time"

	"github.com/pmghartman/phosphorus/internal/util"
)

const (
	// ocDir opencode's config on the host, apart from the user's own
	ocDir = `"$HOME/.phosphorus/opencode"`
	// ocPath where opencode's installer puts it, ahead of a non-login PATH
	ocPath = `PATH="$HOME/.opencode/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH; `
	// ocArgMax a prompt opencode takes as an argument
	ocArgMax = 100 * 1024
)

// ocRun what one opencode run has said so far
type ocRun struct {
	start time.Time
	steps int
	in    float64
	out   float64
	cost  float64
	err   string
}

// ocConfig opencode's config: the mesh's models as an Anthropic-shaped
// provider on the gateway, phosphorus's mcp, tools allowed but in plan mode
func ocConfig(base, model, perm string) string {
	allow := "allow"
	if perm == "plan" {
		allow = "deny"
	}
	models := map[string]any{}
	for _, m := range Mesh {
		models[m] = map[string]any{"name": m}
	}
	return string(util.Marshal(map[string]any{
		"$schema": "https://opencode.ai/config.json", "autoupdate": false, "share": "disabled",
		"model": "phosphorus/" + model, "small_model": "phosphorus/chimp",
		"provider": map[string]any{"phosphorus": map[string]any{
			"npm": "@ai-sdk/anthropic", "name": "phosphorus",
			"options": map[string]any{"baseURL": base + "/api/model/v1", "apiKey": "{env:" + keyVar + "}"},
			"models":  models}},
		"mcp": map[string]any{"phosphorus": map[string]any{"type": "remote", "url": base + "/api/mcp", "enabled": true,
			"headers": map[string]any{"Authorization": "Bearer {env:" + keyVar + "}", "X-Phosphorus-Via": "opencode"}}},
		"permission": map[string]any{"edit": allow, "bash": allow, "webfetch": "allow"},
	}))
}

// ocSetup for sh -s: the config written fresh, opencode looked for
func ocSetup(base, model, perm string) string {
	eof := "PHOS_EOF_" + randHex(8)
	return "set -e\numask 077\nD=" + ocDir + "\nmkdir -p \"$D\"\n" +
		"cat > \"$D/opencode.json\" <<'" + eof + "'\n" + ocConfig(base, model, perm) + "\n" + eof + "\n" +
		ocPath + "\ncommand -v opencode >/dev/null 2>&1 || exit 127\n"
}

// ocLaunch one run in dir on prompt, its env read off stdin first, resumed
// from sid when there's one
func ocLaunch(dir, model, perm, sid, prompt string) string {
	args := []string{"opencode", "run", "--format", "json", "--model", quote("phosphorus/" + model)}
	// nobody's at a run's prompt to approve a tool: allowed, but in plan mode, where they're refused
	if perm != "plan" {
		args = append(args, "--auto")
	}
	if sid != "" {
		args = append(args, "--session", quote(sid))
	}
	args = append(args, "--", quote(prompt))
	script := ocPath +
		`while IFS= read -r l && [ -n "$l" ]; do export "$l"; done; ` +
		"OPENCODE_CONFIG=" + ocDir + "/opencode.json; export OPENCODE_CONFIG; " +
		"cd " + shDir(dir) + " || exit 3; " +
		"command -v opencode >/dev/null 2>&1 || exit 127; " +
		"exec " + strings.Join(args, " ") + " </dev/null"
	return "sh -c " + quote(script)
}

// ocBegin opencode's turn to start: nothing runs until a prompt does, the
// creds kept for the prompts; under s.mu
func (s *session) ocBegin(c Creds) error {
	if c.Key == "" || c.Base == "" {
		return fmt.Errorf("opencode needs your mcp key and the mesh's address")
	}
	if provider(s.rec.Model) != "mesh" {
		return fmt.Errorf("opencode runs on the mesh's models: %s", strings.Join(Mesh, " or "))
	}
	s.oc = &c
	s.rec.Err = ""
	if s.p == nil && len(s.queue) > 0 {
		s.ocKick()
		return nil
	}
	if s.rec.Status != "working" {
		s.status("idle")
	}
	return nil
}

// ocKick the next queued prompt run, when nothing's running; under s.mu
func (s *session) ocKick() {
	if s.p != nil || s.starting || s.oc == nil || len(s.queue) == 0 || s.deleted {
		return
	}
	text := s.queue[0]
	s.queue = s.queue[1:]
	if len(text) > ocArgMax {
		s.fail(fmt.Sprintf("opencode takes a prompt of up to %dKB", ocArgMax/1024))
		return
	}
	c := *s.oc
	setup := ocSetup(c.Base, s.rec.Model, s.rec.Perm)
	cmd := ocLaunch(s.rec.Dir, s.rec.Model, s.rec.Perm, s.rec.ClaudeSID, text)
	env := envBlock([]string{keyVar + "=" + c.Key})
	s.starting = true
	s.status("working")
	host := s.rec.Host
	go func() {
		p, err := spawn(host, c, setup, cmd, env)
		s.mu.Lock()
		defer s.mu.Unlock()
		s.starting = false
		if err != nil {
			s.queue = nil
			s.fail(strings.ReplaceAll(err.Error(), "claude", "opencode"))
			return
		}
		if s.deleted {
			p.kill()
			return
		}
		s.p, s.stopping = p, false
		s.gen++
		s.run = ocRun{start: time.Now()}
		go s.read(p, s.gen)
	}()
}

// ocExited a run over: its result told, the next prompt run; under s.mu
func (s *session) ocExited(g, code int, errs string) {
	if g != s.gen {
		return
	}
	s.p = nil
	s.gen++
	stopping := s.stopping
	s.stopping = false
	if s.deleted {
		return
	}
	r := s.run
	switch {
	case stopping:
		s.emit(map[string]any{"kind": "claude", "ev": map[string]any{"type": "result", "subtype": "error_during_execution",
			"is_error": true, "result": "stopped", "num_turns": r.steps, "duration_ms": time.Since(r.start).Milliseconds()}}, true)
		s.status("idle")
	case code == 0 && r.err == "":
		s.on(map[string]any{"type": "result", "subtype": "success", "num_turns": r.steps, "duration_ms": time.Since(r.start).Milliseconds(),
			"usage": map[string]any{"input_tokens": r.in, "output_tokens": r.out}, "total_cost_usd": r.cost})
	case code == 127:
		s.fail(missing(Opencode, s.rec.Host))
	case code == 3:
		s.fail(fmt.Sprintf("no folder %s on %s", s.rec.Dir, s.rec.Host))
	default:
		why := r.err
		if why == "" {
			why = lastLine(errs)
		}
		if why == "" {
			why = fmt.Sprintf("opencode exited with %d", code)
		}
		s.fail(why)
	}
	if !stopping {
		s.ocKick()
	}
}

// ocEvents one opencode event as claude's: its text an assistant message,
// a finished tool a tool_use and its tool_result, a step's tokens counted
func (s *session) ocEvents(ev map[string]any) []map[string]any {
	sid := util.Str(ev["sessionID"])
	part := util.Obj(ev["part"])
	with := func(m map[string]any) map[string]any {
		if sid != "" {
			m["session_id"] = sid
		}
		return m
	}
	switch util.Str(ev["type"]) {
	case "text":
		t := util.Str(part["text"])
		if strings.TrimSpace(t) == "" {
			return nil
		}
		return []map[string]any{with(map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant",
			"content": []any{map[string]any{"type": "text", "text": t}}}})}
	case "tool_use":
		st := util.Obj(part["state"])
		id := util.Str(part["callID"])
		if id == "" {
			id = util.Str(part["id"])
		}
		name, input := ocTool(util.Str(part["tool"]), util.Obj(st["input"]))
		out, bad := util.Str(st["output"]), util.Str(st["status"]) == "error"
		if bad && out == "" {
			out = util.Str(st["error"])
		}
		return []map[string]any{
			with(map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant",
				"content": []any{map[string]any{"type": "tool_use", "id": id, "name": name, "input": input}}}}),
			with(map[string]any{"type": "user", "message": map[string]any{"role": "user",
				"content": []any{map[string]any{"type": "tool_result", "tool_use_id": id, "content": out, "is_error": bad}}}}),
		}
	case "step_start":
		s.run.steps++
		if sid != "" && sid != s.rec.ClaudeSID {
			s.rec.ClaudeSID = sid
			s.save()
		}
	case "step_finish":
		tk := util.Obj(part["tokens"])
		cache := util.Obj(tk["cache"])
		s.run.in += num(tk["input"]) + num(cache["read"]) + num(cache["write"])
		s.run.out += num(tk["output"])
		s.run.cost += num(part["cost"])
	case "error":
		e := util.Obj(ev["error"])
		msg := util.Str(e["message"])
		if msg == "" {
			msg = util.Str(util.Obj(e["data"])["message"])
		}
		if msg == "" {
			msg = util.Str(e["name"])
		}
		if msg == "" {
			msg = "opencode failed"
		}
		s.run.err = clip(msg, 500)
		return []map[string]any{with(map[string]any{"type": "assistant", "error": msg, "message": map[string]any{"role": "assistant", "content": []any{}}})}
	}
	return nil
}

// ocTool opencode's tool as claude's name and input, so its edits read as
// claude's Edit, Write and the rest everywhere they're drawn
func ocTool(tool string, in map[string]any) (string, map[string]any) {
	str := func(k string) any { return in[k] }
	// the file as today's opencode names it, path, or as older ones did, filePath
	file := in["path"]
	if file == nil {
		file = in["filePath"]
	}
	switch tool {
	case "edit":
		return "Edit", map[string]any{"file_path": file, "old_string": str("oldString"), "new_string": str("newString"), "replace_all": in["replaceAll"] == true}
	case "multiedit":
		edits := []any{}
		for _, e := range anyList(in["edits"]) {
			x := util.Obj(e)
			edits = append(edits, map[string]any{"old_string": x["oldString"], "new_string": x["newString"], "replace_all": x["replaceAll"] == true})
		}
		return "MultiEdit", map[string]any{"file_path": file, "edits": edits}
	case "write":
		return "Write", map[string]any{"file_path": file, "content": str("content")}
	case "read":
		return "Read", map[string]any{"file_path": file, "offset": in["offset"], "limit": in["limit"]}
	case "bash":
		return "Bash", map[string]any{"command": str("command"), "description": str("description")}
	case "glob":
		return "Glob", map[string]any{"pattern": str("pattern"), "path": str("path")}
	case "grep":
		return "Grep", map[string]any{"pattern": str("pattern"), "path": str("path"), "glob": str("include")}
	case "list":
		return "LS", map[string]any{"path": str("path")}
	case "webfetch":
		return "WebFetch", map[string]any{"url": str("url")}
	case "todowrite":
		return "TodoWrite", map[string]any{"todos": in["todos"]}
	case "task":
		return "Task", map[string]any{"description": str("description"), "prompt": str("prompt")}
	}
	return tool, in
}

func anyList(v any) []any {
	if l, ok := v.([]any); ok {
		return l
	}
	return nil
}
