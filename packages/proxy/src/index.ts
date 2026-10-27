// the ingress cloudflared points at: every published service by path or
// subdomain, the frontend itself for everything else
import type { Server } from "bun";
import { envInt, logf, marshal, Notes } from "@phosphorus/util";
import { type Ctx, dial, type Handler, isUpgrade, remoteIP, upgrade, websocket, type WSData } from "@phosphorus/wsock";

export { favicon, faviconWhy, type Icon } from "./favicon.ts";

export const baseDomain = process.env.BASE_DOMAIN ?? "";
const selfHost = process.env.SELF_HOST ?? "";
const ingressPort = envInt("INGRESS_PORT", 80);
export const notes = new Notes("ingress");

// --- validation ------------------------------------------------------------

const nameRe = /^[a-z0-9][a-z0-9-]*$/;
const baseRe = /^[a-z0-9]([a-z0-9/_-]*[a-z0-9])?$/;
const sizeRe = /^([0-9]+)(KB|MB|GB)?$/;
const unit: Record<string, number> = { "": 1, KB: 1e3, MB: 1e6, GB: 1e9 };
const gameStatus = new Set(["online", "offline", "starting", "stopping"]);

// services.export `extras`, spread onto the published row
export const ExtraKeys = ["flush_interval", "max_body", "forwarded_proto"];

function extraOK(k: string, v: unknown): boolean {
  if (k === "flush_interval") return Number.isInteger(Number(v)) && /^-?[0-9]+$/.test(String(v));
  if (k === "max_body") return sizeRe.test(String(v));
  if (k === "forwarded_proto") return v === "http" || v === "https";
  return true;
}

const validPort = (p: unknown) => typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 65535;

export type Row = Record<string, any>;

// why a published row can't be routed, "" when it can
export function rowError(r: Row | undefined | null): string {
  if (!r || typeof r !== "object") return "not an object";
  if (!r.name || !nameRe.test(String(r.name))) return `'${r.name}' is not a valid name`;
  if (!validPort(r.port)) return `'${r.port}' is not a valid port`;
  if (r.type === "game") {
    if (!("status" in r)) return "";
    return typeof r.status === "string" && gameStatus.has(r.status) ? "" : `'${r.status}' is not a game status`;
  }
  if ("type" in r && r.type !== "") return `'${r.type}' is not a service type`;
  if (r.scheme !== "http" && r.scheme !== "https") return `'${r.scheme}' is not http or https`;
  if (r.mode !== "path" && r.mode !== "subdomain") return `'${r.mode}' is not path or subdomain`;
  if ("public" in r && r.public !== true && r.public !== false) return `'${r.public}' is not true or false`;
  if (r.base_path && (typeof r.base_path !== "string" || r.base_path.includes("..") || !baseRe.test(r.base_path)))
    return `'${r.base_path}' is not a valid base_path`;
  for (const k of ExtraKeys) if (k in r && !extraOK(k, r[k])) return `'${r[k]}' is not a valid ${k}`;
  return "";
}

// --- routing table ---------------------------------------------------------

// one served destination
export type Route = {
  host: string;
  name: string;
  master: boolean;
  git: boolean;
  public: boolean;
  domain: string;
  prefix: string;
  scheme: string;
  ip: string;
  port: number;
  maxBody: number;
  proto: string;
  // a peer's own frontend, its pin cookie kept
  pin?: boolean;
};

type Table = { domains: Map<string, Route>; paths: Route[] };
let table: Table = { domains: new Map(), paths: [] };
let every: Route[] = [];
let tableFp = "[]";
let pinIPs: Record<string, string> = {};

function toRoute(r: Row, ip: string): Route {
  const base = r.base_path ? "/" + r.base_path : "";
  // no domain: a subdomain service on a path instead
  const sub = r.mode === "subdomain" && !!baseDomain;
  const name = String(r.name);
  const rt: Route = {
    host: r.host,
    name,
    master: false,
    git: false,
    public: r.public === true,
    domain: "",
    prefix: "",
    scheme: String(r.scheme),
    ip,
    port: r.port,
    maxBody: 0,
    proto: "http",
  };
  if (typeof r.master === "boolean") {
    rt.git = true;
    rt.master = r.master;
  }
  if (sub) {
    rt.domain = name + "." + baseDomain;
    rt.prefix = base;
  } else rt.prefix = `/${r.host}/${name}${base}`;
  if (r.max_body) {
    const m = sizeRe.exec(String(r.max_body));
    if (m) rt.maxBody = Number(m[1]) * unit[m[2] ?? ""]!;
  }
  if (typeof r.forwarded_proto === "string" && r.forwarded_proto) rt.proto = r.forwarded_proto;
  return rt;
}

const routeJSON = ({ pin, ...rt }: Route) => rt;

// validated then swapped, the live table untouched on any failure
export function swap(rows: Row[], ipOf: (h: string) => string): boolean {
  const domains = new Map<string, Route>();
  const paths: Route[] = [];
  const all: Route[] = [];
  for (const r of rows) {
    if (r.type === "game") continue;
    const why = typeof r.host === "string" && nameRe.test(r.host) ? rowError(r) : `'${r.host}' is not a valid host`;
    if (why) {
      notes.note("table", `routes rejected, still serving the previous ones: ${r.host}'s ${r.name}: ${why}`);
      return false;
    }
    const rt = toRoute(r, ipOf(r.host) || r.host);
    all.push(rt);
    if (!rt.domain) {
      paths.push(rt);
      continue;
    }
    const held = domains.get(rt.domain);
    if (held && !(rt.master && !held.master)) {
      notes.note("dup:" + rt.domain, `${rt.domain} is published by ${held.host} and ${rt.host}; serving ${held.host}'s`);
      continue;
    }
    domains.set(rt.domain, rt);
  }
  paths.sort((a, b) => b.prefix.length - a.prefix.length);
  notes.clear("table");
  every = all;
  // a Map's order: insertion, kept by the rows' own order
  const seen = new Set<string>();
  const served = all.filter((rt) => rt.domain && domains.get(rt.domain) === rt && !seen.has(rt.domain) && seen.add(rt.domain));
  served.push(...paths);
  const fp = marshal(served.map(routeJSON));
  if (fp === tableFp) return false;
  table = { domains, paths };
  tableFp = fp;
  const hosts = new Set(served.map((r) => r.host));
  const s = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  notes.log(`routes updated, now serving ${s(served.length, "service")} across ${s(hosts.size, "host")}`);
  return true;
}

// every route, a subdomain's shadowed duplicate too
export const everyRoute = () => every;

// --- matching --------------------------------------------------------------

export const under = (p: string, prefix: string) => p === prefix || p.startsWith(prefix + "/");
export const strip = (p: string, prefix: string) => p.slice(prefix.length) || "/";

// a service's redirect kept under the prefix its request was stripped of, as
// Apache's ProxyPassReverse: a path from the service's own root, or an absolute
// URL back at this host or the service itself; relative ones, ones already under
// the prefix and other hosts' left as they are
export function reverseLocation(loc: string, prefix: string, ...hosts: string[]): string {
  if (!prefix) return loc;
  let head = "", rest = loc;
  const abs = /^([a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)(.*)$/is.exec(loc);
  if (abs) {
    if (!hosts.some((h) => h.toLowerCase() === abs[2]!.toLowerCase())) return loc;
    head = (abs[1] ?? "") + "//" + abs[2];
    rest = abs[3] || "/";
    if (!rest.startsWith("/")) rest = "/" + rest;
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(loc) || !loc.startsWith("/")) return loc;
  const cut = rest.search(/[?#]/);
  const path = cut < 0 ? rest : rest.slice(0, cut);
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {}
  if (under(decoded, prefix)) return loc;
  return head + prefix + rest;
}

// 127.0.0.1 or ::1
export const isLoopbackAddr = (a: string) => a === "127.0.0.1" || a === "::1";

// 100.64.0.0/10
export function isTailnetAddr(a: string): boolean {
  if (!a.startsWith("100.")) return false;
  const n = Number(a.split(".")[1]);
  return Number.isInteger(n) && n >= 64 && n <= 127;
}

// an address, a bare name or a tailnet one
export function unrebindable(host: string): boolean {
  let h = host;
  const m = /^\[([^\]]*)\](?::\d+)?$/.exec(h) ?? /^([^:]*):\d+$/.exec(h);
  if (m) h = m[1]!;
  h = h.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":");
  return ip || !h.includes(".") || h.endsWith(".ts.net");
}

const onMesh = (c: Ctx) => isLoopbackAddr(c.ip) || isTailnetAddr(c.ip);

type Hit = { route?: Route; path?: string; frontend?: boolean; status?: number; text?: string };

// the raw path and query, as the request line had them
export const requestURI = (c: Ctx) => c.url.pathname + c.url.search;
const reqHost = (req: Request) => (req.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");

function resolve(c: Ctx): Hit {
  const host = reqHost(c.req);
  const raw = requestURI(c);
  const pathname = c.url.pathname, search = c.url.search;
  const t = table;
  // the domain, or on the tailnet any host's own name or address
  const main = host === baseDomain || (!t.domains.has(host) && pathname !== "/healthz" && onMesh(c) && unrebindable(host));
  if (main) {
    for (const x of t.paths) if (under(pathname, x.prefix)) return { route: x, path: strip(pathname, x.prefix) + search };
    if (pathname === "/api/update/local") return { status: 404, text: "not found" };
    return onMesh(c) ? { frontend: true } : { status: 403, text: "forbidden" };
  }
  const x = t.domains.get(host);
  if (x) {
    if (!x.prefix) return { route: x, path: raw };
    if (under(pathname, x.prefix)) return { route: x, path: strip(pathname, x.prefix) + search };
    return { status: 404, text: "not found" };
  }
  if (pathname === "/healthz") return { status: 200, text: "ok" };
  return { status: 404, text: "no route for this hostname" };
}

// --- proxying --------------------------------------------------------------

const loginCookie = "phosphorus-user";
const pinCookie = "phosphorus-host";
const pinHop = "x-forwarded-phosphorus-host";
const hopHeaders = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate"];

const pinHopped = (req: Request) => !!req.headers.get(pinHop);
function pinnedTo(req: Request): string {
  const m = /(?:^|;\s*)phosphorus-host=([a-z0-9-]+)/.exec(req.headers.get("cookie") ?? "");
  return m ? m[1]! : "";
}
const pinCookieFor = (host: string) => `${pinCookie}=${host}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly`;

// live phosphorus peers, name -> tailnet IP
export const pinTargets = (ips: Record<string, string>) => void (pinIPs = { ...ips });

function peerIngress(host: string): Route | undefined {
  const ip = pinIPs[host];
  if (!ip) return;
  return { pin: true, host, name: "frontend", scheme: "http", ip, port: ingressPort, proto: "https", master: false, git: false, public: false, domain: "", prefix: "", maxBody: 0 };
}

function pinRoute(req: Request): Route | undefined {
  if (!selfHost || pinHopped(req)) return;
  const h = pinnedTo(req);
  if (h && h !== selfHost) return peerIngress(h);
}

export const refuse = (status: number, text: string, headers: Record<string, string> = {}) =>
  new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });

export function frameable(csp: string): string {
  const kept = csp.split(";").map((d) => d.trim()).filter((d) => d && !/^frame-ancestors(\s|$)/i.test(d));
  let anc = "frame-ancestors 'self'";
  if (baseDomain) anc += " https://" + baseDomain;
  return [...kept, anc].join("; ");
}

const hostPort = (rt: Route) => (rt.ip.includes(":") ? `[${rt.ip}]` : rt.ip) + ":" + rt.port;

// the request's headers as the service gets them
function outHeaders(rt: Route, c: Ctx): Headers {
  const h = new Headers(c.req.headers);
  for (const k of [...h.keys()]) if (k.startsWith("x-forwarded-") || hopHeaders.includes(k)) h.delete(k);
  if (!rt.pin) {
    const kept = (c.req.headers.get("cookie") ?? "").split(/;\s*/).filter((x) => x && !x.startsWith(loginCookie + "="));
    h.delete("cookie");
    if (kept.length) h.set("cookie", kept.join("; "));
  }
  h.set("x-forwarded-for", c.ip);
  h.set("x-forwarded-proto", rt.proto);
  h.set("x-forwarded-host", c.req.headers.get("host") ?? "");
  if (rt.pin) h.set(pinHop, selfHost);
  return h;
}

class TooLarge extends Error {}

// a body cut off past max bytes
function capped(body: ReadableStream<Uint8Array>, max: number) {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        seen += chunk.length;
        if (seen > max) ctl.error(new TooLarge("request body too large"));
        else ctl.enqueue(chunk);
      },
    }),
  );
}

async function forward(rt: Route, c: Ctx, p: string): Promise<Response | undefined> {
  if (isUpgrade(c.req)) return forwardSocket(rt, c, p);
  const req = c.req;
  if (rt.maxBody > 0 && Number(req.headers.get("content-length")) > rt.maxBody) return refuse(413, "request body too large");
  let body: ReadableStream<Uint8Array> | null = req.body;
  if (body && rt.maxBody > 0) body = capped(body, rt.maxBody);
  let res: Response;
  try {
    res = await fetch(`${rt.scheme}://${hostPort(rt)}${p}`, {
      method: req.method,
      headers: outHeaders(rt, c),
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      redirect: "manual",
      decompress: false,
      tls: { rejectUnauthorized: false },
      signal: req.signal,
      duplex: "half",
    } as RequestInit);
  } catch (e) {
    if (e instanceof TooLarge || (e as any)?.cause instanceof TooLarge) return refuse(413, "request body too large");
    return refuse(502, `${rt.host}'s ${rt.name} didn't answer`, rt.pin ? { "Set-Cookie": pinCookieFor(selfHost) } : {});
  }
  const h = new Headers(res.headers);
  const loc = h.get("location");
  if (loc) h.set("location", reverseLocation(loc, rt.prefix, req.headers.get("host") ?? "", hostPort(rt)));
  // every service shown in the desktop's windows, on a path or a subdomain; a
  // peer's frontend keeps its own headers
  if (!rt.pin) {
    const denied = h.has("x-frame-options");
    h.delete("x-frame-options");
    const csp = h.get("content-security-policy");
    if (csp !== null) h.set("content-security-policy", frameable(csp));
    // the X-Frame-Options dropped above still kept from every other site
    else if (denied) h.set("content-security-policy", frameable(""));
  }
  for (const k of hopHeaders) h.delete(k);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// a websocket carried through: the service's socket opened first, its protocol
// the one the client is answered with
async function forwardSocket(rt: Route, c: Ctx, p: string): Promise<Response | undefined> {
  const h = outHeaders(rt, c);
  const protocols = (c.req.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const k of [...h.keys()]) if (k.startsWith("sec-websocket-")) h.delete(k);
  let up;
  try {
    up = await dial(`${rt.scheme === "https" ? "wss" : "ws"}://${hostPort(rt)}${p}`, Object.fromEntries(h), 30_000, protocols, { rejectUnauthorized: false });
  } catch {
    return refuse(502, `${rt.host}'s ${rt.name} didn't answer`, rt.pin ? { "Set-Cookie": pinCookieFor(selfHost) } : {});
  }
  const proto = up.protocol();
  const ok = upgrade(
    c,
    (down) => {
      up.onMessage((d, bin) => (bin ? down.binary(d as Uint8Array) : down.text(d as string)));
      down.onMessage((d, bin) => (bin ? up.binary(d as Uint8Array) : up.text(d as string)));
      up.onClose(() => down.close(up.code === 1005 || up.code === 1006 ? 1000 : up.code));
      down.onClose(() => up.close(down.code === 1005 || down.code === 1006 ? 1000 : down.code));
    },
    proto ? { "Sec-WebSocket-Protocol": proto } : undefined,
  );
  if (!ok) {
    up.close();
    return refuse(400, "bad upgrade");
  }
}

// --- the login ------------------------------------------------------------

// the login's checks, users.pass and users.issuers
export type Gate = { pass: (c: Ctx) => boolean; issuers: (c: Ctx) => string[] };

const openAPI = /^\/api\/(me|login|logout|users|run)(\/|$)/;

// public routes left to the service's own login
const gated = (h: Hit) => (h.route ? !h.route.git && !h.route.public : !!h.frontend);

function isOpen(c: Ctx, h: Hit): boolean {
  if (!h.frontend) return false;
  const p = c.url.pathname;
  if (!p.startsWith("/api/") && !p.startsWith("/internal/")) return true;
  // a key checked by the frontend itself
  if (p === "/api/mcp" && (c.req.headers.get("authorization") ?? "").startsWith("Bearer ")) return true;
  if (p.startsWith("/api/mcp/") && p.slice(9).replace(/^\/+|\/+$/g, "")) return true;
  return openAPI.test(p);
}

function deny(c: Ctx): Response {
  const host = (c.req.headers.get("host") ?? "").toLowerCase();
  const page = c.req.method === "GET" && (c.req.headers.get("accept") ?? "").includes("text/html");
  if (page && baseDomain) {
    const why = /(?:^|;\s*)phosphorus-user=/.test(c.req.headers.get("cookie") ?? "") ? "refused" : "none";
    const q = new URLSearchParams({ next: "https://" + host + requestURI(c), why, by: selfHost });
    return new Response(null, { status: 302, headers: { Location: `https://${baseDomain}/?${q}`, "Cache-Control": "no-store" } });
  }
  return refuse(401, "log in first" + (selfHost ? ` (${selfHost})` : ""));
}

function pinSwitch(c: Ctx): Response {
  const host = c.url.searchParams.get("host") ?? "";
  const o = c.req.headers.get("origin");
  if (o) {
    let ok = false;
    try {
      ok = new URL(o).host === c.req.headers.get("host");
    } catch {}
    if (!ok) return refuse(403, "forbidden");
  }
  if (!selfHost || (host !== selfHost && !pinIPs[host])) return refuse(409, (host || "that host") + " isn't serving");
  return new Response(null, { status: 204, headers: { "Set-Cookie": pinCookieFor(host) } });
}

// the ingress itself, the frontend app for whatever no route claims
export function handler(app: Handler, gate: Gate): Handler {
  const issuerRoute = (c: Ctx) => {
    if (pinHopped(c.req)) return;
    for (const h of gate.issuers(c)) if (pinIPs[h]) return peerIngress(h);
  };
  return async (c) => {
    c.ingress = true;
    const h = resolve(c);
    if (isUpgrade(c.req)) {
      const pin = h.frontend ? pinRoute(c.req) : undefined;
      if (gated(h) && !pin && !gate.pass(c)) {
        const via = issuerRoute(c);
        return via ? forward(via, c, requestURI(c)) : new Response(null, { status: 401 });
      }
      if (h.route) return forward(h.route, c, h.path!);
      if (pin) return forward(pin, c, requestURI(c));
      if (h.frontend) return app(c);
      return new Response(null, { status: h.status });
    }
    const hopReq = !!h.frontend && c.req.method === "POST" && /^\/api\/host(\?|$)/.test(requestURI(c));
    const pin = h.frontend && !hopReq ? pinRoute(c.req) : undefined;
    if (gated(h) && !pin && !isOpen(c, h) && !gate.pass(c)) {
      const via = issuerRoute(c);
      return via ? forward(via, c, requestURI(c)) : deny(c);
    }
    if (hopReq) return pinSwitch(c);
    if (h.route) return forward(h.route, c, h.path!);
    if (pin) return forward(pin, c, requestURI(c));
    if (h.frontend) {
      const res = await app(c);
      if (res && selfHost && !pinHopped(c.req) && pinnedTo(c.req) !== selfHost) {
        const out = new Response(res.body, res);
        out.headers.append("Set-Cookie", pinCookieFor(selfHost));
        return out;
      }
      return res;
    }
    return refuse(h.status!, h.text!);
  };
}

// a Bun server on port for handler h, every request's context made
export function serve(port: number, h: Handler, ingress: boolean, hostname?: string): Server<WSData> {
  return Bun.serve<WSData>({
    port,
    hostname,
    idleTimeout: 0,
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    development: false,
    websocket,
    async fetch(req, server) {
      const c: Ctx = { req, url: new URL(req.url), ip: remoteIP(server, req), ingress, server };
      try {
        return await h(c);
      } catch (e) {
        logf("[frontend] %s %s: %s", req.method, c.url.pathname, (e as Error)?.stack ?? e);
        return new Response("internal error", { status: 500 });
      }
    },
    error: () => new Response("internal error", { status: 500 }),
  });
}

// the ingress, exiting the process when it can't bind
export function listen(port: number, app: Handler, gate: Gate) {
  try {
    serve(port, handler(app, gate), true);
  } catch (e) {
    notes.log(`can't serve on port ${port}: ${(e as Error).message}`);
    process.exit(1);
  }
  notes.log(`serving ${baseDomain || "the tailnet"} on port ${port}`);
}
