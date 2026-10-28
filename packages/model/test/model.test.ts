import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "phos-model-"));
process.env.HOME_FS = join(dir, "home");
process.env.STATE_DIR = join(dir, "state");
process.env.SELF_HOST = "razer";
process.env.BASE_DOMAIN = "mesh.example";
mkdirSync(process.env.STATE_DIR, { recursive: true });

// a stand-in llama-server: a token per word, the template framing the system
// messages ahead of the ask, a streamed chat ending in its usage
const enc = new TextEncoder();
const asked: { path: string; body: Record<string, any> }[] = [];
const llama = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    const body: Record<string, any> = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    asked.push({ path: u.pathname + u.search, body });
    const json = (v: unknown, status = 200) => Response.json(v, { status });
    switch (u.pathname) {
      case "/tokenize":
        return json({ tokens: String(body.content).split(/\s+/).filter(Boolean) });
      case "/apply-template": {
        const ms: Record<string, any>[] = body.messages;
        return json({ prompt: "<|sys|>" + ms.filter((m) => m.role === "system").map((m) => m.content).join(" ") + "<|end|>" + ms.at(-1)!.content });
      }
      case "/v1/chat/completions": {
        if (!body.stream) return json({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
        const lines = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "hel" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 21 } })}\n\n`,
          "data: [DONE]\n\n",
        ];
        const stream = new ReadableStream<Uint8Array>({
          async start(c) {
            for (const l of lines) {
              c.enqueue(enc.encode(l));
              await Bun.sleep(15);
            }
            c.close();
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      }
      case "/v1/messages":
        return json({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 } });
      case "/slots":
        return json([
          { id: 0, is_processing: false },
          { id: 1, is_processing: true },
        ]);
      case "/slots/0":
        return json({ ok: true });
    }
    return json({ error: "nope" }, 404);
  },
});
process.env.MODEL_SERVER_PORT = String(llama.port);
// a frontend port nobody answers on, for a hop to a peer
const free = Bun.serve({ port: 0, fetch: () => new Response("") });
process.env.FRONTEND_PORT = String(free.port);
free.stop(true);

const sysfs = await import("@phosphorus/sysfs");
const M = await import("@phosphorus/model");
const { StateDir } = await import("@phosphorus/util");

const gib = 1 << 30;
const claimFile = join(StateDir, "model-claim.json");
const claim = async (c: Record<string, any> | undefined) => {
  // readFresh keys its cache on the mtime
  await Bun.sleep(2);
  writeFileSync(claimFile, c ? JSON.stringify(c) : "null");
};
const since = Date.now();
const ready = { host: "razer", ip: "127.0.0.1", runs: true, server: "ready", serverSince: since, size: 4 * gib, file: "q4.gguf", ctx: 8192, slots: 2, gpu: true, vram: 8 * gib, total: 16 * gib, machine: 32 * gib, need: 5 * gib, tools: true };
const req = (headers: Record<string, string> = {}) => new Request("http://razer/api/model/v1/messages", { method: "POST", headers });
// the last call on a path, measuring's own calls landing in between
const sent = (path: string) => asked.filter((a) => a.path === path).at(-1)!;
const settled = async (fn: () => boolean) => {
  for (let i = 0; i < 200 && !fn(); i++) await Bun.sleep(10);
};

test("target", () => {
  for (const [input, want] of Object.entries({
    "phosphorus/razer": ["razer", ""], "claude-3-5-haiku-20241022": ["", "small"], "claude-sonnet-4-5": ["", "large"],
    "": ["", "large"], "phosphorus/bad host": ["", "large"], chimp: ["", "large"],
    "agent-claude-code": ["", "large"], "agent-claude-code-fast": ["", "small"],
    "agent-nope": ["", "large"],
  })) {
    const [h, r] = M.Target(input);
    expect([input, h, r]).toEqual([input, ...want]);
  }
});

test("anthropic usage", () => {
  const u = M.anthUsage({ input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 })!;
  expect(u.prompt_tokens).toBe(15);
  expect(u.completion_tokens).toBe(7);
  expect(M.anthUsage(undefined)).toBeUndefined();
});

test("chat shaped", () => {
  const m = M.chatShaped({ system: [{ type: "text", text: "be " }, { type: "text", text: "brief" }], messages: [{ role: "user", content: "hi" }] });
  expect(m).toEqual([{ role: "system", content: "be brief" }, { role: "user", content: "hi" }]);
});

test("gate refuses", () => {
  const r = req();
  expect(M.gate(r, false)?.status).toBe(401);
  expect(M.gate(r, true)).toBeUndefined();
  const junk = req({ Authorization: "Bearer junk" });
  expect(M.gate(junk, false)?.status).toBe(401);
  expect(M.keyOf(junk)).toBe("junk");
  expect(M.keyOf(req({ "x-api-key": "k2" }))).toBe("k2");
});

test("fold system", () => {
  const p = { system: "be brief", messages: [{ role: "user", content: "hi" }, { role: "system", content: [{ type: "text", text: "context" }] }] };
  const out = M.foldSystem(p);
  expect(out.messages).toHaveLength(1);
  expect(out.system).toHaveLength(2);
  expect(M.textOf(out.system)).toBe("be briefcontext");
  expect(p.messages).toHaveLength(2);
  const plain = { messages: [{ role: "user", content: "hi" }] };
  expect("system" in M.foldSystem(plain)).toBe(false);
});

test("excuses", () => {
  const a = { host: "a", file: "f", runs: true };
  expect(M.excuse([], undefined)).toBe("not loaded: no host is running the model daemon");
  expect(M.excuse([a], undefined)).toBe("not loaded: no host has host = true under [model] in its phosphorus.ini");
  expect(M.excuse([a], { ...a, why: "no gpu" })).toBe("not loaded: no gpu");
  expect(M.excuse([a], { ...a, oom: true, server: "loading" })).toBe("out of vram, lower ctx or slots");
  expect(M.excuse([a], { ...a, server: "down", exits: 1, lastExit: "x" })).toBe("not loaded: llama-server has exited 1 time since it was last up (x), the phosphorus log on a says why");
  expect(M.excuse([a], { ...a, server: "loading", serverSince: Date.now() - 125000, exits: 2, lastExit: "x" })).toBe(
    "still loading f on a, 2m in; llama-server has exited 2 times since it was last up (x), the phosphorus log on a says why",
  );
  expect(M.excuse([a], { ...a, server: "loading" })).toBe("still loading f on a, 0m in");
  expect(M.excuse([a], { ...a, download: { done: 1.5 * gib, total: 3 * gib } })).toBe("not loaded: a is still downloading f 50% (1.5GB so far)");
  expect(M.excuse([a], { ...a, download: { done: 0 } })).toBe("not loaded: a is still downloading f (0.0GB so far)");
  expect(M.excuse([a], a)).toBe("not loaded: starting llama-server on a");
});

test("pick by tier and preference", () => {
  const big = { host: "big", runs: true, server: "ready", size: 9 };
  const small = { host: "small", runs: true, server: "ready", size: 1 };
  const mid = { host: "mid", runs: true, server: "loading", size: 5 };
  const states = [mid, big, small, { host: "none", runs: false, server: "ready", size: 0 }];
  expect(M.pick(states, "small", "")?.host).toBe("small");
  expect(M.pick(states, "large", "")?.host).toBe("big");
  expect(M.pick(states, "large", "phosphorus/small")?.host).toBe("small");
  // a preferred host not ready: the tier's pick, until nothing is ready
  expect(M.pick(states, "large", "phosphorus/mid")?.host).toBe("big");
  const down = [mid, { ...big, server: "loading" }];
  expect(M.pick(down, "large", "phosphorus/mid")?.host).toBe("mid");
  expect(M.pick(down, "large", "")?.host).toBe("mid");
  expect(M.pick([], "large", "")).toBeUndefined();
});

test("no model anywhere", async () => {
  expect(M.State()).toBeUndefined();
  const s = M.Summary();
  expect(s.models).toEqual([]);
  expect(s.agents.map((a: any) => a.id)).toEqual(["code", "claude-code", "opencode"]);
  expect(s.agents[0].slots.model).toEqual({ chosen: "", inherited: false, assigned: "", model: "", host: "", ready: false, why: "not loaded: no host is running the model daemon" });
  expect(Object.keys(s.agents[0].slots)).toEqual(["model", "fast"]);
  const r = await M.ServeChat(req(), { model: "razer", messages: [] }, true);
  expect(r.status).toBe(503);
  expect(await r.json()).toEqual({ error: { message: "not loaded: no host is running the model daemon" } });
  expect((await M.ServeChat(req(), {}, true)).status).toBe(400);
  const m = await M.ServeMessages(req(), { model: "phosphorus/razer", messages: [] }, "", true, false);
  expect(m.status).toBe(529);
  expect(await m.json()).toEqual({ type: "error", error: { type: "overloaded_error", message: "not loaded: no host is running the model daemon" } });
  expect((await M.ServeMessages(req(), { model: "phosphorus/razer", messages: [] }, "/x", true, false)).status).toBe(404);
  expect(M.Assign({ agent: "code", model: "razer" })).toEqual([409, { error: "razer runs no model" }]);
});

test("summary of a ready claim", async () => {
  await claim(ready);
  expect(M.State()).toEqual(ready);
  const s = M.Summary();
  expect(s.models).toEqual([
    {
      host: "razer", file: "q4.gguf", size: 4 * gib, ctx: 8192, slots: 2, ready: true, loading: false,
      gpu: true, vram: 8 * gib, total: 16 * gib, machine: 32 * gib, need: 5 * gib,
      why: "", use: null, download: null, tools: true, agents: ["code", "claude-code", "opencode"],
    },
  ]);
  expect(s.agents[1]).toEqual({
    id: "claude-code", label: "Claude Code", about: "Claude Code in a project, on the mesh's models", parent: "code", fast: true,
    slots: {
      model: { chosen: "", inherited: false, assigned: "", model: "phosphorus/razer", host: "razer", ready: true, why: "" },
      fast: { chosen: "", inherited: false, assigned: "", model: "phosphorus/razer", host: "razer", ready: true, why: "" },
    },
  });
  await claim({ ...ready, server: "loading", use: { system: 5, chat: -1, ask: 2, reply: 3, tps: 4, at: 9, extra: 1 }, download: { done: "7", total: 10 } });
  const row = M.Summary().models[0];
  expect(row.ready).toBe(false);
  expect(row.loading).toBe(true);
  expect(row.why).toBe("still loading q4.gguf on razer, 0m in");
  expect(row.use).toBeNull();
  expect(row.download).toEqual({ done: 7, total: 10 });
  await claim({ ...ready, use: { system: 5, chat: -1, ask: 2, reply: 3, tps: 4, at: 9, extra: 1 } });
  expect(M.Summary().models[0].use).toEqual({ system: 5, chat: 0, ask: 2, reply: 3, tps: 4, at: 9 });
});

test("assign", async () => {
  await claim(ready);
  expect(M.Assign({ agent: "nope" })).toEqual([400, { error: "agent is code, claude-code, opencode" }]);
  expect(M.Assign({ agent: "code", slot: "x" })).toEqual([400, { error: "Code app has no x slot" }]);
  expect(M.Assign({ agent: "code", model: "other/x" })).toEqual([400, { error: "model is a mesh host running one, as phosphorus/<host>, blank for the automatic pick" }]);
  expect(M.Assign({ agent: "code", model: "ghost" })).toEqual([409, { error: "ghost runs no model" }]);
  expect(M.Assign({ agent: "code", model: " razer " })).toEqual([200, { agent: "code", slot: "model", model: "phosphorus/razer" }]);
  expect(sysfs.read("etc/model/agents/code.json")).toEqual({ model: "phosphorus/razer" });
  const cc = M.Summary().agents[1].slots;
  expect(cc.model).toMatchObject({ chosen: "", inherited: true, assigned: "phosphorus/razer", model: "phosphorus/razer", ready: true });
  expect(cc.fast).toMatchObject({ chosen: "", inherited: false, assigned: "" });
  expect(M.Target("agent-claude-code")).toEqual(["", "large", "phosphorus/razer"]);
  expect(M.Assign({ agent: "claude-code", slot: "fast", model: "phosphorus/razer" })).toEqual([200, { agent: "claude-code", slot: "fast", model: "phosphorus/razer" }]);
  expect(M.Summary().agents[1].slots.fast).toMatchObject({ chosen: "phosphorus/razer", inherited: false, assigned: "phosphorus/razer" });
  expect(M.Target("Agent-Claude-Code-Fast ")).toEqual(["", "small", "phosphorus/razer"]);
  expect(M.Assign({ agent: "code", model: "" })).toEqual([200, { agent: "code", slot: "model", model: "" }]);
  expect(sysfs.read("etc/model/agents/code.json")).toEqual({});
  expect(M.Summary().agents[1].slots.model).toMatchObject({ chosen: "", inherited: false, assigned: "" });
  // a host since gone keeps its pick, a value not a mesh host is dropped
  sysfs.write("etc/model/agents/code.json", { model: "phosphorus/gone", fast: "openai/gpt" });
  expect(M.Summary().agents[0].slots.model).toMatchObject({ chosen: "phosphorus/gone", assigned: "phosphorus/gone", model: "phosphorus/razer", host: "razer" });
  expect(M.Summary().agents[0].slots.fast.chosen).toBe("");
  sysfs.write("etc/model/agents/code.json", {});
  sysfs.write("etc/model/agents/claude-code.json", {});
});

test("chat streamed and measured", async () => {
  await claim(ready);
  const p = {
    model: "razer", stream: true, stream_options: { x: 1 },
    messages: [{ role: "system", content: "be brief" }, { role: "user", content: "<context>\nnote here\n</context>\n\nhello there friend" }],
  };
  const r = await M.ServeChat(req(), p, false);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("text/event-stream");
  expect(r.headers.get("cache-control")).toBe("no-cache");
  const text = await r.text();
  expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  expect(text.split("\n\n").filter(Boolean)).toHaveLength(4);
  const sent = asked.find((a) => a.path === "/v1/chat/completions")!.body;
  expect(sent.stream_options).toEqual({ x: 1, include_usage: true });
  expect(sent.messages).toEqual(p.messages);
  // the asker's body untouched
  expect(p.stream_options).toEqual({ x: 1 });
  await settled(() => M.State()?.use !== undefined);
  const use = M.State()!.use;
  // the frame <|sys|>be brief<|end|> is 2 words, the note 4, the ask 3, of 12
  expect(use).toMatchObject({ since, system: 6, ask: 3, chat: 3, reply: 21 });
  expect(use.tps).toBeGreaterThan(0);
  expect(use.at).toBeGreaterThan(0);
  expect(asked.find((a) => a.path === "/apply-template")!.body).toEqual({ messages: [p.messages[0], { role: "user", content: "\u0000ask\u0000" }], add_generation_prompt: false });
  // a claim from another run of the server carries no use
  await claim({ ...ready, serverSince: since + 1 });
  expect(M.State()!.use).toBeUndefined();
  await claim(ready);
  expect(M.State()!.use).toEqual(use);
});

test("chat for another host", async () => {
  await claim(ready);
  const r = await M.ServeChat(req(), { model: "torus", messages: [] }, true);
  expect(r.status).toBe(503);
  expect(await r.json()).toEqual({ error: { message: "not loaded: no host has host = true under [model] in its phosphorus.ini" } });
  await claim({ ...ready, host: "torus" });
  const far = await M.ServeChat(req(), { model: "torus", messages: [] }, false);
  expect(far.status).toBe(409);
  expect(await far.json()).toEqual({ error: { message: "torus isn't this host" } });
  // the hop to torus's frontend, nobody there
  const hop = await M.ServeChat(req(), { model: "torus", messages: [] }, true);
  expect(hop.status).toBe(502);
  expect((await hop.json()).error.message).toMatch(/^torus didn't answer: /);
});

test("messages", async () => {
  await claim(ready);
  const p = { model: "phosphorus/razer", max_tokens: 100, system: "be brief", messages: [{ role: "user", content: "hi" }, { role: "system", content: "and kind" }] };
  const r = await M.ServeMessages(req(), p, "", true, false);
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ content: [{ type: "text", text: "ok" }] });
  // a pinned host: the body as sent, its system folded
  expect(sent("/v1/messages").body).toEqual({ model: "phosphorus/razer", max_tokens: 100, system: [{ type: "text", text: "be brief" }, { type: "text", text: "and kind" }], messages: [{ role: "user", content: "hi" }] });
  await settled(() => M.State()?.use?.reply === 7);
  // the folded system <|sys|>be briefand kind<|end|> is 3 words of 15
  expect(M.State()!.use).toMatchObject({ reply: 7, system: 3, ask: 0, chat: 12 });
  // an agent's name: a key, or a user's own page; its tier's profile
  expect((await M.ServeMessages(req(), { ...p, model: "agent-code" }, "", true, false)).status).toBe(401);
  expect((await M.ServeMessages(req(), { ...p, model: "agent-code" }, "", false, false)).status).toBe(401);
  const u = await M.ServeMessages(req(), { ...p, model: "agent-code" }, "", false, true);
  expect(u.status).toBe(200);
  expect(sent("/v1/messages").body).toMatchObject({ model: "agent-code", max_tokens: 100, chat_template_kwargs: { enable_thinking: true, reasoning_effort: "high" } });
  expect(sent("/v1/messages").body.temperature).toBeUndefined();
  const f = await M.ServeMessages(req(), { ...p, model: "agent-code-fast", max_tokens: 9000 }, "", false, true);
  expect(f.status).toBe(200);
  expect(sent("/v1/messages").body).toMatchObject({ max_tokens: 4096, temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5, chat_template_kwargs: { enable_thinking: false, reasoning_effort: "low" } });
  // counting tokens: unprofiled, llama-server's own answer passed back
  const c = await M.ServeMessages(req(), { ...p, model: "agent-code" }, "/count_tokens", false, true);
  expect(c.status).toBe(404);
  expect(sent("/v1/messages/count_tokens").body).toMatchObject({ model: "agent-code", max_tokens: 100 });
  expect(sent("/v1/messages/count_tokens").body.chat_template_kwargs).toBeUndefined();
  expect((await M.ServeMessages(req(), { model: "agent-code" }, "", false, true)).status).toBe(400);
});

test("models", async () => {
  await claim(ready);
  expect(M.ServeModels(req(), false).status).toBe(401);
  const r = M.ServeModels(req(), true);
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  const b = await r.json();
  expect(b.data.map((m: any) => m.id)).toEqual(["agent-code", "agent-claude-code", "agent-opencode"]);
  expect(b.data[0]).toMatchObject({ type: "model", display_name: "Code app", ready: true });
  expect(b.data[0].created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  expect(b).toMatchObject({ has_more: false, first_id: "agent-code", last_id: "agent-opencode" });
});

test("purge", async () => {
  await claim(ready);
  expect(await M.EraseSlots()).toEqual({ host: "razer", erased: 1, busy: 1 });
  expect(sent("/slots/0?action=erase").body).toEqual({});
  expect(await M.Purge("phosphorus/razer")).toEqual({ host: "razer", erased: 1, busy: 1 });
  expect(await M.Purge("razer")).toEqual({ host: "razer", erased: 1, busy: 1 });
  await expect(M.Purge("ghost")).rejects.toThrow(`"ghost" isn't a mesh model, nothing here to purge`);
  await claim({ ...ready, server: "loading" });
  await expect(M.Purge("razer")).rejects.toThrow("no model loaded on razer");
});
