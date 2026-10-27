// the Anthropic Messages API on the mesh's models, for claude code: a user's
// key, a role or a host as the model, llama-server's own /v1/messages answering
import { CheckMCPKey } from "@phosphorus/users";
import { FrontendPort, marshal, obj } from "@phosphorus/util";
import { type Agent, AgentName, Agents, agentOf, assigned, excuse, forward, jsString, measure, Mesh, meshHost, n, profiled, resolve, runners, selfHost, serverPort, str, textOf, tierOf, view } from "./model.ts";

// anthErr an error as the Anthropic API words it
const anthErr = (status: number, typ: string, msg: string) =>
  new Response(marshal({ type: "error", error: { type: typ, message: msg } }), { status, headers: { "Content-Type": "application/json" } });

// keyOf the caller's key: a bearer token or x-api-key, as claude sends either
export function keyOf(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return (req.headers.get("x-api-key") ?? "").trim();
}

// gate a live user key, or none at all where open: a mesh peer's hop naming a
// host, a peer listing the models; else the refusal to answer with
export function gate(req: Request, open: boolean): Response | undefined {
  const k = keyOf(req);
  if (k === "" && open) return;
  if (k === "") return anthErr(401, "authentication_error", "a phosphorus key as the bearer token or x-api-key");
  const [s, why] = CheckMCPKey(k);
  if (!s && !open) return anthErr(401, "authentication_error", "key refused: " + why);
  return;
}

// Target the model asked for as an agent or a pinned host: agent-<id>[-fast]
// (pref its assigned model), phosphorus/<host>; any other name (claude's own)
// its nearest tier
export function Target(m: string): [host: string, tier: string, pref: string] {
  m = m.toLowerCase().trim();
  const h = meshHost(m);
  if (h) return [h, "", ""];
  const [a, slot] = agentOf(m);
  if (a) return ["", tierOf(a, slot), assigned(a, slot)[0]];
  if (m.includes("haiku") || m.includes("small") || m.includes("fast")) return ["", "small", ""];
  return ["", "large", ""];
}

// anthUsage the Anthropic usage as measure reads chat's
export function anthUsage(u: Record<string, any> | undefined): Record<string, number> | undefined {
  if (!u) return;
  const prompt = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
  return { prompt_tokens: prompt, completion_tokens: n(u.output_tokens) };
}

// chatShaped the system and messages as measure reads a chat's
export function chatShaped(p: Record<string, any>): unknown[] {
  const s = textOf(p.system);
  return [...(s ? [{ role: "system", content: s }] : []), ...(Array.isArray(p.messages) ? p.messages : [])];
}

// foldSystem system messages among the messages, as newer claude codes send,
// moved to the top-level system: a chat template like Qwen's refuses a system
// message anywhere but first
export function foldSystem(p: Record<string, any>): Record<string, any> {
  const ms: unknown[] = Array.isArray(p.messages) ? p.messages : [];
  const keep: unknown[] = [];
  const extra: unknown[] = [];
  for (const m of ms) {
    const mm = obj(m);
    if (str(mm?.role) !== "system") {
      keep.push(m);
      continue;
    }
    const c = mm?.content;
    if (typeof c === "string") extra.push({ type: "text", text: c });
    else if (Array.isArray(c)) extra.push(...c);
  }
  if (keep.length === ms.length) return p;
  const sys: unknown[] = typeof p.system === "string" ? (p.system ? [{ type: "text", text: p.system }] : []) : Array.isArray(p.system) ? [...p.system] : [];
  return { ...p, system: [...sys, ...extra], messages: keep };
}

// ServeMessages POST /api/model/v1/messages[/count_tokens]: sub "" or
// "/count_tokens", peer a tailnet or loopback caller, user a logged-in user's
// own page (the ide's chat), its login the pass a key is for anyone else
export async function ServeMessages(req: Request, p: Record<string, any>, sub: string, peer: boolean, user: boolean): Promise<Response> {
  if (sub !== "" && sub !== "/count_tokens") return anthErr(404, "not_found_error", "no such endpoint");
  const [host, role, pref] = Target(str(p.model));
  const refused = gate(req, (peer && host !== "") || user);
  if (refused) return refused;
  if (!Array.isArray(p.messages)) return anthErr(400, "invalid_request_error", "messages: an array");
  p = foldSystem(p);
  const states = view();
  const s = role ? resolve(states, role, pref)[1] : runners(states).findLast((x) => x.host === host);
  if (!s || s.server !== "ready") return anthErr(529, "overloaded_error", excuse(states, s));
  const h = jsString(s.host);
  const body = sub === "" && role ? profiled(p, role) : p;
  if (h !== selfHost) return forward(req, jsString(s.ip), FrontendPort, "/api/model/v1/messages" + sub, { ...body, model: Mesh + "/" + h }, h);
  const msgs = chatShaped(p);
  return forward(req, "127.0.0.1", serverPort, "/v1/messages" + sub, body, "llama-server on " + h, (out) => {
    if (out.ok && sub === "") measure(msgs, p.tools, anthUsage(out.usage), out.genMS).catch(() => {});
  });
}

// ServeModels GET /api/model/v1/models: the agents' names, as the Anthropic API lists models
export function ServeModels(req: Request, peer: boolean): Response {
  const refused = gate(req, peer);
  if (refused) return refused;
  const states = view();
  const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const data = Agents.map((a: Agent) => {
    const s = resolve(states, a.tier, assigned(a, "model")[0])[1];
    return { type: "model", id: AgentName(a.id, false), display_name: a.label, created_at: at, ready: s?.server === "ready" };
  });
  return new Response(marshal({ data, has_more: false, first_id: data[0]!.id, last_id: data[data.length - 1]!.id }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
