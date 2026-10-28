// what the tools share past one call: terminals opened and not yet logged in,
// the audit of every write a key made
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { marshal, obj, StateDir } from "@phosphorus/util";
import { clientOf } from "./calls.ts";
import { chatRows } from "./chat.ts";
import { type Caller, errc, type Meta, src, str } from "./common.ts";

const openedFor_ = 10 * 60_000;
const auditMax = 4 << 20;
const auditArgMax = 400;

const opened = new Map<string, number>();

// noteOpened a terminal opened on who's page for host, pending its login
export const noteOpened = (who: string, host: string) => void opened.set(who + "\0" + host, Date.now());

// openedFor whether a terminal for host was opened for who in the last ten minutes
export function openedFor(who: string, host: string): boolean {
  const at = opened.get(who + "\0" + host);
  return at !== undefined && Date.now() - at < openedFor_;
}

// viaOf the agent a keyed call came through: as it says, else the name its session
// opened with, else just agent
export function viaOf(m: Meta): string {
  if (!m.caller) return "";
  return m.caller.via || clientOf(m.caller.user) || "agent";
}

// channelKnown throws unless want is blank, mesh, a known person's dm or a channel with lines
export function channelKnown(m: Meta, want: string) {
  if (!want || want === "mesh") return;
  if (want.startsWith("dm:")) {
    const p = want.slice(3);
    if (src.known(p)) return;
    throw errc("not_found", `no one called ${p}`);
  }
  const seen = new Set(["mesh"]);
  for (const r of chatRows(m, "")) seen.add(str(r.channel));
  if (seen.has(want)) return;
  throw errc("not_found", `no channel ${want}; there are ${[...seen].join(", ")}, or dm:<name>`);
}

const auditFile = () => join(StateDir, "mcp-audit.jsonl");

// audit one write a key made, kept per host in state/mcp-audit.jsonl
export function audit(c: Caller, tool: string, args: Record<string, any>, err: Error | undefined) {
  const a: Record<string, any> = {};
  for (const [k, v] of Object.entries(args)) {
    const b = Buffer.from(marshal(v));
    a[k] = b.length > auditArgMax ? b.subarray(0, auditArgMax).toString("utf8") + "…" : v;
  }
  const row: Record<string, any> = {
    at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    user: c.user,
    via: viaOf({ caller: c, local: false }),
    tool,
    args: a,
    ok: !err,
    host: src.self().host,
  };
  if (err) row.error = err.message;
  const p = auditFile();
  try {
    // the older half dropped once it grows past its cap
    if (statSync(p).size > auditMax) {
      const b = readFileSync(p);
      writeFileSync(p, b.subarray(b.length >> 1), { mode: 0o600 });
    }
  } catch {}
  try {
    appendFileSync(p, marshal(row) + "\n", { mode: 0o600 });
  } catch {}
}

// auditRows this host's audit, newest last; user's own unless all
export function auditRows(user: string, all: boolean, limit: number): Record<string, any>[] {
  let text: string;
  try {
    text = readFileSync(auditFile(), "utf8");
  } catch {
    return [];
  }
  const out: Record<string, any>[] = [];
  for (const line of text.split("\n")) {
    let r: Record<string, any> | undefined;
    try {
      r = obj(JSON.parse(line));
    } catch {}
    if (!r || (!all && str(r.user) !== user)) continue;
    // a partial first line after a trim skipped
    if (r.tool === null || r.tool === undefined) continue;
    out.push(r);
  }
  return out.length > limit ? out.slice(out.length - limit) : out;
}
