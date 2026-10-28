// opencode as a session's harness: one `opencode run --format json` a prompt
// in the session's folder, its own session resumed by id, the mesh's models
// its provider through the same gateway claude's are; its events turned into
// claude's stream-json shapes as they come, so every page draws both alike
import { errText, marshal } from "@phosphorus/util";
import type { Session } from "./claude.ts";
import { missing, Opencode } from "./harness.ts";
import {
  type Creds,
  envBlock,
  keyVar,
  Mesh,
  ocAgent,
  ocDir,
  ocPath,
  provider,
  quote,
  randHex,
  shDir,
} from "./script.ts";
import { spawn } from "./spawn.ts";
import { anyList, clip, lastLine, num, orObj, str } from "./text.ts";

// ocArgMax a prompt opencode takes as an argument
const ocArgMax = 100 * 1024;

// OcRun what one opencode run has said so far
export type OcRun = { start: number; steps: number; in: number; out: number; cost: number; err: string };

// ocConfig opencode's config: the mesh's models as an Anthropic-shaped
// provider on the gateway, phosphorus's mcp, tools allowed but in plan mode
export function ocConfig(base: string, _model: string, perm: string): string {
  const allow = perm === "plan" ? "deny" : "allow";
  const models: Record<string, any> = {};
  for (const m of [ocAgent, ocAgent + "-fast"]) models[m] = { name: m };
  return marshal({
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    model: "phosphorus/" + ocAgent,
    small_model: "phosphorus/" + ocAgent + "-fast",
    provider: {
      phosphorus: {
        npm: "@ai-sdk/anthropic",
        name: "phosphorus",
        options: { baseURL: base + "/api/model/v1", apiKey: "{env:" + keyVar + "}" },
        models,
      },
    },
    mcp: {
      phosphorus: {
        type: "remote",
        url: base + "/api/mcp",
        enabled: true,
        headers: { Authorization: "Bearer {env:" + keyVar + "}", "X-Phosphorus-Via": "opencode" },
      },
    },
    permission: { edit: allow, bash: allow, webfetch: "allow" },
  });
}

// ocSetup for sh -s: the config written fresh, opencode looked for
export function ocSetup(base: string, model: string, perm: string): string {
  const eof = "PHOS_EOF_" + randHex(8);
  return (
    `set -e\numask 077\nD=${ocDir}\nmkdir -p "$D"\n` +
    `cat > "$D/opencode.json" <<'${eof}'\n${ocConfig(base, model, perm)}\n${eof}\n` +
    ocPath +
    "\ncommand -v opencode >/dev/null 2>&1 || exit 127\n"
  );
}

// ocLaunch one run in dir on prompt, its env read off stdin first, resumed
// from sid when there's one
export function ocLaunch(dir: string, _model: string, perm: string, sid: string, prompt: string): string {
  const args = ["opencode", "run", "--format", "json", "--model", quote("phosphorus/" + ocAgent)];
  // nobody's at a run's prompt to approve a tool: allowed, but in plan mode, where they're refused
  if (perm !== "plan") args.push("--auto");
  if (sid) args.push("--session", quote(sid));
  args.push("--", quote(prompt));
  const script =
    ocPath +
    `while IFS= read -r l && [ -n "$l" ]; do export "$l"; done; ` +
    "OPENCODE_CONFIG=" +
    ocDir +
    "/opencode.json; export OPENCODE_CONFIG; " +
    "cd " +
    shDir(dir) +
    " || exit 3; " +
    "command -v opencode >/dev/null 2>&1 || exit 127; " +
    "exec " +
    args.join(" ") +
    " </dev/null";
  return "sh -c " + quote(script);
}

// ocBegin opencode's turn to start: nothing runs until a prompt does, the
// creds kept for the prompts; throws what keeps it from starting
export function ocBegin(s: Session, c: Creds) {
  if (!c.key || !c.base) throw new Error("opencode needs your mcp key and the mesh's address");
  if (provider(s.rec.model) !== "mesh") throw new Error("opencode runs on the mesh's models: " + Mesh.join(" or "));
  s.oc = c;
  s.rec.err = "";
  if (!s.p && s.queue.length) return ocKick(s);
  if (s.rec.status !== "working") s.status("idle");
}

// ocKick the next queued prompt run, when nothing's running
export function ocKick(s: Session) {
  if (s.p || s.starting || !s.oc || !s.queue.length || s.deleted) return;
  const text = s.queue.shift()!;
  if (text.length > ocArgMax) return s.fail(`opencode takes a prompt of up to ${ocArgMax / 1024}KB`);
  const c = s.oc;
  const setup = ocSetup(c.base, s.rec.model, s.rec.perm);
  const cmd = ocLaunch(s.rec.dir, s.rec.model, s.rec.perm, s.rec.claudeSID, text);
  const env = envBlock([keyVar + "=" + c.key]);
  s.starting = true;
  s.status("working");
  void (async () => {
    let p;
    try {
      p = await spawn(s.rec.host, c, setup, cmd, env);
    } catch (e) {
      s.starting = false;
      s.queue = [];
      s.fail(errText(e).replaceAll("claude", "opencode"));
      return;
    }
    s.starting = false;
    if (s.deleted) return p.kill();
    s.p = p;
    s.stopping = false;
    s.gen++;
    s.run = { start: Date.now(), steps: 0, in: 0, out: 0, cost: 0, err: "" };
    void s.read(p, s.gen);
  })();
}

// ocExited a run over: its result told, the next prompt run
export function ocExited(s: Session, g: number, code: number, errs: string) {
  if (g !== s.gen) return;
  s.p = undefined;
  s.gen++;
  const stopping = s.stopping;
  s.stopping = false;
  if (s.deleted) return;
  const r = s.run;
  if (stopping) {
    s.emit(
      {
        kind: "claude",
        ev: {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "stopped",
          num_turns: r.steps,
          duration_ms: Date.now() - r.start,
        },
      },
      true,
    );
    s.status("idle");
  } else if (code === 0 && !r.err) {
    s.on({
      type: "result",
      subtype: "success",
      num_turns: r.steps,
      duration_ms: Date.now() - r.start,
      usage: { input_tokens: r.in, output_tokens: r.out },
      total_cost_usd: r.cost,
    });
  } else if (code === 127) s.fail(missing(Opencode, s.rec.host));
  else if (code === 3) s.fail(`no folder ${s.rec.dir} on ${s.rec.host}`);
  else s.fail(r.err || lastLine(errs) || `opencode exited with ${code}`);
  if (!stopping) ocKick(s);
}

// ocEvents one opencode event as claude's: its text an assistant message,
// a finished tool a tool_use and its tool_result, a step's tokens counted
export function ocEvents(s: Session, ev: Record<string, any>): Record<string, any>[] {
  const sid = str(ev.sessionID);
  const part = orObj(ev.part);
  const with_ = (m: Record<string, any>) => (sid ? { ...m, session_id: sid } : m);
  switch (str(ev.type)) {
    case "text": {
      const t = str(part.text);
      if (!t.trim()) return [];
      return [with_({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t }] } })];
    }
    case "tool_use": {
      const st = orObj(part.state);
      const id = str(part.callID) || str(part.id);
      const [name, input] = ocTool(str(part.tool), orObj(st.input));
      const bad = str(st.status) === "error";
      let out = str(st.output);
      if (bad && !out) out = str(st.error);
      return [
        with_({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }),
        with_({
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: out, is_error: bad }] },
        }),
      ];
    }
    case "step_start":
      s.run.steps++;
      if (sid && sid !== s.rec.claudeSID) {
        s.rec.claudeSID = sid;
        s.save();
      }
      break;
    case "step_finish": {
      const tk = orObj(part.tokens);
      const cache = orObj(tk.cache);
      s.run.in += num(tk.input) + num(cache.read) + num(cache.write);
      s.run.out += num(tk.output);
      s.run.cost += num(part.cost);
      break;
    }
    case "error": {
      const e = orObj(ev.error);
      const msg = str(e.message) || str(orObj(e.data).message) || str(e.name) || "opencode failed";
      s.run.err = clip(msg, 500);
      return [with_({ type: "assistant", error: msg, message: { role: "assistant", content: [] } })];
    }
  }
  return [];
}

// ocTool opencode's tool as claude's name and input, so its edits read as
// claude's Edit, Write and the rest everywhere they're drawn
export function ocTool(tool: string, input: Record<string, any>): [string, Record<string, any>] {
  // the file as today's opencode names it, path, or as older ones did, filePath
  const file = input.path ?? input.filePath;
  switch (tool) {
    case "edit":
      return [
        "Edit",
        {
          file_path: file,
          old_string: input.oldString,
          new_string: input.newString,
          replace_all: input.replaceAll === true,
        },
      ];
    case "multiedit":
      return [
        "MultiEdit",
        {
          file_path: file,
          edits: anyList(input.edits).map((e) => {
            const x = orObj(e);
            return { old_string: x.oldString, new_string: x.newString, replace_all: x.replaceAll === true };
          }),
        },
      ];
    case "write":
      return ["Write", { file_path: file, content: input.content }];
    case "read":
      return ["Read", { file_path: file, offset: input.offset, limit: input.limit }];
    case "bash":
      return ["Bash", { command: input.command, description: input.description }];
    case "glob":
      return ["Glob", { pattern: input.pattern, path: input.path }];
    case "grep":
      return ["Grep", { pattern: input.pattern, path: input.path, glob: input.include }];
    case "list":
      return ["LS", { path: input.path }];
    case "webfetch":
      return ["WebFetch", { url: input.url }];
    case "todowrite":
      return ["TodoWrite", { todos: input.todos }];
    case "task":
      return ["Task", { description: input.description, prompt: input.prompt }];
  }
  return [tool, input];
}
