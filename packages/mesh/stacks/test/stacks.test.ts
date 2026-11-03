// the env (./env.ts) set before the stacks are imported below; publishing a recorded seam
import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppDef } from "@phosphorus/wire";
import { bin, dir, log } from "./env.ts";

const store = await import("@phosphorus/store");
const S = await import("@phosphorus/stacks");

// the app's page, answering health checks on the web port
const page = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
const webPort = page.port!;

const def = (over: Partial<AppDef> = {}): AppDef => ({
  id: "kuma",
  source: "casaos",
  ref: "UptimeKuma",
  name: "Uptime Kuma",
  tagline: "a monitor",
  description: "",
  icon: "",
  category: "tools",
  repo: "https://github.com/louislam/uptime-kuma",
  licence: "Apache-2.0",
  archs: [],
  compose: `services:
  web:
    image: louislam/uptime-kuma:1
    ports:
      - "\${WEB_PORT:-${webPort}}:3001"
      - "9999:9999/udp"
    volumes:
      - kuma-data:/app/data
      - \${APP_DATA}/config:/config
      - ./extra:/extra
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /tmp/scratch
    environment:
      TZ: \${TZ}
      PUID: \${PUID}
      URL: \${APP_URL}
      ESCAPED: $$APP_DATA
      PASSWORD: \${ADMIN_PASSWORD}
  db:
    image: mariadb:11
    ports:
      - "3306:3306"
    volumes:
      - type: volume
        source: db
        target: /var/lib/mysql
      - cache:/cache
volumes:
  kuma-data: {}
  db: {}
  cache: {}
  outside:
    external: true
`,
  env: [
    { name: "ADMIN_PASSWORD", label: "Admin password", secret: true },
    { name: "SITE", label: "Site name", required: true },
    { name: "MODE", label: "Mode", default: "fast", options: ["fast", "slow"] },
  ],
  manifest: {
    volumes: [
      { service: "web", target: "/tmp/scratch", kind: "cache" },
      { service: "db", target: "/cache", kind: "cache" },
    ],
    web: { service: "web", port: 3001 },
    health: { service: "web", path: "/" },
    backup: { pre: [{ service: "db", run: ["mariadb-dump", "--all-databases"] }] },
  },
  ...over,
});

let published: [string, Record<string, string> | null][] = [];
S.seams.ipOf = () => "127.0.0.1";
S.seams.hosts = () => ["a", "b", "c"];
S.seams.defInBody = true;
S.seams.publish = async (name, fields) => {
  published.push([name, fields]);
  return [200, { ok: true }];
};

const calls = (): string[][] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
// the compose subcommands run on a project, as "pull", "up -d --remove-orphans"
const composed = (id: string) =>
  calls()
    .filter((a) => a[0] === "compose" && a[2] === `phos-${id}` && a[3] === "--project-directory")
    .map((a) => a.slice(7).join(" "));

beforeEach(() => {
  rmSync(log, { force: true });
  published = [];
});

const ctx = {
  dir: "/srv/phos/stacks/kuma",
  ip: "100.64.0.7",
  puid: "1000",
  pgid: "1001",
  tz: "Europe/Amsterdam",
  domain: "",
};

test("render: data volumes bind mounts under data/, cache under cache/, phosphorus's variables filled in", () => {
  const r = S.render(def(), { ADMIN_PASSWORD: "pw", SITE: "x", MODE: "fast" }, ctx);
  const doc = Bun.YAML.parse(r.compose) as any;
  expect(doc.name).toBe("phos-kuma");
  const web = doc.services.web;
  expect(web.volumes).toEqual([
    "/srv/phos/stacks/kuma/data/kuma-data:/app/data",
    "/srv/phos/stacks/kuma/data/config:/config",
    "/srv/phos/stacks/kuma/data/extra:/extra",
    "/var/run/docker.sock:/var/run/docker.sock:ro",
    "/srv/phos/stacks/kuma/cache/web-tmp-scratch:/tmp/scratch",
  ]);
  expect(doc.services.db.volumes).toEqual([
    {
      type: "bind",
      source: "/srv/phos/stacks/kuma/data/db",
      target: "/var/lib/mysql",
      bind: { create_host_path: true },
    },
    "/srv/phos/stacks/kuma/cache/cache:/cache",
  ]);
  // the mesh's own volumes gone from the top, an external one kept
  expect(doc.volumes).toEqual({ outside: { external: true } });
  expect(web.environment).toEqual({
    TZ: "Europe/Amsterdam",
    PUID: "1000",
    URL: `http://100.64.0.7:${webPort}`,
    ESCAPED: "$$APP_DATA",
    // the app's own values left to compose, from .env
    PASSWORD: "${ADMIN_PASSWORD}",
  });
  // host ports on the web service alone, bound to the tailnet address
  expect(web.ports).toEqual([`100.64.0.7:${webPort}:3001`, "100.64.0.7:9999:9999/udp"]);
  expect(doc.services.db.ports).toBeUndefined();
  expect(r.webPort).toBe(webPort);
  expect(r.dirs).toContain("/srv/phos/stacks/kuma/data/kuma-data");
  expect(r.dirs).toContain("/srv/phos/stacks/kuma/data/config");
  expect(r.build).toBe(false);
  expect(r.clone).toBe(false);
});

test("render: a domain's url, a value's port, a web port added when the file publishes none", () => {
  const d = def({
    compose:
      "services:\n  app:\n    image: x\n    environment:\n      U: ${APP_URL}\n      D: ${APP_DOMAIN}\n      Z: ${TZ:-UTC}\n",
    manifest: { volumes: [], web: { service: "app", port: 80 } },
  });
  const doc = Bun.YAML.parse(S.render(d, {}, { ...ctx, domain: "example.test", tz: "" }).compose) as any;
  expect(doc.services.app.environment).toEqual({ U: "https://kuma.example.test", D: "kuma.example.test", Z: "UTC" });
  expect(doc.services.app.ports).toEqual(["100.64.0.7:80:80"]);
  const v = S.render(def(), { WEB_PORT: "8123" }, ctx);
  expect(v.webPort).toBe(8123);
  expect((Bun.YAML.parse(v.compose) as any).services.web.ports[0]).toBe("100.64.0.7:8123:3001");
});

test("render: a repo's build and its own files from its clone in src/", () => {
  const d = def({
    source: "github",
    ref: "someone/app",
    compose:
      "services:\n  app:\n    build: .\n    volumes:\n      - ./nginx.conf:/etc/nginx.conf:ro\n      - ./state:/state\n  worker:\n    build:\n      context: ./worker\n      dockerfile: Dockerfile\n",
    manifest: { volumes: [{ service: "app", target: "/state", kind: "data" }], web: { service: "app", port: 80 } },
  });
  const r = S.render(d, {}, ctx);
  const doc = Bun.YAML.parse(r.compose) as any;
  expect(r.build).toBe(true);
  expect(r.clone).toBe(true);
  expect(doc.services.app.build).toBe("/srv/phos/stacks/kuma/src/");
  expect(doc.services.worker.build).toEqual({ context: "/srv/phos/stacks/kuma/src/worker", dockerfile: "Dockerfile" });
  expect(doc.services.app.volumes).toEqual([
    "/srv/phos/stacks/kuma/src/nginx.conf:/etc/nginx.conf:ro",
    "/srv/phos/stacks/kuma/data/state:/state",
  ]);
});

test("render: .env quoting, and interpolation as compose does it", () => {
  expect(S.quote("plain $x")).toBe("'plain $x'");
  expect(S.quote(`it's "$x"`)).toBe(`"it's \\"\\$x\\""`);
  expect(S.interp("${A:-d} ${B-d} ${A:+y} $A $$A ${C}", { A: "", B: "" })).toBe("d    $$A ${C}");
  expect(S.interp("${C:-8080}:80 ${C}", {}, true)).toBe("8080:80 ");
  const e = S.envText(def(), { SITE: "x" }, ctx, 8080);
  expect(e).toContain("APP_DATA='/srv/phos/stacks/kuma/data'\n");
  expect(e).toContain("APP_URL='http://100.64.0.7:8080'\n");
  expect(e).toContain("SITE='x'\n");
});

test("install: checked against the def, secrets generated once and sealed, gen 1", async () => {
  const body = (over: Record<string, any> = {}) => ({
    source: "casaos",
    ref: "UptimeKuma",
    def: def(),
    env: { SITE: "home" },
    active: "a",
    standbys: [],
    ...over,
  });
  expect((await S.Install(body({ env: {} }), "pat"))[1].error).toBe("SITE wanted");
  expect((await S.Install(body({ active: "zed" }), "pat"))[1].error).toBe("zed isn't a phosphorus host");
  expect((await S.Install(body({ standbys: ["a"] }), "pat"))[1].error).toBe("a is already the app's host");
  expect((await S.Install(body({ env: { SITE: "x", MODE: "warp" } }), "pat"))[1].error).toBe(
    "MODE is one of fast, slow",
  );
  expect((await S.Install(body({ ref: "Other" }), "pat"))[1].error).toBe("the def isn't the one asked for");
  const [st, b] = await S.Install(body({ standbys: ["b"] }), "pat");
  expect(st).toBe(200);
  expect(b.want).toMatchObject({
    active: "a",
    standbys: ["b"],
    gen: 1,
    by: "pat",
    web: { service: "web", port: 3001 },
  });
  expect(b.want.env).toBeUndefined();
  expect(b.want.summary).toMatchObject({ id: "kuma", installed: true, licence: "Apache-2.0" });
  const w = S.wantOf("kuma")!;
  expect(w.env.SITE).toBe("home");
  expect(w.env.MODE).toBe("fast");
  expect(w.env.ADMIN_PASSWORD).toStartWith("sealed:");
  const [open] = S.opened(w);
  expect(open.ADMIN_PASSWORD).toMatch(/^[A-Za-z0-9_-]{24}$/);
  expect((await S.Install(body(), "pat"))[0]).toBe(409);
  expect(Object.keys(S.views())).toEqual(["kuma"]);
  S.Remove("kuma", true, "pat");
  store.remove(S.removedRel("kuma"));
});

const want = async (over: Record<string, any> = {}, d = def()) => {
  const [st, b] = await S.Install(
    { source: d.source, ref: d.ref, def: d, env: { SITE: "home", ADMIN_PASSWORD: "hunter2" }, active: "a", ...over },
    "pat",
  );
  expect(st).toBe(200);
  return b;
};

// the want moved: its active host and standbys
const place = (id: string, active: string, standbys: string[]) => {
  const w = S.wantOf(id)!;
  store.write(`etc/stacks/${id}.json`, { ...w, active, standbys, gen: w.gen + 1 });
};

test("reconcile: the active host pulls, runs and publishes; healthy; .env from the want", async () => {
  await want();
  await S.tick();
  expect(composed("kuma")).toEqual(["pull", "up -d --remove-orphans"]);
  expect(published).toEqual([["kuma", { port: String(webPort) }]]);
  const st = S.statuses().kuma!;
  expect(st).toMatchObject({ role: "active", gen: 1, running: true });
  expect(st.job).toMatchObject({ op: "install", done: true, ok: true });
  expect(st.job!.log).toContain("$ docker compose up -d --remove-orphans");
  const envF = readFileSync(join(S.dirOf("kuma"), ".env"), "utf8");
  expect(envF).toContain("ADMIN_PASSWORD='hunter2'\n");
  expect(readFileSync(join(S.dirOf("kuma"), "compose.yml"), "utf8")).not.toContain("hunter2");
  expect(existsSync(join(S.dirOf("kuma"), "data", "kuma-data"))).toBe(true);
  // steady: nothing run again but the checks
  rmSync(log, { force: true });
  await S.tick();
  expect(composed("kuma")).toEqual([]);
  expect(S.statuses().kuma!.healthy).toBe(true);
});

test("reconcile: an update pulls and comes up again with the new gen", async () => {
  const [st] = await S.Update("kuma", "pat");
  expect(st).toBe(200);
  await S.tick();
  expect(composed("kuma")).toEqual(["pull", "up -d --remove-orphans"]);
  expect(S.statuses().kuma).toMatchObject({ gen: 2, job: { op: "update", ok: true } });
  // already published at that port: not written again
  expect(published).toEqual([]);
});

test("reconcile: standbys added to a running copy: pulled again, left running for failover", async () => {
  place("kuma", "a", ["b"]);
  await S.tick();
  expect(composed("kuma")).toEqual(["pull"]);
  expect(published).toEqual([]);
  expect(S.statuses().kuma).toMatchObject({ role: "active", gen: 3, running: true });
  // nor brought back up by the loop when it stops: failover's call
  writeFileSync(join(bin, "phos-kuma.json"), "[]");
  rmSync(log, { force: true });
  await S.tick();
  expect(composed("kuma")).toEqual([]);
  expect(S.statuses().kuma!.running).toBe(false);
  await S.runtime.up("kuma");
});

test("failover's seam: down holds it down, up brings it back; hooks run in the container", async () => {
  await S.runtime.down("kuma");
  expect(composed("kuma")).toEqual(["stop"]);
  expect(await S.runtime.running("kuma")).toBe(false);
  rmSync(log, { force: true });
  await S.tick();
  // held: the loop doesn't bring it back
  expect(composed("kuma")).toEqual([]);
  await S.runtime.hook("kuma", "pre");
  expect(composed("kuma")).toEqual(["exec -T db mariadb-dump --all-databases"]);
  await S.runtime.up("kuma");
  expect(await S.runtime.running("kuma")).toBe(true);
  expect(published.map((p) => p[1])).toEqual([null, { port: String(webPort) }]);
  expect(S.runtime.dataDir("kuma")).toBe(join(S.dirOf("kuma"), "data"));
});

test("reconcile: a host in neither role takes its copy down, the data kept", async () => {
  place("kuma", "b", ["c"]);
  await S.tick();
  expect(composed("kuma")).toEqual(["down --remove-orphans"]);
  expect(published).toEqual([["kuma", null]]);
  expect(existsSync(join(S.dirOf("kuma"), "compose.yml"))).toBe(false);
  expect(existsSync(join(S.dirOf("kuma"), "data", "kuma-data"))).toBe(true);
  expect(S.statuses().kuma).toMatchObject({ role: "none", gen: 0, job: { op: "remove", ok: true } });
  rmSync(log, { force: true });
  await S.tick();
  expect(calls().filter((a) => a[0] === "compose" && a[1] === "-p")).toEqual([]);
});

test("reconcile: a standby pulls its images and stays down", async () => {
  place("kuma", "b", ["a"]);
  await S.tick();
  expect(composed("kuma")).toEqual(["pull"]);
  expect(published).toEqual([]);
  expect(S.statuses().kuma).toMatchObject({ role: "standby", running: false, job: { op: "install" } });
});

test("remove: the copy gone everywhere, its data too when asked", async () => {
  expect(S.Remove("kuma", false, "pat")[0]).toBe(200);
  expect(S.views()).toEqual({});
  await S.tick();
  expect(composed("kuma")).toEqual(["down --remove-orphans --volumes"]);
  expect(existsSync(S.dirOf("kuma"))).toBe(false);
  expect(S.statuses().kuma).toMatchObject({ role: "none", job: { op: "remove", ok: true } });
});

test("reconcile: a failed step reported and retried after a pause, not every round", async () => {
  writeFileSync(join(bin, "fail"), "pull");
  try {
    await want({}, def({ id: "beszel", ref: "Beszel" }));
    await S.tick();
    expect(composed("beszel")).toEqual(["pull"]);
    const st = S.statuses().beszel!;
    expect(st.error).toBe("docker compose pull exited 1");
    expect(st.job).toMatchObject({ op: "install", done: true, ok: false });
    expect(st.job!.log).toContain("pull failed");
    rmSync(log, { force: true });
    await S.tick();
    expect(composed("beszel")).toEqual([]);
  } finally {
    rmSync(join(bin, "fail"), { force: true });
  }
});

test("docker: found with compose v2 through the fake", async () => {
  const d = await S.detectDocker();
  expect(d).toMatchObject({ state: "present", version: "27.3.1", compose: "2.29.7", arch: S.arch() });
});

test("docker: compose 5 is fine, the old 1.x docker-compose isn't", async () => {
  const v = join(bin, "compose-version");
  try {
    writeFileSync(v, "v5.6.1\n");
    expect(await S.detectDocker()).toMatchObject({ state: "present", compose: "5.6.1" });
    writeFileSync(v, "1.29.2\n");
    const d = await S.detectDocker();
    expect(d.state).not.toBe("present");
    expect(d.error).toBe("docker compose 1.29.2 is older than v2");
  } finally {
    rmSync(v, { force: true });
  }
  expect((await S.detectDocker()).state).toBe("present");
});

test("with standbys: every candidate renders and pulls, failover alone brings it up or down", async () => {
  await want({ standbys: ["b"] }, def({ id: "vault", ref: "Vault" }));
  await S.tick();
  // the active candidate pulls and waits for failover's up
  expect(composed("vault")).toEqual(["pull"]);
  expect(published).toEqual([]);
  expect(await S.runtime.gen("vault")).toBe(1);
  expect(S.statuses().vault).toMatchObject({
    role: "active",
    gen: 1,
    running: false,
    job: { op: "install", ok: true },
  });
  await S.runtime.up("vault");
  expect(published).toEqual([["vault", { port: String(webPort) }]]);
  // promotion written by failover: the roles swapped, nothing pulled again, nothing taken down
  rmSync(log, { force: true });
  const w = S.wantOf("vault")!;
  store.write("etc/stacks/vault.json", { ...w, active: "b", standbys: ["a"] });
  await S.tick();
  expect(composed("vault")).toEqual([]);
  expect(await S.runtime.running("vault")).toBe(true);
  // failover's own part of the status spread in
  S.seams.haStatus = (id) => (id === "vault" ? { role: "standby", lastSync: 42 } : undefined);
  expect(S.statuses().vault).toMatchObject({ role: "standby", gen: 1, lastSync: 42 });
  S.seams.haStatus = undefined;
  // a new gen: pulled on the candidate, still not brought up or down by the loop
  await S.Update("vault", "pat");
  await S.tick();
  expect(composed("vault")).toEqual(["pull"]);
  expect(await S.runtime.gen("vault")).toBe(2);
});
