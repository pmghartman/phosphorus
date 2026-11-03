// installed apps' server halves, run in this process: each verified bundle's
// server/index.js imported and handed its context (@phosphorus/app-sdk); its
// routes under /api/app/<id>/ and /internal/app/<id>/, its sockets and tools
// dropped when it's removed or replaced by another version
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AppContext,
  AppRequest,
  AppSocket,
  AppStore,
  Tool as AppTool,
  Handler,
  RouteOpts,
  SocketAt,
  Vault,
  Who,
} from "@phosphorus/app-sdk";
import { setAppTools, skill, type Tool, ToolError, viaOf } from "@phosphorus/mcp";
import * as peers from "@phosphorus/peers";
import * as store from "@phosphorus/store";
import * as users from "@phosphorus/users";
import { errText, FrontendPort, logf as log, requestJSON, SelfHost, StateDir, tailnetIP } from "@phosphorus/util";
import * as webapps from "@phosphorus/webapps";
import { type Conn, type Ctx, upgrade } from "@phosphorus/wsock";
import { userUIAsync } from "./hostops.ts";
import { forbidden, isLocalOrPeer, isLoopback, isTailnet, maxJSONBody, readRaw, refuse, sendJSON } from "./http.ts";

const logf = (f: string, ...a: unknown[]) => log("[apps] " + f, ...a);

type Route = { method: string; path: string; under: boolean; h: Handler; opts: RouteOpts };
type Sock = {
  path: string;
  under: boolean;
  open: (ws: AppSocket, who: Who | undefined, at: SocketAt) => void;
  pub: boolean;
};
type Running = {
  id: string;
  version: string;
  live: boolean;
  // its register() done
  up: boolean;
  routes: Route[];
  socks: Sock[];
  stops: (() => void | Promise<void>)[];
  conns: Set<Conn>;
  // each person this app was handed, to the login and request behind them: what
  // opens their vault for it, nothing it can make up itself
  whos: WeakMap<Who, { s: users.Session; c: Ctx }>;
};

const running = new Map<string, Running>();
const apiRe = /^\/(api|internal)\/app\/([a-z][a-z0-9-]*)(\/.*)?$/;
const storeRelRe = /^[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63}){0,2}$/;
const pathRe = /^\/[A-Za-z0-9._~\/-]*$/;

export const appDataDir = (id: string) => join(StateDir, "appdata", id);

// the app's slice of the store, etc/appdata/<id>/
function storeFor(r: Running): AppStore {
  const base = `etc/appdata/${r.id}`;
  const rel = (p: string) => {
    if (!storeRelRe.test(p)) throw new Error(`bad store path ${p}`);
    return `${base}/${p}.json`;
  };
  return {
    read: (p) => store.read(rel(p)),
    write: (p, v) => store.write(rel(p), v),
    remove: (p) => store.remove(rel(p)),
    list: (dir = "") => {
      if (dir && !storeRelRe.test(dir)) throw new Error(`bad store path ${dir}`);
      return store.list(dir ? `${base}/${dir}` : base).map((f) => f.replace(/\.json$/, ""));
    },
    watch: (fn) =>
      store.watch((p) => {
        if (r.live && p.startsWith(base + "/")) fn(p.slice(base.length + 1).replace(/\.json$/, ""));
      }),
  };
}

// a first-party app's data from before it was one: var/<id>/ into its folder,
// moved, what's there already kept; etc/<id>/ into etc/appdata/<id>/, the old
// files removed mesh-wide
function adopt(id: string, dataDir: string): boolean {
  if (webapps.appOf(id)?.key !== "release") throw new Error("only phosphorus's own apps adopt");
  let any = false;
  const old = join(store.Root, "var", id);
  if (existsSync(old)) {
    for (const n of readdirSync(old)) {
      const to = join(dataDir, n);
      if (!existsSync(to)) renameSync(join(old, n), to);
    }
    rmSync(old, { recursive: true, force: true });
    any = true;
  }
  for (const f of store.list(`etc/${id}`)) {
    const from = `etc/${id}/${f}`;
    const to = `etc/appdata/${id}/${f}`;
    if (store.validRel(to) && store.read(to) === undefined) store.write(to, store.read(from));
    store.remove(from);
    any = true;
  }
  if (any) logf("%s: took over what phosphorus kept for it", id);
  return any;
}

function whoOf(r: Running, c: Ctx): Who | undefined {
  const s = users.Of(c);
  if (!s || s.boot) return;
  const who = { user: s.user, admin: !!s.admin };
  r.whos.set(who, { s, c });
  return who;
}

// where this host's phosphorus answers another host over the tailnet
async function meshBase(): Promise<string> {
  const ip = await tailnetIP(SelfHost);
  if (!ip) throw new Error(`can't find ${SelfHost}'s own tailnet address`);
  return `http://${ip}:${FrontendPort}`;
}

// the person's vault as the app may use it (the sdk's Vault says what and why)
function vaultFor(r: Running): Vault {
  const of = (who: Who) => {
    const x = r.whos.get(who);
    if (!x) throw new Error("not a person this app was handed");
    return x;
  };
  return {
    ready: (who) => users.VaultOK(of(who).s),
    hosts: (who) => users.HostLogins(of(who).s),
    async login(who, host) {
      const [user, pass, ok] = await users.HostLogin(of(who).s, host);
      return ok ? { user, pass } : undefined;
    },
    anthropic: (who) => users.AnthropicToken(of(who).s),
    async setAnthropic(who, token) {
      const o = await users.SetAnthropic(of(who).s, { token });
      if (o.status !== 200) throw new Error(String(o.body?.error ?? `status ${o.status}`));
    },
    async agent(who) {
      const { s, c } = of(who);
      const [key, ok] = await users.KeyOf(s, c);
      if (!ok) throw new Error("this host hasn't your mcp key yet, try again shortly");
      const base = await meshBase();
      // the skill names the address the person knows, the base domain's when there is one
      return { key, base, skill: await skill(process.env.BASE_DOMAIN ? users.MCPBase(c) : base) };
    },
  };
}

// the asking host on an internal route, by its tailnet address
function peerOf(c: Ctx): string {
  if (isLoopback(c)) return SelfHost;
  for (const [h, ip] of Object.entries(peers.peerIPs())) if (ip === c.ip) return h;
  return "";
}

function wrap(conn: Conn): AppSocket {
  return {
    get open() {
      return conn.open();
    },
    queued: () => conn.queued(),
    send: (m) => void (typeof m === "string" ? conn.text(m) : conn.json(m)),
    close: (code = 1000) => conn.close(code),
    onMessage: (fn) =>
      conn.onMessage((raw) => {
        let v: unknown;
        try {
          v = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
        } catch {
          return;
        }
        fn(v);
      }),
    onClose: (fn) => conn.onClose(fn),
  };
}

const toolCodes = new Set(["not_found", "bad_input", "forbidden", "unreachable", "conflict"]);

// an app's tool as the mcp server runs it: a user's key only, its person and
// agent handed on, an error's code kept
function mcpTool(t: AppTool): Tool {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    schema: t.schema,
    read: t.read,
    admin: t.admin,
    destructive: t.destructive,
    scope: "key",
    run: async (a, m) => {
      if (!m.caller) throw new ToolError("forbidden", "on a user's key only");
      if (t.admin && !m.caller.admin) throw new ToolError("forbidden", "admins only");
      try {
        return await t.run(a, { user: m.caller.user, admin: !!m.caller.admin, via: viaOf(m) });
      } catch (e) {
        const code = (e as { code?: unknown })?.code;
        if (typeof code === "string" && toolCodes.has(code)) throw new ToolError(code, errText(e));
        throw e;
      }
    },
  };
}

function context(r: Running): AppContext {
  const dataDir = appDataDir(r.id);
  mkdirSync(dataDir, { recursive: true });
  const app = (f: string, ...a: unknown[]) => logf(r.id + ": " + f, ...a);
  return {
    id: r.id,
    version: r.version,
    host: SelfHost,
    dataDir,
    log: app,
    route(method, path, h, opts = {}) {
      const under = path.endsWith("/*");
      const p = under ? path.slice(0, -2) : path;
      if (p && !pathRe.test(p)) throw new Error(`bad route ${path}`);
      r.routes.push({ method: method.toUpperCase(), path: p || (under ? "" : "/"), under, h, opts });
    },
    socket(path, open, opts = {}) {
      const under = path.endsWith("/*");
      const p = under ? path.slice(0, -2) : path;
      if (!pathRe.test(p || "/")) throw new Error(`bad socket ${path}`);
      r.socks.push({ path: p, under, open, pub: !!opts.public });
    },
    store: storeFor(r),
    hosts: () => [SelfHost, ...Object.keys(peers.peerIPs())].sort(),
    address: (host) => tailnetIP(host),
    vault: vaultFor(r),
    async peer(host, path, body) {
      if (!pathRe.test(path)) throw new Error(`bad path ${path}`);
      const ip = host === SelfHost ? "127.0.0.1" : peers.peerIPs()[host];
      if (!ip) throw new Error(`${host} isn't up`);
      const res = await requestJSON({
        host: ip,
        port: FrontendPort,
        method: "POST",
        path: `/internal/app/${r.id}${path}`,
        body: body ?? {},
        timeoutMs: 10000,
      });
      if (res.status !== 200) throw new Error(`${host} answered ${res.status}`);
      return res.body;
    },
    async peerFetch(host, path, init = {}) {
      if (!pathRe.test(path)) throw new Error(`bad path ${path}`);
      const ip = host === SelfHost ? "127.0.0.1" : peers.peerIPs()[host];
      if (!ip) throw new Error(`${host} isn't up`);
      return fetch(`http://${ip}:${FrontendPort}/internal/app/${r.id}${path}`, {
        method: init.method ?? "GET",
        body: init.body,
        signal: AbortSignal.timeout(init.timeoutMs ?? 60000),
      });
    },
    isUser: (name) => users.Exists(name),
    adopt: () => adopt(r.id, dataDir),
    ui: (user, action) => {
      if (r.live) userUIAsync(user, action);
    },
    tools(list) {
      if (!r.live) return;
      const skipped = setAppTools(r.id, list.map(mcpTool));
      if (skipped.length) app("tools taken already, skipped: %s", skipped.join(", "));
    },
    onStop: (fn) => void r.stops.push(fn),
  };
}

async function stop(r: Running) {
  r.live = false;
  if (running.get(r.id) === r) running.delete(r.id);
  setAppTools(r.id, []);
  for (const c of r.conns) c.close(1001);
  for (const fn of r.stops)
    try {
      await fn();
    } catch (e) {
      logf("%s: stopping: %s", r.id, errText(e));
    }
}

// the app brought to what this host has installed: started, swapped or stopped
async function settle(id: string) {
  const want = webapps.serverOf(id);
  const cur = running.get(id);
  if (cur && cur.version === want?.version) return;
  if (cur) await stop(cur);
  if (!want) {
    if (!webapps.wantOf(id)) rmSync(appDataDir(id), { recursive: true, force: true });
    if (cur) logf("%s stopped", id);
    return;
  }
  const r: Running = {
    id,
    version: want.version,
    live: true,
    up: false,
    routes: [],
    socks: [],
    stops: [],
    conns: new Set(),
    whos: new WeakMap(),
  };
  running.set(id, r);
  try {
    const mod = await import(pathToFileURL(want.entry).href);
    const app = mod.default ?? mod;
    if (typeof app?.register !== "function") throw new Error("its module exports no register()");
    await app.register(context(r));
    r.up = true;
    logf("%s v%s running", id, want.version);
  } catch (e) {
    logf("%s v%s didn't start: %s", id, want.version, errText(e));
    await stop(r);
  }
}

// one settle at a time per app, in the order asked
const queue = new Map<string, Promise<void>>();
export function settleApp(id: string): Promise<void> {
  const p = (queue.get(id) ?? Promise.resolve()).then(() => settle(id));
  queue.set(id, p);
  void p.finally(() => queue.get(id) === p && queue.delete(id));
  return p;
}

export function startApps() {
  webapps.onChange((id) => void settleApp(id));
  for (const a of webapps.Catalog) if (a.server) void settleApp(a.id);
}

// every app stopped as the host goes down, so each saves what it holds
export async function stopApps() {
  await Promise.all([...running.values()].map(stop));
}

// which apps run here, their register() done, for the page and the tests
export const runningApps = () =>
  [...running.values()].filter((r) => r.up).map((r) => ({ id: r.id, version: r.version }));

async function bodyJSON(c: Ctx): Promise<any> {
  const b = await readRaw(c, maxJSONBody);
  if (b === undefined) return;
  try {
    return b.length ? JSON.parse(Buffer.from(b).toString("utf8")) : {};
  } catch {
    return;
  }
}

function find(r: Running, method: string, path: string, internal: boolean): Route | undefined {
  return r.routes.find(
    (x) =>
      !!x.opts.internal === internal &&
      (x.method === method || x.method === "*") &&
      (x.under ? path === x.path || path.startsWith(x.path + "/") : path === x.path),
  );
}

// an app's route, undefined when the path isn't an app's
export async function appRoute(c: Ctx, pathname: string): Promise<Response | undefined> {
  const m = apiRe.exec(pathname);
  if (!m) return;
  const internal = m[1] === "internal";
  const r = running.get(m[2]!);
  if (!r) return sendJSON(404, { error: `${m[2]} isn't running here` });
  const path = m[3] || "/";
  const rt = find(r, c.req.method === "HEAD" ? "GET" : c.req.method, path, internal);
  if (!rt) return sendJSON(404, { error: "not found" });
  let who: Who | undefined;
  let peer = "";
  if (internal) {
    if (!(await isTailnet(c)) && !isLoopback(c)) return forbidden();
    peer = peerOf(c);
  } else {
    if (!(await isLocalOrPeer(c))) return forbidden();
    who = whoOf(r, c);
    if (!rt.opts.public && !who) return sendJSON(401, { error: "log in first" });
    if (rt.opts.admin && !who?.admin) return forbidden();
  }
  const req: AppRequest = { req: c.req, path, query: c.url.searchParams, who, peer, json: () => bodyJSON(c) };
  try {
    const out = await rt.h(req);
    return out instanceof Response ? out : sendJSON(out[0], out[1]);
  } catch (e) {
    logf("%s %s %s: %s", r.id, c.req.method, path, errText(e));
    return sendJSON(500, { error: errText(e) });
  }
}

// an app's socket, false when the path isn't an app's
export function appSocket(c: Ctx, pathname: string): Response | undefined | false {
  const m = apiRe.exec(pathname);
  if (!m || m[1] !== "api") return false;
  const r = running.get(m[2]!);
  const path = m[3] || "/";
  const sk = r?.socks.find((s) => (s.under ? path === s.path || path.startsWith(s.path + "/") : path === s.path));
  if (!r || !sk) return refuse(404);
  const who = whoOf(r, c);
  if (!sk.pub && !who) return refuse(403);
  const ok = upgrade(c, (conn) => {
    conn.keepAlive();
    r.conns.add(conn);
    conn.onClose(() => r.conns.delete(conn));
    try {
      sk.open(wrap(conn), who, { path, query: c.url.searchParams });
    } catch (e) {
      logf("%s socket %s: %s", r.id, path, errText(e));
      conn.close(1011);
    }
  });
  return ok ? undefined : refuse(400);
}
