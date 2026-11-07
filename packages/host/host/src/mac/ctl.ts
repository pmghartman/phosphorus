// the daemon's control socket on macOS: start, stop, status, the keys and
// updates for the tray of the console user who set it up, and root

import { dlopen, ptr } from "bun:ffi";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import * as envfile from "@phosphorus/envfile";
import { at, envPath, errText, home, say, selfArgv } from "../base.ts";
import { ownerUid } from "../darwin.ts";
import { meshUp } from "../net/status.ts";
import { keySet } from "../start.ts";
import { agentReport } from "../upgrade.ts";
import { releaseKey, stageUpdate } from "./update.ts";

export const sockPath = "/var/run/phosphorus.sock";

// a line's limit: the keys' 64KB and the request around them
export const maxLine = 70_000;

// root, or the console user recorded at setup; nobody else
export const peerAllowed = (uid: number, owner: number | undefined) =>
  uid === 0 || (owner !== undefined && owner > 0 && uid === owner);

export type Reply = { ok: boolean; error?: string; [k: string]: unknown };

export type Deps = {
  status(): Promise<{ running: boolean; vpn: boolean }>;
  keys(): { keys: Record<string, boolean>; domain: string };
  setKeys(text: string): void;
  // a host command as root in its own session, its exit code and output
  command(args: string[]): Promise<{ code: number; output: string }>;
  // the pending update request's id, consumed; undefined with none
  takeRequest(): string | undefined;
  report(id: string, state: string, current: boolean, version: string, error: string): void;
  // the bundle at file checked against the release key and staged, its install begun
  update(file: string, signature: string, id: string, uid: number): Promise<void>;
};

const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
// knownKeys the form's keys alone: .env is run's env as root, never a PATH or DYLD_ of the user's
export function knownKeys(text: string): Record<string, string> {
  const vals = envfile.parse(text);
  return Object.fromEntries(envfile.Keys.filter((k) => vals[k.name]).map((k) => [k.name, vals[k.name]!]));
}

// a command's output, its tail alone past 8KB
const tail = (s: string) => (s.length > 8192 ? s.slice(-8192) : s);

// respond one request line from a peer of uid, the owner as recorded now
export async function respond(line: string, uid: number, owner: number | undefined, d: Deps): Promise<Reply> {
  if (!peerAllowed(uid, owner)) return { ok: false, error: "not allowed: only the user who set phosphorus up" };
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(line);
    if (!r || typeof r !== "object") throw new Error();
  } catch {
    return { ok: false, error: "bad request" };
  }
  switch (r.op) {
    case "ping":
      return { ok: true };
    case "status":
      return { ok: true, ...(await d.status()) };
    case "keys":
      return { ok: true, ...d.keys() };
    case "keys-set":
      if (!str(r.text, 1 << 16)) return { ok: false, error: "bad request" };
      d.setKeys(r.text as string);
      return { ok: true };
    case "start":
    case "stop":
    case "rebuild": {
      const c = await d.command([r.op]);
      return { ok: c.code === 0, output: tail(c.output) };
    }
    case "take-request": {
      const id = d.takeRequest();
      return id === undefined ? { ok: true } : { ok: true, id };
    }
    case "report":
      if (
        !str(r.id, 200) ||
        !["running", "ok", "failed"].includes(r.state as string) ||
        !str(r.version ?? "", 100) ||
        !str(r.error ?? "", 4000)
      )
        return { ok: false, error: "bad request" };
      d.report(r.id as string, r.state as string, !!r.current, (r.version as string) ?? "", (r.error as string) ?? "");
      return { ok: true };
    case "update":
      if (!str(r.file, 4096) || !str(r.signature, 4096) || !str(r.id, 200)) return { ok: false, error: "bad request" };
      try {
        await d.update(r.file as string, r.signature as string, r.id as string, uid);
      } catch (e) {
        return { ok: false, error: errText(e) };
      }
      return { ok: true };
  }
  return { ok: false, error: "unknown request" };
}

// --- the daemon's side ---------------------------------------------------------------

// detached a host command as root in its own session, out of reach of the
// daemon's restart; its log in state/log/<cmd>.log
async function detached(args: string[]): Promise<{ code: number; output: string }> {
  mkdirSync(at("state", "log"), { recursive: true });
  const log = at("state", "log", args[0] + ".log");
  const fd = openSync(log, "w", 0o644);
  let code = -1;
  try {
    const p = Bun.spawn([...selfArgv(), ...args, "--home", home], {
      env: { ...process.env, PHOSPHORUS_DETACHED: "1" },
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
      detached: true,
    });
    code = await p.exited;
  } catch (e) {
    return { code: -1, output: errText(e) };
  } finally {
    closeSync(fd);
  }
  let out = "";
  try {
    out = readFileSync(log, "utf8");
  } catch {}
  return { code, output: out };
}

// daemonDeps the requests as run serves them, running its round's word
export function daemonDeps(running: () => boolean): Deps {
  return {
    status: async () => ({ running: running(), vpn: meshUp() }),
    keys() {
      envfile.ensure(envPath());
      const have = envfile.read(envPath());
      return { keys: keySet(have), domain: have.BASE_DOMAIN ?? "" };
    },
    setKeys(text) {
      envfile.ensure(envPath());
      envfile.set(envPath(), knownKeys(text));
      envfile.lock(envPath());
    },
    command: detached,
    takeRequest() {
      const req = at("state", "update-request.json");
      let raw: string;
      try {
        raw = readFileSync(req, "utf8");
      } catch {
        return undefined;
      }
      rmSync(req, { force: true });
      try {
        return String(JSON.parse(raw)?.id ?? "");
      } catch {
        return "";
      }
    },
    report: (id, state, current, version, error) => agentReport(id)(state, current, version, error),
    async update(file, signature, id, uid) {
      const s = await stageUpdate(file, signature, uid, releaseKey());
      agentReport(id)("running", false, s.version, "");
      say(`update ${id}: ${s.version} checked and staged, installing`);
      // not waited on: its install restarts this daemon
      void detached(["upgrade", id]);
    },
  };
}

// --- the socket, over libSystem: Bun's own servers give no peer's uid --------------

const SOL_SOCKET = 0xffff,
  SO_SNDTIMEO = 0x1005,
  SO_RCVTIMEO = 0x1006,
  SO_NOSIGPIPE = 0x1022;

const symbols = {
  socket: { args: ["i32", "i32", "i32"], returns: "i32" },
  bind: { args: ["i32", "ptr", "u32"], returns: "i32" },
  listen: { args: ["i32", "i32"], returns: "i32" },
  accept: { args: ["i32", "ptr", "ptr"], returns: "i32" },
  getpeereid: { args: ["i32", "ptr", "ptr"], returns: "i32" },
  setsockopt: { args: ["i32", "i32", "i32", "ptr", "u32"], returns: "i32" },
  read: { args: ["i32", "ptr", "u64"], returns: "i64" },
  write: { args: ["i32", "ptr", "u64"], returns: "i64" },
  close: { args: ["i32"], returns: "i32" },
} as const;

// sockaddr_un as Darwin lays it out: its length, AF_UNIX, the NUL-ended path
export function sockaddr(path: string): Buffer {
  const p = Buffer.from(path);
  if (p.length > 103) throw new Error("socket path too long");
  const b = Buffer.alloc(106);
  b[0] = p.length + 3;
  b[1] = 1;
  p.copy(b, 2);
  return b;
}

// blocks in accept, the peer's uid checked before a byte is read: others refused
// at once, the owner's one line read (5s at most) and handed to the main thread
const SERVER = `import { dlopen, ptr } from "bun:ffi";
const c = dlopen("libSystem.B.dylib", ${JSON.stringify(symbols)}).symbols;
const refused = Buffer.from(JSON.stringify({ ok: false, error: "not allowed: only the user who set phosphorus up" }) + "\\n");
self.onmessage = (e) => {
  const { fd: lfd, sab, max } = e.data;
  const owner = new Int32Array(sab);
  const uid = new Uint32Array(1), gid = new Uint32Array(1), one = new Int32Array([1]);
  const tv = new BigInt64Array([5n, 0n]);
  const buf = new Uint8Array(max);
  for (;;) {
    const fd = c.accept(lfd, null, null);
    if (fd < 0) continue;
    c.setsockopt(fd, ${SOL_SOCKET}, ${SO_NOSIGPIPE}, one, 4);
    c.setsockopt(fd, ${SOL_SOCKET}, ${SO_RCVTIMEO}, tv, 16);
    c.setsockopt(fd, ${SOL_SOCKET}, ${SO_SNDTIMEO}, tv, 16);
    if (c.getpeereid(fd, uid, gid) !== 0) { c.close(fd); continue; }
    const u = uid[0], o = Atomics.load(owner, 0);
    if (u !== 0 && (o <= 0 || u !== o)) { c.write(fd, refused, refused.length); c.close(fd); continue; }
    let n = 0;
    while (n < max) {
      const r = Number(c.read(fd, ptr(buf, n), max - n));
      if (r <= 0) break;
      n += r;
      if (buf.subarray(n - r, n).includes(10)) break;
    }
    postMessage({ fd, uid: u, line: new TextDecoder().decode(buf.subarray(0, n)) });
  }
};`;

// serveControl the socket at sockPath, read and written by all, answered for
// root and the owner alone; its close
export function serveControl(d: Deps): () => void {
  if (process.platform !== "darwin") return () => {};
  const c = dlopen("libSystem.B.dylib", symbols).symbols;
  rmSync(sockPath, { force: true });
  const lfd = c.socket(1 /* AF_UNIX */, 1 /* SOCK_STREAM */, 0);
  const addr = sockaddr(sockPath);
  if (lfd < 0 || c.bind(lfd, addr, addr[0]!) !== 0 || c.listen(lfd, 16) !== 0) {
    if (lfd >= 0) c.close(lfd);
    say(`couldn't serve ${sockPath}: the tray can't reach this daemon`);
    return () => {};
  }
  chmodSync(sockPath, 0o666);
  const owner = new Int32Array(new SharedArrayBuffer(4));
  const noteOwner = () => Atomics.store(owner, 0, ownerUid() ?? -1);
  noteOwner();
  const w = new Worker(URL.createObjectURL(new Blob([SERVER], { type: "application/javascript" })));
  w.onmessage = async (e: MessageEvent<{ fd: number; uid: number; line: string }>) => {
    const { fd, uid, line } = e.data;
    let reply: Reply;
    try {
      reply = await respond(line, uid, ownerUid(), d);
    } catch (err) {
      reply = { ok: false, error: errText(err) };
    }
    const b = Buffer.from(JSON.stringify(reply) + "\n");
    for (let off = 0; off < b.length; ) {
      const n = Number(c.write(fd, ptr(b, off), b.length - off));
      if (n <= 0) break;
      off += n;
    }
    c.close(fd);
  };
  w.postMessage({ fd: lfd, sab: owner.buffer, max: maxLine });
  // an owner set after start taken up by the worker
  const t = setInterval(noteOwner, 5000);
  return () => {
    clearInterval(t);
    w.terminate();
    c.close(lfd);
    rmSync(sockPath, { force: true });
  };
}
