// the real claude CLI against a fake mesh, run locally in place of ssh:
// skipped without claude on PATH, or with CLAUDE_E2E=0
import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { sleep, which } from "@phosphorus/util";
import { of } from "../src/claude.ts";
import {
  answer,
  create,
  get,
  remove,
  type Spawner,
  send,
  setModel,
  setPerm,
  setRunDir,
  setSpawn,
  stop,
  Tail,
  zipOf,
} from "../src/index.ts";
import { attach } from "../src/ws.ts";
import { FakeConn, tmp } from "./fake.ts";

const sse = (events: Record<string, any>[]) =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });

// fakeAPI a Messages API: Bash once, then done; an mcp server noting its auth
function fakeAPI(auths: Map<string, any>) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 255,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      auths.set(path, req.headers.get("Authorization") ?? "");
      const s = await req.text();
      if (path.startsWith("/api/mcp")) {
        let m: Record<string, any> = {};
        try {
          m = JSON.parse(s);
        } catch {}
        if (m.id === undefined || m.id === null) return new Response(null, { status: 202 });
        let res: Record<string, any> = {};
        if (m.method === "initialize")
          res = {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "phosphorus", version: "1" },
          };
        else if (m.method === "tools/list") res = { tools: [] };
        return Response.json({ jsonrpc: "2.0", id: m.id, result: res });
      }
      if (path.endsWith("/count_tokens")) return new Response('{"input_tokens":10}');
      if (!path.endsWith("/v1/messages")) return new Response(null, { status: 404 });
      let p: Record<string, any> = {};
      try {
        p = JSON.parse(s);
      } catch {}
      if (s.includes("run it") && s.includes("after resume")) auths.set("resumed", true);
      const hasBash = s.includes('"name":"Bash"');
      const done = s.includes('"tool_result"');
      const msg: Record<string, any> = {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: p.model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      };
      const usage = { output_tokens: 5 };
      if (hasBash && !done && p.stream === true)
        return sse([
          { type: "message_start", message: msg },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: '{"command":"touch made-by-e2e && echo phos-e2e","description":"say it"}',
            },
          },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage },
          { type: "message_stop" },
        ]);
      if (s.includes("go slow") && !s.includes("slow done") && p.stream === true) {
        // a text that never ends until the client goes
        const enc = new TextEncoder();
        const line = (e: Record<string, any>) => enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        const stream = new ReadableStream<Uint8Array>({
          start(ctl) {
            ctl.enqueue(line({ type: "message_start", message: msg }));
            ctl.enqueue(line({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
            let i = 0;
            const t = setInterval(() => {
              try {
                if (i++ < 200)
                  ctl.enqueue(
                    line({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "zz " } }),
                  );
                else ctl.close();
              } catch {
                clearInterval(t);
              }
            }, 100);
            req.signal.addEventListener("abort", () => {
              auths.set("interrupted", true);
              clearInterval(t);
            });
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      }
      const text = done ? "all done" : "ok";
      if (p.stream !== true)
        return Response.json({ ...msg, content: [{ type: "text", text }], stop_reason: "end_turn" });
      return sse([
        { type: "message_start", message: msg },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
        { type: "message_stop" },
      ]);
    },
  });
}

// localSpawn setup and claude run here under home, no ssh
function localSpawn(home: string): Spawner {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("CLAUDE") && !k.startsWith("ANTHROPIC")) env[k] = v;
  Object.assign(env, { HOME: home, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" });
  return async (_host, _c, setup, command, envs) => {
    const st = Bun.spawn(["sh", "-s"], { env, stdin: new Blob([setup]), stdout: "pipe", stderr: "pipe" });
    const [out, errs, code] = await Promise.all([
      new Response(st.stdout).text(),
      new Response(st.stderr).text(),
      st.exited,
    ]);
    if (code !== 0) throw new Error(`setup: ${code} ${out}${errs}`);
    const cmd = Bun.spawn(["sh", "-c", command], { env, cwd: home, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const tail = new Tail();
    void (async () => {
      for await (const c of cmd.stderr) tail.write(c);
    })();
    cmd.stdin.write(envs);
    cmd.stdin.flush();
    return {
      in: { write: (s) => void (cmd.stdin.write(s), cmd.stdin.flush()), end: () => void cmd.stdin.end() },
      out: cmd.stdout,
      errs: tail,
      wait: () => cmd.exited,
      kill: () => {
        cmd.stdin.end();
        cmd.kill("SIGINT");
      },
    };
  };
}

const claude = which("claude");

test.skipIf(!claude || process.env.CLAUDE_E2E === "0")(
  "e2e: the real claude on a fake mesh",
  async () => {
    const home = tmp("e2e-home");
    setRunDir(tmp("e2e"));
    setSpawn(localSpawn(home));
    const auths = new Map<string, any>();
    const api = fakeAPI(auths);
    const skill = zipOf({ "phosphorus/SKILL.md": "---\nname: phosphorus\ndescription: test\n---\nhi\n" });
    const creds = () => ({
      user: "",
      pass: "",
      token: "",
      key: "testkey",
      base: `http://127.0.0.1:${api.port}`,
      skill,
    });
    let end!: () => void;
    const done = new Promise<void>((r) => (end = r));
    try {
      const [st, body] = await create(
        "pmh",
        { host: "here", dir: "~", model: "mesh", perm: "default", prompt: "run it" },
        creds,
      );
      expect(st, JSON.stringify(body)).toBe(200);
      const id = body.id;
      const fc = new FakeConn();
      fc.id = id;
      void attach(fc, done, "pmh", id, 0);

      const perm = await fc.wait("permission ask", 90_000, (m) => m.kind === "permission");
      expect(perm.tool).toBe("Bash");
      expect(JSON.stringify(perm.input)).toContain("phos-e2e");
      expect(answer("pmh", id, { reqId: perm.reqId, allow: true })[0]).toBe(200);
      await fc.wait("tool output", 60_000, (m) => {
        const b = JSON.stringify(m.ev);
        return m.kind === "claude" && b.includes("tool_result") && b.includes("phos-e2e");
      });
      await fc.wait("result", 60_000, (m) => m.kind === "claude" && m.ev?.type === "result");
      expect(auths.get("/api/model/v1/messages")).toBe("Bearer testkey");
      expect(auths.has("/api/mcp"), "claude never called the mcp server").toBe(true);
      expect(auths.get("/api/mcp")).toBe("Bearer testkey");
      expect(existsSync(home + "/.phosphorus/claude/skills/phosphorus/SKILL.md")).toBe(true);
      // a second prompt on the same process, then stop
      expect((await send("pmh", id, { text: "again" }, creds))[0]).toBe(200);
      expect(get("pmh", id)[1].claudeSID).not.toBe("");
      // a switch within the mesh in band
      expect(setModel("pmh", id, { model: "mesh" })[0]).toBe(200);
      expect(setPerm("pmh", id, { mode: "acceptEdits" })[0]).toBe(200);
      expect(stop("pmh", id)[0]).toBe(200);
      await sleep(2000);
      // let go as idle, then resumed by the next prompt with the history
      const s = of("pmh", id)!;
      s.stopping = true;
      s.p!.kill();
      for (let i = 0; i < 100 && get("pmh", id)[1].status !== "ended"; i++) await sleep(100);
      expect(get("pmh", id)[1].status).toBe("ended");
      expect((await send("pmh", id, { text: "after resume" }, creds))[0]).toBe(200);
      for (let i = 0; i < 300 && !auths.has("resumed"); i++) await sleep(100);
      expect(auths.has("resumed"), "resume lost the history").toBe(true);
      // a slow turn stopped mid-stream
      await fc.wait("resumed result", 60_000, (m) => m.kind === "claude" && m.seq > 20 && m.ev?.type === "result");
      await send("pmh", id, { text: "go slow" }, creds);
      await fc.wait(
        "partial text",
        30_000,
        (m) => m.kind === "claude" && m.seq === 0 && JSON.stringify(m).includes("zz"),
      );
      const t0 = Date.now();
      stop("pmh", id);
      for (let i = 0; i < 100 && !auths.has("interrupted"); i++) await sleep(100);
      expect(auths.has("interrupted"), "stop didn't interrupt").toBe(true);
      console.log("interrupted in", Date.now() - t0, "ms");
      await sleep(1000);
      expect(get("pmh", id)[1].status).toBe("idle");
      expect(fc.find((m) => m.kind === "error")).toBeUndefined();
      remove("pmh", id);
      await sleep(500);
    } finally {
      end();
      setSpawn();
      api.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  },
  600_000,
);
