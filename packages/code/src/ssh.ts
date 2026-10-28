// the host reached over ssh with the user's saved login, as the terminal's:
// this host's own sshd as the terminal finds it, a peer's on its tailnet address
import { Client, type ClientChannel } from "ssh2";
import { env, envInt, errText, SelfHost, tailnetIP } from "@phosphorus/util";
import type { Creds } from "./script.ts";

const tailMax = 8 * 1024;

// addrOf where host's sshd answers; this one's as HOST_SSH_HOST and
// HOST_SSH_PORT say, read each time so a test may point them elsewhere
async function addrOf(host: string): Promise<{ host: string; port: number }> {
  if (host === (process.env.SELF_HOST ?? SelfHost)) return { host: env("HOST_SSH_HOST", "127.0.0.1"), port: envInt("HOST_SSH_PORT", 22) || 22 };
  const ip = await tailnetIP(host);
  if (!ip) throw new Error(`can't find ${host} on the tailnet`);
  return { host: ip, port: 22 };
}

// dial host as user, a password or keyboard-interactive login
export function dial(host: string, user: string, pass: string): Promise<Client> {
  return addrOf(host).then((addr) => new Promise<Client>((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", (e) => {
      c.end();
      const msg = errText(e);
      reject(new Error(/authentication methods failed|unable to authenticate/i.test(msg) ? `the saved login for ${host} was refused` : `ssh to ${host}: ${msg}`));
    });
    c.on("keyboard-interactive", (_n, _i, _l, prompts, finish) => finish(prompts.map(() => pass)));
    c.connect({ host: addr.host, port: addr.port, username: user, password: pass, tryKeyboard: true, readyTimeout: 10_000 });
  }));
}

// dialAs host as c's login
export const dialAs = (host: string, c: Creds) => dial(host, c.user, c.pass);

// Tail a sink keeping the last tailMax bytes
export class Tail {
  private b: Uint8Array = new Uint8Array();
  write(p: Uint8Array) {
    this.b = this.b.length + p.length > tailMax ? Buffer.concat([this.b, p]).subarray(-tailMax) : Buffer.concat([this.b, p]);
  }
  toString() {
    return Buffer.from(this.b).toString().trim();
  }
}

export const exec = (cl: Client, cmd: string) =>
  new Promise<ClientChannel>((res, rej) => cl.exec(cmd, (err, st) => (err ? rej(err) : res(st))));

// exit the channel's exit code, -1 when it never gave one (a signal, a lost connection)
export function exit(st: ClientChannel): Promise<number> {
  return new Promise((r) => {
    let code = -1;
    st.on("exit", (c: unknown) => void (typeof c === "number" && (code = c)));
    st.on("close", (c: unknown) => r(typeof c === "number" ? c : code));
  });
}

// feed stdin into the channel to its end, at most limit bytes, with backpressure
export async function feed(st: ClientChannel, stdin: Stdin, limit = Infinity) {
  try {
    const chunks = stdin instanceof Uint8Array ? [stdin] : typeof stdin === "string" ? [new TextEncoder().encode(stdin)] : stdin ?? [];
    let n = 0;
    for await (let c of chunks) {
      if (n + c.length > limit) c = c.subarray(0, limit - n);
      n += c.length;
      if (c.length && !st.write(c)) await new Promise((r) => st.once("drain", r));
      if (n >= limit) break;
    }
  } catch {}
  st.end();
}

export type Stdin = string | Uint8Array | AsyncIterable<Uint8Array> | undefined | null;

export type Captured = { code: number; out: Uint8Array; errs: string; error?: string };

// capture one command to its end, stdin fed it: its exit, stdout up to max,
// stderr's tail; code -1 and error when it never ran out
export async function capture(cl: Client, cmd: string, stdin: Stdin, max: number, timeoutMs: number, limit?: number): Promise<Captured> {
  let st: ClientChannel;
  try {
    st = await exec(cl, cmd);
  } catch (e) {
    return { code: -1, out: new Uint8Array(), errs: "", error: errText(e) };
  }
  const parts: Uint8Array[] = [];
  let n = 0;
  const errs = new Tail();
  st.on("data", (d: Uint8Array) => {
    if (n < max) parts.push(d.subarray(0, max - n));
    n += d.length;
  });
  st.stderr.on("data", (d: Uint8Array) => errs.write(d));
  const done = exit(st);
  if (stdin !== undefined && stdin !== null) void feed(st, stdin, limit);
  else st.end();
  const code = await Promise.race([done, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
  if (code === null) {
    try {
      st.signal("KILL");
      st.close();
    } catch {}
    return { code: -1, out: Buffer.concat(parts), errs: errs.toString(), error: "timed out" };
  }
  return { code, out: Buffer.concat(parts), errs: errs.toString() };
}

// run one command to its end, stdin fed it: its exit code and output's tail
export async function run(cl: Client, cmd: string, stdin: string, timeoutMs: number): Promise<{ code: number; out: string; error?: string }> {
  let st: ClientChannel;
  try {
    st = await exec(cl, cmd);
  } catch (e) {
    return { code: -1, out: "", error: errText(e) };
  }
  const out = new Tail();
  st.on("data", (d: Uint8Array) => out.write(d));
  st.stderr.on("data", (d: Uint8Array) => out.write(d));
  const done = exit(st);
  if (stdin) void feed(st, stdin);
  else st.end();
  const code = await Promise.race([done, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
  if (code === null) {
    try {
      st.signal("KILL");
      st.close();
    } catch {}
    return { code: -1, out: out.toString(), error: "timed out" };
  }
  return { code, out: out.toString() };
}

// Proc a running harness: its stdin, stdout, stderr's tail and end
export type Proc = {
  in: { write(s: string): void; end(): void };
  out: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  errs: Tail;
  wait(): Promise<number>;
  kill(): void;
};

// install an official installer, cmd, run as the login: ok and its output's tail
export async function install(host: string, c: Creds, cmd: string): Promise<{ ok: boolean; out: string; error?: string }> {
  const cl = await dial(host, c.user, c.pass);
  try {
    const r = await run(cl, cmd, "", 10 * 60_000);
    return r.error ? { ok: false, out: r.out, error: r.error } : { ok: r.code === 0, out: r.out };
  } finally {
    cl.end();
  }
}
