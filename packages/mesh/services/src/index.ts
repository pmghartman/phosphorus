// this host's own services: the installed ones it serves (packages/stacks) and its
// records in the store (records.ts), health checked, live ones and git published;
// a blank scheme sniffed, each a subdomain once *.<domain> answers; pages neither
// names found and offered, one whose record was removed not written back
import { connect } from "node:net";
import type { Row } from "@phosphorus/proxy";
import { env, envInt, errText, FrontendPort, IdleMS, markHot, marshal, Notes, now } from "@phosphorus/util";
import { listening } from "./listen.ts";
import { adoptOne, records, removedPorts } from "./records.ts";
import { pollWildcard, wildcardUp } from "./wildcard.ts";

export { listening, portsOf } from "./listen.ts";
export { Keys, parse } from "./parse.ts";
export { editService, listed, migrateFile, records, removedPorts, setPublic } from "./records.ts";
export { tunnelID, type Wildcard, wildcard, wildcardUp } from "./wildcard.ts";
export type { Row };

const notes = new Notes("services");
const probeTimeout = 1000;

// the installed services this host serves, each a row its want makes (packages/stacks)
let stackRows: () => Row[] = () => [];
export const setStackRows = (fn: () => Row[]) => void (stackRows = fn);

let declared: Row[] = [];
let declaredSig = "";

// the installed ones first, a record of the same name left out
function readDeclared() {
  const rows = stackRows();
  const names = new Set(rows.map((r) => r.name));
  for (const r of records()) if (!names.has(r.name)) rows.push(r);
  const sig = marshal(rows);
  if (sig === declaredSig) return;
  declaredSig = sig;
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

// each port's sniffed scheme, its row's when the record leaves it blank
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

// --- rows ------------------------------------------------------------------

// a subdomain once *.<domain> reaches the mesh, a path till then
const pickMode = () => (wildcardUp() ? "subdomain" : "path");

// a name this host serves as the active copy of a failover stack: its row the
// master one, the proxy serving it over a former active's
let masterOf: (name: string) => boolean = () => false;
export const setMasterOf = (fn: (name: string) => boolean) => void (masterOf = fn);

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
    return { ...r, scheme, mode, auto: true, ...(masterOf(name) ? { master: true } : {}) };
  }
  notes.note("svc:" + name, `${name} is not answering on port ${port}, not published`);
  return;
}

// --- found -----------------------------------------------------------------

// a web page on this host that nothing declares yet, offered for
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

// phosphorus's own: ssh, the ingress, the frontend, the model
function ownPorts(): Set<number> {
  return new Set([
    envInt("HOST_SSH_PORT", 22) || 22,
    envInt("INGRESS_PORT", 80),
    FrontendPort,
    envInt("MODEL_SERVER_PORT", 8791),
  ]);
}

const unentity = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'");

// a title as a service name: its first words, lowercase and dashed
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

// found pages written in as records, their ports alone: the scheme sniffed, the
// mode picked, behind the phosphorus login; those whose record was removed left
// alone, still offered. The ones written
export function adopt(pages: Found[]): Found[] {
  const removed = removedPorts();
  const todo = pages.filter((f) => !removed.has(f.port) && adoptOne(f.name, f.port));
  if (!todo.length) return [];
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

// once per tick at ip, the tailnet address peers route to
export async function refresh(ip: string): Promise<Row[]> {
  readDeclared();
  for (const p of probes.values()) p.seen = false;
  const rows: Row[] = [];
  for (const r of declared) {
    const out = webRow(r, ip);
    if (out) rows.push(out);
  }
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
    published,
    listening: (await connects(ip, port)) || (await connects("127.0.0.1", port)),
  };
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
