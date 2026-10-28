// this host's own services, services.export validated whole or not at all,
// health checked, live ones, games and git published
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { IdleMS, markHot } from "@phosphorus/util";
import { ExtraKeys, rowError, type Row } from "@phosphorus/proxy";
import { env, errText, Notes, now, readJSONMap, RepoDir, StateDir, writeFileAtomic } from "@phosphorus/util";
import { listening } from "./listen.ts";

export type { Row };
export { listening, portsOf } from "./listen.ts";

const servicesFile = env("SERVICES_FILE", join(RepoDir, "config", "services.export"));
const gitRoleFile = join(StateDir, "git-role");
const notes = new Notes("services");
const keys = new Set(["port", "scheme", "mode", "base_path", "extras", "type", "start", "stop", "public"]);
const headRe = /^\[\s*(.*?)\s*\]$/;
const commentRe = /^[#;]/;
const digitsRe = /^[0-9]+$/;
const quoteRe = /^"|"$/g;

const probeTimeout = 1000;
const gameConnectMS = 10000;
const gameActionMS: Record<string, number> = { start: 180000, stop: 60000 };

type Section = { name: string; f: Map<string, string> };

// every section as a declared row, or the first reason to reject
export function parse(text: string): [Row[], string] {
  const sections: Section[] = [];
  let cur: Section | undefined;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "").trim();
    if (!line || commentRe.test(line)) continue;
    const m = headRe.exec(line);
    if (m) {
      sections.push((cur = { name: m[1]!, f: new Map() }));
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) return [[], `line ${i + 1} is not key = value`];
    const key = line.slice(0, eq).trim();
    if (!cur) return [[], `line ${i + 1}: ${key} outside any [section]`];
    if (!keys.has(key)) return [[], `[${cur.name}] has an unknown key, ${key}`];
    cur.f.set(key, line.slice(eq + 1).trim().replace(quoteRe, ""));
  }
  const rows: Row[] = [];
  const names = new Set<string>();
  for (const s of sections) {
    if (names.has(s.name)) return [[], `[${s.name}] is declared twice`];
    names.add(s.name);
    let port: unknown = s.f.has("port") ? s.f.get("port") : undefined;
    if (digitsRe.test(s.f.get("port") ?? "")) port = Number(s.f.get("port"));
    let row: Row;
    if (s.f.get("type") === "game") {
      row = { name: s.name, port, type: "game", mode: "game", controllable: !!s.f.get("start") && !!s.f.get("stop") };
    } else {
      let extras: unknown;
      try {
        extras = JSON.parse(s.f.get("extras") || "{}");
      } catch {
        return [[], `[${s.name}] extras is not valid JSON`];
      }
      if (!extras || typeof extras !== "object" || Array.isArray(extras)) return [[], `[${s.name}] extras is not a JSON object`];
      for (const k of Object.keys(extras)) if (!ExtraKeys.includes(k)) return [[], `[${s.name}] extras has an unknown key, ${k}`];
      row = { ...(extras as Row), name: s.name, port, scheme: s.f.get("scheme") || "http", mode: s.f.get("mode") || "path", base_path: s.f.get("base_path") ?? "" };
      if (s.f.get("type")) row.type = s.f.get("type");
      if (s.f.has("public")) {
        const p = s.f.get("public")!;
        row.public = p === "true" || p === "false" ? p === "true" : p;
      }
    }
    if (port === undefined) delete row.port;
    const why = rowError(row);
    if (why) return [[], `[${s.name}] ${why}`];
    rows.push(row);
  }
  return [rows, ""];
}

let text: string | undefined;
let declared: Row[] = [];

function readDeclared() {
  let t: string;
  try {
    t = readFileSync(servicesFile, "utf8");
  } catch {
    notes.note("file", `can't read ${servicesFile}; publishing nothing`);
    text = undefined;
    declared = [];
    return;
  }
  notes.clear("file");
  if (text === t) return;
  text = t;
  const [rows, why] = parse(t);
  if (why) {
    notes.note("parse", `${servicesFile} rejected, still publishing the last good one: ${why}`);
    return;
  }
  notes.note("parse", `${servicesFile} read: ${rows.length} declared`);
  declared = rows;
  notes.reset("svc:");
}

// --- health ----------------------------------------------------------------

type Probe = { at: number; up?: boolean; busy: boolean; seen: boolean };

const probes = new Map<string, Probe>();

// a check's last answer, re-run in the background every everyMS; undefined
// until the first one lands
function probe(key: string, everyMS: number, check: () => Promise<boolean>): boolean | undefined {
  let p = probes.get(key);
  if (!p) probes.set(key, (p = { at: 0, busy: false, seen: true }));
  p.seen = true;
  if (!p.busy && now() - p.at >= everyMS) {
    p.busy = true;
    p.at = now();
    check().then((up) => {
      const changed = p.up !== up;
      p.up = up;
      p.busy = false;
      if (changed) markHot();
    });
  }
  return p.up;
}

const hostPort = (host: string, port: number) => `${host.includes(":") ? `[${host}]` : host}:${port}`;

// one GET, any answer counting, redirects not followed, certificates not
// checked, no proxy from the environment
function probeGet(scheme: string, host: string, port: number, base: string): Promise<Response> {
  return fetch(`${scheme}://${hostPort(host, port)}/${base}`, {
    proxy: false,
    redirect: "manual",
    tls: { rejectUnauthorized: false },
    signal: AbortSignal.timeout(probeTimeout),
  } as RequestInit);
}

async function answers(scheme: string, host: string, port: number, base: string): Promise<boolean> {
  try {
    await (await probeGet(scheme, host, port, base)).body?.cancel();
    return true;
  } catch {
    return false;
  }
}

function connects(host: string, port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = connect({ host, port });
    s.setTimeout(probeTimeout);
    const end = (ok: boolean) => (s.destroy(), res(ok));
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
    s.once("timeout", () => end(false));
  });
}

// --- game presses ----------------------------------------------------------

type Press = { action: string; until: number };

const pending = new Map<string, Press>();

// starting/stopping until the port flips, "" clearing it
export function setPending(name: string, action: string) {
  if (action) pending.set(name, { action, until: now() + (gameActionMS[action] ?? 0) });
  else pending.delete(name);
  markHot();
}

function pendingFor(name: string): string {
  const p = pending.get(name);
  if (p && p.until > now()) return p.action;
  pending.delete(name);
  return "";
}

// --- rows ------------------------------------------------------------------

function gameRow(r: Row, ip: string, ports: Set<number> | undefined): Row {
  const port = r.port as number;
  let up = ports?.has(port) ?? false;
  if (!up) up = probe(`game:${ip}:${port}`, gameConnectMS, () => connects(ip, port)) === true;
  const name = r.name as string;
  const pr = pendingFor(name);
  const status = up && pr === "stop" ? "stopping" : up ? "online" : pr === "start" ? "starting" : "offline";
  notes.note("svc:" + name, `game ${name} on port ${port} is ${status}`);
  return { ...r, status };
}

function webRow(r: Row, ip: string): Row | undefined {
  const port = r.port as number;
  const scheme = typeof r.scheme === "string" ? r.scheme : "";
  const base = typeof r.base_path === "string" ? r.base_path : "";
  const up = probe(`web:${scheme}:${ip}:${port}:${base}`, IdleMS, () => answers(scheme, ip, port, base));
  if (up === undefined) return;
  const name = r.name as string;
  if (up) {
    notes.note("svc:" + name, `${name} is up on port ${port}, published`);
    return r;
  }
  notes.note("svc:" + name, `${name} is not answering on port ${port}, not published`);
  return;
}

function gitRow(ip: string): Row | undefined {
  const g = readJSONMap(gitRoleFile);
  if (!g || g.publish !== true) {
    notes.clear("git");
    return;
  }
  // a non-empty string, else any truthy value as JS strings it, else def
  const str = (k: string, def: string) => (typeof g[k] === "string" && g[k] ? g[k] : k in g && g[k] ? String(g[k]) : def);
  const row: Row = { name: g.name, port: g.port, scheme: str("scheme", "http"), mode: str("mode", "subdomain"), base_path: str("base_path", ""), master: g.master === true };
  const why = rowError(row);
  if (why) {
    notes.note("git", "ignoring git-role: " + why);
    return;
  }
  const port = row.port as number, scheme = row.scheme as string, base = row.base_path as string;
  const up = probe(`web:${scheme}:${ip}:${port}:${base}`, IdleMS, () => answers(scheme, ip, port, base));
  if (up === undefined) return;
  const name = String(row.name);
  if (up) {
    notes.note("git", `${name} is up on port ${port}, published (master=${row.master})`);
    return row;
  }
  notes.note("git", `git-role says publish, but ${name} is not answering on port ${port}, not published`);
  return;
}

let ownRows: Row[] = [];
let lastScan = 0;
let ports: Set<number> | undefined;

// once per tick at ip, the tailnet address peers route to
export async function refresh(ip: string): Promise<Row[]> {
  readDeclared();
  let pressing = false;
  for (const name of [...pending.keys()]) if (pendingFor(name)) pressing = true;
  const games = declared.some((r) => r.type === "game");
  const scan = games && (pressing || now() - lastScan >= IdleMS);
  if (pressing) markHot();
  if (scan) {
    lastScan = now();
    ports = await listening(ip);
  }
  for (const p of probes.values()) p.seen = false;
  const rows: Row[] = [];
  for (const r of declared) {
    const out = r.type === "game" ? gameRow(r, ip, ports) : webRow(r, ip);
    if (out) rows.push(out);
  }
  const g = gitRow(ip);
  if (g) rows.push(g);
  for (const [k, p] of probes) if (!p.seen && !p.busy) probes.delete(k);
  ownRows = rows;
  return rows;
}

// the last refresh's rows
export const own = () => ownRows;

// [name]'s public line set or dropped, the whole file validated first
export function setPublic(name: string, on: boolean): [number, any] {
  let lines: string[];
  try {
    lines = readFileSync(servicesFile, "utf8").split("\n");
  } catch {
    return [500, { error: "can't read services.export" }];
  }
  let start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const m = headRe.exec(lines[i]!.replace(/\r$/, "").trim());
    if (!m) continue;
    if (start >= 0) {
      end = i;
      break;
    }
    if (m[1] === name) start = i;
  }
  if (start < 0) return [404, { error: "this host declares no service called " + name }];
  const out = lines.slice(0, start + 1);
  let last = start;
  for (let i = start + 1; i < end; i++) {
    const line = lines[i]!.trim();
    const eq = line.indexOf("=");
    if (eq > 0 && !commentRe.test(line) && line.slice(0, eq).trim() === "public") continue;
    out.push(lines[i]!);
    if (line) last = out.length - 1;
  }
  if (on) out.splice(last + 1, 0, "public = true");
  out.push(...lines.slice(end));
  const text = out.join("\n");
  const [rows, why] = parse(text);
  if (why) return [400, { error: why }];
  for (const r of rows) if (r.name === name && r.type === "game") return [400, { error: "public is for web services only" }];
  try {
    writeFileAtomic(servicesFile, text);
  } catch (e) {
    return [500, { error: "can't write services.export: " + errText(e) }];
  }
  markHot();
  return [200, { public: on }];
}

// one declared service checked now: listening, its HTTP answer, and whether
// it's published, with why not; undefined when nothing declares name
export async function health(name: string, ip: string): Promise<Record<string, any> | undefined> {
  readDeclared();
  let r: Row | undefined;
  for (const x of declared) if (x.name === name) r = { ...x };
  const published = ownRows.some((x) => x.name === name);
  if (!r) return;
  const port = r.port as number;
  const out: Record<string, any> = { name, port, type: (typeof r.type === "string" && r.type) || "web", published, listening: (await connects(ip, port)) || (await connects("127.0.0.1", port)) };
  if (r.type === "game") {
    out.why = out.listening ? "up" : `nothing listening on :${port}, start it with game_power`;
    return out;
  }
  const scheme = (typeof r.scheme === "string" && r.scheme) || "http";
  const base = typeof r.base_path === "string" ? r.base_path : "";
  let res: Response;
  try {
    res = await probeGet(scheme, ip, port, base);
  } catch (e) {
    if (!out.listening) out.why = `not published: nothing on :${port}`;
    else {
      out.error = errText(e);
      out.why = `not published: :${port} takes connections but no ${scheme} answer (${out.error})`;
    }
    return out;
  }
  await res.body?.cancel();
  out.httpStatus = res.status;
  out.why = published ? "answering" : "answering, published on the next tick";
  return out;
}
