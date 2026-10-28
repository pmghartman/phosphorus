// the mesh's models, every host's claim, which agents each is assigned to,
// the calls made to them passed to the host running them
import { join } from "node:path";
import { peerModel, routes } from "@phosphorus/peers";
import * as store from "@phosphorus/store";
import { wantOf } from "@phosphorus/webapps";
import { envInt, errText, FrontendPort, localeCompare, marshal, now, obj, readFresh, requestJSON, SelfHost, StateDir } from "@phosphorus/util";

export const selfHost = SelfHost;
const claimFile = join(StateDir, "model-claim.json");
export const serverPort = envInt("MODEL_SERVER_PORT", 8791);
const nameRe = /^[A-Za-z0-9-]{1,63}$/;
const contextRe = /<context>\n[\s\S]*?\n<\/context>\n\n/;
const claimMaxAge = 5000;
const askTimeout = 5 * 60 * 1000;
const gib = 1 << 30;
const sentinel = "\u0000ask\u0000";
// Mesh the prefix of a mesh host's own model, as phosphorus/<host>
export const Mesh = "phosphorus";

type Profile = { maxTokens: number; thinking: boolean; effort: string; sampling?: Record<string, unknown> };
const profiles: Record<string, Profile> = {
  small: { maxTokens: 4096, thinking: false, effort: "low", sampling: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5 } },
  large: { maxTokens: 32768, thinking: true, effort: "high" },
};

// a host's claim as its model daemon published it
export type State = Record<string, any>;

// JS truthiness of a JSON value
export const truthy = (v: unknown) => !!v;
// as a JS template literal renders a JSON value
export const jsString = (v: unknown): string =>
  v == null ? "null" : Array.isArray(v) ? v.map((e) => (e == null ? "" : jsString(e))).join(",") : typeof v === "object" ? "[object Object]" : String(v);
export const str = (v: unknown) => (truthy(v) ? jsString(v) : "");
const decode = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(marshal(body), { status, headers: { "Content-Type": "application/json", ...headers } });

// a JSON value as a number, NaN and the unparsable 0
export function n(v: unknown): number {
  if (typeof v === "number") return Number.isNaN(v) ? 0 : v;
  if (typeof v === "string") {
    const f = parseFloat(v);
    return Number.isNaN(f) ? 0 : f;
  }
  return v === true ? 1 : 0;
}

// --- claims ----------------------------------------------------------------

let use: Record<string, any> | undefined;

// State the daemon's own claim, the last ask's use carried along
export function State(): State | undefined {
  const c = obj(readFresh(claimFile, claimMaxAge));
  if (!c) return undefined;
  // use.since is 0 until a claim's serverSince was seen, which no claim equals
  if (use && truthy(c.runs) && use.since !== 0 && c.serverSince === use.since) return { ...c, use };
  return c;
}

export function view(): State[] {
  const s = State();
  return [...(s ? [s] : []), ...peerModel()].map(obj).filter((m): m is State => !!m && typeof m.host === "string" && nameRe.test(m.host));
}

export function runners(states: State[]): State[] {
  return states.filter((s) => truthy(s.runs)).sort((a, b) => localeCompare(jsString(a.host), jsString(b.host)));
}

const bySize = (a: State, b: State) => (n(a.size) < n(b.size) ? -1 : n(a.size) > n(b.size) ? 1 : 0);

// --- tiers -------------------------------------------------------------------

export function meshHost(m: string): string {
  const h = m.startsWith(Mesh + "/") ? m.slice(Mesh.length + 1) : "";
  return nameRe.test(h) ? h : "";
}

// pick the model for a tier: pref's host when it's ready, else the smallest
// ready model for the small tier and the biggest for the large
export function pick(states: State[], r: string, pref: string): State | undefined {
  const all = runners(states);
  const want = pref ? all.find((s) => s.host === meshHost(pref)) : undefined;
  if (want?.server === "ready") return want;
  const up = all.filter((s) => s.server === "ready").sort(bySize);
  if (up.length) return r === "small" ? up[0] : up[up.length - 1];
  if (want) return want;
  return [...all].sort(bySize)[0];
}

export function resolve(states: State[], r: string, pref: string): [string, State | undefined] {
  const s = pick(states, r, pref);
  return s ? [Mesh + "/" + jsString(s.host), s] : ["", undefined];
}

const useKeys = ["system", "chat", "ask", "reply", "tps", "at"];

function useOf(s: State): Record<string, number> | undefined {
  const u = obj(s.use);
  return u && Object.fromEntries(useKeys.map((k) => [k, Math.max(0, n(u[k]))]));
}

function row(s: State, states: State[]): Record<string, any> {
  const ready = s.server === "ready";
  const d = obj(s.download);
  return {
    host: s.host, file: str(s.file), size: n(s.size),
    ctx: n(s.ctx), slots: n(s.slots), ready, loading: s.server === "loading",
    gpu: truthy(s.gpu), vram: n(s.vram), total: n(s.total), machine: n(s.machine), need: n(s.need),
    why: ready ? "" : excuse(states, s), use: (ready && useOf(s)) || null, download: d ? { done: n(d.done), total: n(d.total) } : null, tools: s.tools ?? null,
  };
}

// Summary every model with the agents on it, each agent's assignment, what it answers with and why not
export function Summary(): Record<string, any> {
  const states = view();
  const agents = agentRows(states);
  const models: Record<string, any>[] = runners(states).map((s) => ({ ...row(s, states), agents: [] }));
  for (const m of models) m.agents = agentsOn(agents, jsString(m.host));
  return { agents, models };
}

export function excuse(states: State[], s: State | undefined): string {
  if (!states.length) return "not loaded: no host is running the model daemon";
  if (!s) return "not loaded: no host has host = true under [model] in its phosphorus.ini";
  const why = str(s.why);
  if (why) return "not loaded: " + why;
  if (truthy(s.oom) && s.server !== "ready") return "out of vram, lower ctx or slots";
  const e = Math.trunc(n(s.exits));
  const crashed = e > 0 ? `llama-server has exited ${e === 1 ? "1 time" : `${e} times`} since it was last up (${jsString(s.lastExit)}), the phosphorus log on ${jsString(s.host)} says why` : "";
  if (crashed && s.server !== "loading") return "not loaded: " + crashed;
  if (s.server === "loading") {
    const since = n(s.serverSince);
    const mins = since > 0 ? Math.floor((now() - since) / 60000) : 0;
    return `still loading ${jsString(s.file)} on ${jsString(s.host)}, ${mins}m in${crashed ? "; " + crashed : ""}`;
  }
  const d = obj(s.download);
  if (d) {
    const t = n(d.total);
    const pct = t > 0 ? ` ${Math.floor((100 * n(d.done)) / t)}%` : "";
    return `not loaded: ${jsString(s.host)} is still downloading ${jsString(s.file)}${pct} (${(n(d.done) / gib).toFixed(1)}GB so far)`;
  }
  return "not loaded: starting llama-server on " + jsString(s.host);
}

// --- asking ----------------------------------------------------------------

const local = (method: string, path: string, body: unknown, timeoutMs: number) => requestJSON({ port: serverPort, method, path, body, timeoutMs });

async function tokens(content: string): Promise<number> {
  try {
    const r = await local("POST", "/tokenize", { content }, 5000);
    const t = r.status === 200 ? obj(r.body)?.tokens : undefined;
    return Array.isArray(t) ? t.length : 0;
  } catch {
    return 0;
  }
}

export function textOf(c: unknown): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  let out = "";
  for (const p of c) {
    const t = obj(p)?.text;
    if (typeof t === "string") out += t;
  }
  return out;
}

let framedKey = "";
let framedN = 0;

// the tokens of the system messages and tools as the chat template frames them, the last framing remembered
async function frameTokens(systems: unknown[], tools: unknown): Promise<number> {
  const key = marshal([systems, tools ?? []]);
  if (framedKey === key) return framedN;
  const body: Record<string, any> = { messages: [...systems, { role: "user", content: sentinel }], add_generation_prompt: false };
  if (Array.isArray(tools) && tools.length) body.tools = tools;
  let prompt = "";
  let at = -1;
  try {
    const r = await local("POST", "/apply-template", body, 5000);
    const p = r.status === 200 ? obj(r.body)?.prompt : undefined;
    if (typeof p === "string") {
      prompt = p;
      at = prompt.indexOf(sentinel);
    }
  } catch {}
  const cnt = at > 0 ? await tokens(prompt.slice(0, at)) : await tokens(systems.map((m) => textOf(obj(m)?.content)).join("\n"));
  framedKey = key;
  framedN = cnt;
  return cnt;
}

// the last ask's prompt split into the frame, the note under <context> and what was said
export async function measure(messages: unknown[], tools: unknown, usage: Record<string, any> | undefined, genMS: number) {
  const prompt = n(usage?.prompt_tokens);
  const claim = State();
  if (prompt === 0 || !claim) return;
  const reply = n(usage?.completion_tokens);
  let first = messages.findIndex((m) => obj(m)?.role !== "system");
  if (first < 0) first = messages.length;
  const systems = messages.slice(0, first);
  let text = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = obj(messages[i]);
    if (m?.role === "user" && contextRe.test(textOf(m.content))) {
      text = textOf(m.content);
      break;
    }
  }
  const loc = contextRe.exec(text);
  let frame = 0;
  let note = 0;
  let said = 0;
  if (systems.length) frame = await frameTokens(systems, tools);
  if (loc) {
    note = await tokens(loc[0]);
    said = await tokens(text.slice(loc.index + loc[0].length));
  }
  const system = Math.min(prompt, frame + note);
  const ask = Math.min(prompt - system, said);
  let tps = 0;
  if (genMS > 0 && reply > 1) tps = Math.round(((reply - 1) * 1000) / genMS);
  else if (use) tps = n(use.tps);
  use = { since: truthy(claim.serverSince) ? claim.serverSince : 0, at: now(), system, ask, chat: Math.max(0, prompt - system - ask), reply, tps };
}

export function profiled(p: Record<string, any>, r: string): Record<string, any> {
  const f = profiles[r];
  if (!f) return p;
  const mt = n(p.max_tokens);
  return {
    ...p,
    ...f.sampling,
    max_tokens: mt === 0 || mt > f.maxTokens ? f.maxTokens : mt,
    chat_template_kwargs: { ...obj(p.chat_template_kwargs), enable_thinking: f.thinking, reasoning_effort: f.effort },
  };
}

export function completion(p: Record<string, any>): Record<string, any> {
  return truthy(p.stream) ? { ...p, stream_options: { ...obj(p.stream_options), include_usage: true } } : p;
}

export type FwdOut = { ok: boolean; usage?: Record<string, any>; genMS: number };

// forward the call to host:port, its answer streamed back as it comes, done
// told its usage once over; an answer idle past askTimeout cut off there
export async function forward(req: Request, host: string, port: number, path: string, body: unknown, who: string, done?: (o: FwdOut) => void): Promise<Response> {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  req.signal.addEventListener("abort", onAbort, { once: true });
  let idle = setTimeout(onAbort, askTimeout);
  const stop = () => {
    clearTimeout(idle);
    req.signal.removeEventListener("abort", onAbort);
  };
  let res: Response;
  try {
    res = await fetch(`http://${host}:${port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: marshal(body), signal: ac.signal });
  } catch (e) {
    stop();
    return json(502, { error: { message: `${who} didn't answer: ${errText(e)}` } });
  }
  const ct = res.headers.get("content-type") || "application/json";
  const sse = ct.includes("event-stream");
  const headers = { "Content-Type": ct, "Cache-Control": "no-cache" };
  const dec = new TextDecoder();
  let buf = "";
  let all = "";
  let first = 0;
  let usage: Record<string, any> | undefined;
  let ended = false;
  const scan = (chunk: Uint8Array) => {
    const s = dec.decode(chunk, { stream: true });
    if (!sse) {
      all += s;
      return;
    }
    buf += s;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.startsWith("data: ")) continue;
      const d = line.slice(6).trim();
      if (d === "" || d === "[DONE]") continue;
      const u = obj(obj(decode(d))?.usage);
      if (u) usage = u;
    }
  };
  const end = () => {
    if (ended) return;
    ended = true;
    stop();
    if (!sse) usage = obj(obj(decode(all))?.usage);
    done?.({ ok: res.status === 200, usage, genMS: sse && first ? now() - first : 0 });
  };
  const rd = res.body?.getReader();
  if (!rd) {
    end();
    return new Response(null, { status: res.status, headers });
  }
  const out = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      let r: Awaited<ReturnType<typeof rd.read>>;
      try {
        r = await rd.read();
      } catch {
        r = { done: true, value: undefined };
      }
      if (r.done) {
        end();
        ctl.close();
        return;
      }
      clearTimeout(idle);
      idle = setTimeout(onAbort, askTimeout);
      if (!first) first = now();
      ctl.enqueue(r.value);
      scan(r.value);
    },
    cancel() {
      ac.abort();
      end();
    },
  });
  return new Response(out, { status: res.status, headers });
}

// chatTarget the model a chat names: a host (bare or as phosphorus/<host>),
// or an agent (agent-<id>[-fast]) resolved to its assigned or tier's model
export function chatTarget(states: State[], m: string): State | undefined {
  const [a, slot] = agentOf(m.toLowerCase().trim());
  if (a) return resolve(states, tierOf(a, slot), assigned(a, slot)[0])[1];
  const host = meshHost(m) || m;
  return runners(states).findLast((x) => x.host === host);
}

// ServeChat a call to a mesh model, answered here or passed on
export async function ServeChat(req: Request, p: Record<string, any>, isLocal: boolean): Promise<Response> {
  const fail = (status: number, msg: string) => json(status, { error: { message: msg } });
  const msgs = p.messages;
  if (!Array.isArray(msgs)) return fail(400, "bad messages");
  const states = view();
  const s = chatTarget(states, str(p.model));
  if (!s || s.server !== "ready") return fail(503, excuse(states, s));
  const host = jsString(s.host);
  if (host !== selfHost) {
    if (!isLocal) return fail(409, host + " isn't this host");
    return forward(req, jsString(s.ip), FrontendPort, "/api/model/v1/chat/completions", { ...p, model: host }, host);
  }
  return forward(req, "127.0.0.1", serverPort, "/v1/chat/completions", completion({ ...p, model: host }), "llama-server on " + host, (out) => {
    if (out.ok) measure(msgs, p.tools, out.usage, out.genMS).catch(() => {});
  });
}

// Purge a mesh host's idle slots erased, asked of the host running it
export async function Purge(host: string): Promise<any> {
  host = meshHost(Mesh + "/" + (host.startsWith(Mesh + "/") ? host.slice(Mesh.length + 1) : host));
  const s = runners(view()).findLast((x) => x.host === host);
  if (!s) throw new Error(`${JSON.stringify(host)} isn't a mesh model, nothing here to purge`);
  if (s.server !== "ready") throw new Error("no model loaded on " + host);
  if (s.host === selfHost) return EraseSlots();
  const res = await requestJSON({ host: jsString(s.ip), port: FrontendPort, method: "POST", path: "/api/model/purge", timeoutMs: 10000 });
  const b = res.body;
  if (res.status !== 200 || b == null) throw new Error(str(obj(b)?.error) || jsString(s.host) + " would not purge");
  return b;
}

// EraseSlots the slots not mid-answer erased here
export async function EraseSlots(): Promise<Record<string, any>> {
  let slots: unknown;
  try {
    const r = await local("GET", "/slots", undefined, 5000);
    if (r.status === 200) slots = r.body;
  } catch {}
  if (!Array.isArray(slots)) throw new Error("llama-server would not list its slots");
  const idle = slots.filter((x) => !truthy(obj(x)?.is_processing));
  const done = await Promise.all(
    idle.map(async (x) => {
      try {
        const res = await local("POST", `/slots/${jsString(obj(x)?.id)}?action=erase`, {}, 5000);
        return res.status === 200;
      } catch {
        return false;
      }
    }),
  );
  if (idle.length === slots.length) use = undefined;
  return { host: selfHost, erased: done.filter(Boolean).length, busy: slots.length - idle.length };
}

// --- agents ----------------------------------------------------------------

// Agent one implementation that asks the mesh's models: a model is assigned
// to any number of them, each asking by the name agent-<id>
export type Agent = {
  id: string;
  label: string;
  about: string;
  // parent the agent whose assignment this one follows while unset
  parent: string;
  // fast an agent with a second, small model for its background work
  fast: boolean;
  // tier what its model is while unassigned: "small" the smallest ready model, "large" the biggest
  tier: string;
};

// the built-in agents, every implementation of phosphorus's own that asks a model, in the pages' order
const builtin: Agent[] = [
  { id: "code", label: "Code app", about: "the projects' agent sessions, the default for every harness below", parent: "", tier: "large", fast: true },
  { id: "claude-code", label: "Claude Code", about: "Claude Code in a project, on the mesh's models", parent: "code", tier: "large", fast: true },
  { id: "opencode", label: "OpenCode", about: "opencode in a project, on the mesh's models", parent: "code", tier: "large", fast: true },
];

// apps on the mesh that ask a model, each an agent while it's there: a service of its
// name published on any host, or an app of the apps page installed onto the mesh
const apps: (Agent & { service?: string; app?: string })[] = [
  { id: "tavern", label: "Tavern", about: "the dungeon master of the tavern app, asking as agent-tavern", parent: "", tier: "large", fast: false, service: "tavern" },
  { id: "sulfur", label: "Sulfur", about: "the editor's chat, asking as agent-sulfur; its inline completions as agent-sulfur-fast", parent: "", tier: "large", fast: true, app: "sulfur" },
];

// whether a service of that name is published on the mesh, and whether an app is
// installed onto it, each swapped for a fake in tests
export const seams = {
  published: (name: string) => routes().some((r) => r.name === name),
  installed: (id: string) => wantOf(id) !== undefined,
};

// Agents the agents right now: the built-ins, then the apps on the mesh
export function Agents(): Agent[] {
  return [...builtin, ...apps.filter((a) => (a.service ? seams.published(a.service) : seams.installed(a.app!))).map(({ service: _, app: __, ...a }) => a)];
}

// slots an agent's assignments: its model, and for some a fast one
const slots = ["model", "fast"];
const agentPrefix = "agent-";
const agentFile = (id: string) => `etc/model/agents/${id}.json`;

// AgentByID the agent named, undefined for none
export const AgentByID = (id: string) => Agents().find((a) => a.id === id);

// AgentName the name an agent asks the gateway by: agent-<id>, agent-<id>-fast
export const AgentName = (id: string, fast: boolean) => agentPrefix + id + (fast ? "-fast" : "");

// agentOf the agent and slot a gateway name stands for
export function agentOf(m: string): [Agent | undefined, string] {
  if (!m.startsWith(agentPrefix)) return [undefined, ""];
  let id = m.slice(agentPrefix.length);
  let slot = "model";
  if (id.endsWith("-fast")) {
    id = id.slice(0, -5);
    slot = "fast";
  }
  const a = AgentByID(id);
  if (!a || (slot === "fast" && !a.fast)) return [undefined, ""];
  return [a, slot];
}

// own an agent's slot as picked for it, "" for none
function own(a: Agent, slot: string): string {
  const v = obj(store.read(agentFile(a.id)))?.[slot];
  // a model picked on a host since gone is kept; a non-mesh value never is
  return typeof v === "string" && meshHost(v) ? v : "";
}

// assigned an agent's slot as it asks: its own pick, else its parent's
export function assigned(a: Agent, slot: string): [string, boolean] {
  const v = own(a, slot);
  if (v) return [v, false];
  const p = a.parent ? AgentByID(a.parent) : undefined;
  const pv = p ? own(p, slot) : "";
  return pv ? [pv, true] : ["", false];
}

export const tierOf = (a: Agent, slot: string) => (slot === "fast" ? "small" : a.tier);

// Assign a model to an agent's slot, mesh-wide; blank for the automatic pick
export function Assign(p: Record<string, any>): [number, any] {
  const a = AgentByID(str(p.agent));
  if (!a) return [400, { error: "agent is " + Agents().map((x) => x.id).join(", ") }];
  const slot = str(p.slot) || "model";
  if (slot !== "model" && (slot !== "fast" || !a.fast)) return [400, { error: `${a.label} has no ${slot} slot` }];
  let m = str(p.model).trim();
  if (m && !m.includes("/")) m = Mesh + "/" + m;
  if (m && !meshHost(m)) return [400, { error: `model is a mesh host running one, as ${Mesh}/<host>, blank for the automatic pick` }];
  const h = meshHost(m);
  if (h && !runners(view()).some((s) => s.host === h)) return [409, { error: h + " runs no model" }];
  const c: Record<string, any> = { ...obj(store.read(agentFile(a.id))) };
  if (m) c[slot] = m;
  else delete c[slot];
  store.write(agentFile(a.id), c);
  return [200, { agent: a.id, slot, model: m }];
}

// agentRows each agent with its slots: what was picked, what it answers with, why not
function agentRows(states: State[]): Record<string, any>[] {
  return Agents().map((a) => {
    const sl: Record<string, any> = {};
    for (const slot of slots) {
      if (slot === "fast" && !a.fast) continue;
      const [pref, inherited] = assigned(a, slot);
      const [m, s] = resolve(states, tierOf(a, slot), pref);
      const ready = m !== "" && s?.server === "ready";
      sl[slot] = { chosen: own(a, slot), inherited, assigned: pref, model: m, host: s ? jsString(s.host) : "", ready, why: ready ? "" : excuse(states, s) };
    }
    return { id: a.id, label: a.label, about: a.about, parent: a.parent, fast: a.fast, slots: sl };
  });
}

// agentsOn the ids of the agents asking host's model, in any slot
function agentsOn(rows: Record<string, any>[], host: string): string[] {
  return rows.filter((x) => Object.values(obj(x.slots) ?? {}).some((s) => obj(s)?.host === host && truthy(obj(s)?.ready))).map((x) => str(x.id));
}
