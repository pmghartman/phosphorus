// the page's calls, each answering a status and a body; a session another
// user's is no session at all
import { randomBytes } from "node:crypto";
import { errText, now } from "@phosphorus/util";
import { all, dropRecord, load, of, record, Session, type SessionRecord } from "./claude.ts";
import { Claude, errB, harnessByID, harnessIDs, harnessOf, hostRe, Opencode, type Res } from "./harness.ts";
import { ocKick } from "./opencode.ts";
import { Anthropic, type Creds, Mesh, Perms, provider } from "./script.ts";
import { clip, orObj, str } from "./text.ts";

// liveMax processes running at once per user
const liveMax = 8;
const textMax = 256 * 1024;
const dirMax = 1024;
const titleMax = 200;

// CredsFn what a start on host needs, for model, from the logged in user;
// throws what keeps it from starting
export type CredsFn = (host: string, model: string) => Creds | Promise<Creds>;

const gone = errB("no such session");
const ok = () => ({});

// list the user's sessions, the latest active first
export function list(user: string): Res {
  load();
  const out: SessionRecord[] = [];
  for (const s of all.values()) if (s.rec.user === user && !s.deleted) out.push(s.rec);
  out.sort((a, b) => b.updated - a.updated);
  return [200, { sessions: out }];
}

// get one session's record
export function get(user: string, id: string): Res {
  const s = of(user, id);
  return s ? [200, s.rec] : [404, gone];
}

// owns whether id is the user's session
export const owns = (user: string, id: string) => !!of(user, id);

function liveCount(user: string): number {
  let n = 0;
  for (const s of all.values()) if (s.rec.user === user && (s.p || s.starting)) n++;
  return n;
}

function cleanText(v: unknown, n: number): string {
  const t = str(v);
  return Buffer.byteLength(t) > n ? "" : t;
}

const fields = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");

// create a session on host in dir, started and sent prompt
export async function create(user: string, p: Record<string, any>, creds: CredsFn): Promise<Res> {
  load();
  const host = str(p.host).trim();
  const dir = str(p.dir).trim();
  const model = str(p.model);
  let perm = str(p.perm);
  const harness = str(p.harness) || Claude;
  const prompt = cleanText(p.prompt, textMax);
  const h = harnessByID(harness);
  if (!h) return [400, errB("harness is one of " + harnessIDs().join(", "))];
  if (h.meshOnly && provider(model) !== "mesh")
    return [400, errB(h.label + " runs on the mesh's models: " + Mesh.join(", "))];
  if (!hostRe.test(host)) return [400, errB("pick a host")];
  if (!dir || dir.length > dirMax || /[\0\r\n]/.test(dir)) return [400, errB("pick a folder")];
  if (!provider(model)) return [400, errB("model is one of " + [...Mesh, ...Anthropic].join(", "))];
  if (!perm) perm = "default";
  if (!Perms.includes(perm)) return [400, errB("perm is one of " + Perms.join(", "))];
  if (liveCount(user) >= liveMax) return [429, errB("too many sessions running: stop one first")];
  let c: Creds;
  try {
    c = await creds(host, model);
  } catch (e) {
    return [400, errB(errText(e))];
  }
  const t = now();
  const rec = record({
    id: newID(),
    user,
    host,
    dir,
    model,
    perm,
    harness,
    status: "starting",
    created: t,
    updated: t,
  });
  const s = new Session(rec);
  try {
    s.begin(c);
  } catch (e) {
    return [400, errB(errText(e))];
  }
  all.set(rec.id, s);
  if (prompt.trim()) send_(s, prompt);
  return [200, s.rec];
}

export function newID(): string {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  return [...randomBytes(12)].map((b) => abc[b % abc.length]).join("");
}

// send_ a prompt logged, then written or queued for the process
function send_(s: Session, text: string) {
  if (!s.rec.title) s.rec.title = clip(fields(text), 80);
  s.emit({ kind: "user", text, at: now() }, true);
  if (harnessOf(s.rec) === Opencode) {
    // a run a prompt: queued, run once the one before is done
    s.queue.push(text);
    ocKick(s);
    s.status("");
    return;
  }
  if (s.alive() && !s.starting) s.prompt(text);
  else s.queue.push(text);
  s.status(s.rec.status !== "starting" ? "working" : "");
}

// send a prompt, the process resumed when it's gone
export async function send(user: string, id: string, p: Record<string, any>, creds: CredsFn): Promise<Res> {
  const s = of(user, id);
  if (!s) return [404, gone];
  const text = cleanText(p.text, textMax);
  if (!text.trim()) return [400, errB("text: what to send, up to 256KB")];
  const needs = !s.alive() && !s.starting && !s.next && (harnessOf(s.rec) !== Opencode || !s.oc);
  let c: Creds | undefined;
  if (needs) {
    if (liveCount(user) >= liveMax) return [429, errB("too many sessions running: stop one first")];
    try {
      c = await creds(s.rec.host, s.rec.model);
    } catch (e) {
      return [400, errB(errText(e))];
    }
  }
  if (c && !s.alive() && !s.starting) {
    try {
      s.begin(c);
    } catch (e) {
      return [400, errB(errText(e))];
    }
  }
  send_(s, text);
  return [200, ok()];
}

// stop the turn under way interrupted, queued prompts dropped
export function stop(user: string, id: string): Res {
  const s = of(user, id);
  if (!s) return [404, gone];
  s.queue = [];
  if (harnessOf(s.rec) === Opencode) {
    if (s.p) {
      s.stopping = true;
      s.p.kill();
    }
    return [200, ok()];
  }
  if (s.alive()) s.control("interrupt", { subtype: "interrupt" });
  return [200, ok()];
}

// setModel within a provider claude's own switch; across one refused, a new
// session's to make
export function setModel(user: string, id: string, p: Record<string, any>): Res {
  const s = of(user, id);
  if (!s) return [404, gone];
  const m = str(p.model);
  if (!provider(m)) return [400, errB("model is one of " + [...Mesh, ...Anthropic].join(", "))];
  if (m === s.rec.model) return [200, s.rec];
  if (s.starting) return [409, errB("still starting, switch once it's up")];
  if (provider(m) !== provider(s.rec.model)) return [409, errB("start a new session to change provider")];
  s.rec.model = m;
  if (s.alive() && harnessOf(s.rec) === Claude) s.control("model", { subtype: "set_model", model: m });
  s.status("");
  return [200, s.rec];
}

// setPerm the permission mode, claude's own switch while it runs
export function setPerm(user: string, id: string, p: Record<string, any>): Res {
  const s = of(user, id);
  if (!s) return [404, gone];
  const m = str(p.mode);
  if (!Perms.includes(m)) return [400, errB("mode is one of " + Perms.join(", "))];
  s.rec.perm = m;
  if (s.alive() && harnessOf(s.rec) === Claude)
    s.control("permission mode", { subtype: "set_permission_mode", mode: m });
  s.status("");
  return [200, s.rec];
}

// permAnswer claude's can_use_tool answer: the input as asked, always the
// rules claude suggested kept for the session
export function permAnswer(
  req: Record<string, any>,
  allow: boolean,
  always: boolean,
  msg: string,
): Record<string, any> {
  if (!allow)
    return { behavior: "deny", message: msg.trim() ? msg : "The user denied this. Ask them what to do instead." };
  const out: Record<string, any> = { behavior: "allow", updatedInput: orObj(req.input) };
  const sg = req.permission_suggestions;
  if (always && Array.isArray(sg) && sg.length) out.updatedPermissions = sg;
  return out;
}

// answer a pending permission ask
export function answer(user: string, id: string, p: Record<string, any>): Res {
  const s = of(user, id);
  if (!s) return [404, gone];
  const reqID = str(p.reqId);
  const allow = p.allow === true;
  const req = s.perms.get(reqID);
  if (!req) return [404, errB("no such permission waiting")];
  s.perms.delete(reqID);
  s.respond(reqID, true, permAnswer(req, allow, p.always === true, cleanText(p.message, 4096)));
  s.emit({ kind: "permission_done", reqId: reqID, allow }, true);
  return [200, ok()];
}

// rename the session's title
export function rename(user: string, id: string, p: Record<string, any>): Res {
  const s = of(user, id);
  if (!s) return [404, gone];
  const t = fields(str(p.title));
  if (!t) return [400, errB("title: a name")];
  s.rec.title = clip(t, titleMax);
  s.status("");
  return [200, s.rec];
}

// remove the process ended, its record and log gone; the files in dir untouched
export function remove(user: string, id: string): Res {
  const s = of(user, id);
  if (!s) return [404, gone];
  all.delete(id);
  s.deleted = true;
  s.queue = [];
  s.next = undefined;
  if (s.p) {
    s.stopping = true;
    s.p.kill();
  }
  for (const c of s.subs.keys()) c.close(4000);
  s.log.remove();
  dropRecord(id);
  return [200, ok()];
}
