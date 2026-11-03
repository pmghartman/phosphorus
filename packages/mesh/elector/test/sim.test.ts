import { expect, test } from "bun:test";
import { Sim, simTiming } from "./sim.ts";

// three git hosts booted together, a master and its servants in sync
async function three(seed: number, rates = [1, 1, 1]) {
  const sim = new Sim(seed);
  ["a", "b", "c"].forEach((n, i) =>
    sim.add(n, { monoOff: 1e6 * (i + 1) * 7, wallOff: 1.7e12 + i * 3e5, rate: rates[i] }),
  );
  for (const h of sim.hosts.values()) h.boot();
  const took = await sim.until(() => sim.master() !== "", 40_000);
  expect(took).toBeGreaterThanOrEqual(0);
  // the servants' first pulls landed
  await sim.run(12_000);
  return sim;
}

const done = (sim: Sim) => {
  if (sim.violations.length) console.log(sim.lines.join("\n"));
  expect(sim.violations).toEqual([]);
};

test("boots one master, the others its servants, in sync", async () => {
  const sim = await three(1);
  const m = sim.master();
  for (const h of sim.hosts.values()) {
    if (h.name === m) continue;
    expect([h.e.role, h.e.master, h.local().inSync]).toEqual(["servant", m, true]);
  }
  expect(sim.promotions.map((p) => p.host)).toEqual([m]);
  done(sim);
});

test("a crashed master's in-sync servant takes over, never two serving at once", async () => {
  const sim = await three(2);
  const old = sim.master();
  const acked = sim.writes(old);
  sim.hosts.get(old)!.crash();
  const took = await sim.until(() => sim.master() !== "" && sim.master() !== old, 20_000);
  expect(took).toBeGreaterThan(0);
  expect(took).toBeLessThan(10_000);
  const now = sim.master();
  expect(sim.promotions.at(-1)!.gen).toBe(sim.promotions.at(-2)!.gen + 1);
  // at most a replication interval of writes lost
  expect(acked - sim.promotions.at(-1)!.writes).toBeLessThanOrEqual(30);
  // back: it follows the new master, its older gen never leading again
  sim.hosts.get(old)!.boot();
  await sim.run(20_000);
  expect(sim.master()).toBe(now);
  expect([sim.hosts.get(old)!.e.role, sim.hosts.get(old)!.e.master]).toEqual(["servant", now]);
  done(sim);
});

test("a master cut from the majority is fenced, the majority elects, the old one rejoins as servant", async () => {
  const sim = await three(3);
  const old = sim.master();
  sim.isolate(old);
  const took = await sim.until(() => sim.master() !== "" && sim.master() !== old, 20_000);
  expect(took).toBeGreaterThan(0);
  expect(sim.fenced).toBeGreaterThanOrEqual(1);
  expect(sim.hosts.get(old)!.forgejo).toBe(false);
  const now = sim.master();
  sim.heal();
  await sim.run(20_000);
  expect(sim.master()).toBe(now);
  expect(sim.hosts.get(old)!.e.master).toBe(now);
  done(sim);
});

test("a host cut off alone never leads", async () => {
  const sim = await three(4);
  const m = sim.master();
  const lone = [...sim.hosts.keys()].find((h) => h !== m)!;
  sim.isolate(lone);
  await sim.run(60_000);
  expect(sim.master()).toBe(m);
  expect(sim.hosts.get(lone)!.e.role).toBe("none");
  expect(sim.promotions.length).toBe(1);
  done(sim);
});

test("a planned handoff loses no write", async () => {
  const sim = await three(5);
  const old = sim.master();
  const to = sim.hosts.get(old)!.e.successor();
  expect(to).not.toBe("");
  const h = sim.hosts.get(old)!;
  h.handoffReq = { to, at: h.wall() };
  const took = await sim.until(() => sim.master() === to, 20_000);
  expect(took).toBeGreaterThan(0);
  const p = sim.promotions.at(-1)!;
  expect(p.host).toBe(to);
  // every write the old master took, the final pull carrying them
  expect(p.writes).toBe(sim.writes(old));
  expect(sim.hosts.get(old)!.e.master).toBe(to);
  done(sim);
});

test("an update hands off to a servant, then the host's clean stop", async () => {
  const sim = await three(6);
  const old = sim.master();
  const h = sim.hosts.get(old)!;
  h.updating = true;
  const took = await sim.until(() => sim.master() !== "" && sim.master() !== old, 20_000);
  expect(took).toBeGreaterThan(0);
  expect(sim.promotions.at(-1)!.writes).toBe(sim.writes(old));
  await h.shutdown();
  h.updating = false;
  h.boot();
  await sim.run(20_000);
  expect(h.e.role).toBe("servant");
  done(sim);
});

// git-daemon.sh's term kills rsyncd once the elector has released its votes,
// so the successor's final pull finds it gone and leads on its last regular
// pull: up to a replication interval of pushes lost (an update hands off
// while the host is still up, above, and loses none)
test("a clean stop of the master hands off at once, its last pushes since the last pull lost", async () => {
  const sim = await three(7);
  const old = sim.master();
  const h = sim.hosts.get(old)!;
  await h.shutdown();
  const took = await sim.until(() => sim.master() !== "", 10_000);
  expect(took).toBeGreaterThanOrEqual(0);
  expect(took).toBeLessThan(4000);
  expect(sim.writes(old) - sim.promotions.at(-1)!.writes).toBeLessThanOrEqual(5000 / 250 + 1);
  done(sim);
});

test("skewed clocks: monotonic offsets and rates a few percent apart", async () => {
  const sim = await three(8, [0.96, 1.04, 1]);
  for (let i = 0; i < 4; i++) {
    const old = sim.master();
    sim.hosts.get(old)!.crash();
    expect(await sim.until(() => sim.master() !== "" && sim.master() !== old, 20_000)).toBeGreaterThan(0);
    sim.hosts.get(old)!.boot();
    await sim.run(15_000);
  }
  done(sim);
});

// seeded chaos: crashes, restarts, partitions and heals at random, five hosts on
// skewed clocks; safety throughout, a master once all is well again
for (const seed of [11, 12, 13, 14]) {
  test(`chaos, seed ${seed}`, async () => {
    const sim = new Sim(seed);
    const names = ["a", "b", "c", "d", "e"];
    for (const [i, n] of names.entries())
      sim.add(n, { monoOff: 1e5 * (i + 3), wallOff: 1.7e12 + i * 1e4, rate: 0.97 + 0.015 * i });
    for (const h of sim.hosts.values()) h.boot();
    await sim.run(40_000);
    for (let step = 0; step < 60; step++) {
      const r = sim.rand();
      const n = names[Math.floor(sim.rand() * names.length)]!;
      const h = sim.hosts.get(n)!;
      if (r < 0.2) {
        if (h.alive) h.crash();
        else h.boot();
      } else if (r < 0.4) sim.cut(n, names[Math.floor(sim.rand() * names.length)]!);
      else if (r < 0.5) sim.isolate(n);
      else if (r < 0.65) sim.heal();
      else if (r < 0.7 && h.alive && h.e.role === "master") {
        const to = h.e.successor();
        if (to) h.handoffReq = { to, at: h.wall() };
      }
      await sim.run(2000 + Math.floor(sim.rand() * 8000));
    }
    sim.heal();
    for (const h of sim.hosts.values()) if (!h.alive) h.boot();
    const took = await sim.until(() => sim.master() !== "", 120_000);
    if (took < 0) console.log(sim.lines.slice(-80).join("\n"));
    expect(took).toBeGreaterThanOrEqual(0);
    done(sim);
  }, 60_000);
}

test("the same seed, the same run", async () => {
  const a = await three(21);
  const b = await three(21);
  a.hosts.get(a.master())!.crash();
  b.hosts.get(b.master())!.crash();
  await a.run(20_000);
  await b.run(20_000);
  expect(a.lines).toEqual(b.lines);
  expect(a.lines.length).toBeGreaterThan(3);
});

// the checker itself: a lease outliving the votes behind it lets a cut-off
// master serve beside the new one
test("a lease longer than its votes shows as two serving", async () => {
  const sim = new Sim(31, { ...simTiming, leaseMarginMS: -8000 });
  for (const n of ["a", "b", "c"]) sim.add(n);
  for (const h of sim.hosts.values()) h.boot();
  await sim.until(() => sim.master() !== "", 40_000);
  await sim.run(12_000);
  sim.isolate(sim.master());
  await sim.run(20_000);
  expect(sim.violations.some((v) => v.includes("both serving"))).toBe(true);
});
