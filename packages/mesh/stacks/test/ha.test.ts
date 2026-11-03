import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "@phosphorus/elector";
import type { Runtime } from "@phosphorus/stacks";
import { groupOf, HA, type Mesh } from "@phosphorus/stacks/ha";
import type { AppDef, StackWant } from "@phosphorus/wire";

// --- a small mesh on simulated time ---------------------------------------------

class World {
  t = 0;
  seq = 0;
  timers: { at: number; seq: number; fn: () => void }[] = [];
  root = mkdtempSync(join(tmpdir(), "phos-ha-"));
  wants: Record<string, StackWant> = {};
  hosts = new Map<string, Node>();
  cuts = new Set<string>();
  notes: string[] = [];

  at(ms: number, fn: () => void) {
    this.timers.push({ at: this.t + ms, seq: this.seq++, fn });
    this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  linked = (a: string, b: string) => a === b || !this.cuts.has([a, b].sort().join("|"));
  isolate(a: string) {
    for (const b of this.hosts.keys()) if (b !== a) this.cuts.add([a, b].sort().join("|"));
  }

  async run(ms: number) {
    const end = this.t + ms;
    while (this.timers.length && this.timers[0]!.at <= end) {
      const tm = this.timers.shift()!;
      this.t = tm.at;
      tm.fn();
      await new Promise<void>((r) => setImmediate(r));
    }
    this.t = end;
  }

  async until(pred: () => boolean, ms: number) {
    const start = this.t;
    while (this.t - start < ms) {
      if (pred()) return this.t - start;
      await this.run(250);
    }
    return pred() ? this.t - start : -1;
  }

  node(name: string) {
    const n = new Node(this, name);
    this.hosts.set(name, n);
    return n;
  }
}

// compose as the fake has it: per stack running or not, hooks logged; outlives
// a host's phosphorus, as containers do
class FakeRuntime implements Runtime {
  on = new Set<string>();
  log: string[] = [];
  gens: Record<string, number> = {};
  constructor(
    public root: string,
    public world: World,
  ) {}
  dataDir = (id: string) => join(this.root, "stacks", id, "data");
  async up(id: string) {
    mkdirSync(this.dataDir(id), { recursive: true });
    this.on.add(id);
    this.log.push("up");
  }
  async down(id: string) {
    this.on.delete(id);
    this.log.push("down");
  }
  running = async (id: string) => this.on.has(id);
  gen = async (id: string) => this.gens[id] ?? this.world.wants[id]?.gen ?? 0;
  // the app's database dumped before a copy, the dump dropped after
  async hook(id: string, phase: "pre" | "post") {
    this.log.push(phase);
    const d = this.dataDir(id);
    if (phase === "pre") writeFileSync(join(d, "db.dump"), readFileSync(join(d, "db"), "utf8"));
  }
  // an acknowledged write, only on a running copy
  write(id: string, v: string) {
    if (!this.on.has(id)) return false;
    writeFileSync(join(this.dataDir(id), "db"), v);
    return true;
  }
  read = (id: string) => {
    try {
      return readFileSync(join(this.dataDir(id), "db"), "utf8");
    } catch {
      return "";
    }
  };
}

class Node {
  alive = false;
  life = 0;
  crashedAt = 0;
  ha!: HA;
  rt: FakeRuntime;
  dir: string;

  constructor(
    public w: World,
    public name: string,
  ) {
    this.dir = join(w.root, name);
    this.rt = new FakeRuntime(this.dir, w);
  }

  clock(): Clock {
    const life = this.life;
    return {
      mono: () => 5e6 + this.w.t,
      wall: () => 1.75e12 + this.w.t,
      sleep: (ms) =>
        new Promise((res) =>
          this.w.at(Math.max(1, ms), () => {
            if (this.alive && this.life === life) res();
          }),
        ),
    };
  }

  peer(h: string): Node | undefined {
    const p = this.w.hosts.get(h);
    return p?.alive && this.alive && this.w.linked(this.name, h) ? p : undefined;
  }

  mesh(): Mesh {
    return {
      self: this.name,
      stateDir: join(this.dir, "state"),
      wants: () => this.w.wants,
      setWant: (id, v) => void (this.w.wants[id] = v),
      peers: () => {
        const out: Record<string, Record<string, any>> = {};
        for (const h of this.w.hosts.keys()) if (h !== this.name && this.peer(h)) out[h] = this.peer(h)!.ha.own();
        return out;
      },
      offlineMs: () => {
        const out: Record<string, number> = {};
        for (const p of this.w.hosts.values()) if (!p.alive) out[p.name] = this.w.t - p.crashedAt;
        return out;
      },
      pollMs: () => 500,
      updating: () => false,
      bootId: () => `${this.name}-${this.life}`,
      notify: (title, body) => void this.w.notes.push(`${this.name}: ${title}: ${body}`),
      call: async (h, method, path, body) => {
        const p = this.peer(h);
        if (!p) return undefined;
        const m = /^\/api\/ha\/([a-z0-9-]+)\/(view|vote|snap|handoff)$/.exec(path);
        if (!m) return undefined;
        const g = m[1]!;
        if (m[2] === "view") return p.ha.view(g);
        if (m[2] === "snap") return p.ha.manifest(g) as any;
        const [st, out] = m[2] === "vote" ? p.ha.vote(g, body as any) : p.ha.askHandoff(g, (body as any)?.to);
        return st === 200 ? out : undefined;
      },
      fetchFile: async (h, g, path, file) => {
        const f = this.peer(h)?.ha.file(g, path);
        if (!f) return false;
        copyFileSync(f, file);
        return true;
      },
      clock: this.clock(),
    };
  }

  boot() {
    this.alive = true;
    this.life++;
    this.ha = new HA(this.mesh());
    this.ha.attach(this.rt);
    const life = this.life;
    const every = (ms: number, fn: () => void) => {
      const go = () => {
        if (!this.alive || this.life !== life) return;
        fn();
        this.w.at(ms, go);
      };
      this.w.at(ms, go);
    };
    every(250, () => this.ha.step());
    every(200, () => this.ha.watchdog());
  }

  // the host gone, its containers still running
  crash() {
    this.alive = false;
    this.crashedAt = this.w.t;
  }

  role = (id: string) => this.ha.status(id)?.role;
}

const def = (id: string): AppDef => ({
  id,
  source: "github",
  ref: "o/" + id,
  name: "Vault",
  tagline: "",
  description: "",
  icon: "",
  category: "",
  repo: "",
  licence: "MIT",
  archs: [],
  compose: "services: {}",
  env: [],
  manifest: { volumes: [], backup: { pre: [{ service: "db", run: ["dump"] }] } },
});

// a, the active, b its standby, c a voter; the app up on a with one write
async function mesh3() {
  const w = new World();
  const a = w.node("a");
  const b = w.node("b");
  const c = w.node("c");
  w.wants.vault = { def: def("vault"), env: {}, active: "a", standbys: ["b"], gen: 1, by: "admin", at: 1 };
  mkdirSync(a.rt.dataDir("vault"), { recursive: true });
  writeFileSync(join(a.rt.dataDir("vault"), "db"), "v0");
  for (const n of [a, b, c]) n.boot();
  // voters abstain their first 10s
  expect(await w.until(() => a.rt.on.has("vault"), 30_000)).toBeGreaterThan(0);
  expect(a.rt.write("vault", "v1")).toBe(true);
  expect(await w.until(() => b.rt.read("vault") === "" && copyOf(b) === "v1", 20_000)).toBeGreaterThanOrEqual(0);
  return { w, a, b, c };
}

const copyOf = (n: Node) => {
  try {
    return readFileSync(join(n.rt.dataDir("vault"), "..", "ha", "copy", "db"), "utf8");
  } catch {
    return "";
  }
};

test("the active snapshots between its hooks, the standby pulls a copy and reports it", async () => {
  const { a, b, c } = await mesh3();
  expect(a.role("vault")).toBe("active");
  expect(b.role("vault")).toBe("standby");
  // c votes but holds no copy
  expect(c.ha.status("vault")).toBeUndefined();
  expect(c.ha.vote(groupOf("vault"), { c: "x", ms: 0, roster: { epoch: 0, members: [], prev: null } })[0]).toBe(200);
  // pre before every copy, post after
  const hooks = a.rt.log.filter((x) => x === "pre" || x === "post");
  expect(hooks.length).toBeGreaterThanOrEqual(2);
  expect(hooks.every((x, i) => x === (i % 2 ? "post" : "pre"))).toBe(true);
  // the dump the pre hook made rode along
  expect(readFileSync(join(b.rt.dataDir("vault"), "..", "ha", "copy", "db.dump"), "utf8")).toBe("v1");
  expect(b.ha.status("vault")!.lastSync).toBeGreaterThan(0);
  expect(b.rt.on.has("vault")).toBe(false);
  // unchanged data: no more hooks
  const n = a.rt.log.length;
  await a.w.run(15_000);
  expect(a.rt.log.length).toBe(n);
});

test("the active's host failing: the standby promotes, the want and route follow, a former active returns as standby", async () => {
  const { w, a, b } = await mesh3();
  const g = groupOf("vault");
  a.crash();
  const took = await w.until(() => b.rt.on.has("vault"), 30_000);
  expect(took).toBeGreaterThan(0);
  expect(took).toBeLessThan(10_000);
  expect(b.rt.read("vault")).toBe("v1");
  expect(w.wants.vault!.active).toBe("b");
  expect(w.wants.vault!.standbys).toEqual(["a"]);
  expect(w.wants.vault!.gen).toBe(1);
  expect(b.ha.leads("vault")).toBe(true);
  expect(b.ha.leader(g)).toBe("b");
  expect(w.notes.some((n) => n.startsWith("b: Vault moved to b: a stopped answering"))).toBe(true);
  expect(b.rt.write("vault", "v2")).toBe(true);

  // back with its containers still up: stopped at once, its data set aside, a standby again
  expect(a.rt.on.has("vault")).toBe(true);
  a.boot();
  expect(await w.until(() => !a.rt.on.has("vault"), 20_000)).toBeGreaterThanOrEqual(0);
  expect(await w.until(() => copyOf(a) === "v2", 30_000)).toBeGreaterThanOrEqual(0);
  expect(a.ha.leads("vault")).toBe(false);
  expect(a.role("vault")).toBe("standby");
  const base = join(a.rt.dataDir("vault"), "..");
  const orphans = readdirSync(base).filter((f) => f.startsWith("data.orphan-"));
  expect(orphans.length).toBe(1);
  expect(readFileSync(join(base, orphans[0]!, "db"), "utf8")).toBe("v1");
  expect(b.ha.leads("vault")).toBe(true);
  expect(a.rt.log.filter((x) => x === "up").length).toBe(1);
});

test("a planned move: the active stops, the standby's final pull carries every write", async () => {
  const { w, a, b } = await mesh3();
  // written after the last snapshot: only the final pull has it
  await w.run(2000);
  expect(a.rt.write("vault", "v-last")).toBe(true);
  const res = b.ha.move("vault", "b", 30_000);
  let out: [number, any] | undefined;
  void res.then((r) => (out = r));
  expect(await w.until(() => out !== undefined, 40_000)).toBeGreaterThanOrEqual(0);
  expect(out).toEqual([200, { ok: true }]);
  expect(b.rt.read("vault")).toBe("v-last");
  expect(a.rt.on.has("vault")).toBe(false);
  expect(w.wants.vault!.active).toBe("b");
  expect(w.notes.some((n) => n.includes("handed over by a, nothing lost"))).toBe(true);
  // the old active following, its data set aside
  expect(await w.until(() => a.role("vault") === "standby" && copyOf(a) === "v-last", 30_000)).toBeGreaterThanOrEqual(
    0,
  );
});

test("a move to a host that isn't a standby, or not in sync, is refused", async () => {
  const { a, c } = await mesh3();
  expect((await a.ha.move("vault", "c"))[0]).toBe(409);
  expect(await a.ha.move("vault", "a")).toEqual([200, { ok: true, note: "already active" }]);
  expect((await c.ha.move("nope", "a"))[0]).toBe(404);
});

test("an active cut off from the mesh is fenced, the standby takes over", async () => {
  const { w, a, b } = await mesh3();
  w.isolate("a");
  expect(await w.until(() => !a.rt.on.has("vault"), 10_000)).toBeGreaterThan(0);
  expect(await w.until(() => b.rt.on.has("vault"), 30_000)).toBeGreaterThan(0);
  // never both
  expect(a.rt.on.has("vault")).toBe(false);
});

test("a standby whose app gen differs from the active's is never promoted", async () => {
  const { w, a, b } = await mesh3();
  b.rt.gens.vault = 7;
  await w.run(1000);
  a.crash();
  await w.run(30_000);
  expect(b.rt.on.has("vault")).toBe(false);
  expect(w.wants.vault!.active).toBe("a");
});

test("standbys edited: the gen bumped, a dropped standby no longer a candidate", async () => {
  const { w, a, b } = await mesh3();
  const [st, out] = a.ha.setStandbys("vault", ["c", "a", "c"], "admin");
  expect(st).toBe(200);
  expect(out.want.standbys).toEqual(["c"]);
  expect(w.wants.vault!.gen).toBe(2);
  await w.run(2000);
  expect(b.ha.status("vault")).toBeUndefined();
  expect(a.ha.setStandbys("vault", ["bad host"], "admin")[0]).toBe(400);
  expect(existsSync(join(b.rt.dataDir("vault"), "..", "ha"))).toBe(true);
});
