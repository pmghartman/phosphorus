import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "mcp-test-"));
const { allTools, callBegin, callDetail, callEnd, calls, handle, init, skill, skillFiles, statsRow, statsShape } = await import("@phosphorus/mcp");
type Caller = import("@phosphorus/mcp").Caller;
type Actions = import("@phosphorus/mcp").Actions;
// the few buttons a test wires, typed as the whole set
const acts = (a: Partial<Actions>) => a as Actions;

const rpc = (method: string, params?: Record<string, any>) => ({ jsonrpc: "2.0", id: 1, method, params });

// unzip every file by name, as archive/zip reads the skill
function unzip(z: Uint8Array): Map<string, string> {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
  let eocd = -1;
  for (let i = z.length - 22; i >= 0; i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  expect(eocd).toBeGreaterThanOrEqual(0);
  const n = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  for (let k = 0; k < n; k++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), cmtLen = v.getUint16(p + 32, true);
    const at = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(z.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + cmtLen;
    expect(v.getUint32(at, true)).toBe(0x04034b50);
    const start = at + 30 + v.getUint16(at + 26, true) + v.getUint16(at + 28, true);
    const raw = z.subarray(start, start + csize);
    expect(method).toBe(8);
    out.set(name, new TextDecoder().decode(inflateRawSync(raw)));
  }
  return out;
}

test("handle", async () => {
  init({ self: () => ({ host: "h", version: "1" }) });
  const [, out] = await handle(rpc("ping"), false, undefined);
  expect(out.result).toBeDefined();
  const list = async (c: Caller) => (await handle(rpc("tools/list"), false, c))[1].result.tools.length;
  const user = await list({ user: "u" }), admin = await list({ user: "a", admin: true });
  expect(user).toBeGreaterThan(0);
  expect(admin).toBeGreaterThan(user);
  const [, o] = await handle(rpc("tools/call", { name: "nope" }), false, { user: "u" });
  expect(o.error).toBeDefined();
  const [st] = await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, false, undefined);
  expect(st).toBe(202);
});

test("call log", () => {
  expect(callDetail({ host: "a", command: "ls   -la\n/tmp" })).toBe("ls -la /tmp");
  expect(callDetail({ n: 1, zz: "z", b: "b" })).toBe("b");
  const id = callBegin("tester", "terminal_run", "ls", "");
  expect(calls("tester").calls).toHaveLength(1);
  callEnd("tester", id, "boom");
  const c = calls("tester");
  expect(c.calls).toHaveLength(0);
  expect(c.recent).toHaveLength(1);
  expect(c.recent[0].error).toBe("boom");
});

// backticked words in the skill that are arguments, not tools
const skillWords = new Set(["dry_run", "wait_s", "base_path", "clone_url", "mcp__phosphorus__", "bad_input", "not_found"]);

test("skill", async () => {
  init({ self: () => ({ host: "h", version: "1.2" }) });
  const got = unzip(await skill("pat", true, "https://mesh.example"));
  expect(got.size).toBeGreaterThan(0);
  for (const [n, s] of got) {
    expect(n.startsWith("phosphorus/")).toBe(true);
    expect(s).not.toContain("{{");
    expect(s).not.toContain("$ARGUMENTS");
    expect(s).not.toContain("/api/mcp");
  }
  const sk = got.get("phosphorus/SKILL.md")!;
  expect(sk.startsWith("---\nname: phosphorus\ndescription: ")).toBe(true);
  expect(sk).toContain("https://mesh.example");
  expect(sk).toContain("phosphorus 1.2");
  for (const f of ["status", "diagnose", "run", "files", "service", "update", "chat", "git"]) {
    expect(got.get(`phosphorus/references/${f}.md`)).toBeTruthy();
    expect(sk).toContain(`references/${f}.md`);
  }
  // every tool the skill names is one the server lists
  const names = new Set(allTools().map((t) => t.name));
  for (const body of got.values()) {
    for (const m of body.matchAll(/`([a-z]+_[a-z_]+)`/g)) expect(names.has(m[1]!) || skillWords.has(m[1]!)).toBe(true);
  }
});

test("the skill's file list is the folder", () => {
  const root = resolve(import.meta.dir, "..", "skill");
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  const onDisk = walk(root).map((p) => p.slice(root.length + 1).replaceAll("\\", "/")).sort();
  expect(Object.keys(skillFiles).sort()).toEqual(onDisk);
  for (const [n, p] of Object.entries(skillFiles)) expect(resolve(p)).toBe(join(root, n));
});

test("mesh_hosts gives the self row its version", async () => {
  const rows = [{ name: "h" }, { name: "p", version: "1" }];
  init({ self: () => ({ host: "h", version: "2" }), domain: () => "", tailnet: () => rows });
  const [, o] = await handle(rpc("tools/call", { name: "mesh_hosts" }), false, { user: "u" });
  const text: string = o.result.content[0].text;
  expect(JSON.parse(text).hosts[0].version).toBe("2");
  expect((rows[0] as any).version).toBeUndefined();
});

test("stats shape", () => {
  const long = "x".repeat(300);
  const s = {
    host: "h", cpu: { total: 12.5, cores: [1, 2], load: [0.123456, null, 1] },
    mem: { total: 200, used: 50, avail: 150, cached: 9, swapTotal: 10, swapUsed: 5 },
    disk: { count: 1, total: 1000, used: 778 },
    gpus: [{ name: "g", util: 38.886, temp: null }],
    procs: { count: 9, top: [{ name: "a", cmd: long }, {}, {}, {}, {}, {}, {}] },
    parts: [{ name: "frontend", cpu: 1, mem: 2, pids: 3 }],
  };
  const st = statsShape(s);
  expect(st.parts).toHaveLength(1);
  expect(st.mem.usedPct).toBe(25);
  expect(st.mem.cached).toBeUndefined();
  expect(st.procs.top).toHaveLength(6);
  expect([...st.procs.top[0].cmd]).toHaveLength(101);
  expect(st.gpus[0].util).toBe(38.9);
  expect(st.gpus[0].temp).toBeUndefined();
  expect(st.cpu.load).toEqual([0.12, null, 1]);
  const r = statsRow(st);
  expect(r.diskPct).toBe(77.8);
  expect(r.swapPct).toBe(50);
  expect(r.gpuPct).toBe(38.9);
  expect(r.cpuPct).toBe(12.5);
});

test("key grants", async () => {
  init({ self: () => ({ host: "h", version: "1" }), domain: () => "mesh.example" });
  const bare = (): Caller => ({ user: "u", pages: () => undefined });
  const git: Caller = { user: "u", hosts: () => ["b", "a"], pages: () => ({ git: { user: "u", pass: "p" } }) };
  const names = async (c: Caller) => {
    const [, o] = await handle(rpc("tools/list"), false, c);
    return Object.fromEntries(o.result.tools.map((t: any) => [t.name, t.description])) as Record<string, string>;
  };
  expect((await names(bare())).forgejo).toBeUndefined();
  const g = await names(git);
  expect(g.forgejo).toBeDefined();
  expect(g.terminal_run).toContain("saved logins: a, b;");
  let [, o] = await handle(rpc("tools/call", { name: "forgejo" }), false, bare());
  expect(o.error.message).toContain("off this key");
  [, o] = await handle(rpc("initialize"), false, bare());
  const ins: string = o.result.instructions;
  for (const w of ["acts as u, a user", "no saved host logins", "No forgejo login", "Off this key:", "host_power"]) expect(ins).toContain(w);
  // the mark off the mesh's domain first, inline after it
  const icons: { src: string }[] = o.result.serverInfo.icons;
  expect(icons[0]!.src).toBe("https://mesh.example/icon-192.png");
  expect(icons[1]!.src.startsWith("data:image/png;base64,iVBOR")).toBe(true);
});

test("a tool's error carries its code, a batch answers each request", async () => {
  init({ self: () => ({ host: "h", version: "1" }), tailnet: () => [] });
  const [st, out] = await handle([rpc("tools/call", { name: "host_stats", arguments: { host: "nope" } }), { jsonrpc: "2.0", method: "x" }, rpc("nope")], true, undefined);
  expect(st).toBe(200);
  expect(out).toHaveLength(2);
  expect(out[0].result.isError).toBe(true);
  expect(out[0].result.structuredContent.error.code).toBe("not_found");
  expect(out[0].result.content[0].text).toMatch(/^not_found: no phosphorus host nope/);
  expect(out[1].error.code).toBe(-32601);
  // an unkeyed peer sees reads alone, this host its own buttons too
  const peer = (await handle(rpc("tools/list"), false, undefined))[1].result.tools.map((t: any) => t.name);
  const local = (await handle(rpc("tools/list"), true, undefined))[1].result.tools.map((t: any) => t.name);
  expect(peer).toContain("mesh_hosts");
  expect(peer).not.toContain("game_power");
  expect(local).toContain("game_power");
  expect(local).not.toContain("host_logs");
});

test("a keyed write is audited, logged and mirrored", async () => {
  const steps: Record<string, any>[] = [];
  init({
    self: () => ({ host: "h", version: "1" }), tailnet: () => [],
    actions: acts({ files: (_c, _h, _op, _s, body) => [200, { ok: true, path: body.path }], userUIAsync: (_u, s) => void steps.push(s) }),
  });
  const c: Caller = { user: "u", via: "claude" };
  const [, o] = await handle(rpc("tools/call", { name: "files_change", arguments: { host: "h", share: "0", op: "mkdir", path: "a/b" } }), false, c);
  expect(JSON.parse(o.result.content[0].text)).toEqual({ ok: true, op: "mkdir", path: "a/b", now: "a/b" });
  await Bun.sleep(10);
  expect(steps.map((s) => s.phase)).toEqual(["start", "end"]);
  expect(steps[0]).toMatchObject({ kind: "agent", tool: "files_change", read: false, args: { host: "h", path: "a/b" } });
  expect(steps[1]).toMatchObject({ kind: "agent", ok: true, error: "" });
  const [, log] = await handle(rpc("tools/call", { name: "audit_log" }), false, c);
  const rows = JSON.parse(log.result.content[0].text).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ user: "u", via: "claude", tool: "files_change", ok: true, host: "h", args: { op: "mkdir", path: "a/b" } });
  expect(rows[0].at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  const mine = calls("u");
  expect(mine.recent[1]).toMatchObject({ tool: "files_change", detail: "a/b", host: "h", ok: true });
  expect(mine.client).toBe("claude");
});

test("terminal_run git hands the forgejo login to a fresh shell", async () => {
  let got: any;
  init({
    self: () => ({ host: "h", version: "1" }), tailnet: () => [], domain: () => "mesh.example",
    actions: acts({ op: (_h, op, p) => ((got = { op, p }), [200, { exit: 0, output: "ok" }]), userUIAsync: () => {} }),
  });
  const c: Caller = { user: "u", login: () => ({ user: "me", pass: "pw" }), pages: () => ({ git: { user: "gu", pass: "gp" } }) };
  const [, o] = await handle(rpc("tools/call", { name: "terminal_run", arguments: { host: "h", command: "git fetch", git: true, stdin: "x" } }), false, c);
  expect(o.result.isError).toBeUndefined();
  expect(got.op).toBe("exec");
  expect(got.p).toMatchObject({ user: "me", pass: "pw", timeout: 60, stdin: "gu\ngp\nx" });
  expect(got.p.cmd.startsWith("IFS= read -r PHOS_GIT_USER; IFS= read -r PHOS_GIT_PASS; export ")).toBe(true);
  expect(got.p.cmd).toContain("GIT_CONFIG_KEY_0='credential.https://git.mesh.example.helper'");
  expect(got.p.cmd.endsWith("; f'\ngit fetch")).toBe(true);
  // a saved login and no git: the persistent session, reset passed along
  await handle(rpc("tools/call", { name: "terminal_run", arguments: { host: "h", command: "ls", reset: true } }), false, c);
  expect(got).toMatchObject({ op: "shell", p: { cmd: "ls", stdin: "", reset: true } });
});
