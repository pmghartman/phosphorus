// the code service's sessions, a harness (claude, opencode) run over ssh on a
// mesh host as its user; its events logged as claude's stream-json, fanned
// out to the page's sockets, permission asks answered there
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { errText, marshal, now, obj, readJSON, StateDir } from "@phosphorus/util";
import { Claude, harnessOf, missing, Opencode } from "./harness.ts";
import { EvLog, writePrivate } from "./log.ts";
import { ocBegin, ocEvents, ocExited, type OcRun } from "./opencode.ts";
import { type Creds, envBlock, envLines, launchCommand, provider, randHex, setupScript } from "./script.ts";
import { spawn } from "./spawn.ts";
import type { Proc } from "./ssh.ts";
import { clip, lastLine, num, orObj, str } from "./text.ts";

// idleAfter a process waiting this long on a prompt let go, resumed on the next
const idleAfter = 30 * 60_000;
// queueHigh a replay waits while the socket holds this many frames
export const queueHigh = 256;
const outMax = 64 << 20;

export let runDir = join(StateDir, "claude-runs");
export const idRe = /^[a-z0-9]{12}$/;
export const all = new Map<string, Session>();
let loaded = false;

// setRunDir the records kept elsewhere, none loaded yet: the tests' temp dir
export function setRunDir(d: string) {
  runDir = d;
  all.clear();
  loaded = false;
}

// Usage summed from claude's result events
export type Usage = { in: number; out: number; costUSD: number };

// SessionRecord a session as the page sees it and as it's kept on disk
export type SessionRecord = {
  id: string;
  user: string;
  host: string;
  dir: string;
  title: string;
  model: string;
  perm: string;
  status: string;
  err: string;
  claudeSID: string;
  created: number;
  updated: number;
  usage: Usage;
  // harness what runs the session: claude, or opencode; absent for claude's from before
  harness?: string;
};

// record every field present, as Go's zero values read a file back
export function record(r: Partial<SessionRecord>): SessionRecord {
  const u = obj(r.usage) ?? {};
  const out: SessionRecord = { id: str(r.id), user: str(r.user), host: str(r.host), dir: str(r.dir), title: str(r.title), model: str(r.model),
    perm: str(r.perm), status: str(r.status), err: str(r.err), claudeSID: str(r.claudeSID), created: num(r.created), updated: num(r.updated),
    usage: { in: num(u.in), out: num(u.out), costUSD: num(u.costUSD) } };
  if (r.harness) out.harness = r.harness;
  return out;
}

// Conn a page's socket, as wsock's Conn
export type Conn = { text(s: string): boolean; open(): boolean; queued(): number; close(code?: number): void };

// Sub a socket joined, live messages held back while its replay goes out
export type Sub = { c: Conn; ready: boolean; backlog: string[]; seqs: number[] };

export const recFile = (id: string) => join(runDir, id + ".json");
export const logFile = (id: string) => join(runDir, id + ".jsonl");

export class Session {
  log: EvLog;
  p?: Proc;
  gen = 0;
  starting = false;
  stopping = false;
  deleted = false;
  // queue prompts waiting on the process
  queue: string[] = [];
  // next the creds of a start held until the dying process is gone
  next?: Creds;
  subs = new Map<Conn, Sub>();
  perms = new Map<string, Record<string, any>>();
  ctl = new Map<string, string>();
  idle?: ReturnType<typeof setTimeout>;
  // oc an opencode session's creds, each prompt its own run; run what the current one's said
  oc?: Creds;
  run: OcRun = { start: 0, steps: 0, in: 0, out: 0, cost: 0, err: "" };

  constructor(public rec: SessionRecord) {
    this.log = new EvLog(logFile(rec.id));
  }

  // save the record
  save() {
    if (this.deleted) return;
    try {
      writePrivate(recFile(this.rec.id), marshal(this.rec));
    } catch {}
  }

  // emit m to every socket, logged under a seq when keep, else seq 0
  emit(m: Record<string, any>, keep: boolean) {
    let b: string, seq = 0;
    if (keep) {
      b = this.log.add(m);
      seq = this.log.last();
    } else {
      m.seq = 0;
      b = marshal(m);
    }
    for (const x of this.subs.values()) {
      if (x.ready) x.c.text(b);
      else {
        x.backlog.push(b);
        x.seqs.push(seq);
      }
    }
  }

  // status the record's new status saved and sent
  status(st: string) {
    if (st) this.rec.status = st;
    this.rec.updated = now();
    this.save();
    this.emit({ kind: "status", record: this.rec }, false);
  }

  // fail the error logged and the session failed
  fail(err: string) {
    this.rec.err = err;
    this.emit({ kind: "error", text: err, at: now() }, true);
    this.status("failed");
  }

  // alive a process taking prompts
  alive() {
    return !!this.p && !this.stopping;
  }

  // begin a process started, resumed when claude's session is known; throws
  // what keeps it from starting
  begin(c: Creds) {
    if (this.starting || this.deleted) return;
    if (harnessOf(this.rec) === Opencode) return ocBegin(this, c);
    if (this.p) {
      // the old one still going: started once it's gone
      this.next = c;
      return;
    }
    const env = envLines(this.rec.model, c);
    const setup = setupScript(c.skill, c.base);
    const cmd = launchCommand(this.rec.dir, this.rec.model, this.rec.perm, this.rec.claudeSID);
    this.starting = true;
    this.rec.err = "";
    this.status("starting");
    void (async () => {
      let p: Proc;
      try {
        p = await spawn(this.rec.host, c, setup, cmd, envBlock(env));
      } catch (e) {
        this.starting = false;
        this.queue = [];
        this.fail(errText(e));
        return;
      }
      this.starting = false;
      if (this.deleted) return p.kill();
      this.p = p;
      this.stopping = false;
      const g = ++this.gen;
      void this.read(p, g);
      let st = "idle";
      for (const t of this.queue) {
        this.prompt(t);
        st = "working";
      }
      this.queue = [];
      this.status(st);
    })();
  }

  // write one stream-json message to claude
  write(v: unknown) {
    this.p?.in.write(marshal(v) + "\n");
  }

  // prompt a user message to claude
  prompt(text: string) {
    this.write(userMessage(text));
    clearTimeout(this.idle);
  }

  // control a request of claude's control protocol
  control(what: string, req: Record<string, any>) {
    const id = "phos-" + randHex(6);
    this.ctl.set(id, what);
    this.write({ type: "control_request", request_id: id, request: req });
  }

  // respond claude's own control request answered
  respond(id: string, ok: boolean, body: unknown) {
    const r = ok ? { subtype: "success", request_id: id, response: body } : { subtype: "error", request_id: id, error: body };
    this.write({ type: "control_response", response: r });
  }

  // read claude's stdout to its end, then its exit
  async read(p: Proc, g: number) {
    for await (const line of lines(p.out)) {
      let ev: Record<string, any> | undefined;
      try {
        ev = obj(JSON.parse(line));
      } catch {}
      if (!ev) {
        // a profile's chatter, kept with stderr for the error
        p.errs.write(new TextEncoder().encode(line + "\n"));
        continue;
      }
      if (g !== this.gen) continue;
      if (harnessOf(this.rec) === Opencode) for (const e of ocEvents(this, ev)) this.on(e);
      else this.on(ev);
    }
    const code = await p.wait();
    this.exited(g, code, p.errs.toString());
  }

  // on one claude event
  on(ev: Record<string, any>) {
    const typ = str(ev.type);
    switch (typ) {
      case "keep_alive":
        return;
      case "control_request": {
        const id = str(ev.request_id);
        const req = orObj(ev.request);
        if (str(req.subtype) !== "can_use_tool") return this.respond(id, false, "phosphorus doesn't handle " + str(req.subtype));
        this.perms.set(id, req);
        this.emit({ kind: "permission", reqId: id, tool: str(req.tool_name), input: orObj(req.input),
          reason: str(req.decision_reason), toolUseId: str(req.tool_use_id), at: now() }, true);
        return;
      }
      case "control_cancel_request": {
        const id = str(ev.request_id);
        if (this.perms.delete(id)) this.emit({ kind: "permission_done", reqId: id, allow: false, cancelled: true }, true);
        return;
      }
      case "control_response": {
        const r = orObj(ev.response);
        const id = str(r.request_id);
        const what = this.ctl.get(id) ?? "";
        this.ctl.delete(id);
        if (str(r.subtype) === "error" && what) this.emit({ kind: "error", text: what + ": " + str(r.error), at: now() }, true);
        return;
      }
      case "stream_event":
        this.emit({ kind: "claude", ev }, false);
        if (this.rec.status !== "working") this.status("working");
        return;
    }
    const sid = str(ev.session_id);
    if (sid && sid !== this.rec.claudeSID) {
      this.rec.claudeSID = sid;
      this.save();
    }
    this.emit({ kind: "claude", ev }, true);
    switch (typ) {
      case "result": {
        const u = orObj(ev.usage);
        this.rec.usage.in += Math.trunc(num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens));
        this.rec.usage.out += Math.trunc(num(u.output_tokens));
        if (provider(this.rec.model) === "anthropic") this.rec.usage.costUSD += num(ev.total_cost_usd);
        this.rec.err = "";
        if (ev.is_error === true) this.rec.err = clip(str(ev.result), 500);
        this.status("idle");
        this.armIdle();
        break;
      }
      case "assistant":
      case "user":
        if (this.rec.status !== "working") this.status("working");
    }
  }

  // armIdle the process let go once idle long enough
  armIdle() {
    clearTimeout(this.idle);
    const g = this.gen;
    this.idle = setTimeout(() => {
      if (g === this.gen && this.rec.status === "idle" && this.p && this.perms.size === 0) {
        this.stopping = true;
        this.p.kill();
      }
    }, idleAfter);
    this.idle.unref?.();
  }

  // exited the process gone: its asks void, the session ended or failed
  exited(g: number, code: number, errs: string) {
    if (harnessOf(this.rec) === Opencode) return ocExited(this, g, code, errs);
    if (g !== this.gen) return;
    this.p = undefined;
    this.gen++;
    clearTimeout(this.idle);
    for (const id of this.perms.keys()) this.emit({ kind: "permission_done", reqId: id, allow: false, cancelled: true }, true);
    this.perms = new Map();
    this.ctl = new Map();
    const stopping = this.stopping;
    this.stopping = false;
    if (this.deleted) return;
    if (stopping || code === 0) this.status("ended");
    else if (code === 127) this.fail(missing(Claude, this.rec.host));
    else if (code === 3) this.fail(`no folder ${this.rec.dir} on ${this.rec.host}`);
    else this.fail(lastLine(errs) || `claude exited with ${code}`);
    const n = this.next;
    if (n) {
      this.next = undefined;
      try {
        this.begin(n);
      } catch (e) {
        this.fail(errText(e));
      }
    }
  }
}

export const userMessage = (text: string) => ({ type: "user", parent_tool_use_id: null, session_id: "",
  message: { role: "user", content: [{ type: "text", text }] } });

// lines of a byte stream, a \r before the \n dropped, the read over at one
// past outMax
export async function* lines(out: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): AsyncGenerator<string> {
  let buf: Uint8Array = new Uint8Array();
  for await (const chunk of out) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let i;
    while ((i = buf.indexOf(10)) >= 0) {
      const end = i > 0 && buf[i - 1] === 13 ? i - 1 : i;
      yield Buffer.from(buf.subarray(0, end)).toString();
      buf = buf.subarray(i + 1);
    }
    if (buf.length > outMax) return;
  }
  if (buf.length) yield Buffer.from(buf).toString();
}

// load the records kept here, none running after a restart
export function load() {
  if (loaded) return;
  loaded = true;
  let ents: string[] = [];
  try {
    ents = readdirSync(runDir);
  } catch {}
  for (const name of ents) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!idRe.test(id)) continue;
    const raw = obj(readJSON(recFile(id)));
    if (!raw || raw.id !== id) continue;
    const rec = record(raw);
    if (["starting", "working", "idle"].includes(rec.status)) rec.status = "ended";
    all.set(id, new Session(rec));
  }
}

// of the user's session id, undefined for none or another's
export function of(user: string, id: string): Session | undefined {
  load();
  if (!idRe.test(id)) return undefined;
  const s = all.get(id);
  return s && s.rec.user === user ? s : undefined;
}

// dropRecord the record file gone
export function dropRecord(id: string) {
  try {
    unlinkSync(recFile(id));
  } catch {}
}
