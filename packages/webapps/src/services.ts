// optional services for the mesh: a git checkout per host, run there as the
// person's own login under a systemd user unit, published in that host's
// services.export; installed by anyone with a saved login for the host
import { randomBytes } from "node:crypto";
import { Client, type ClientChannel } from "ssh2";
import * as sysfs from "@phosphorus/sysfs";
import { env, envInt, errText, logf as log, now, obj, SelfHost } from "@phosphorus/util";

const logf = (f: string, ...a: unknown[]) => log("[services] " + f, ...a);

// one service the mesh can take: its repo cloned under ~/.phosphorus/services/<id>
// on the host, the scripts run in that checkout as the login, the port and mode
// published; the rest is what the apps page shows of it
export type Service = {
  id: string; name: string; tagline: string; about: string; features: string[]; category: string; by: string;
  repo: string; port: number; mode: "path" | "subdomain";
  // the host OSes its scripts run on, as the tailnet names them
  os: string[];
  // what the host needs before an install
  needs: string;
  // under the service's root, answering {version}
  versionPath: string;
  // the agents it asks the mesh's models as, listed in the agents app while published
  agents?: string[];
  // run by sh in the checkout: install (first time), update, remove (the unit undone)
  install: string; update: string; remove: string;
};

export const Services: Service[] = [
  {
    id: "circuit",
    name: "Circuit",
    tagline: "a schematic editor with a live circuit solver",
    about: "Draw a circuit and watch it solve as you edit: DC, transient and graph layout from a Rust core, the UI served by its own small web server. Built from source on the host, updated from its own header button or here.",
    features: ["live solving as you draw", "transient analysis", "a desktop app too, from the same checkout", "updates itself from main"],
    category: "engineering",
    by: "pmghartman",
    repo: "https://github.com/pmghartman/circuit.git",
    port: 8099,
    mode: "path",
    os: ["linux"],
    needs: "git; Rust is installed by the build when missing (several minutes the first time)",
    versionPath: "api/version",
    install: "PORT=8099 scripts/install.sh",
    update: "scripts/update.sh",
    remove: "scripts/uninstall.sh",
  },
  {
    id: "tavern",
    name: "Tavern",
    tagline: "D&D 5e in a chat room, an AI dungeon master on the mesh",
    about: "A strict rules engine decides every outcome while a dungeon master on the mesh's models tells the story: campaigns, character sheets, grid combat, adventure modules read from a PDF. The DM asks phosphorus's model gateway as the Tavern agent.",
    features: ["campaign lobby and persistent memory", "full character creation and level-up", "grid combat with the real action economy", "adventure modules read from PDF or text", "the DM on the mesh's models, assigned on the agents page"],
    category: "games",
    by: "pmghartman",
    repo: "https://github.com/pmghartman/tavern.git",
    port: 8484,
    mode: "path",
    os: ["linux"],
    needs: "git and Node 20+ (a build toolchain when no prebuilt sqlite binary fits)",
    versionPath: "api/health",
    agents: ["agent-tavern"],
    install: "scripts/rebuild.sh",
    update: "scripts/update.sh",
    remove: "systemctl --user disable --now tavern; rm -f \"$HOME/.config/systemd/user/tavern.service\"; systemctl --user daemon-reload",
  },
];

export const serviceOf = (id: string) => Services.find((s) => s.id === id);

export type Op = "install" | "update" | "remove";
export const Ops: Op[] = ["install", "update", "remove"];

// how long each step may run: a first build of circuit takes a while
const opTimeoutMS: Record<Op, number> = { install: 45 * 60000, update: 30 * 60000, remove: 5 * 60000 };

const logMax = 64 << 10;
const logTail = 4 << 10;

// --- the scripts, run by sh as the login in its own checkout ------------------

const checkoutDir = (id: string) => `"$HOME/.phosphorus/services/${id}"`;

// the login's own PATH and systemd user manager, reached without a seat
const head = (s: Service) =>
  "set -e\n" +
  'PATH="$HOME/.local/node/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin:$PATH"; export PATH\n' +
  'if [ -z "$XDG_RUNTIME_DIR" ]; then XDG_RUNTIME_DIR="/run/user/$(id -u)"; export XDG_RUNTIME_DIR; fi\n' +
  'if [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"; export DBUS_SESSION_BUS_ADDRESS; fi\n' +
  `dir=${checkoutDir(s.id)}\n`;

// script the sh script for op on s
export function script(s: Service, op: Op): string {
  switch (op) {
    case "install":
      return head(s) +
        'mkdir -p "$(dirname "$dir")"\n' +
        'if [ -d "$dir/.git" ]; then\n' +
        '  echo "updating the checkout in $dir"\n' +
        '  git -C "$dir" fetch -q origin main\n' +
        '  git -C "$dir" reset -q --hard origin/main\n' +
        "else\n" +
        `  echo "cloning ${s.repo} into $dir"\n` +
        `  git clone -q ${s.repo} "$dir"\n` +
        "fi\n" +
        'cd "$dir"\n' +
        // the unit outlives this login: linger, by the login itself or sudo without a prompt
        'loginctl enable-linger "$(id -un)" 2>/dev/null || sudo -n loginctl enable-linger "$(id -un)" 2>/dev/null || ' +
        `echo "note: couldn't enable linger; ${s.name} stops when $(id -un) logs out (sudo loginctl enable-linger $(id -un))"\n` +
        s.install + "\n";
    case "update":
      return head(s) +
        '[ -d "$dir/.git" ] || { echo "no checkout in $dir; install first" >&2; exit 2; }\n' +
        'cd "$dir"\n' +
        s.update + "\n";
    case "remove":
      return head(s) +
        'if [ -d "$dir" ]; then\n' +
        '  cd "$dir"\n' +
        `  ( ${s.remove} ) || echo "note: the uninstall step failed; removing the checkout anyway"\n` +
        "  cd /\n" +
        '  rm -rf "$dir"\n' +
        '  echo "removed $dir"\n' +
        "else\n" +
        '  echo "no checkout in $dir"\n' +
        "fi\n";
  }
}

// --- what the mesh knows: etc/services/<id>/<host>.json, who installed it as which login -----

export type Record_ = { login: string; by: string; at: number };

const recordRel = (id: string, host: string) => `etc/services/${id}/${host}.json`;

export function recordOf(id: string, host: string): Record_ | undefined {
  const o = obj(sysfs.read(recordRel(id, host)));
  if (!o || typeof o.login !== "string") return;
  return { login: o.login, by: typeof o.by === "string" ? o.by : "", at: typeof o.at === "number" ? o.at : 0 };
}

export function records(id: string): Record<string, Record_> {
  const out: Record<string, Record_> = {};
  for (const f of sysfs.list(`etc/services/${id}`)) {
    const host = f.replace(/\.json$/, "");
    const r = recordOf(id, host);
    if (r) out[host] = r;
  }
  return out;
}

// --- the jobs: one per service per host, on the host whose page started it --------

export type Login = { user: string; pass: string };

export type Job = {
  id: string; host: string; op: Op; by: string; login: string;
  at: number; done: number; ok?: boolean; error: string; log: string;
};

// what the page sees of a job: the log's tail
export type JobView = Omit<Job, "log"> & { log: string };

const jobs = new Map<string, Job>();
const jobKey = (id: string, host: string) => id + "/" + host;

function view(j: Job): JobView {
  let log = j.log;
  if (log.length > logTail) {
    const nl = log.indexOf("\n", log.length - logTail);
    log = nl < 0 ? log.slice(-logTail) : log.slice(nl + 1);
  }
  return { ...j, log };
}

// Jobs every job this host ran or runs, finished ones kept for the page
export const Jobs = (id?: string): JobView[] => [...jobs.values()].filter((j) => !id || j.id === id).map(view);

// Publish a service's entry in host's services.export set, or dropped with fields null
export type Publish = (host: string, name: string, fields: Record<string, string> | null) => Promise<[number, any]>;
// Runner a script run on host as login, each chunk of output to onOut; the exit code
export type Runner = (host: string, login: Login, script: string, onOut: (s: string) => void, timeoutMs: number) => Promise<number>;
// Device a tailnet device as mesh.tailnet lists it
export type Device = { name?: unknown; os?: unknown; phosphorus?: unknown };
// Route a published service as mesh.routes lists it
export type Route = { host?: unknown; name?: unknown; port?: unknown; mode?: unknown; base_path?: unknown; scheme?: unknown; type?: unknown; public?: unknown };

// seams the mesh as this module sees it, set at Start and swapped in tests
export const seams: { routes: () => Route[]; tailnet: () => Device[]; publish: Publish; run: Runner; ipOf: (host: string) => string | Promise<string> } = {
  routes: () => [],
  tailnet: () => [],
  publish: async () => [503, { error: "the mesh isn't up yet" }],
  run: sshRun,
  ipOf: () => "",
};

export function Start(s: Partial<typeof seams>) {
  Object.assign(seams, s);
}

// ServiceOp an install, update or removal of id on host as login, started for by:
// [status, body] at once, the job running on
export async function ServiceOp(op: string, id: string, host: string, login: Login, by: string): Promise<[number, any]> {
  const s = serviceOf(id);
  if (!s) return [404, { error: `no service called ${id}` }];
  if (!Ops.includes(op as Op)) return [400, { error: "op is " + Ops.join(", ") }];
  const d = seams.tailnet().find((x) => x.name === host);
  if (!d || d.phosphorus !== true) return [404, { error: `${host} isn't a phosphorus host` }];
  const os = typeof d.os === "string" ? d.os : "";
  if (os && !s.os.includes(os)) return [400, { error: `${s.name} runs on ${s.os.join(", ")} hosts; ${host} is ${os}` }];
  if (!login.user) return [400, { error: `a login for ${host}` }];
  const key = jobKey(id, host);
  const held = jobs.get(key);
  if (held && !held.done) return [409, { error: `${s.name} is already ${held.op === "remove" ? "being removed from" : held.op === "update" ? "updating on" : "installing on"} ${host}`, job: view(held) }];
  const j: Job = { id, host, op: op as Op, by, login: login.user, at: now(), done: 0, error: "", log: "" };
  jobs.set(key, j);
  logf("%s %s on %s as %s, for %s", op, s.name, host, login.user, by);
  void run(s, j, login);
  return [200, { ok: true, job: view(j) }];
}

async function run(s: Service, j: Job, login: Login) {
  const append = (text: string) => {
    j.log += text;
    if (j.log.length > logMax) j.log = j.log.slice(j.log.indexOf("\n", j.log.length - logMax) + 1);
  };
  try {
    const code = await seams.run(j.host, login, script(s, j.op), append, opTimeoutMS[j.op]);
    if (code !== 0) throw new Error(`the ${j.op} script exited ${code}`);
    if (j.op === "remove") {
      const [st, b] = await seams.publish(j.host, s.id, null);
      // nothing declared there is as good as dropped
      if (st !== 200 && st !== 404 && !/no service/i.test(String(b?.error ?? ""))) throw new Error(`unpublishing: ${b?.error ?? `status ${st}`}`);
      sysfs.remove(recordRel(s.id, j.host));
      append(`\n${s.name} unpublished on ${j.host}\n`);
    } else {
      const [st, b] = await seams.publish(j.host, s.id, { port: String(s.port), mode: s.mode });
      if (st !== 200) throw new Error(`publishing: ${b?.error ?? `status ${st}`}`);
      sysfs.write(recordRel(s.id, j.host), { login: j.login, by: j.by, at: now() } satisfies Record_);
      const o = obj(b?.outcome);
      append(`\n${s.name} ${o?.published === true ? "published" : "declared"} on ${j.host}${o && o.published !== true && o.why ? `: ${o.why}` : ""}\n`);
    }
    j.ok = true;
    logf("%s %s on %s: done", j.op, s.name, j.host);
  } catch (e) {
    j.ok = false;
    j.error = errText(e);
    logf("%s %s on %s: %s", j.op, s.name, j.host, j.error);
  } finally {
    j.done = now();
  }
}

// --- the ssh runner: the host's own sshd as the login, the script fed to sh -----

async function addrOf(host: string): Promise<{ host: string; port: number }> {
  if (host === (process.env.SELF_HOST ?? SelfHost)) return { host: env("HOST_SSH_HOST", "127.0.0.1"), port: envInt("HOST_SSH_PORT", 22) || 22 };
  const ip = await seams.ipOf(host);
  if (!ip) throw new Error(`can't find ${host} on the tailnet`);
  return { host: ip, port: 22 };
}

function dial(host: string, login: Login): Promise<Client> {
  return addrOf(host).then((addr) => new Promise<Client>((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", (e) => {
      c.end();
      const msg = errText(e);
      reject(new Error(/authentication methods failed|unable to authenticate/i.test(msg) ? `the saved login for ${host} was refused` : `ssh to ${host}: ${msg}`));
    });
    c.on("keyboard-interactive", (_n, _i, _l, prompts, finish) => finish(prompts.map(() => login.pass)));
    c.connect({ host: addr.host, port: addr.port, username: login.user, password: login.pass, tryKeyboard: true, readyTimeout: 10_000 });
  }));
}

async function sshRun(host: string, login: Login, text: string, onOut: (s: string) => void, timeoutMs: number): Promise<number> {
  const c = await dial(host, login);
  try {
    // the script by heredoc on sh's stdin, nothing of it in argv or on disk
    const delim = "PHOS_SVC_" + randomBytes(6).toString("hex");
    const cmd = `sh -s <<'${delim}'\n${text}\n${delim}\n`;
    const st = await new Promise<ClientChannel>((res, rej) => c.exec(cmd, (err, ch) => (err ? rej(err) : res(ch))));
    const dec = new TextDecoder();
    st.on("data", (b: Uint8Array) => onOut(dec.decode(b, { stream: true })));
    st.stderr.on("data", (b: Uint8Array) => onOut(dec.decode(b, { stream: true })));
    return await new Promise<number>((res, rej) => {
      let code = -1;
      const t = setTimeout(() => {
        rej(new Error(`the script ran past ${Math.round(timeoutMs / 60000)} minutes`));
        st.close();
      }, timeoutMs);
      st.on("exit", (x: unknown) => void (typeof x === "number" && (code = x)));
      st.on("close", (x: unknown) => {
        clearTimeout(t);
        res(typeof x === "number" ? x : code);
      });
    });
  } finally {
    c.end();
  }
}

// --- versions: each published copy asked, cached a minute ----------------------

const versionTTL = 60000;
const versions = new Map<string, { at: number; v: string }>();

async function versionOf(s: Service, r: Route): Promise<string> {
  const host = String(r.host ?? "");
  const key = s.id + "/" + host;
  const cur = versions.get(key);
  if (cur && now() - cur.at < versionTTL) return cur.v;
  let v = "";
  try {
    const ip = (await seams.ipOf(host)) || host;
    const scheme = r.scheme === "https" ? "https" : "http";
    const bp = String(r.base_path ?? "").replace(/^\/+|\/+$/g, "");
    const res = await fetch(`${scheme}://${ip}:${r.port}${bp ? "/" + bp : ""}/${s.versionPath}`, { signal: AbortSignal.timeout(3000) });
    const o = obj(await res.json());
    if (typeof o?.version === "string") v = o.version;
  } catch {}
  versions.set(key, { at: now(), v });
  return v;
}

// --- the page's read ---------------------------------------------------------------

export type HostView = { published: boolean; route?: Route; version: string; record?: Record_; job?: JobView };

export async function summary(): Promise<any[]> {
  const routes = seams.routes();
  return Promise.all(Services.map(async (s) => {
    const hosts: Record<string, HostView> = {};
    const at = (h: string) => (hosts[h] ??= { published: false, version: "" });
    for (const r of routes) {
      if (r.name !== s.id || r.type === "game") continue;
      const h = at(String(r.host));
      h.published = true;
      h.route = r;
    }
    for (const [h, rec] of Object.entries(records(s.id))) at(h).record = rec;
    for (const j of Jobs(s.id)) at(j.host).job = j;
    await Promise.all(Object.values(hosts).filter((h) => h.route).map(async (h) => void (h.version = await versionOf(s, h.route!))));
    return {
      id: s.id, name: s.name, tagline: s.tagline, about: s.about, features: s.features, category: s.category, by: s.by,
      repo: s.repo, port: s.port, mode: s.mode, os: s.os, needs: s.needs, agents: s.agents ?? [], checkout: `~/.phosphorus/services/${s.id}`,
      hosts,
    };
  }));
}

// for tests: the jobs and version cache forgotten
export function reset() {
  jobs.clear();
  versions.clear();
}
