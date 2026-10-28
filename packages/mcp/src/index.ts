// phosphorus's mcp server over json-rpc at /api/mcp, the mesh read by any mcp
// client on the tailnet, its buttons pressed for an asker
import { marshal, obj } from "@phosphorus/util";
import icon from "../assets/icon.png" with { type: "file" };
import { agentTools, describe } from "./agent.ts";
import { callBegin, callDetail, callEnd, callHost, markSeen, noteClient } from "./calls.ts";
import { type Caller, type Meta, protocol, src, str, type Tool, ToolError, tools } from "./common.ts";
import { controlTools } from "./control.ts";
import { audit } from "./extra.ts";
import { forgejoTools } from "./forgejo.ts";
import { grantsOf, keyDescription, keyNote, sig, withheld } from "./grants.ts";
import { mirror, mirrorArgs, mirrorEnd } from "./mirror.ts";
import { coreTools } from "./tools.ts";

export { type Action, type Actions, type Asker, type Caller, init, type Loc, type Meta, type Res, type Src, ToolError } from "./common.ts";
export { callBegin, callDetail, callEnd, calls, watch } from "./calls.ts";
export { skill, skillFiles } from "./skill.ts";
export { statsRow, statsShape } from "./hosts.ts";

const toolIndex = new Map<string, Tool>();
// the tools/list answer per kind of caller, built once
const listed = new Map<string, Record<string, any>[]>();

// the tools built once, on the first call
function build() {
  if (tools.length) return;
  tools.push(...coreTools(), ...agentTools(), ...controlTools(), ...forgejoTools());
  describe();
  for (const t of tools) toolIndex.set(t.name, t);
}

// allTools every tool the server knows, for the tests
export function allTools(): Tool[] {
  build();
  return tools;
}

// visible whether a caller sees a tool: a key every tool it isn't withheld,
// this host unkeyed all but a key's, an unkeyed peer only reads
function visible(t: Tool, local: boolean, caller: Caller | undefined): boolean {
  if (caller) return withheld(t, caller) === "";
  if (local) return t.scope !== "key";
  return !!t.read && !t.scope;
}

// icons the mesh's mark for an agent's connector list, on its own dark tile edge to
// edge: claude.ai frames a connector's icon on white, so a clear background showed
// as a white box; off the mesh's own domain first (claude.ai draws no data url),
// inline for a client with no web
let iconURI: string | undefined;
async function icons(): Promise<Record<string, any>[]> {
  iconURI ??= "data:image/png;base64," + Buffer.from(await Bun.file(icon).bytes()).toString("base64");
  const domain = src.domain();
  const out: Record<string, any>[] = [];
  if (domain) out.push({ src: `https://${domain}/connector-icon.png`, mimeType: "image/png", sizes: ["192x192"] });
  out.push({ src: iconURI, mimeType: "image/png", sizes: ["128x128"] });
  return out;
}

const reply = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

// one request's answer, undefined for a notification
async function one(raw: unknown, local: boolean, caller: Caller | undefined): Promise<Record<string, any> | undefined> {
  const msg = obj(raw);
  const id = msg?.id ?? null;
  const method = msg?.method;
  if (!msg || msg.jsonrpc !== "2.0" || typeof method !== "string") return fail(id, -32600, "invalid request");
  if (!("id" in msg)) return;
  const params = obj(msg.params) ?? {};
  switch (method) {
    case "initialize":
      if (caller) noteClient(caller.user, str(obj(params.clientInfo)?.name));
      return initialize(id, params, caller);
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: toolList(local, caller) });
    case "tools/call":
      return callTool(id, params, local, caller);
  }
  return fail(id, -32601, "no method " + method);
}

async function initialize(id: unknown, params: Record<string, any>, caller: Caller | undefined) {
  return reply(id, {
    protocolVersion: params.protocolVersion || protocol,
    capabilities: { tools: {} },
    serverInfo: { name: "phosphorus", title: "Phosphorus", version: src.self().version, icons: await icons() },
    instructions: instructions(caller),
  });
}

// instructions the server's, and on a key what that key can and can't do
function instructions(caller: Caller | undefined): string {
  const s =
    "phosphorus, a self-hosted mesh: read its hosts, services, stats, git, models, chat and updates, its buttons " +
    "and messages pressed and sent only for a person asking phosphorus.";
  return caller ? s + keyNote(caller) : s;
}

// toolList the tools a caller sees, kept for the three kinds of caller
function toolList(local: boolean, caller: Caller | undefined): Record<string, any>[] {
  const key = caller ? "key|" + sig(grantsOf(caller)) : local ? "local" : "peer";
  const hit = listed.get(key);
  if (hit) return hit;
  const list: Record<string, any>[] = [];
  for (const t of tools) {
    if (!visible(t, local, caller)) continue;
    const ann: Record<string, any> = { readOnlyHint: !!t.read, openWorldHint: !!t.open };
    if (!t.read) ann.destructiveHint = !!t.destructive;
    list.push({ name: t.name, description: caller ? keyDescription(t, caller) : t.description, inputSchema: t.schema, annotations: ann });
  }
  listed.set(key, list);
  return list;
}

// runTool one tool's run, whatever it throws its error
async function runTool(t: Tool, params: Record<string, any>, local: boolean, caller: Caller | undefined): Promise<[unknown, Error | undefined]> {
  const args = { ...obj(params.arguments) };
  let out: unknown, err: Error | undefined;
  try {
    out = await t.run(args, { caller, local } satisfies Meta);
  } catch (e) {
    err = e instanceof Error ? e : new Error(String(e));
  }
  if (!t.read && caller) audit(caller, t.name, args, err);
  return [out, err];
}

async function callTool(id: unknown, params: Record<string, any>, local: boolean, caller: Caller | undefined) {
  const name = typeof params.name === "string" ? params.name : "";
  const t = toolIndex.get(name);
  if (t && caller) {
    const why = withheld(t, caller);
    if (why) return fail(id, -32602, `${name} is off this key: ${why}`);
  }
  if (!t || !visible(t, local, caller)) return fail(id, -32602, `no tool ${params.name === undefined ? "null" : String(params.name)}`);
  let out: unknown, err: Error | undefined;
  if (caller) {
    const args = obj(params.arguments);
    const cid = callBegin(caller.user, name, callDetail(args), callHost(args));
    mirror(caller.user, { phase: "start", id: cid, tool: name, args: mirrorArgs(args), read: !!t.read });
    try {
      [out, err] = await runTool(t, params, local, caller);
    } finally {
      const errText = err?.message ?? "";
      callEnd(caller.user, cid, errText);
      const end: Record<string, any> = { phase: "end", id: cid, tool: name, ok: errText === "", error: errText };
      mirrorEnd(end, name, out);
      mirror(caller.user, end);
    }
  } else [out, err] = await runTool(t, params, local, caller);
  if (!err) return reply(id, { content: [{ type: "text", text: marshal(out) }] });
  const code = err instanceof ToolError ? err.code : "failed";
  const data = err instanceof ToolError ? err.data : undefined;
  const e: Record<string, any> = { code, message: err.message };
  let text = code + ": " + err.message;
  if (data !== null && data !== undefined) {
    e.data = data;
    text += "\n" + marshal(data);
  }
  return reply(id, { content: [{ type: "text", text }], structuredContent: { error: e }, isError: true });
}

// handle a message or a batch: status and body, 202 and undefined for notifications only
export async function handle(body: unknown, local = false, caller?: Caller): Promise<[number, any]> {
  build();
  if (caller) {
    markSeen(caller.user);
    // a client naming itself on every request is the last used, sessions or not
    if (caller.via) noteClient(caller.user, caller.via);
  }
  if (Array.isArray(body)) {
    const res = (await Promise.all(body.map((m) => one(m, local, caller)))).filter((o) => o !== undefined);
    return res.length ? [200, res] : [202, undefined];
  }
  const out = await one(body, local, caller);
  return out ? [200, out] : [202, undefined];
}
