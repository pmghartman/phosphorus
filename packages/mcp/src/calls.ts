// a keyed user's calls on this host, in flight and just done, for the agent tray
import { now, obj } from "@phosphorus/util";

const recentCalls = 40;

type LiveCall = { id: number; tool: string; detail: string; host: string; since: number };
type CallLog = { live: LiveCall[]; done: Record<string, any>[]; seen: number; at: number; client: string };

const by = new Map<string, CallLog>();
let next = 0;

// watchers wanting a nudge when a user's status moves
const watchers = new Map<string, Set<() => void>>();

// watch fn run on any change to a user's calls, and its stop
export function watch(user: string, fn: () => void): () => void {
  let s = watchers.get(user);
  if (!s) watchers.set(user, (s = new Set()));
  s.add(fn);
  return () => {
    s.delete(fn);
    if (!s.size) watchers.delete(user);
  };
}

function poke(user: string) {
  for (const fn of watchers.get(user) ?? []) fn();
}

function logOf(user: string): CallLog {
  let l = by.get(user);
  if (!l) by.set(user, (l = { live: [], done: [], seen: 0, at: 0, client: "" }));
  return l;
}

// markSeen any request on a user's key, its agent's connector saying it's there
export function markSeen(user: string) {
  logOf(user).seen = now();
  poke(user);
}

// noteClient the agent that last opened a session on a user's key, by the name it gives
export function noteClient(user: string, name: string) {
  logOf(user).client = name;
  poke(user);
}

// clientOf that agent's name as a word, claude-ai or Claude Code as claude; blank for none
export function clientOf(user: string): string {
  const w = (by.get(user)?.client ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return w[0] ?? "";
}

export function callBegin(user: string, tool: string, detail: string, host: string): number {
  const id = ++next;
  logOf(user).live.push({ id, tool, detail, host, since: now() });
  poke(user);
  return id;
}

export function callEnd(user: string, id: number, errText: string) {
  const l = logOf(user);
  const i = l.live.findIndex((c) => c.id === id);
  if (i < 0) return;
  const [c] = l.live.splice(i, 1);
  const at = now();
  l.done.unshift({ tool: c!.tool, detail: c!.detail, host: c!.host, at, ms: at - c!.since, ok: errText === "", error: errText });
  if (l.done.length > recentCalls) l.done.length = recentCalls;
  l.at = at;
  poke(user);
}

// calls a user's calls on this host: in flight, the recent newest first, when last seen
export function calls(user: string): Record<string, any> {
  const l = by.get(user);
  if (!l) return { calls: [], recent: [], seen: 0, at: 0, client: "", now: now() };
  const live = l.live.map((c) => ({ tool: c.tool, detail: c.detail, host: c.host, since: c.since }));
  return { calls: live, recent: [...l.done], seen: l.seen, at: l.at, client: l.client, now: now() };
}

// callHost the host a call acts on, a copy's source or destination when it names none
export function callHost(args: Record<string, any> | undefined): string {
  if (typeof args?.host === "string" && args.host) return args.host;
  for (const k of ["from", "to"]) {
    const h = obj(args?.[k])?.host;
    if (typeof h === "string" && h) return h;
  }
  return "";
}

const detailKeys = ["command", "script", "path", "file", "url", "query", "host", "name", "repo", "text"];

// callDetail a call's arguments in a line: the usual subject keys first, else the first string
export function callDetail(args: Record<string, any> | undefined): string {
  const a = args ?? {};
  let s = "";
  for (const k of detailKeys) {
    if (typeof a[k] === "string" && a[k]) {
      s = a[k];
      break;
    }
  }
  if (!s) {
    for (const k of Object.keys(a).sort()) {
      if (typeof a[k] === "string" && a[k]) {
        s = a[k];
        break;
      }
    }
  }
  const r = [...s.split(/\s+/).filter(Boolean).join(" ")];
  return r.length > 120 ? r.slice(0, 120).join("") + "…" : r.join("");
}
