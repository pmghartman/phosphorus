// the GameStream host on this machine as glow uses it: found (Sunshine or Apollo,
// whichever answers on loopback), trusted without a PIN where phosphorus may write
// its state (our certificate added as a paired client, the host restarted once),
// and given one app of phosphorus's own whose command starts whatever the next
// stream asks for, so no app needs the host's list edited or the host restarted

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { type Identity, makeIdentity } from "./cert.ts";
import { apps, type Host, LumenError, pair, type ServerInfo, serverInfo } from "./lumen.ts";

// the app phosphorus adds to the host's list
export const launcherName = "phosphorus";

export type HostFiles = {
  // the host's config dir and its files, as its sunshine.conf names them
  dir: string;
  state: string;
  apps: string;
  cert: string;
  // the service to restart once our certificate is in, "" for none
  service: string;
  kind: "sunshine" | "apollo";
};

export type Platform = {
  os: "windows" | "linux" | "darwin";
  // where the host's files are, undefined when phosphorus can't find or write them
  files(): HostFiles | undefined;
  // the host restarted, back once it answers again
  restart(f: HostFiles): Promise<void>;
  // the launcher's command line and how to aim it at the next app
  launcher(dir: string): { cmd: string; aim(target: string): void };
};

// a host's sunshine.conf: key = value lines
export function parseConf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/.exec(l);
    if (m && !l.trimStart().startsWith("#")) out[m[1]!] = m[2]!;
  }
  return out;
}

// the files a config dir's sunshine.conf points at, relative ones under the dir
export function filesOf(dir: string, conf: string, kind: HostFiles["kind"], service: string): HostFiles {
  const c = parseConf(conf);
  const at = (v: string | undefined, d: string) =>
    v ? (isAbsolute(v) || /^[A-Za-z]:[\\/]/.test(v) ? v : join(dir, v)) : join(dir, d);
  return {
    dir,
    state: at(c.file_state, "sunshine_state.json"),
    apps: at(c.file_apps, "apps.json"),
    cert: at(c.cert, join("credentials", "cacert.pem")),
    service,
    kind,
  };
}

// our certificate among the host's paired clients, the state otherwise as it was
export function addClient(stateText: string, cert: string, name = launcherName): { text: string; changed: boolean } {
  let st: any = {};
  try {
    st = stateText.trim() ? JSON.parse(stateText) : {};
  } catch {
    throw new Error("the host's state file isn't JSON; pair with a PIN instead");
  }
  st.root ??= {};
  // a state with no id of its own is read as empty: the host's paired clients with it
  if (typeof st.root.uniqueid !== "string" || !st.root.uniqueid) st.root.uniqueid = randomUUID().toUpperCase();
  const list: any[] = Array.isArray(st.root.named_devices) ? st.root.named_devices : [];
  const norm = (s: string) => s.replace(/\s+/g, "");
  if (list.some((d) => typeof d?.cert === "string" && norm(d.cert) === norm(cert)))
    return { text: stateText, changed: false };
  list.push({ name, cert, uuid: randomUUID().toUpperCase() });
  st.root.named_devices = list;
  return { text: JSON.stringify(st, null, 4), changed: true };
}

// phosphorus's own app in the host's list, its command the launcher's
export function addLauncher(appsText: string, cmd: string): { text: string; changed: boolean } {
  let a: any = {};
  try {
    a = appsText.trim() ? JSON.parse(appsText) : {};
  } catch {
    throw new Error("the host's apps.json isn't JSON");
  }
  a.env ??= {};
  const list: any[] = Array.isArray(a.apps) ? a.apps : [];
  const mine = list.find((x) => x?.name === launcherName);
  const want = { name: launcherName, cmd, "auto-detach": "true", "wait-all": "true", "exit-timeout": "5" };
  if (mine && mine.cmd === cmd) return { text: appsText, changed: false };
  if (mine) Object.assign(mine, want);
  else list.push(want);
  a.apps = list;
  return { text: JSON.stringify(a, null, 4), changed: true };
}

const writeAtomic = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(`${p}.phos-tmp`, text);
  renameSync(`${p}.phos-tmp`, p);
};

type Saved = { id: Omit<Identity, "sig"> & { sig: string }; server?: string; serverId?: string };

export type Ready = { host: Host; id: Identity; info: ServerInfo };

export class GlowHost {
  private id?: Identity;
  private server?: string;
  private serverId?: string;
  private readying?: Promise<Ready>;
  // one stream at a time: a GameStream host streams one app
  busy = "";

  constructor(
    private dir: string,
    private plat: Platform,
    private addr = "127.0.0.1",
    private httpPort = 47989,
  ) {}

  private load() {
    if (this.id) return;
    const f = join(this.dir, "identity.json");
    if (existsSync(f)) {
      try {
        const s = JSON.parse(readFileSync(f, "utf8")) as Saved;
        this.id = { ...s.id, sig: new Uint8Array(Buffer.from(s.id.sig, "hex")) };
        this.server = s.server;
        this.serverId = s.serverId;
        return;
      } catch {}
    }
    this.id = makeIdentity(launcherName);
    this.save();
  }

  private save() {
    const id = this.id!;
    const s: Saved = {
      id: { ...id, sig: Buffer.from(id.sig).toString("hex") },
      server: this.server,
      serverId: this.serverId,
    };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeAtomic(join(this.dir, "identity.json"), JSON.stringify(s));
  }

  private hostOf(info?: ServerInfo): Host {
    return { addr: this.addr, http: this.httpPort, https: info?.httpsPort ?? this.httpPort - 5, cert: this.server };
  }

  // found, trusted and set up: the same answer to every stream until it fails
  ready(note: (s: string) => void): Promise<Ready> {
    this.readying ??= this.setUp(note).catch((e) => {
      this.readying = undefined;
      throw e;
    });
    return this.readying;
  }

  forget() {
    this.readying = undefined;
  }

  // the host's own apps, once it's set up (never set up for a listing), phosphorus's launcher aside
  async listed(): Promise<string[]> {
    if (!this.readying) {
      this.load();
      if (!this.server && !this.plat.files()) return [];
      // set up already by an earlier run: ready at once, no restart, no PIN
      const quiet = await serverInfo(this.hostOf(), this.id!, true, 1500).catch(() => undefined);
      if (!quiet?.paired) return [];
    }
    try {
      const r = await this.ready(() => {});
      return (await apps(r.host, r.id)).map((a) => a.title).filter((t) => t !== launcherName);
    } catch {
      return [];
    }
  }

  private async setUp(note: (s: string) => void): Promise<Ready> {
    this.load();
    const id = this.id!;
    let info: ServerInfo;
    try {
      info = await serverInfo(this.hostOf(), id, false);
    } catch {
      throw new LumenError(
        503,
        this.plat.os === "windows"
          ? "window apps on Windows stream through Sunshine or Apollo: install one on this host (Apollo streams with no monitor attached)"
          : "no Sunshine or Apollo answers on this host",
      );
    }
    // a host reinstalled since: its old certificate forgotten
    if (this.serverId && info.uniqueid && info.uniqueid !== this.serverId) this.server = undefined;
    const f = this.plat.files();
    if (f && existsSync(f.cert)) this.server ??= readFileSync(f.cert, "utf8");
    let host = this.hostOf(info);
    const paired = async () => {
      try {
        return (await serverInfo(host, id, true)).paired;
      } catch {
        return false;
      }
    };
    let restart = false;
    const launcher = this.plat.launcher(this.dir);
    if (f) {
      const st = addClient(existsSync(f.state) ? readFileSync(f.state, "utf8") : "", id.cert);
      const ap = addLauncher(existsSync(f.apps) ? readFileSync(f.apps, "utf8") : "", launcher.cmd);
      if (st.changed && !(await paired())) {
        writeAtomic(f.state, st.text);
        restart = true;
      }
      if (ap.changed) {
        writeAtomic(f.apps, ap.text);
        restart = true;
      }
      if (restart) {
        note(`setting up ${f.kind === "apollo" ? "Apollo" : "Sunshine"} for phosphorus: it restarts once`);
        await this.plat.restart(f);
        info = await serverInfo(this.hostOf(), id, false, 5000);
        if (existsSync(f.cert)) this.server = readFileSync(f.cert, "utf8");
        host = this.hostOf(info);
      }
    }
    if (!(await paired())) {
      // no files phosphorus may write: paired with a PIN typed into the host's own page
      const pin = String(1000 + Math.floor(Math.random() * 9000));
      note(
        `pair phosphorus with this host's ${info.kind === "apollo" ? "Apollo" : "Sunshine"}: type PIN ${pin} into its web page (https://localhost:47990, PIN)`,
      );
      this.server = await pair(host, id, pin);
      host = this.hostOf(info);
    }
    this.serverId = info.uniqueid;
    this.save();
    info = await serverInfo(host, id, true);
    if (f) info.kind = f.kind;
    return { host, id, info };
  }

  // the host's app id for a stream: the launcher aimed at target (a path or command
  // line the host's desk listed), or one of the host's own apps by title
  async appFor(r: Ready, want: { target?: string; title?: string }): Promise<number> {
    const list = await apps(r.host, r.id);
    if (want.title) {
      const a = list.find((x) => x.title === want.title);
      if (!a) throw new LumenError(404, `the host has no app named ${want.title}`);
      return a.id;
    }
    const l = list.find((x) => x.title === launcherName);
    if (!l) {
      this.forget();
      throw new LumenError(503, "the host's app list has no phosphorus launcher; it can't be set up from here");
    }
    this.plat.launcher(this.dir).aim(want.target ?? "");
    return l.id;
  }
}

// --- the platforms -------------------------------------------------------------------------

const run = async (argv: string[]) => {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return { code: p.exitCode ?? 1, out };
};

async function waitUp(ms: number, addr = "127.0.0.1", port = 47989) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://${addr}:${port}/serverinfo`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new LumenError(503, "the host didn't come back after its restart");
}

// Windows: the installed service (Apollo's or Sunshine's), its files under Program
// Files, the launcher a .cmd in ProgramData that starts the next app and waits on it
export const windows: Platform = {
  os: "windows",
  files() {
    const pf = process.env.ProgramFiles ?? "C:\\Program Files";
    for (const [kind, name, service] of [
      ["apollo", "Apollo", "ApolloService"],
      ["sunshine", "Sunshine", "SunshineService"],
    ] as const) {
      const dir = join(pf, name, "config");
      const conf = join(dir, "sunshine.conf");
      if (existsSync(conf)) return filesOf(dir, readFileSync(conf, "utf8"), kind, service);
    }
    return undefined;
  },
  async restart(f) {
    if (!f.service) return;
    await run(["net", "stop", f.service]);
    await run(["net", "start", f.service]);
    await waitUp(30_000);
  },
  launcher() {
    const shared = join(process.env.ProgramData ?? "C:\\ProgramData", "phosphorus", "glow");
    const script = join(shared, "launch.cmd");
    const next = join(shared, "next.txt");
    return {
      cmd: `cmd.exe /d /c "${script}"`,
      aim(target) {
        mkdirSync(shared, { recursive: true });
        // written by SYSTEM, read by the signed-in user who runs it: only SYSTEM and
        // administrators may change it, so no one else aims the launcher anywhere
        // (a folder someone made first loses its owner and every grant it had)
        for (const a of [
          ["/reset", "/T", "/C"],
          ["/setowner", "*S-1-5-32-544", "/T", "/C"],
          ["/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "*S-1-5-32-545:(OI)(CI)RX"],
        ])
          Bun.spawnSync(["icacls", shared, ...a]);
        // the next app's command line, read as one line and started as the shell would,
        // waited on so the host streams it until it quits
        writeFileSync(
          script,
          '@echo off\r\nsetlocal EnableDelayedExpansion\r\nset /p NEXT=<"%~dp0next.txt"\r\nstart "" /wait !NEXT!\r\n',
        );
        writeFileSync(next, `${target}\r\n`);
      },
    };
  },
};

// Linux and macOS: a Sunshine the user runs, its files under their config dir when
// phosphorus can read them; never restarted from here, so a PIN pairs it
export const unixLike = (os: "linux" | "darwin"): Platform => ({
  os,
  files() {
    return undefined;
  },
  async restart() {},
  launcher(dir) {
    const next = join(dir, "next.sh");
    return {
      cmd: `sh "${next}"`,
      aim(target) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(next, `exec ${target}\n`);
      },
    };
  },
});
