import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSync, sleep } from "@phosphorus/util";
import { all, Session } from "../src/claude.ts";
import { EvLog, lineMax, logMax } from "../src/log.ts";
import { attach, create, envBlock, envLines, get, idRe, launchCommand, newID, permAnswer, record, setModel, setRunDir, setupScript, zipOf } from "../src/index.ts";
import { FakeConn, tmp } from "./fake.ts";

test("record shape", () => {
  const m = JSON.parse(JSON.stringify(record({ id: "abc", usage: { in: 1, out: 2, costUSD: 0.5 } })));
  for (const k of ["id", "user", "host", "dir", "title", "model", "perm", "status", "err", "claudeSID", "created", "updated", "usage"]) expect(k in m).toBe(true);
  expect(m.usage).toEqual({ in: 1, out: 2, costUSD: 0.5 });
  expect("harness" in m).toBe(false);
});

test("env lines", () => {
  const c = { user: "", pass: "", key: "k1", base: "http://100.1.2.3:8090", token: "tok" };
  const mesh = envLines("mesh", c);
  for (const w of ["PHOSPHORUS_MCP_KEY=k1", "ANTHROPIC_BASE_URL=http://100.1.2.3:8090/api/model", "ANTHROPIC_AUTH_TOKEN=k1",
    "ANTHROPIC_MODEL=agent-claude-code", "ANTHROPIC_SMALL_FAST_MODEL=agent-claude-code-fast", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"])
    expect(mesh).toContain(w);
  for (const l of mesh) expect(l).not.toContain("tok");
  const an = envLines("sonnet", c);
  expect(an).toContain("CLAUDE_CODE_OAUTH_TOKEN=tok");
  expect(an.length).toBe(2);
  expect(() => envLines("opus", { ...c, token: "" })).toThrow("no Anthropic token");
  expect(() => envLines("mesh", { ...c, key: "k\nX=1" })).toThrow("line break");
  expect(() => envLines("gpt", c)).toThrow("no model");
  // the models sessions were once saved with, chimp and orangutan, are no model now
  expect(() => envLines("chimp", c)).toThrow("no model");
  expect(envBlock(["A=1", "B=2"])).toBe("A=1\nB=2\n\n");
});

test("launch command", () => {
  const c = launchCommand("~/src/it's", "opus", "default", "sid-1");
  for (const w of ["--input-format stream-json", "--output-format stream-json", "--include-partial-messages",
    "--permission-prompt-tool stdio", "--strict-mcp-config", "--allowedTools mcp__phosphorus", "--model opus", "--resume"])
    expect(c).toContain(w);
  expect(c).not.toContain("--permission-mode");
  expect(launchCommand("/x", "mesh", "plan", "")).toContain("--permission-mode plan");
  expect(launchCommand("/x", "mesh", "plan", "")).not.toContain("--resume");
});

// sh reads the launch script as written: env off stdin, then claude in dir
test.skipIf(process.platform === "win32" || !Bun.which("sh"))("launch script runs", () => {
  const home = tmp("launch");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, "it's here"), { recursive: true });
  // a fake claude printing its env, args and stdin's rest
  writeFileSync(join(bin, "claude"), "#!/bin/sh\necho \"dir=$PWD\"\necho \"key=$PHOSPHORUS_MCP_KEY cfg=$CLAUDE_CONFIG_DIR api=$ANTHROPIC_API_KEY\"\necho \"args=$*\"\ncat\n", { mode: 0o755 });
  const env = { HOME: home, PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "leak" };
  const r = runSync(["sh", "-c", launchCommand("~/it's here", "mesh", "acceptEdits", "s'1")], { env, input: envBlock(["PHOSPHORUS_MCP_KEY=sec ret"]) + '{"type":"user"}\n' });
  expect(r.ok).toBe(true);
  for (const w of ["dir=" + join(home, "it's here"), "key=sec ret cfg=" + home + "/.phosphorus/claude api=\n",
    "--resume s'1", "--permission-mode acceptEdits", "--mcp-config " + home + "/.phosphorus/claude/mcp.json", '{"type":"user"}'])
    expect(r.output).toContain(w);
  // no claude: 127; no folder: 3
  expect(runSync(["sh", "-c", launchCommand("/nowhere/at/all", "mesh", "", "")], { env: { HOME: home, PATH: "/usr/bin:/bin" }, input: "\n" }).code).toBe(3);
  runSync(["rm", join(bin, "claude")]);
  expect(runSync(["sh", "-c", launchCommand("~", "mesh", "", "")], { env: { HOME: home, PATH: "/usr/bin:/bin" }, input: "\n" }).code).toBe(127);
});

test.skipIf(process.platform === "win32" || !Bun.which("sh"))("setup script", () => {
  const home = tmp("setup");
  const old = join(home, ".phosphorus/claude/skills/phosphorus/stale.md");
  mkdirSync(join(home, ".phosphorus/claude/skills/phosphorus"), { recursive: true });
  writeFileSync(old, "x");
  const body = "---\nname: phosphorus\n---\nit's $HOME `x` PHOS_EOF_ \\ no newline";
  const s = setupScript(zipOf({ "phosphorus/SKILL.md": body, "phosphorus/references/a.md": "a\n" }), "http://1.2.3.4:8090");
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(join(home, ".local/bin/claude"), "#!/bin/sh\n", { mode: 0o755 });
  const r = runSync(["sh", "-s"], { env: { HOME: home, PATH: "/usr/bin:/bin" }, input: s });
  expect(r.ok, r.output).toBe(true);
  const d = join(home, ".phosphorus/claude");
  expect(readFileSync(join(d, "skills/phosphorus/SKILL.md"), "utf8")).toBe(body + "\n");
  expect(existsSync(old)).toBe(false);
  const mc = JSON.parse(readFileSync(join(d, "mcp.json"), "utf8"));
  const ph = mc.mcpServers.phosphorus;
  expect(ph.url).toBe("http://1.2.3.4:8090/api/mcp");
  expect(ph.headers.Authorization).toBe("Bearer ${PHOSPHORUS_MCP_KEY}");
  expect(statSync(join(d, "mcp.json")).mode & 0o777).toBe(0o600);
  expect(() => setupScript(zipOf({ "../evil": "x" }), "b")).toThrow("bad skill file");
});

test("perm answer", () => {
  const req = { input: { command: "ls" }, permission_suggestions: [{ type: "addRules" }] };
  const a = permAnswer(req, true, false, "");
  expect(a.behavior).toBe("allow");
  expect(a.updatedInput.command).toBe("ls");
  expect(a.updatedPermissions).toBeUndefined();
  expect(permAnswer(req, true, true, "").updatedPermissions).toBeDefined();
  const d = permAnswer(req, false, true, "no");
  expect(d).toEqual({ behavior: "deny", message: "no" });
  expect(permAnswer({}, false, false, "").message).not.toBe("");
});

test("log replay", () => {
  const f = join(tmp("log"), "x.jsonl");
  const l = new EvLog(f);
  for (let i = 0; i < 5; i++) l.add({ kind: "user", text: "t" });
  const seqs: number[] = [];
  l.each(2, (seq) => seqs.push(seq));
  expect(seqs).toEqual([3, 4, 5]);
  const l2 = new EvLog(f);
  expect([l2.last(), l2.lines]).toEqual([5, 5]);
  const big = l.add({ kind: "claude", ev: { type: "user", x: "a".repeat(lineMax) } });
  expect(big.length).toBeLessThan(1000);
  expect(big).toContain('"truncated":true');
  for (let i = 0; i < logMax + logMax / 10; i++) l.add({ kind: "user" });
  let n = 0, first = 0;
  l.each(0, (seq) => {
    if (!first) first = seq;
    n++;
  });
  expect(n).toBeLessThanOrEqual(logMax + logMax / 10);
  expect(n).toBeGreaterThanOrEqual(logMax);
  expect(first).toBeGreaterThan(6);
});

// a socket joining mid-session: the log replayed past since, a line logged
// during the replay sent once, live ones after, the status last
test("attach replay", async () => {
  setRunDir(tmp("attach"));
  const s = new Session(record({ id: "aaaaaaaaaaaa", user: "pmh", status: "idle" }));
  all.set(s.rec.id, s);
  for (let i = 0; i < 4; i++) s.emit({ kind: "user", text: "x" }, true);
  const fc = new FakeConn();
  let end!: () => void;
  const done = new Promise<void>((r) => (end = r));
  const ok = attach(fc, done, "pmh", s.rec.id, 2);
  while (fc.msgs.length < 3) await sleep(1);
  s.emit({ kind: "claude", ev: { type: "stream_event" } }, false);
  s.emit({ kind: "user", text: "late" }, true);
  end();
  expect(await ok).toBe(true);
  expect(fc.msgs.map((m) => m.seq)).toEqual([3, 4, 0, 0, 5]);
  expect(fc.msgs[2]!.kind).toBe("status");
  expect(await attach(fc, done, "other", s.rec.id, 0)).toBe(false);
});

test("create validates", async () => {
  setRunDir(tmp("create"));
  const never = () => {
    throw new Error("creds asked");
  };
  for (const p of [
    { host: "", dir: "/x", model: "mesh" },
    { host: "razer", dir: "", model: "mesh" },
    { host: "razer", dir: "/x\ny", model: "mesh" },
    { host: "razer", dir: "/x", model: "gpt-5" },
    { host: "razer", dir: "/x", model: "chimp" },
    { host: "razer", dir: "/x", model: "mesh", perm: "yolo" },
    { host: "razer", dir: "/x", model: "mesh", harness: "aider" },
  ]) {
    const [st, b] = await create("pmh", p, never);
    expect(st, JSON.stringify(b)).toBe(400);
    expect(b.error).not.toContain("creds asked");
  }
  expect(get("pmh", "nope")[0]).toBe(404);
  expect(newID()).not.toBe(newID());
  expect(idRe.test(newID())).toBe(true);
});

test("set model within a provider", () => {
  setRunDir(tmp("model"));
  const rec = record({ id: newID(), user: "pmh", host: "razer", dir: "/x", model: "mesh", perm: "default", status: "ended" });
  all.set(rec.id, new Session(rec));
  const [st, b] = setModel("pmh", rec.id, { model: "opus" });
  expect(st).toBe(409);
  expect(b.error).toContain("new session");
  const [st2, b2] = setModel("pmh", rec.id, { model: "mesh" });
  expect([st2, b2.model]).toEqual([200, "mesh"]);
  const r = get("pmh", rec.id)[1];
  expect([r.model, r.status]).toEqual(["mesh", "ended"]);
});
