// the mesh tools' host operations: logs, config, page actions and a request
// to a published service, here or on a peer through /internal paths
import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { configText, editIni, editService } from "@phosphorus/cli";
import { jsNumber } from "@phosphorus/files";
import * as mesh from "@phosphorus/mesh";
import { health } from "@phosphorus/services";
import { SealGrant } from "@phosphorus/users";
import { errText, FrontendPort, peerCall, RepoDir, requestJSON, run, sleep, tailnetIP } from "@phosphorus/util";
import { clients } from "./chat.ts";
import { uiFor } from "./chatws.ts";
import { gameKeyDir, selfHost } from "./config.ts";
import type { Res } from "./http.ts";
import { decode, jsString, obj, str, truthy, utf8 } from "./js.ts";
import { gameUserRe } from "./server.ts";
import { filesInfo } from "./shares.ts";

const logLinesMax = 2000;
const logOutMax = 256 << 10;

// logLevel the words a level's lines hold, worst first
const logLevel: Record<string, RegExp> = {
  error: /\b(error|err|fail(ed|ure)?|fatal|panic|refused|denied)\b/i,
  warn: /\b(error|err|fail(ed|ure)?|fatal|panic|refused|denied|warn(ing)?|retry(ing)?|timeout|timed out)\b/i,
};

const pad = (n: number) => String(n).padStart(2, "0");
// Go's "2006-01-02 15:04:05", local
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const isoRe = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

// an RFC3339 stamp, the offset with or without its colon
function isoTime(v: string): Date | undefined {
  const m = isoRe.exec(v);
  if (!m) return;
  const [, y, mo, d, h, mi, s, frac, z] = m;
  const ms = frac ? Math.round(Number(frac) * 1000) : 0;
  let t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
  if (z !== "Z") {
    const sign = z![0] === "-" ? -1 : 1;
    const off = z!.slice(1).replace(":", "");
    t -= sign * (Number(off.slice(0, 2)) * 60 + Number(off.slice(2))) * 60000;
  }
  const out = new Date(t);
  return Number.isNaN(out.getTime()) ? undefined : out;
}

const local = (y: string, mo: string, d: string, h = "0", mi = "0", s = "0") => {
  const out = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  // a date that rolled over, as 2026-02-31, isn't one
  return out.getDate() === Number(d) ? out : undefined;
};

// logTime a since or until: RFC3339, a date, or an age like 30m, 2h, 1d;
// undefined for none, throwing on a bad one
export function logTime(v: string): Date | undefined {
  v = v.trim();
  if (!v) return;
  const age = /^(-?\d+)([smhd])$/.exec(v);
  if (age) {
    const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[age[2]!]!;
    return new Date(Date.now() - Number(age[1]) * unit);
  }
  const iso = isoTime(v);
  if (iso) return iso;
  let m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(v);
  if (m) {
    const t = local(m[1]!, m[2]!, m[3]!, m[4], m[5], m[6]);
    if (t) return t;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (m) {
    const t = local(m[1]!, m[2]!, m[3]!, m[4], m[5]);
    if (t) return t;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) {
    const t = local(m[1]!, m[2]!, m[3]!);
    if (t) return t;
  }
  throw new Error("since/until: RFC3339, a date, or an age like 30m, 2h, 1d");
}

// lineTime a log line's own leading timestamp, journal's iso or Go's log
// a line's time at its start, or after a third party's [tag]
const lineTimeRe = /^(?:\[[^\]]*\] )?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^ ]*|\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})/;

export function lineTime(l: string): Date | undefined {
  const sm = lineTimeRe.exec(l);
  if (!sm) return;
  const m = sm[1]!;
  const iso = isoTime(m);
  if (iso) return iso;
  const g = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(m);
  if (g) return local(g[1]!, g[2]!, g[3]!, g[4], g[5], g[6]);
  return;
}

// hostLogs this host's logs, their last lines filtered: source phosphorus (all
// of it), frontend, cloudflared, git, model or another role's tag, game:<name>
// for a game's start/stop output; match, level, since, until
export async function hostLogs(p: Record<string, any>): Promise<Res> {
  let lines = Math.trunc(jsNumber(p.lines)) || 0;
  if (lines < 1) lines = 200;
  if (lines > logLinesMax) lines = logLinesMax;
  const match = str(p.match), level = str(p.level).toLowerCase();
  let source = str(p.source).toLowerCase() || "phosphorus";
  if (level !== "" && !logLevel[level]) return [400, { error: "level is error or warn" }];
  let since: Date | undefined, until: Date | undefined;
  try {
    since = logTime(str(p.since));
    until = logTime(str(p.until));
  } catch (e) {
    return [400, { error: errText(e) }];
  }
  const filtered = match !== "" || level !== "" || source !== "phosphorus";
  const n = filtered ? logLinesMax * 10 : lines;
  let all: string[];
  let from = "";
  if (source.startsWith("game:")) {
    const name = source.slice(5);
    if (!gameUserRe.test(name) || name.includes("..")) return [400, { error: "bad game name" }];
    const got = await tailFile(join(gameKeyDir, name + ".log"));
    if (!got) return [404, { error: "no output from " + name + " yet" }];
    all = got;
    from = "game";
  } else {
    [all, from] = await phosphorusLog(n, since, until);
    if (source !== "phosphorus") {
      const tag = "[" + source;
      all = all.filter((l) => l.includes(tag));
    }
  }
  const m = match.toLowerCase();
  const kept: string[] = [];
  // an untimed line, a trace or a child's own print, as old as the last timed one;
  // none timed yet and a window asked, left out
  let at = 0;
  let timed = false;
  for (const l of all) {
    const t = lineTime(l);
    if (t) {
      at = t.getTime();
      timed = true;
    }
    if ((since || until) && (!timed || (since && at < since.getTime()) || (until && at > until.getTime()))) continue;
    if (m !== "" && !l.toLowerCase().includes(m)) continue;
    if (level !== "" && !logLevel[level]!.test(l)) continue;
    kept.push(l);
  }
  all = kept;
  if (all.length > lines) all = all.slice(-lines);
  let text = all.join("\n");
  if (Buffer.byteLength(text) > logOutMax) text = Buffer.from(text).subarray(-logOutMax).toString("utf8");
  return [200, { host: selfHost, source, from, lines: all.length, text }];
}

function splitLines(s: string): string[] {
  s = s.replace(/\n+$/, "");
  return s === "" ? [] : s.split("\n");
}

// phosphorusLog systemd's journal on Linux, state/phosphorus.log where it's
// empty or unreadable, and elsewhere
async function phosphorusLog(n: number, since: Date | undefined, until: Date | undefined): Promise<[string[], string]> {
  const logFile = join(RepoDir, "state", "phosphorus.log");
  if (process.platform === "linux") {
    const args = ["journalctl", "-u", "phosphorus", "-n", String(n), "--no-pager", "-o", "short-iso", "-q"];
    if (since) args.push("--since", stamp(since));
    if (until) args.push("--until", stamp(until));
    const r = await run(args, { timeoutMs: 15000 });
    const ls = splitLines(r.stdout).filter((l) => !l.startsWith("-- "));
    if (ls.length > 0 || (!since && !until && !existsSync(logFile))) return [ls, "journal"];
  }
  return [(await tailFile(logFile)) ?? [], "file"];
}

// tailFile a log's last 8MB as lines, undefined when it can't be read
export async function tailFile(p: string): Promise<string[] | undefined> {
  let f;
  try {
    f = await open(p, "r");
  } catch {
    return;
  }
  try {
    const size = (await f.stat()).size;
    // the tail alone, a long log never read whole
    const max = 8 << 20;
    const start = size > max ? size - max : 0;
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await f.read(buf, got, buf.length - got, start + got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    const text = buf.subarray(0, got).toString("utf8");
    if (!text) return [];
    const ls = text.split("\n");
    if (ls[ls.length - 1] === "") ls.pop();
    return ls.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  } catch {
    return;
  } finally {
    await f.close();
  }
}

// onHost a call run here when host is this one, else on the peer's /internal path
export async function onHost(host: string, path: string, body: Record<string, any>, waitMs: number): Promise<Res | undefined> {
  if (host === selfHost) return;
  const ip = await tailnetIP(host);
  if (!ip) return [502, { error: `can't find ${host} on the tailnet` }];
  return peerCall(host, { host: ip, method: "POST", path, body, timeoutMs: waitMs });
}

// configOp this host's config: get both files, or set one service or ini key,
// dry returning the diff alone; a service's outcome waited on once written
export async function configOp(p: Record<string, any>): Promise<Res> {
  let why = "", diff = "";
  const dry = truthy(p.dry_run);
  switch (str(p.op)) {
    case "get": {
      const [ini, svc] = configText();
      return [200, { host: selfHost, "phosphorus.ini": ini, "services.export": svc, shares: filesInfo().shares }];
    }
    case "service": {
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj(p.fields) ?? {})) fields[k] = jsString(v);
      [why, diff] = editService(str(p.name), fields, truthy(p.remove), dry);
      break;
    }
    case "ini":
      [why, diff] = editIni(str(p.section), str(p.key), str(p.value), dry);
      break;
    default:
      return [400, { error: "op is get, service or ini" }];
  }
  if (why) return [400, { error: why }];
  const out: Record<string, any> = { ok: true, host: selfHost, diff };
  if (dry) {
    out.dry_run = true;
    out.note = "nothing written";
  } else if (diff === "") out.note = "already so, nothing changed";
  else if (str(p.op) === "service" && !truthy(p.remove)) out.outcome = await serviceOutcome(str(p.name));
  else out.note = "saved, applied within seconds";
  return [200, out];
}

// serviceOutcome a just-written service waited on up to 12s: published, or why not
async function serviceOutcome(name: string): Promise<Record<string, any>> {
  const ip = (await tailnetIP(selfHost)) || "127.0.0.1";
  let h: Record<string, any> | undefined;
  const end = Date.now() + 12000;
  for (;;) {
    h = await health(name, ip);
    if (!h || h.published === true || Date.now() > end) break;
    await sleep(1000);
  }
  if (!h) return { published: false, why: "not declared, services.export rejected it" };
  if (h.published === true) for (const r of mesh.routes()) if (str(r.host) === selfHost && str(r.name) === name) h.route = r;
  return h;
}

// hostConfig configOp here or on host
export async function hostConfig(host: string, p: Record<string, any>): Promise<Res> {
  return (await onHost(host, "/internal/config", p, 15000)) ?? configOp(p);
}

// hostLogsOn hostLogs here or on host
export async function hostLogsOn(host: string, p: Record<string, any>): Promise<Res> {
  return (await onHost(host, "/internal/logs", p, 30000)) ?? hostLogs(p);
}

// the page actions a key may send: nothing that asks the person for anything
const keyUI = new Set(["agent", "notify", "code", "view", "terminal", "host"]);

// localUI an action to user's pages on this host, true when one took it
export function localUI(user: string, action: Record<string, any>): boolean {
  if (user === "" || !keyUI.has(str(action.kind))) return false;
  let ok = false;
  for (const c of [...clients]) if (c.name === user) ok = uiFor(c, action) || ok;
  return ok;
}

// userUI an action to user's pages on every host, sealed for each peer
export async function userUI(user: string, action: Record<string, any>): Promise<boolean> {
  if (!keyUI.has(str(action.kind))) return false;
  let ok = localUI(user, action);
  const grant = SealGrant({ u: user, a: action }, 30 * 1000);
  await Promise.all(
    Object.values(mesh.peerIPs()).map(async (ip) => {
      try {
        const res = await requestJSON({ host: ip, port: FrontendPort, method: "POST", path: "/internal/ui", body: { grant }, timeoutMs: 5000 });
        if (res.status === 200 && truthy(obj(res.body)?.ok)) ok = true;
      } catch {}
    }),
  );
  return ok;
}

// each peer's page actions in order, a slow or gone peer holding up only its own
const uiPeers = new Map<string, string[]>();
const uiPeerQueue = 256;

async function uiDrain(ip: string, q: string[]) {
  for (let g = q.shift(); g !== undefined; g = q.shift()) {
    try {
      await requestJSON({ host: ip, port: FrontendPort, method: "POST", path: "/internal/ui", body: { grant: g }, timeoutMs: 3000 });
    } catch {}
  }
  uiPeers.delete(ip);
}

// userUIAsync an action to user's pages here at once, to each peer's through its queue
export function userUIAsync(user: string, action: Record<string, any>) {
  if (!keyUI.has(str(action.kind))) return;
  localUI(user, action);
  const grant = SealGrant({ u: user, a: action }, 30 * 1000);
  for (const ip of Object.values(mesh.peerIPs())) {
    const q = uiPeers.get(ip);
    if (q) {
      if (q.length < uiPeerQueue) q.push(grant);
      continue;
    }
    const fresh = [grant];
    uiPeers.set(ip, fresh);
    void uiDrain(ip, fresh);
  }
}

const svcOutMax = 512 << 10;

// svcRequest one request to a published web service, straight to it, its body back as json or text
export async function svcRequest(host: string, name: string, method: string, path: string, headers: Record<string, string>, body: string): Promise<Res> {
  let r: Record<string, any> | undefined;
  for (const x of mesh.routes()) {
    if (str(x.name) === name && x.type !== "game" && (host === "" || str(x.host) === host) && (!r || x.master === true)) r = x;
  }
  if (!r) return [404, { error: `no web service ${name} on the mesh` }];
  const ip = (await tailnetIP(str(r.host))) || str(r.host);
  const scheme = str(r.scheme) === "https" ? "https" : "http";
  const bp = str(r.base_path).replace(/^\/+|\/+$/g, "");
  const base = bp ? "/" + bp : "";
  if (!path.startsWith("/")) path = "/" + path;
  const h = new Headers(headers);
  if (body !== "" && !h.has("content-type")) h.set("Content-Type", "application/json");
  let res: Response;
  try {
    res = await fetch(`${scheme}://${ip}:${jsString(r.port)}${base}${path}`, {
      method: (method || "GET").toUpperCase(), headers: h, body: body === "" ? undefined : body,
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    return [502, { error: errText(e) }];
  }
  let b: Uint8Array;
  try {
    b = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    return [502, { error: errText(e) }];
  }
  const ct = res.headers.get("content-type") ?? "";
  const out: Record<string, any> = { status: res.status, host: r.host, contentType: ct };
  if (b.length > svcOutMax) {
    b = b.subarray(0, svcOutMax);
    out.truncated = true;
  }
  const v = decode(b);
  if (v !== undefined && v !== null && ct.includes("json")) out.json = v;
  else if (!b.subarray(0, Math.min(b.length, 8000)).includes(0)) out.text = utf8(b);
  else out.bytes = b.length;
  return [200, out];
}
