// this host's own services, services.export validated whole or not at all,
// health checked, live ones, games and git published; a blank scheme sniffed,
// each a subdomain once *.<domain> answers; pages it doesn't name found and
// offered, a section taken out not offered for writing back
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { type Row, rowError } from "@phosphorus/proxy";
import {
  env,
  envInt,
  errText,
  FrontendPort,
  IdleMS,
  markHot,
  marshal,
  Notes,
  now,
  RepoDir,
  readJSONMap,
  StateDir,
  writeFileAtomic,
} from "@phosphorus/util";
import { listening } from "./listen.ts";
import { pollWildcard, wildcardUp } from "./wildcard.ts";

export { listening, portsOf } from "./listen.ts";
export { tunnelID, type Wildcard, wildcard, wildcardUp } from "./wildcard.ts";
export type { Row };

const servicesFile = env("SERVICES_FILE", join(RepoDir, "config", "services.export"));
const gitRoleFile = join(StateDir, "git-role");
// the ports of sections taken out of services.export, a found page there left alone
const removedFile = join(StateDir, "services-removed");
const notes = new Notes("services");
// a web service's port, scheme (blank: sniffed), max_body and public; a game's
// type, start and stop until the Games app takes them
export const Keys = ["port", "scheme", "max_body", "public", "type", "start", "stop"];
// older keys still read, dropped whenever the file is rewritten: mode is picked
// (a subdomain once *.<domain> answers, settled across hosts), base_path is gone,
// extras' max_body is a key of its own, forwarded_proto follows the ingress
const oldKeys = ["mode", "base_path", "extras"];
const extraKeys = ["flush_interval", "max_body", "forwarded_proto"];
const headRe = /^\[\s*(.*?)\s*\]$/;
const commentRe = /^[#;]/;
const digitsRe = /^[0-9]+$/;
const quoteRe = /^"|"$/g;

const probeTimeout = 1000;
const gameConnectMS = 10000;
const gameActionMS: Record<string, number> = { start: 180000, stop: 60000 };

type Section = { name: string; f: Map<string, string> };

// every section as a declared row, or the first reason to reject; old keys
// still read listed as "[name] key"
export function parse(text: string): [Row[], string, string[]] {
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
    if (eq < 0) return [[], `line ${i + 1} is not key = value`, []];
    const key = line.slice(0, eq).trim();
    if (!cur) return [[], `line ${i + 1}: ${key} outside any [section]`, []];
    if (!Keys.includes(key) && !oldKeys.includes(key)) return [[], `[${cur.name}] has an unknown key, ${key}`, []];
    cur.f.set(
      key,
      line
        .slice(eq + 1)
        .trim()
        .replace(quoteRe, ""),
    );
  }
  const rows: Row[] = [];
  const old: string[] = [];
  const names = new Set<string>();
  for (const s of sections) {
    const no = (why: string): [Row[], string, string[]] => [[], `[${s.name}] ${why}`, []];
    if (names.has(s.name)) return no("is declared twice");
    names.add(s.name);
    for (const k of oldKeys) if (s.f.has(k)) old.push(`[${s.name}] ${k}`);
    if (!s.f.has("port")) return no("has no port");
    let port: unknown = s.f.get("port");
    if (digitsRe.test(s.f.get("port")!)) port = Number(s.f.get("port"));
    const game = s.f.get("type") === "game";
    if (game && !s.f.get("start") !== !s.f.get("stop")) return no("start and stop go together");
    if (!game && (s.f.get("start") || s.f.get("stop"))) return no("start and stop are for games only");
    let row: Row;
    if (game) {
      row = { name: s.name, port, type: "game", mode: "game", controllable: !!s.f.get("start") && !!s.f.get("stop") };
    } else {
      let maxBody: unknown = s.f.get("max_body") || undefined;
      if (s.f.has("extras")) {
        let extras: unknown;
        try {
          extras = JSON.parse(s.f.get("extras") || "{}");
        } catch {
          return no("extras is not valid JSON");
        }
        if (!extras || typeof extras !== "object" || Array.isArray(extras)) return no("extras is not a JSON object");
        for (const k of Object.keys(extras)) if (!extraKeys.includes(k)) return no(`extras has an unknown key, ${k}`);
        maxBody ??= (extras as Row).max_body;
      }
      // a blank scheme sniffed when published
      row = { name: s.name, port, scheme: s.f.get("scheme") || "" };
      if (maxBody !== undefined) row.max_body = maxBody;
      if (s.f.get("type")) row.type = s.f.get("type");
      if (s.f.has("public")) {
        const p = s.f.get("public")!;
        row.public = p === "true" || p === "false" ? p === "true" : p;
      }
    }
    const why = rowError(game ? row : { ...row, scheme: row.scheme || "http", mode: "path" });
    if (why) return no(why);
    rows.push(row);
  }
  return [rows, "", old];
}

// text with the old keys out: mode, base_path and extras dropped, extras'
// max_body kept as a line of its own where the section has none
export function migrate(text: string): string {
  const lines = text.split("\n");
  const keyOf = (line: string) => {
    const t = line.replace(/\r$/, "").trim();
    const eq = t.indexOf("=");
    return !t || commentRe.test(t) || eq <= 0 ? "" : t.slice(0, eq).trim();
  };
  const out: string[] = [];
  let start = 0;
  const flush = (end: number) => {
    const sec = lines.slice(start, end);
    let hasMax = sec.some((l) => keyOf(l) === "max_body");
    for (const l of sec) {
      const k = keyOf(l);
      if (!oldKeys.includes(k)) {
        out.push(l);
        continue;
      }
      if (k !== "extras" || hasMax) continue;
      let v: unknown;
      try {
        v = JSON.parse(
          l
            .replace(/\r$/, "")
            .slice(l.indexOf("=") + 1)
            .trim()
            .replace(quoteRe, "") || "{}",
        )?.max_body;
      } catch {}
      if (v === undefined || v === null || v === "") continue;
      out.push(`max_body = ${v}` + (l.endsWith("\r") ? "\r" : ""));
      hasMax = true;
    }
  };
  for (let i = 0; i < lines.length; i++)
    if (headRe.test(lines[i]!.replace(/\r$/, "").trim())) {
      flush(i);
      start = i;
    }
  flush(lines.length);
  return out.join("\n");
}

let text: string | undefined;
let declared: Row[] = [];
// a good read had: the first one's sections aren't news
let read = false;

// the ports taken out of services.export, kept across restarts
export function removedPorts(): Set<number> {
  try {
    const a = JSON.parse(readFileSync(removedFile, "utf8"));
    return new Set(Array.isArray(a) ? a.filter((p) => Number.isInteger(p)) : []);
  } catch {
    return new Set();
  }
}

// a port no section names any more remembered, one named again forgotten
function remember(before: Row[], after: Row[]) {
  const now = new Set(after.map((r) => r.port as number));
  const set = removedPorts();
  const size = set.size;
  let changed = false;
  for (const r of before) if (!now.has(r.port as number)) set.add(r.port as number);
  for (const p of now) if (set.delete(p)) changed = true;
  if (!changed && set.size === size) return;
  try {
    writeFileAtomic(removedFile, JSON.stringify([...set].sort((a, b) => a - b)) + "\n");
  } catch {}
}

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
  const [rows, why, old] = parse(t);
  if (why) {
    notes.note("parse", `${servicesFile} rejected, still publishing the last good one: ${why}`);
    return;
  }
  notes.note("parse", `${servicesFile} read: ${rows.length} declared`);
  if (old.length)
    notes.note(
      "old",
      `${servicesFile} has keys no longer used, dropped when it's next written (extras' max_body kept): ${old.join(", ")}`,
    );
  else notes.clear("old");
  if (read) remember(declared, rows);
  read = true;
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

// the scheme a port answers in, "" for none: want alone when set, else https
// first, since a plain server fails a handshake where a TLS one may still
// answer plain HTTP with a 400
async function sniff(want: string, host: string, port: number, base: string): Promise<string> {
  for (const s of want ? [want] : ["https", "http"]) if (await answers(s, host, port, base)) return s;
  return "";
}

// each port's sniffed scheme, its row's when services.export leaves it blank
const sniffed = new Map<number, string>();

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

// a subdomain once *.<domain> reaches the mesh, a path till then
const pickMode = () => (wildcardUp() ? "subdomain" : "path");

function webRow(r: Row, ip: string): Row | undefined {
  const port = r.port as number;
  const want = typeof r.scheme === "string" ? r.scheme : "";
  const up = probe(`web:${want}:${ip}:${port}:`, IdleMS, async () => {
    const s = await sniff(want, ip, port, "");
    if (s) sniffed.set(port, s);
    return !!s;
  });
  if (up === undefined) return;
  const name = r.name as string;
  if (up) {
    const scheme = want || sniffed.get(port) || "http";
    const mode = pickMode();
    notes.note("svc:" + name, `${name} is up on port ${port}, published (${scheme}, ${mode})`);
    // auto: the mode picked here, a subdomain yielding to one asked for by name (proxy settle)
    return { ...r, scheme, mode, auto: true };
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
  const str = (k: string, def: string) =>
    typeof g[k] === "string" && g[k] ? g[k] : k in g && g[k] ? String(g[k]) : def;
  const row: Row = {
    name: g.name,
    port: g.port,
    scheme: str("scheme", "http"),
    mode: str("mode", "subdomain"),
    base_path: str("base_path", ""),
    master: g.master === true,
  };
  const why = rowError(row);
  if (why) {
    notes.note("git", "ignoring git-role: " + why);
    return;
  }
  const port = row.port as number,
    scheme = row.scheme as string,
    base = row.base_path as string;
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

// --- found -----------------------------------------------------------------

// a web page on this host that services.export doesn't name yet, offered for
// publishing; its name a guess from its title
export type Found = { port: number; scheme: string; title: string; name: string };

// 0 for no scan
const findMS = envInt("SERVICES_FIND_MS", 60_000);
// found pages only offered by default, an admin publishing each from apps'
// discovered or the desktop; 1: written in as soon as they're found
const autoPublish = env("SERVICES_AUTO", "0") === "1";
const findMax = 200;
const findAtOnce = 8;
const titleRe = /<title[^>]*>([^<]*)<\/title>/i;
const nameRe = /^[a-z0-9][a-z0-9-]*$/;

// phosphorus's own: ssh, the ingress, the frontend, game DNS, the model, git
function ownPorts(): Set<number> {
  const out = new Set([
    envInt("HOST_SSH_PORT", 22) || 22,
    envInt("INGRESS_PORT", 80),
    FrontendPort,
    envInt("GAME_DNS_PORT", 53),
    envInt("MODEL_SERVER_PORT", 8791),
  ]);
  const g = readJSONMap(gitRoleFile);
  if (typeof g?.port === "number") out.add(g.port);
  return out;
}

const unentity = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'");

// a title as a services.export name: its first words, lowercase and dashed
export function nameFrom(title: string): string {
  return title
    .toLowerCase()
    .split(/\s+[-|:–—·]\s+/)[0]!
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}

// a page's title, redirects followed; "" for anything not an HTML page with one,
// an API or tailscale's own peer listener among them, and for an error page:
// Windows' HTTP.sys answers :5357 (WSDAPI) with a titled "Service Unavailable" 503
async function titleOf(scheme: string, host: string, port: number): Promise<string> {
  try {
    const res = await fetch(`${scheme}://${hostPort(host, port)}/`, {
      proxy: false,
      tls: { rejectUnauthorized: false },
      signal: AbortSignal.timeout(probeTimeout * 3),
    } as RequestInit);
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/html")) {
      await res.body?.cancel();
      return "";
    }
    const m = titleRe.exec((await res.text()).slice(0, 65536));
    return m ? unentity(m[1]!).replace(/\s+/g, " ").trim() : "";
  } catch {
    return "";
  }
}

let found: Found[] = [];
let lastFind = 0;
let finding = false;

// the pages among ports on ip, own and declared ones left out, a few asked at once
export async function pagesOn(ip: string, ports: Iterable<number>): Promise<Found[]> {
  const skip = ownPorts();
  for (const r of declared) skip.add(r.port as number);
  const todo = [...ports]
    .filter((p) => !skip.has(p))
    .sort((a, b) => a - b)
    .slice(0, findMax);
  const got: (Omit<Found, "name"> | undefined)[] = [];
  for (let i = 0; i < todo.length; i += findAtOnce)
    got.push(
      ...(await Promise.all(
        todo.slice(i, i + findAtOnce).map(async (port) => {
          const scheme = await sniff("", ip, port, "");
          const title = scheme ? await titleOf(scheme, ip, port) : "";
          return title ? { port, scheme, title } : undefined;
        }),
      )),
    );
  const names = new Set(declared.map((r) => r.name as string));
  const out: Found[] = [];
  for (const f of got) {
    if (!f) continue;
    let name = nameFrom(f.title);
    if (!nameRe.test(name) || names.has(name)) name = `${name ? name + "-" : "port-"}${f.port}`;
    names.add(name);
    out.push({ ...f, name });
  }
  return out;
}

// found pages written into services.export, their ports alone: the scheme
// sniffed, the mode picked, behind the phosphorus login; those whose section was
// taken out left alone, still offered. The ones written
export function adopt(pages: Found[]): Found[] {
  const removed = removedPorts();
  const todo = pages.filter((f) => !removed.has(f.port));
  if (!todo.length) return [];
  let t: string;
  try {
    t = readFileSync(servicesFile, "utf8");
  } catch {
    return [];
  }
  let next = migrate(t);
  if (next && !next.endsWith("\n")) next += "\n";
  for (const f of todo)
    next += `\n# found by phosphorus: ${f.title.replace(/[\r\n]+/g, " ")}\n[${f.name}]\nport = ${f.port}\n`;
  const why = parse(next)[1];
  if (why) {
    notes.note("adopt", `found pages not written: ${why}`);
    return [];
  }
  try {
    writeFileAtomic(servicesFile, next);
  } catch (e) {
    notes.note("adopt", "found pages not written: " + errText(e));
    return [];
  }
  notes.clear("adopt");
  notes.log(`published what was found listening: ${todo.map((f) => `${f.name} (:${f.port})`).join(", ")}`);
  markHot();
  return todo;
}

async function find(ip: string) {
  const open = await listening(ip);
  if (!open) return;
  let out = await pagesOn(ip, open);
  if (autoPublish) {
    const took = new Set(adopt(out).map((f) => f.port));
    out = out.filter((f) => !took.has(f.port));
  }
  if (marshal(out) !== marshal(found)) {
    found = out;
    notes.note("found", `found ${out.length} unpublished page${out.length === 1 ? "" : "s"}`);
    markHot();
  }
}

// the last scan's pages
export const unpublished = () => found;

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
  pollWildcard();
  if (findMS > 0 && !finding && now() - lastFind >= findMS) {
    finding = true;
    lastFind = now();
    find(ip).finally(() => {
      finding = false;
    });
  }
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
  let start = -1,
    end = lines.length;
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
  const text = migrate(out.join("\n"));
  const [rows, why] = parse(text);
  if (why) return [400, { error: why }];
  for (const r of rows)
    if (r.name === name && r.type === "game") return [400, { error: "public is for web services only" }];
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
  const out: Record<string, any> = {
    name,
    port,
    type: (typeof r.type === "string" && r.type) || "web",
    published,
    listening: (await connects(ip, port)) || (await connects("127.0.0.1", port)),
  };
  if (r.type === "game") {
    out.why = out.listening ? "up" : `nothing listening on :${port}, start it with game_power`;
    return out;
  }
  const scheme = (typeof r.scheme === "string" && r.scheme) || (await sniff("", ip, port, "")) || "http";
  out.scheme = scheme;
  out.mode = pickMode();
  let res: Response;
  try {
    res = await probeGet(scheme, ip, port, "");
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
