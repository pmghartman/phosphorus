// optional services for the mesh: a git checkout per host, run there as the
// person's own login under a systemd user unit, published in that host's
// services.export; installed by anyone with a saved login for the host. A step
// (install, update, remove) is started over ssh as that login and runs on the
// host as a transient user unit of its own, its log and exit under the login's
// ~/.phosphorus/services/.jobs; the host's own phosphorus watches those, publishes
// and records the outcome, so the step outlives the page and the host that
// started it, and every host shows it
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, type ClientChannel } from "ssh2";
import * as store from "@phosphorus/store";
import { env, envInt, errText, logf as log, now, obj, SelfHost, StateDir } from "@phosphorus/util";

const logf = (f: string, ...a: unknown[]) => log("[services] " + f, ...a);

// one service the mesh can take: its repo cloned under ~/.phosphorus/services/<id>
// on the host, the scripts run in that checkout as the login, the port and mode
// published; the rest is what the apps page shows of it
export type Service = {
  id: string; name: string; tagline: string; about: string; features: string[]; category: string; by: string;
  // the GitHub repository, cloned on the host; main is what's installed and updated to
  repo: string;
  // the icon's path in the repository, fetched off its main and served by the page
  icon: string;
  port: number; mode: "path" | "subdomain";
  // the host OSes its scripts run on, as the tailnet names them
  os: string[];
  // what the host needs before an install
  needs: string;
  // under the service's root, answering {version}
  versionPath: string;
  // the agents it asks the mesh's models as, listed in the agents app while published
  agents?: string[];
  // paths in the checkout a remove may keep aside, an install restoring them
  data: string[];
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
    repo: "https://github.com/pmghartman/circuit",
    icon: "src-tauri/icons/icon.png",
    port: 8099,
    mode: "path",
    os: ["linux"],
    needs: "git; Rust is installed by the build when missing (several minutes the first time)",
    versionPath: "api/version",
    data: [],
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
    repo: "https://github.com/pmghartman/tavern",
    icon: "src-tauri/icons/icon.png",
    port: 8484,
    mode: "path",
    os: ["linux"],
    needs: "git and Node 20+ (a build toolchain when no prebuilt sqlite binary fits)",
    versionPath: "api/health",
    agents: ["agent-tavern"],
    data: ["data", ".env"],
    install: "scripts/rebuild.sh",
    update: "scripts/update.sh",
    remove: "systemctl --user disable --now tavern; rm -f \"$HOME/.config/systemd/user/tavern.service\"; systemctl --user daemon-reload",
  },
];

export const serviceOf = (id: string) => Services.find((s) => s.id === id);

// the repository's owner and name, for GitHub's API and raw files
export function repoOf(s: { repo: string }): { owner: string; name: string } | undefined {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(s.repo);
  return m ? { owner: m[1]!, name: m[2]! } : undefined;
}

export type Op = "install" | "update" | "remove";
export const Ops: Op[] = ["install", "update", "remove"];

// how long each step may run on the host: a first build of circuit takes a while
export const opTimeoutMS: Record<Op, number> = { install: 45 * 60000, update: 30 * 60000, remove: 5 * 60000 };
// the ssh start of a step, the script written and its unit begun
const launchTimeoutMS = 60000;

const logTail = 4 << 10;

// --- the scripts, run by sh as the login in its own checkout ------------------

const svcRoot = '"$HOME/.phosphorus/services"';
const checkoutDir = (id: string) => `"$HOME/.phosphorus/services/${id}"`;
const keepDir = (id: string) => `"$HOME/.phosphorus/services/${id}.data"`;
// the unit a step runs as, the files it leaves: <id>.sh, .log, .exit, .commit
export const unitOf = (id: string) => `phos-svc-${id}`;

// the login's own PATH and systemd user manager, reached without a seat
const head = (s: Service) =>
  "set -e\n" +
  'PATH="$HOME/.local/node/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin:$PATH"; export PATH\n' +
  'if [ -z "$XDG_RUNTIME_DIR" ]; then XDG_RUNTIME_DIR="/run/user/$(id -u)"; export XDG_RUNTIME_DIR; fi\n' +
  'if [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"; export DBUS_SESSION_BUS_ADDRESS; fi\n' +
  `dir=${checkoutDir(s.id)}\nkeep=${keepDir(s.id)}\n`;

// the kept data back into a fresh checkout, the keep folder gone once empty
const restore = (s: Service) =>
  s.data.length
    ? 'if [ -d "$keep" ]; then\n' +
      `  for p in ${s.data.join(" ")}; do\n` +
      '    if [ -e "$keep/$p" ]; then rm -rf "$dir/$p"; mv "$keep/$p" "$dir/$p"; echo "restored $p from $keep"; fi\n' +
      "  done\n" +
      '  rmdir "$keep" 2>/dev/null || true\n' +
      "fi\n"
    : "";

// the checkout's data moved aside before the checkout goes
const aside = (s: Service) =>
  s.data.length
    ? '  mkdir -p "$keep"\n' +
      `  for p in ${s.data.join(" ")}; do\n` +
      '    if [ -e "$dir/$p" ]; then rm -rf "$keep/$p"; mv "$dir/$p" "$keep/$p"; echo "kept $p in $keep"; fi\n' +
      "  done\n"
    : "";

// script the sh script for op on s, run on the host in its unit
export function script(s: Service, op: Op, keep = false): string {
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
        `  git clone -q ${s.repo}.git "$dir"\n` +
        "fi\n" +
        restore(s) +
        'cd "$dir"\n' +
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
        (keep ? aside(s) : "") +
        '  rm -rf "$dir"\n' +
        '  echo "removed $dir"\n' +
        "else\n" +
        '  echo "no checkout in $dir"\n' +
        "fi\n";
  }
}

// launch the ssh script that starts op's script on the host: the script written
// under the login's .jobs, its last outcome cleared, then run as a transient user
// unit of the login's own manager (linger on, so it outlives this login), or as a
// plain background process where there's none; the unit's output to .log, its
// exit to .exit, the checkout's commit to .commit once done
export function launch(s: Service, op: Op, keep = false): string {
  const unit = unitOf(s.id);
  // the step's script as a quoted heredoc: no line of a catalogue script is this
  const delim = "PHOS_JOB_END";
  const secs = Math.round(opTimeoutMS[op] / 1000);
  return (
    "set -e\n" +
    'if [ -z "$XDG_RUNTIME_DIR" ]; then XDG_RUNTIME_DIR="/run/user/$(id -u)"; export XDG_RUNTIME_DIR; fi\n' +
    'if [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"; export DBUS_SESSION_BUS_ADDRESS; fi\n' +
    `j=${svcRoot}/.jobs\n` +
    `dir=${checkoutDir(s.id)}\n` +
    'mkdir -p "$j"\n' +
    `cat > "$j/${s.id}.sh" <<'${delim}'\n${script(s, op, keep)}${delim}\n` +
    `rm -f "$j/${s.id}.exit" "$j/${s.id}.commit"\n` +
    `: > "$j/${s.id}.log"\n` +
    // the step outlives this login: linger, by the login itself or sudo without a prompt
    'linger=0\n' +
    'if loginctl enable-linger "$(id -un)" 2>/dev/null || sudo -n loginctl enable-linger "$(id -un)" 2>/dev/null; then linger=1; fi\n' +
    `run='sh "$1" >"$2" 2>&1; echo $? >"$3"; if [ -d "$4/.git" ]; then git -C "$4" rev-parse HEAD >"$5" 2>/dev/null; fi; true'\n` +
    'if [ "$linger" = 1 ] && command -v systemd-run >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then\n' +
    `  systemctl --user stop ${unit}.service 2>/dev/null || true\n` +
    `  systemctl --user reset-failed ${unit}.service 2>/dev/null || true\n` +
    `  systemd-run --user --quiet --collect --unit=${unit} -p RuntimeMaxSec=${secs} sh -c "$run" ${unit} "$j/${s.id}.sh" "$j/${s.id}.log" "$j/${s.id}.exit" "$dir" "$j/${s.id}.commit"\n` +
    `  echo "started as the user unit ${unit}"\n` +
    "else\n" +
    `  nohup setsid sh -c "$run" ${unit} "$j/${s.id}.sh" "$j/${s.id}.log" "$j/${s.id}.exit" "$dir" "$j/${s.id}.commit" >/dev/null 2>&1 &\n` +
    '  if [ "$linger" = 1 ]; then echo "started in the background"; else echo "started in the background; no linger: it stops if $(id -un) logs out"; fi\n' +
    "fi\n"
  );
}

// --- what the mesh knows: etc/services/<id>/<host>.json, who installed it as which
// login and at which commit; etc/services/<id>/jobs/<host>.json, the step under way
// or last run there --------------------------------------------------------------

export type Record_ = { login: string; by: string; at: number; commit: string };

const recordRel = (id: string, host: string) => `etc/services/${id}/${host}.json`;
const jobRel = (id: string, host: string) => `etc/services/${id}/jobs/${host}.json`;

export function recordOf(id: string, host: string): Record_ | undefined {
  const o = obj(store.read(recordRel(id, host)));
  if (!o || typeof o.login !== "string") return;
  return { login: o.login, by: typeof o.by === "string" ? o.by : "", at: typeof o.at === "number" ? o.at : 0, commit: typeof o.commit === "string" ? o.commit : "" };
}

export function records(id: string): Record<string, Record_> {
  const out: Record<string, Record_> = {};
  for (const f of store.list(`etc/services/${id}`)) {
    if (f.includes("/")) continue;
    const host = f.replace(/\.json$/, "");
    const r = recordOf(id, host);
    if (r) out[host] = r;
  }
  return out;
}

// Job a step on one host: asked by by as login from the host from, started at at;
// done once the host has seen it end, ok or with error
export type Job = {
  id: string; host: string; op: Op; by: string; login: string; from: string; keep: boolean;
  at: number; done: number; ok?: boolean; error: string;
};

export function jobOf(id: string, host: string): Job | undefined {
  const o = obj(store.read(jobRel(id, host)));
  if (!o || typeof o.login !== "string" || !Ops.includes(o.op)) return;
  return {
    id, host, op: o.op, by: typeof o.by === "string" ? o.by : "", login: o.login, from: typeof o.from === "string" ? o.from : "", keep: o.keep === true,
    at: typeof o.at === "number" ? o.at : 0, done: typeof o.done === "number" ? o.done : 0, ok: typeof o.ok === "boolean" ? o.ok : undefined, error: typeof o.error === "string" ? o.error : "",
  };
}

export function jobs(id: string): Job[] {
  const out: Job[] = [];
  for (const f of store.list(`etc/services/${id}/jobs`)) {
    const j = jobOf(id, f.replace(/\.json$/, ""));
    if (j) out.push(j);
  }
  return out;
}

const writeJob = (j: Job) => store.write(jobRel(j.id, j.host), { op: j.op, by: j.by, login: j.login, from: j.from, keep: j.keep, at: j.at, done: j.done, ok: j.ok, error: j.error });

// --- the mesh as this module sees it, set at Start and swapped in tests ---------------

export type Login = { user: string; pass: string };
// Runner a script run on host as login to its end, each chunk of output to onOut; the exit code
export type Runner = (host: string, login: Login, script: string, onOut: (s: string) => void, timeoutMs: number) => Promise<number>;
// PublishLocal this host's services.export: [name] set to fields, or dropped with null
export type PublishLocal = (name: string, fields: Record<string, string> | null) => Promise<[number, any]>;
// Device a tailnet device as mesh.tailnet lists it
export type Device = { name?: unknown; os?: unknown; phosphorus?: unknown };
// Route a published service as mesh.routes lists it
export type Route = { host?: unknown; name?: unknown; port?: unknown; mode?: unknown; base_path?: unknown; scheme?: unknown; type?: unknown; public?: unknown };
// Progress what a host says of a step on it, in its info: the log's tail, the exit once there
export type Progress = { log: string; exit?: number };

export const seams: {
  routes: () => Route[];
  tailnet: () => Device[];
  run: Runner;
  publishLocal: PublishLocal;
  ipOf: (host: string) => string | Promise<string>;
  // a host's info as the mesh has it, its services' progress in it
  hostInfo: (host: string) => Record<string, any> | undefined;
  // a login's home on this host
  homeOf: (login: string) => string;
  // JSON from a url, undefined when it can't be had: GitHub's API
  fetchJSON: (url: string) => Promise<any>;
  // bytes and their type from a url: an icon off the repository
  fetchBytes: (url: string) => Promise<{ data: Uint8Array; type: string } | undefined>;
} = {
  routes: () => [],
  tailnet: () => [],
  run: sshRun,
  publishLocal: async () => [503, { error: "the mesh isn't up yet" }],
  ipOf: () => "",
  hostInfo: () => undefined,
  homeOf: passwdHome,
  fetchJSON: async (url) => {
    const r = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "phosphorus" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  },
  fetchBytes: async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return;
    return { data: new Uint8Array(await r.arrayBuffer()), type: r.headers.get("content-type") ?? "" };
  },
};

let ticker: ReturnType<typeof setInterval> | undefined;

export function Start(s: Partial<typeof seams>, tickMS = 3000) {
  Object.assign(seams, s);
  if (ticker) clearInterval(ticker);
  ticker = setInterval(() => void tick(), tickMS);
  void tick();
}

// a login's home from /etc/passwd, /home/<login> when it isn't there
function passwdHome(login: string): string {
  try {
    for (const l of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const f = l.split(":");
      if (f[0] === login && f[5]) return f[5];
    }
  } catch {}
  return "/home/" + login;
}

// --- a step asked: started on the host over ssh, the job noted for the mesh ---------

const opWord: Record<Op, string> = { install: "installing on", update: "updating on", remove: "being removed from" };

// ServiceOp an install, update or removal of id on host as login, asked by by:
// [status, body] once the step has started on the host, the host finishing it
export async function ServiceOp(op: string, id: string, host: string, login: Login, by: string, keep = false): Promise<[number, any]> {
  const s = serviceOf(id);
  if (!s) return [404, { error: `no service called ${id}` }];
  if (!Ops.includes(op as Op)) return [400, { error: "op is " + Ops.join(", ") }];
  const d = seams.tailnet().find((x) => x.name === host);
  if (!d || d.phosphorus !== true) return [404, { error: `${host} isn't a phosphorus host` }];
  const os = typeof d.os === "string" ? d.os : "";
  if (os && !s.os.includes(os)) return [400, { error: `${s.name} runs on ${s.os.join(", ")} hosts; ${host} is ${os}` }];
  if (!login.user) return [400, { error: `a login for ${host}` }];
  const held = jobOf(id, host);
  if (held && !held.done) return [409, { error: `${s.name} is already ${opWord[held.op]} ${host}`, job: held }];
  const j: Job = { id, host, op: op as Op, by, login: login.user, from: SelfHost, keep: keep && op === "remove", at: now(), done: 0, error: "" };
  let out = "";
  try {
    const code = await seams.run(host, login, launch(s, j.op, j.keep), (t) => void (out += t), launchTimeoutMS);
    if (code !== 0) throw new Error(`couldn't start it: ${out.trim().split("\n").at(-1) || `exit ${code}`}`);
  } catch (e) {
    return [502, { error: errText(e) }];
  }
  writeJob(j);
  logf("%s %s on %s as %s, for %s: %s", op, s.name, host, login.user, by, out.trim().split("\n").at(-1));
  return [200, { ok: true, job: j, started: out.trim() }];
}

// --- this host's side: the steps on it watched, their outcome published and recorded ---

const jobsDir = (login: string) => join(seams.homeOf(login), ".phosphorus", "services", ".jobs");

// a file's last n bytes as text, "" when there's none
function tailOf(p: string, n: number): string {
  let fd: number;
  try {
    fd = openSync(p, "r");
  } catch {
    return "";
  }
  try {
    const size = statSync(p).size;
    const start = size > n ? size - n : 0;
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const r = readSync(fd, buf, got, buf.length - got, start + got);
      if (!r) break;
      got += r;
    }
    let t = buf.subarray(0, got).toString("utf8");
    if (start > 0) t = t.slice(t.indexOf("\n") + 1);
    return t;
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

const exitOf = (login: string, id: string): number | undefined => {
  const t = tailOf(join(jobsDir(login), id + ".exit"), 64).trim();
  return /^-?\d+$/.test(t) ? Number(t) : undefined;
};

// progress of the steps on this host, for its info: each service's job here, its log's tail
export function progress(): Record<string, Progress> {
  const out: Record<string, Progress> = {};
  if (!SelfHost) return out;
  for (const s of Services) {
    const j = jobOf(s.id, SelfHost);
    if (!j) continue;
    const p: Progress = { log: tailOf(join(jobsDir(j.login), s.id + ".log"), logTail) };
    const e = exitOf(j.login, s.id);
    if (e !== undefined) p.exit = e;
    out[s.id] = p;
  }
  return out;
}

// finish a step that ended here: its outcome published and recorded, the job done
async function finish(s: Service, j: Job, exit: number | undefined) {
  try {
    if (exit === undefined) throw new Error(`ran past ${Math.round(opTimeoutMS[j.op] / 60000)} minutes`);
    if (exit !== 0) throw new Error(`the ${j.op} script exited ${exit}`);
    if (j.op === "remove") {
      const [st, b] = await seams.publishLocal(s.id, null);
      // nothing declared is as good as dropped
      if (st !== 200 && st !== 404 && !/no service/i.test(String(b?.error ?? ""))) throw new Error(`unpublishing: ${b?.error ?? `status ${st}`}`);
      store.remove(recordRel(s.id, j.host));
    } else {
      const [st, b] = await seams.publishLocal(s.id, { port: String(s.port), mode: s.mode });
      if (st !== 200) throw new Error(`publishing: ${b?.error ?? `status ${st}`}`);
      const commit = tailOf(join(jobsDir(j.login), s.id + ".commit"), 64).trim();
      store.write(recordRel(s.id, j.host), { login: j.login, by: j.by, at: now(), commit } satisfies Record_);
      behind.delete(s.id + "/" + commit);
    }
    j.ok = true;
    logf("%s %s on %s: done", j.op, s.name, j.host);
  } catch (e) {
    j.ok = false;
    j.error = errText(e);
    logf("%s %s on %s: %s", j.op, s.name, j.host, j.error);
  }
  j.done = now();
  writeJob(j);
}

let ticking: Promise<void> | undefined;

// tick the steps under way on this host: one that ended finished, one past its
// time failed
export function tick(): Promise<void> {
  return (ticking ??= (async () => {
    if (!SelfHost) return;
    for (const s of Services) {
      const j = jobOf(s.id, SelfHost);
      if (!j || j.done) continue;
      const exit = exitOf(j.login, s.id);
      if (exit !== undefined) await finish(s, j, exit);
      else if (now() - j.at > opTimeoutMS[j.op] + 60000) await finish(s, j, undefined);
    }
  })().finally(() => (ticking = undefined)));
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
    // the script by heredoc on sh's stdin, nothing of it in argv
    const delim = "PHOS_SVC_" + randomBytes(6).toString("hex");
    const cmd = `sh -s <<'${delim}'\n${text}\n${delim}\n`;
    const st = await new Promise<ClientChannel>((res, rej) => c.exec(cmd, (err, ch) => (err ? rej(err) : res(ch))));
    const dec = new TextDecoder();
    st.on("data", (b: Uint8Array) => onOut(dec.decode(b, { stream: true })));
    st.stderr.on("data", (b: Uint8Array) => onOut(dec.decode(b, { stream: true })));
    return await new Promise<number>((res, rej) => {
      let code = -1;
      const t = setTimeout(() => {
        rej(new Error(`the script ran past ${Math.round(timeoutMs / 1000)}s`));
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

// --- main moved: how far a host's commit is behind the repository's main, from
// GitHub's compare, an hour at a time ---------------------------------------------

const behindTTL = 3600000;
const behindRetry = 600000;
const behind = new Map<string, { at: number; n: number | null }>();
const fetchingBehind = new Map<string, Promise<number | null>>();

// commits on main past commit, null when GitHub can't say
export function behindMain(s: Service, commit: string): Promise<number | null> {
  const repo = repoOf(s);
  if (!repo || !/^[0-9a-f]{7,40}$/.test(commit)) return Promise.resolve(null);
  const key = s.id + "/" + commit;
  const cur = behind.get(key);
  if (cur && now() - cur.at < (cur.n === null ? behindRetry : behindTTL)) return Promise.resolve(cur.n);
  let p = fetchingBehind.get(key);
  if (!p) {
    p = (async () => {
      let n: number | null = null;
      try {
        const o = obj(await seams.fetchJSON(`https://api.github.com/repos/${repo.owner}/${repo.name}/compare/${commit}...main`));
        if (typeof o?.ahead_by === "number") n = o.ahead_by;
      } catch (e) {
        logf("%s's main: %s", s.name, errText(e));
      }
      behind.set(key, { at: now(), n });
      return n;
    })().finally(() => fetchingBehind.delete(key));
    fetchingBehind.set(key, p);
  }
  return p;
}

// --- the icon off the repository's main, kept a day in state/apps/icons -------------

const iconTTL = 86400000;
const iconDir = () => env("APPS_ICON_DIR", join(StateDir, "apps", "icons"));
const iconTypes: Record<string, string> = { ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const iconFetching = new Map<string, Promise<void>>();

export const iconPath = (id: string) => `/api/apps/services/${id}/icon`;

// Icon the service's icon as bytes and type, from the repository on first ask and
// once a day after, the kept copy meanwhile; undefined with none to give
export async function Icon(id: string): Promise<{ data: Uint8Array; type: string } | undefined> {
  const s = serviceOf(id);
  return s ? RepoIcon(s) : undefined;
}

// RepoIcon an icon at a path in a repository's main, kept under its id: a service's, or a web
// app's before any host serves it
export async function RepoIcon(s: { id: string; name: string; repo: string; icon: string }): Promise<{ data: Uint8Array; type: string } | undefined> {
  const repo = repoOf(s);
  if (!repo || !s.icon) return;
  const ext = (/\.[a-z0-9]+$/i.exec(s.icon)?.[0] ?? ".png").toLowerCase();
  const type = iconTypes[ext] ?? "application/octet-stream";
  const file = join(iconDir(), s.id + ext);
  let fresh = false;
  try {
    fresh = now() - statSync(file).mtimeMs < iconTTL;
  } catch {}
  if (!fresh) {
    let p = iconFetching.get(s.id);
    if (!p) {
      p = (async () => {
        const got = await seams.fetchBytes(`https://raw.githubusercontent.com/${repo.owner}/${repo.name}/main/${s.icon}`);
        if (!got || !got.data.length) return;
        mkdirSync(iconDir(), { recursive: true });
        writeFileSync(file, got.data);
      })().catch((e) => logf("%s's icon: %s", s.name, errText(e))).finally(() => iconFetching.delete(s.id));
      iconFetching.set(s.id, p);
    }
    // a kept copy answers at once while a fresher one is fetched
    if (!existsSync(file)) await p;
  }
  try {
    return { data: new Uint8Array(readFileSync(file)), type };
  } catch {
    return;
  }
}

// --- the page's read ---------------------------------------------------------------

export type JobView = Job & Progress;
export type HostView = { published: boolean; route?: Route; version: string; record?: Record_; job?: JobView; behind: number | null };

export async function summary(): Promise<any[]> {
  const routes = seams.routes();
  return Promise.all(Services.map(async (s) => {
    const hosts: Record<string, HostView> = {};
    const at = (h: string) => (hosts[h] ??= { published: false, version: "", behind: null });
    for (const r of routes) {
      if (r.name !== s.id || r.type === "game") continue;
      const h = at(String(r.host));
      h.published = true;
      h.route = r;
    }
    for (const [h, rec] of Object.entries(records(s.id))) at(h).record = rec;
    for (const j of jobs(s.id)) {
      const p = obj(obj(seams.hostInfo(j.host)?.services)?.[s.id]);
      at(j.host).job = { ...j, log: typeof p?.log === "string" ? p.log : "", ...(typeof p?.exit === "number" ? { exit: p.exit } : {}) };
    }
    await Promise.all(Object.entries(hosts).map(async ([, h]) => {
      if (h.route) h.version = await versionOf(s, h.route);
      if (h.record?.commit) h.behind = await behindMain(s, h.record.commit);
    }));
    return {
      id: s.id, name: s.name, tagline: s.tagline, about: s.about, features: s.features, category: s.category, by: s.by,
      repo: s.repo, icon: iconPath(s.id), port: s.port, mode: s.mode, os: s.os, needs: s.needs, agents: s.agents ?? [], data: s.data,
      checkout: `~/.phosphorus/services/${s.id}`, kept: `~/.phosphorus/services/${s.id}.data`,
      hosts,
    };
  }));
}

// for tests: the caches forgotten
export function reset() {
  versions.clear();
  behind.clear();
  if (ticker) clearInterval(ticker);
  ticker = undefined;
}
