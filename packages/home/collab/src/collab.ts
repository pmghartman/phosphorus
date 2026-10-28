// one live session per open file: its text, the ops that made it, the tabs and
// agents on it; saved to disk soon after each change
import type { BigIntStats } from "node:fs";
import * as files from "@phosphorus/files";
import type { Res, Share, Who as FilesWho } from "@phosphorus/files";
import { Exists } from "@phosphorus/users";
import { sleep } from "@phosphorus/util";
import { type Conn, dial } from "@phosphorus/wsock";
import { diskMessage, diskStat, observeDisk, readDisk, resolveDisk, startDiskWatch } from "./disk.ts";
import { Apply, Builder, MapPos, type Op, Parse, Transform } from "./ot.ts";

export const maxText = files.MaxText;
export const history = 2000;
const idle = 60_000;
const hopTimeout = 5000;
const typeSteps = 24;
const typeWait = 40;
const agentStay = 10_000;
const autosave = 1500;
const autosaveMax = 10_000;

// every session's state is changed under one lock, as the file reads and
// writes between a message's steps let other events in
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  // held until the returned release runs
  lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const held = this.tail.then(() => release);
    this.tail = next;
    return held;
  }
  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = await this.lock();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export type Who = { name: string; color: string };

export class Client {
  ws?: Conn;
  cid = 0;
  who?: Who;
  pos = 0;
  agent = false;
  constructor(init: Partial<Client> = {}) {
    Object.assign(this, init);
  }
}

export const mu = new Mutex();
export const sessions = new Map<string, Session>();
let clientSeq = 0;
export const nextCID = () => ++clientSeq;

export const keyOf = (sh: Share, rel: string) => sh.id + "\n" + rel;

export function clip(s: string, n: number): string {
  const r = [...s];
  return r.length > n ? r.slice(0, n).join("") : s;
}

export function sendTo(c: Client, body: unknown) {
  if (c.ws?.open()) c.ws.json(body);
}

export const lf = (t: string) => t.replace(/\r\n?/g, "\n");

type Timer = ReturnType<typeof setTimeout>;

export class Session {
  text: string;
  eol: string;
  // the line ending changed since the last save: written though the text is the same
  eolPending = false;
  version = 0;
  saved: number;
  history: Op[][] = [];
  clients = new Set<Client>();
  order: Client[] = [];
  idle?: Timer;
  autosave?: Timer;
  dirtyAt = 0;
  diskInfo?: BigIntStats;
  diskText: string;
  diskPending = "";
  diskProblem = "";
  diskConflict = false;
  diskRevision = 0;
  diskCRLF = false;
  diskGeneration = 0;

  constructor(
    public key: string,
    public share: Share,
    public rel: string,
    text: string,
    saved: number,
  ) {
    this.eol = text.includes("\r\n") ? "\r\n" : "\n";
    this.text = lf(text);
    this.saved = saved;
    this.diskText = lf(text);
  }

  add(c: Client) {
    this.clients.add(c);
    this.order.push(c);
    startDiskWatch();
  }

  remove(c: Client) {
    this.clients.delete(c);
    const i = this.order.indexOf(c);
    if (i >= 0) this.order.splice(i, 1);
  }

  people(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const c of this.order) {
      if (!c.who) continue;
      const p: Record<string, unknown> = { id: c.cid, name: c.who.name, color: c.who.color, pos: c.pos };
      if (c.agent) p.agent = true;
      out.push(p);
    }
    return out;
  }

  toAll(body: unknown) {
    for (const c of this.order) sendTo(c, body);
  }

  onDisk(): string {
    return this.eol === "\r\n" ? this.text.replaceAll("\n", "\r\n") : this.text;
  }

  leave(c: Client) {
    this.remove(c);
    this.toAll({ type: "people", people: this.people() });
    if (this.clients.size === 0) {
      this.idle = setTimeout(() => {
        mu.run(async () => {
          if (this.clients.size > 0) return;
          // Retain drafts when an external edit needs review or saving fails.
          const [status] = await this.saveNow("");
          if (status !== 200) return;
          sessions.delete(this.key);
        });
      }, idle);
    }
  }

  saveNow(by: string): Promise<Res> {
    return this.saveDisk(by, false);
  }

  async saveDisk(by: string, reviewed: boolean): Promise<Res> {
    clearTimeout(this.autosave);
    this.dirtyAt = 0;
    if (this.saved === this.version && !reviewed && !this.diskConflict && !this.eolPending) return [200, { path: this.rel }];
    if (!files.can(this.share, "w")) return [403, { error: "this share is read-only" }];
    if (!reviewed) {
      const observed = await readDisk(this.share, this.rel);
      if (!observed.valid) {
        this.saveSoon();
        return [409, { error: "file is changing on disk; saving will retry" }];
      }
      observeDisk(this, observed);
      if (this.diskConflict) return [409, { error: "file changed outside the editor; review both versions before saving" }];
    }
    const [status, out] = await files.save(this.share, this.rel, { text: this.onDisk() });
    if (status !== 200) {
      const e = typeof out?.error === "string" && out.error ? out.error : `save failed (${status})`;
      this.toAll({ type: "error", error: e });
      return [status, out];
    }
    this.saved = this.version;
    this.eolPending = false;
    this.diskText = this.text;
    this.diskGeneration++;
    this.diskInfo = undefined; // verify the actual disk snapshot on the next metadata check
    this.diskConflict = false;
    this.diskProblem = "";
    this.diskPending = "";
    this.toAll({ type: "saved", v: this.version, by });
    return [status, out];
  }

  saveSoon() {
    if (!files.can(this.share, "w") || this.diskConflict) return;
    clearTimeout(this.autosave);
    if (!this.dirtyAt) this.dirtyAt = Date.now();
    const wait = Math.max(0, Math.min(autosave, this.dirtyAt + autosaveMax - Date.now()));
    this.autosave = setTimeout(() => void mu.run(() => this.saveNow("")), wait);
  }

  async onMessage(c: Client, msg: Record<string, any>) {
    const str = (v: unknown, def: string) => {
      if (typeof v === "string" && v !== "") return v;
      if (v !== undefined && v !== null && v !== false && v !== "") return String(v);
      return def;
    };
    const readOnly = () => {
      if (files.can(this.share, "w")) return false;
      sendTo(c, { type: "error", error: "this share is read-only" });
      return true;
    };
    switch (msg.type) {
      case "resolveDisk":
        await resolveDisk(this, c, msg);
        return;
      case "join":
        c.who = { name: clip(str(msg.name, "anon"), 32), color: clip(str(msg.color, ""), 16) };
        this.toAll({ type: "people", people: this.people() });
        return;
      case "cursor": {
        const p = typeof msg.pos === "number" ? Math.trunc(msg.pos) : 0;
        c.pos = Math.min(Math.max(p, 0), this.text.length);
        this.toAll({ type: "people", people: this.people() });
        return;
      }
      case "save":
        if (readOnly()) return;
        await this.saveNow(c.who?.name ?? "");
        return;
      case "eol": {
        // Change End of Line Sequence: the text stays LF here, the file written with the new one
        if (readOnly()) return;
        const v = str(msg.eol, "");
        const eol = v === "\r\n" || v === "CRLF" ? "\r\n" : "\n";
        if (this.eol === eol) return;
        this.eol = eol;
        this.eolPending = true;
        this.toAll({ type: "eol", eol });
        await this.saveNow(c.who?.name ?? "");
        return;
      }
      case "op":
        break;
      default:
        return;
    }
    if (readOnly()) return;
    const resync = () => sendTo(c, { type: "resync", text: this.text, v: this.version, saved: this.saved, id: msg.id ?? null });
    let basef = typeof msg.base === "number" ? msg.base : NaN;
    if (typeof msg.base === "string") basef = Number(msg.base) || 0;
    let ops = Parse(msg.ops);
    const base = Math.trunc(basef);
    const oldest = this.version - this.history.length;
    if (!ops || Number.isNaN(basef) || basef !== base || base > this.version || base < oldest) return resync();
    for (const h of this.history.slice(base - oldest)) {
      const t = Transform(ops, h);
      if (!t) return resync();
      ops = t[0];
    }
    const text = Apply(this.text, ops);
    if (text === undefined) return resync();
    if (text.length > maxText) {
      sendTo(c, { type: "error", error: "over 16MB, the edit was not kept" });
      return resync();
    }
    this.text = text;
    this.commit(ops, msg.id, c);
  }

  commit(ops: Op[], id: unknown, by: Client) {
    this.version++;
    this.history.push(ops);
    if (this.history.length > history) this.history.shift();
    for (const c of this.order) if (c !== by && c.pos !== 0) c.pos = MapPos(ops, c.pos);
    this.toAll({ type: "op", v: this.version, ops, id: id ?? null, by: by.who?.name ?? "", agent: by.agent, agentEdit: by.cid });
    if (by.agent) this.toAll({ type: "people", people: this.people() });
    this.saveSoon();
  }
}

async function open(sh: Share, rel: string): Promise<[number, Session | undefined, any]> {
  const key = keyOf(sh, rel);
  const held = sessions.get(key);
  if (held) {
    clearTimeout(held.idle);
    return [200, held, undefined];
  }
  const before = diskStat(sh, rel);
  const [status, f] = await files.read(sh, rel);
  if (status === 404) return [404, undefined, { error: "no such file: renamed, moved or deleted" }];
  if (status !== 200) return [status, undefined, f];
  if (f.binary === true) return [415, undefined, { error: "a binary file, not text" }];
  if (f.tooBig === true) return [413, undefined, { error: "over 16MB, too big to edit here" }];
  const s = newSession(key, sh, rel, f.text, 0);
  s.diskInfo = before;
  return [200, s, undefined];
}

export function newSession(key: string, sh: Share, rel: string, text: string, saved: number): Session {
  const s = new Session(key, sh, rel, text, saved);
  sessions.set(key, s);
  return s;
}

// WriteP an outside save: text, or old and new, by an agent
export type WriteP = { text?: string; old?: string; new?: string; byName?: string; byColor?: string };

// Write a save from outside the editor, typed into the live session when
// one is open, straight to disk otherwise
export async function Write(sh: Share, rel: string, p: WriteP): Promise<Res> {
  let release = await mu.lock();
  const s = sessions.get(keyOf(sh, rel));
  if (!s || s.clients.size === 0) {
    release();
    return files.save(sh, rel, { text: p.text, old: p.old, new: p.new });
  }
  if (!files.can(sh, "w")) {
    release();
    return [403, { error: "this share is read-only" }];
  }
  const cur = s.text;
  let target: string | undefined;
  if (p.text !== undefined) target = lf(p.text);
  if (p.old !== undefined && p.new !== undefined) {
    const old = lf(p.old);
    const at = old !== "" ? cur.indexOf(old) : -1;
    if (at < 0) {
      release();
      return [409, { error: "old text not found" }];
    }
    if (cur.slice(at + 1).includes(old)) {
      release();
      return [409, { error: "old text found more than once, give more of it" }];
    }
    target = cur.slice(0, at) + lf(p.new) + cur.slice(at + old.length);
  }
  if (target === undefined) {
    release();
    return [400, { error: "text, or old and new" }];
  }
  const tgt = target;
  if (tgt.length > maxText) {
    release();
    return [413, { error: "over 16MB" }];
  }
  const name = p.byName || "phosphorus";
  const agent = new Client({ agent: true, cid: nextCID(), who: { name: clip(name, 32), color: clip(p.byColor ?? "", 16) } });
  clearTimeout(s.idle);
  s.add(agent);
  let a = 0;
  while (a < s.text.length && a < tgt.length && s.text[a] === tgt[a]) a++;
  let e = 0;
  while (e < s.text.length - a && e < tgt.length - a && s.text[s.text.length - 1 - e] === tgt[tgt.length - 1 - e]) e++;
  const gone = s.text.length - a - e;
  const typed = tgt.slice(a, tgt.length - e);
  const put = (at: number, del: number, ins: string) => {
    const b = new Builder();
    b.retain(at);
    b.insert(ins);
    b.del(del);
    b.retain(s.text.length - at - del);
    const t = Apply(s.text, b.ops);
    if (t === undefined) return;
    s.text = t;
    agent.pos = at + ins.length;
    s.commit(b.ops, `agent-${Date.now()}`, agent);
  };
  agent.pos = a;
  s.toAll({ type: "people", people: s.people() });
  if (gone > 0) put(a, gone, "");
  release();
  const step = Math.max(1, Math.ceil(typed.length / typeSteps));
  for (let i = 0; i < typed.length; i += step) {
    await sleep(typeWait);
    const end = Math.min(i + step, typed.length);
    release = await mu.lock();
    put(Math.min(agent.pos, s.text.length), 0, typed.slice(i, end));
    release();
  }
  const [status, out] = await mu.run(() => s.saveNow(agent.who!.name));
  setTimeout(() => void mu.run(() => s.leave(agent)), agentStay);
  if (status === 200) return [status, { ...out, live: true, note: "typed into the open editor and saved" }];
  return [status, out];
}

// Attach a tab on this host's file, a home's through its gate
export async function Attach(ws: Conn, shareID: string, rel: string, w: FilesWho | undefined) {
  const fail = (e: string) => {
    ws.json({ type: "error", error: e });
    ws.close(1000);
  };
  const sh = files.shareOf(shareID);
  if (!files.enabled() || !sh) return fail("no such share here");
  if (!files.can(sh, "r")) return fail("this share is not readable");
  if (sh.id === "home") {
    const why = files.homeGate(w, rel, Exists);
    if (why !== "") return fail(why);
  }
  const release = await mu.lock();
  const [status, s, errBody] = await open(sh, rel);
  if (status !== 200 || !s) {
    release();
    const e = typeof errBody?.error === "string" && errBody.error ? errBody.error : `can't open it (${status})`;
    return fail(e);
  }
  const c = new Client({ ws, cid: nextCID() });
  s.add(c);
  sendTo(c, { type: "init", text: s.text, v: s.version, saved: s.saved, perms: sh.perms, people: s.people(), you: c.cid, eol: s.eol });
  if (s.diskConflict) sendTo(c, diskMessage(s));
  release();
  ws.onMessage((d, binary) => {
    let m: unknown;
    try {
      m = JSON.parse(binary ? new TextDecoder().decode(d as Uint8Array) : (d as string));
    } catch {
      return;
    }
    if (typeof m !== "object" || m === null || Array.isArray(m)) return;
    void mu.run(() => s.onMessage(c, m as Record<string, any>));
  });
  ws.onClose(() => void mu.run(() => s.leave(c)));
}

// Forward a tab whose file is on another host, the login cookie along
export function Forward(ws: Conn, lookup: () => string | Promise<string>, cookie: string) {
  let up: Conn | undefined;
  let early: (string | Uint8Array)[] | undefined = [];
  const relay = (to: Conn, d: string | Uint8Array) => (typeof d === "string" ? to.text(d) : to.binary(d));
  ws.onMessage((d) => {
    if (up?.open()) relay(up, d);
    else early?.push(d);
  });
  ws.onClose(() => up?.terminate());
  (async () => {
    const url = await lookup();
    if (!ws.open()) return;
    if (url === "") {
      ws.json({ type: "error", error: "can't find that host on the tailnet" });
      ws.close(1000);
      return;
    }
    let u: Conn;
    try {
      u = await dial(url, cookie ? { Cookie: cookie } : {}, hopTimeout);
    } catch (e: any) {
      ws.json({ type: "error", error: "that host didn't answer: " + (e?.message ?? String(e)) });
      ws.close(1000);
      return;
    }
    if (!ws.open()) return u.terminate();
    up = u;
    for (const d of early ?? []) relay(u, d);
    early = undefined;
    u.onMessage((d) => relay(ws, d));
    u.onClose(() => ws.close(1000));
  })();
}
