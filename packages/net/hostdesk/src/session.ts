// one ssh session per phosphorus user and host: two long lived probes, a fast lane and a
// slow one so an icon never waits on the start menu, sftp beside them, all closed when unused

import { errText } from "@phosphorus/util";
import { Client, type ClientChannel, type SFTPWrapper } from "ssh2";
import winProbe from "./probe.ps1" with { type: "text" };
import linuxProbe from "./probe.sh" with { type: "text" };
import { bootLine, encodedCommand, reply, request, shBoot, winBoot } from "./proto.ts";

const idleMs = 15 * 60_000;
const callMs = 60_000;
const readyMs = 15_000;

export type Target = { host: string; addr: string; port: number; user: string; pass: string; os: string };

// Refused the saved login turned down, apart from a host that didn't answer
export class Refused extends Error {}

type Waiter = { ok: (s: string) => void; no: (e: Error) => void; t: ReturnType<typeof setTimeout> };

// the requests that walk a whole tree or the start menu, kept off the fast lane
const slowCmds = new Set(["apps", "images", "trash", "stat", "empty", "delete", "restore"]);

// Lane one probe on its own channel, its requests pipelined
class Lane {
  n = 0;
  waiting = new Map<number, Waiter>();
  rest = "";
  constructor(public chan: ClientChannel) {}

  feed(b: Uint8Array) {
    this.rest += Buffer.from(b).toString("utf8");
    let i: number;
    while ((i = this.rest.indexOf("\n")) >= 0) {
      const line = this.rest.slice(0, i);
      this.rest = this.rest.slice(i + 1);
      const r = reply(line);
      if (!r) continue;
      const w = this.waiting.get(r.id);
      if (!w) continue;
      this.waiting.delete(r.id);
      clearTimeout(w.t);
      if (r.ok) w.ok(r.body);
      else w.no(new Error(r.body.trim() || "the probe failed"));
    }
  }

  fail(e: Error) {
    for (const w of this.waiting.values()) {
      clearTimeout(w.t);
      w.no(e);
    }
    this.waiting.clear();
  }
}

export class Session {
  client?: Client;
  fast?: Lane;
  slow?: Lane;
  sftpP?: Promise<SFTPWrapper>;
  os: "windows" | "linux" = "linux";
  dead = false;
  lastUse = Date.now();
  // kept by the caller: the profile scope, the last desktop
  extra: Record<string, any> = {};

  constructor(
    public key: string,
    public target: Target,
  ) {}

  async open(): Promise<void> {
    const c = new Client();
    this.client = c;
    await new Promise<void>((resolve, reject) => {
      c.on("ready", () => resolve());
      c.on("error", (e) => {
        this.close();
        const m = errText(e);
        reject(
          /authentication methods failed|unable to authenticate/i.test(m)
            ? new Refused(`the saved login for ${this.target.host} was refused`)
            : new Error(`ssh to ${this.target.host}: ${m}`),
        );
      });
      c.on("keyboard-interactive", (_n, _i, _l, prompts, finish) => finish(prompts.map(() => this.target.pass)));
      c.connect({
        host: this.target.addr,
        port: this.target.port,
        username: this.target.user,
        password: this.target.pass,
        tryKeyboard: true,
        readyTimeout: readyMs,
        keepaliveInterval: 30_000,
      });
    });
    c.on("close", () => this.close());
    this.os = await this.detect();
    // both lanes started at once; a host refusing a second channel keeps one
    const [fast, slow] = await Promise.allSettled([this.lane(false), this.lane(true)]);
    if (fast.status === "rejected") throw fast.reason;
    this.fast = fast.value;
    if (slow.status === "fulfilled") this.slow = slow.value;
  }

  private async lane(slow: boolean): Promise<Lane> {
    const c = this.client;
    if (!c) throw new Error("closed");
    const cmd =
      this.os === "windows"
        ? `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand(winBoot)}`
        : shBoot;
    const ch = await new Promise<ClientChannel>((res, rej) => c.exec(cmd, (e, s) => (e ? rej(e) : res(s))));
    const l = new Lane(ch);
    ch.on("data", (b: Uint8Array) => l.feed(b));
    ch.stderr.on("data", () => {});
    ch.on("close", () => {
      if (!slow || this.fast?.chan === ch) return this.close();
      // the slow lane gone, its requests failed and the rest sent down the fast one
      l.fail(new Error(`${this.target.host} closed the slow probe`));
      if (this.slow === l) this.slow = undefined;
    });
    const script = this.os === "windows" ? (slow ? `$lane = 'slow'\n${winProbe}` : winProbe) : linuxProbe;
    ch.write(bootLine(script));
    return l;
  }

  // the OS as the tailnet named it, else what uname says
  private async detect(): Promise<"windows" | "linux"> {
    if (/win/i.test(this.target.os)) return "windows";
    if (/linux/i.test(this.target.os)) return "linux";
    if (/mac|darwin|ios/i.test(this.target.os))
      throw new Error(`${this.target.host} runs macOS, which host desktop doesn't draw`);
    const out = await this.exec("uname -s").catch(() => "");
    if (/darwin/i.test(out)) throw new Error(`${this.target.host} runs macOS, which host desktop doesn't draw`);
    return /linux|bsd/i.test(out) ? "linux" : "windows";
  }

  // one command's stdout, a short one
  exec(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const c = this.client;
      if (!c) return reject(new Error("closed"));
      c.exec(cmd, (e, s) => {
        if (e) return reject(e);
        let out = "";
        s.on("data", (b: Uint8Array) => {
          if (out.length < 4096) out += Buffer.from(b).toString("utf8");
        });
        s.stderr.on("data", () => {});
        s.on("close", (code: unknown) => (code === 0 ? resolve(out) : reject(new Error(out || `exit ${code}`))));
      });
    });
  }

  // one request answered, pipelined with any others
  call(cmd: string, arg = "", ms = callMs): Promise<string> {
    this.lastUse = Date.now();
    const l = (slowCmds.has(cmd) && this.slow) || this.fast;
    if (this.dead || !l) return Promise.reject(new Error(`the session with ${this.target.host} closed`));
    const id = ++l.n;
    return new Promise((ok, no) => {
      const t = setTimeout(() => {
        l.waiting.delete(id);
        no(new Error(`${this.target.host} took too long to answer ${cmd}`));
      }, ms);
      l.waiting.set(id, { ok, no, t });
      l.chan.write(request(id, cmd, arg));
    });
  }

  sftp(): Promise<SFTPWrapper> {
    this.lastUse = Date.now();
    this.sftpP ??= new Promise<SFTPWrapper>((res, rej) => {
      if (!this.client) return rej(new Error("closed"));
      this.client.sftp((e, s) => {
        if (e) {
          this.sftpP = undefined;
          return rej(e);
        }
        s.on("close", () => {
          this.sftpP = undefined;
        });
        res(s);
      });
    });
    return this.sftpP;
  }

  close() {
    if (this.dead) return;
    this.dead = true;
    const e = new Error(`the session with ${this.target.host} closed`);
    this.fast?.fail(e);
    this.slow?.fail(e);
    try {
      this.client?.end();
    } catch {}
    sessions.delete(this.key);
  }
}

const sessions = new Map<string, Session>();
const opening = new Map<string, Promise<[Session, boolean]>>();

// the live session for key, opened on first use; true when this call opened it
export async function sessionFor(key: string, t: () => Promise<Target>): Promise<[Session, boolean]> {
  const s = sessions.get(key);
  if (s && !s.dead) return [s, false];
  // only the call that opened it is told so: one audit row, one cache load
  const o = opening.get(key);
  if (o) return o.then(([s]) => [s, false]);
  const p = (async (): Promise<[Session, boolean]> => {
    const ns = new Session(key, await t());
    await ns.open();
    sessions.set(key, ns);
    return [ns, true];
  })().finally(() => opening.delete(key));
  opening.set(key, p);
  return p;
}

export const sessionOf = (key: string) => sessions.get(key);

export function dropSession(key: string) {
  sessions.get(key)?.close();
}

// idle sessions closed, from the server's tick
export function reap() {
  for (const s of [...sessions.values()]) if (Date.now() - s.lastUse > idleMs) s.close();
}

export const sessionCount = () => sessions.size;
