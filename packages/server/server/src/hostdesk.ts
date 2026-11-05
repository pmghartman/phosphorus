// host desktop: any computer on the tailnet opened as its own desktop, as the
// viewer's saved login for it; open to every signed in user with one

import { join } from "node:path";
import { AfterglowSource, pathsOf, readLink } from "@phosphorus/afterglow";
import * as as from "@phosphorus/appstream";
import * as hd from "@phosphorus/hostdesk";
import { auditRow } from "@phosphorus/mcp";
import * as peers from "@phosphorus/peers";
import * as users from "@phosphorus/users";
import { DataDir, errText, tailnetIP } from "@phosphorus/util";
import { type Conn, type Ctx, dial, upgrade } from "@phosphorus/wsock";
import { getPlatform, hostSSHHost, hostSSHPort, port, selfHost, whoHeader } from "./config.ts";
import {
  isLocalOrPeer,
  isTailnet,
  maxJSONBody,
  maxSaveBody,
  type Res,
  readRaw,
  refuse,
  sameOrigin,
  sendJSON,
} from "./http.ts";
import { decode, obj, str } from "./js.ts";

const deskRe = /^\/api\/hostdesk\/([a-z0-9][a-z0-9-]*)\/([a-z]+)$/;
const maxText = 16 << 20;

// every computer the tailnet names, this one too
const known = (h: string) => h === selfHost || peers.tailnet().some((d: any) => d?.name === h);
const osOf = (h: string) => {
  if (h === selfHost) return getPlatform() === "windows" ? "windows" : getPlatform() || "";
  return String((peers.tailnet().find((d: any) => d?.name === h) as any)?.os ?? "");
};
// runs phosphorus: a terminal there is phosphorus's own, powershell on Windows
const phosphorusOn = (h: string) => h === selfHost || h in peers.peerIPs();

function note(user: string, tool: string, args: Record<string, any>, err?: unknown) {
  const row: Record<string, any> = { user, via: "desktop", tool, args, ok: !err, host: selfHost };
  if (err) row.error = errText(err);
  auditRow(row);
}

type Who = { s: users.Session; host: string };

// the session's key: the phosphorus user, the host, the login it signs in as
const keyOf = (w: Who, login: string) => `${w.s.user}\0${w.host}\0${login}`;
const cacheKey = (w: Who) => `desk\0${w.s.user}`;

type Cached = { desk: hd.Desk; apps?: hd.Item[]; scope: { exact: string[]; dirs: string[] }; icons: string[] };

async function session(w: Who): Promise<hd.Session> {
  const [user, pass, ok] = await users.HostLogin(w.s, w.host);
  if (!ok) throw new Coded(403, `save a login for ${w.host} first: profile, the hosts you log into`);
  const [s, fresh] = await hd
    .sessionFor(keyOf(w, user), async () => {
      const addr = w.host === selfHost ? hostSSHHost : await tailnetIP(w.host);
      if (!addr) throw new Coded(404, `${w.host} has no tailnet address here`);
      const port = w.host === selfHost ? Number(hostSSHPort) || 22 : 22;
      return { host: w.host, addr, port, user, pass, os: osOf(w.host) };
    })
    .catch((e) => {
      note(w.s.user, "host_desktop", { host: w.host, login: user }, e);
      throw e instanceof hd.Refused ? new Coded(403, e.message) : e;
    });
  const c = hd.ctxOf(s, phosphorusOn(w.host));
  c.psTerm = phosphorusOn(w.host);
  if (fresh) {
    note(w.s.user, "host_desktop", { host: w.host, login: user });
    // what an earlier visit issued, so the cache draws before the probe answers
    const k = hd.cacheJSON<Cached>(w.host, cacheKey(w));
    if (k?.desk) {
      c.scope = new hd.Scope(k.desk.home, s.os === "windows");
      c.scope.load(k.scope ?? {});
      for (const i of k.icons ?? []) c.icons.add(i);
      c.desk = k.desk;
    }
  }
  return s;
}

function remember(w: Who, s: hd.Session) {
  const c = hd.ctxOf(s);
  if (!c.desk) return;
  const k: Cached = { desk: c.desk, apps: c.apps, scope: c.scope.list(), icons: [...c.icons] };
  hd.cachePut(w.host, cacheKey(w), JSON.stringify(k));
}

class Coded extends Error {
  constructor(
    public status: number,
    msg: string,
  ) {
    super(msg);
  }
}

const fail = (e: unknown): Res => [e instanceof Coded ? e.status : 502, { error: errText(e) }];

const inlineOK = /\.(png|jpe?g|gif|webp|bmp|avif|ico|svg|mp4|m4v|webm|mov|ogv|mp3|wav|flac|ogg|oga|m4a|opus|aac|pdf)$/i;
const mimes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  opus: "audio/ogg",
  aac: "audio/aac",
  pdf: "application/pdf",
};

const blobRes = (b: hd.Blob, cache: string) =>
  new Response(b.bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: {
      "Content-Type": b.type,
      "Cache-Control": cache,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });

// the path asked for, kept to what this login may reach
function allowed(s: hd.Session, p: string): string {
  const ok = hd.ctxOf(s).scope.allow(p);
  if (!ok) throw new Coded(403, "outside this login's profile");
  return ok;
}

// /api/hostdesk/<host>/<op>: that computer's desktop, as the viewer's saved login
export async function hostdeskRoute(
  c: Ctx,
  pathname: string,
  method: string,
  q: URLSearchParams,
): Promise<Response | undefined> {
  if (!pathname.startsWith("/api/hostdesk")) return;
  if (!(await isLocalOrPeer(c))) return sendJSON(403, { error: "forbidden" });
  if (q.has("hop")) return await hopList(c, pathname);
  const s = await users.Soon(c);
  if (!s || s.boot) return sendJSON(401, { error: "log in as a user" });
  const m = deskRe.exec(pathname);
  if (!m) return sendJSON(404, { error: "not found" });
  const w: Who = { s, host: m[1]! };
  const op = m[2]!;
  if (!known(w.host)) return sendJSON(404, { error: `${w.host} isn't on the tailnet` });
  if (method === "POST" && !sameOrigin(c)) return sendJSON(403, { error: "forbidden" });
  try {
    if (method === "GET") return await getOp(w, op, q);
    if (method === "POST") return await postOp(w, op, c);
  } catch (e) {
    return sendJSON(...fail(e));
  }
  return sendJSON(405, { error: "method" });
}

async function getOp(w: Who, op: string, q: URLSearchParams): Promise<Response> {
  const nc = { "Cache-Control": "no-store" };
  if (op === "desktop" && q.has("cached")) {
    const k = hd.cacheJSON<Cached>(w.host, cacheKey(w));
    if (!(await users.HostLogin(w.s, w.host))[2])
      throw new Coded(403, `save a login for ${w.host} first: profile, the hosts you log into`);
    // the ssh session opened now, ready by the time the page asks for the live desk
    void session(w)
      .then((s) => k?.desk && hd.prefetch(s, w.host, [...k.desk.icons, ...k.desk.pins]))
      .catch(() => {});
    return sendJSON(200, k ? { desk: k.desk, apps: k.apps ?? [], cached: true } : { cached: false }, nc);
  }
  const s = await session(w);
  switch (op) {
    case "desktop": {
      const desk = await hd.desktop(s);
      remember(w, s);
      void hd.prefetch(s, w.host, [...desk.icons, ...desk.pins]).catch(() => {});
      return sendJSON(200, { desk }, nc);
    }
    case "apps": {
      const apps = await hd.apps(s);
      remember(w, s);
      return sendJSON(200, { apps }, nc);
    }
    case "icon": {
      const b = await hd.icon(s, w.host, q.get("k") ?? "", q.get("v") ?? "");
      // a miss never kept, so the page's retry asks again
      if (!b) return new Response(null, { status: 404, headers: nc });
      return blobRes(b, "private, max-age=31536000, immutable");
    }
    case "wallpaper": {
      const b = await hd.wallpaper(s, w.host);
      if (!b) return new Response(null, { status: 404, headers: nc });
      return blobRes(b, "private, max-age=31536000, immutable");
    }
    case "ls":
      return sendJSON(200, { entries: await hd.ls(s, allowed(s, q.get("path") ?? "")) }, nc);
    case "images":
      return sendJSON(200, { images: await hd.images(s) }, nc);
    case "running": {
      const [login] = await users.HostLogin(w.s, w.host);
      // a Windows host's apps run on its own phosphorus: asked there
      if (w.host !== selfHost && osOf(w.host) === "windows" && phosphorusOn(w.host))
        return sendJSON(200, { apps: await peerList(w, login) }, nc);
      const apps = as.list(keyOf(w, login)).map((a) => ({ id: a.id, title: a.title, name: a.start.name }));
      return sendJSON(200, { apps }, nc);
    }
    case "trash":
      return sendJSON(200, { items: await hd.trash(s) }, nc);
    case "read": {
      const p = allowed(s, q.get("path") ?? "");
      const st = await hd.statOf(s, p);
      if (st.dir) throw new Coded(400, "a folder");
      if (st.size > maxText) return sendJSON(200, { path: p, size: st.size, tooBig: true }, nc);
      const b = await hd.readAll(s, p, maxText);
      if (b.subarray(0, 8000).includes(0)) return sendJSON(200, { path: p, size: st.size, binary: true }, nc);
      return sendJSON(200, { path: p, size: st.size, text: Buffer.from(b).toString("utf8") }, nc);
    }
    case "download": {
      const p = allowed(s, q.get("path") ?? "");
      const { size, body } = await hd.readStream(s, p);
      const name = p.split(/[\\/]/).pop() ?? "file";
      const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
      const inline = q.get("inline") === "1" && inlineOK.test(name);
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": inline ? (mimes[ext] ?? "application/octet-stream") : "application/octet-stream",
          "Content-Length": String(size),
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox",
        },
      });
    }
  }
  throw new Coded(404, "not found");
}

async function postOp(w: Who, op: string, c: Ctx): Promise<Response> {
  const raw = await readRaw(c, op === "save" ? maxSaveBody * 8 : maxJSONBody);
  if (raw === undefined) return sendJSON(413, { error: "too big" });
  const p = obj(decode(raw.length ? raw : "{}")) ?? {};
  const s = await session(w);
  const audited = async (tool: string, args: Record<string, any>, f: () => Promise<Record<string, any>>) => {
    try {
      const out = await f();
      note(w.s.user, tool, { host: w.host, ...args });
      return sendJSON(200, out);
    } catch (e) {
      note(w.s.user, tool, { host: w.host, ...args }, e);
      throw e;
    }
  };
  switch (op) {
    case "trash": {
      const what = str(p.op);
      if (what === "restore")
        return audited("host_desktop_restore", { id: str(p.id) }, async () => ({ to: await hd.restore(s, str(p.id)) }));
      if (what === "empty") return audited("host_desktop_empty", {}, async () => (await hd.empty(s), {}));
      if (what === "delete") {
        const path = allowed(s, str(p.path));
        return audited("host_desktop_delete", { path }, async () => (await hd.remove(s, path), {}));
      }
      throw new Coded(400, "op is restore, empty or delete");
    }
    case "open": {
      const it = await hd.open(s, allowed(s, str(p.path)));
      return sendJSON(200, { item: it, phosphorus: phosphorusOn(w.host) });
    }
    case "set": {
      const ch: hd.Change = {};
      if (typeof p.wallpaper === "string") ch.wallpaper = allowed(s, p.wallpaper);
      if (typeof p.dark === "boolean") ch.dark = p.dark;
      if (typeof p.accent === "string") ch.accent = p.accent;
      if (Array.isArray(p.pins))
        ch.pins = p.pins.filter((x: unknown) => typeof x === "string" && /^[\w.-]{1,200}$/.test(x));
      if (!Object.keys(ch).length) throw new Coded(400, "nothing to change");
      return audited("host_desktop_set", ch, async () => {
        const live = await hd.change(s, ch);
        const desk = await hd.desktop(s);
        remember(w, s);
        return { live, desk };
      });
    }
    case "save": {
      const path = allowed(s, str(p.path));
      const text = typeof p.text === "string" ? p.text : "";
      if (Buffer.byteLength(text) > maxText) throw new Coded(413, "over 16MB");
      return audited("host_desktop_save", { path }, async () => (await hd.writeText(s, path, text), {}));
    }
  }
  throw new Coded(404, "not found");
}

// --- app streaming ---------------------------------------------------------------------

const streamRe = /^\/api\/hostdesk\/([a-z0-9][a-z0-9-]*)\/stream$/;
const idRe = /^[0-9a-f]{24}$/;

// the host's connection as commands to run: the stream's agent and encoder
function runnerOf(s: hd.Session): as.Runner {
  s.extra.runner ??= {
    async run(cmd: string): Promise<as.Chan> {
      const ch = await s.channel(cmd);
      return {
        write: (d) => void ch.write(d),
        onData: (f) => void ch.on("data", (b: Uint8Array) => f(b)),
        onClose: (f) => void ch.on("close", f),
        close: () => {
          try {
            ch.end();
            ch.close();
          } catch {}
        },
      };
    },
    output: (cmd: string) => s.exec(cmd),
  } satisfies as.Runner;
  return s.extra.runner;
}

const num = (q: URLSearchParams, k: string, d: number) => {
  const v = Number(q.get(k));
  return Number.isFinite(v) && v > 0 ? v : d;
};

// a gui app's desktop entry, read on the host, as what the agent runs: only an entry
// the host listed itself, never a command the page sent
async function entryOf(s: hd.Session, path: string): Promise<{ argv: string[]; name: string }> {
  if (!/\.desktop$/.test(path)) throw new Coded(400, "not a desktop entry");
  const text = Buffer.from(await hd.readAll(s, path, 256 << 10)).toString("utf8");
  const e = hd.parseEntry(text);
  if (!e || e.type !== "Application" || e.terminal || !e.exec) throw new Coded(400, "not a window app");
  return { argv: as.parseExec(e.exec, { name: e.name, icon: e.icon, path }), name: e.name };
}

// --- window apps on Windows: the host's own phosphorus and its afterglow
// afterglow (github.com/pmghartman/afterglow), phosphorus's fork of Apollo installed with
// it, streams the host's window apps over one loopback link

// a window app on Windows: its shortcut or program, started on the host as the shell would
const winAppRe = /\.(lnk|exe|appref-ms|url)$/i;
// who's signed in at this Windows machine's console: the account the host's apps run as
let consoleCache: { at: number; user: string } | undefined;
async function consoleUser(): Promise<string> {
  if (consoleCache && Date.now() - consoleCache.at < 10_000) return consoleCache.user;
  const p = Bun.spawn(
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-CimInstance Win32_ComputerSystem).UserName",
    ],
    {
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const out = (await new Response(p.stdout).text()).trim();
  const user = out.split("\\").pop()?.toLowerCase() ?? "";
  consoleCache = { at: Date.now(), user };
  return user;
}

// this machine's afterglow: its link, when phosphorus's setup put it here and wrote one
const localAfterglow = () =>
  getPlatform() === "windows" ? readLink(pathsOf(join(DataDir, "afterglow")).link) : undefined;
// afterglow streams one app at a time
let afterglowBusy = "";

// what a stream asks of the machine that runs it: the viewer, their login, the app
type StreamAsk = { user: string; admin: boolean; host: string; login: string; path: string; name: string };

const viewerOf = (ws: Conn): as.Viewer => ({
  binary: (b) => void ws.binary(b),
  json: (m) => void ws.json(m),
  queued: () => ws.queued(),
  close: (code) => ws.close(code),
});

// input for the app as it comes, held while the app opens
function inputOf(ws: Conn) {
  let app: as.AppSession | undefined;
  const early: unknown[] = [];
  ws.onMessage((d, bin) => {
    if (bin) return;
    let msg: unknown;
    try {
      msg = JSON.parse(String(d));
    } catch {
      return;
    }
    if (app) app.input(msg);
    else if (early.length < 64) early.push(msg);
  });
  return (a: as.AppSession) => {
    app = a;
    for (const m of early.splice(0)) a.input(m);
  };
}

const startOf = (q: URLSearchParams, argv: string[], name: string): as.Start => ({
  argv,
  name,
  w: num(q, "w", 1280),
  h: num(q, "h", 720),
  sw: num(q, "sw", 1920),
  sh: num(q, "sh", 1080),
  scale: Math.min(3, num(q, "dpr", 1)),
  full: q.get("full") === "1",
  fps: q.has("fps") ? Math.min(240, num(q, "fps", 60)) : undefined,
});

// the app streamed from this machine's afterglow: for a viewer here, or one on
// a peer whose phosphorus checked the app against the viewer's login there
async function runAfterglow(ws: Conn, g: StreamAsk, q: URLSearchParams) {
  const v = viewerOf(ws);
  const take = inputOf(ws);
  let app: as.AppSession | undefined;
  ws.onClose(() => app?.detach(v));
  const owner = `${g.user}\0${g.host}\0${g.login}`;
  try {
    const id = q.get("id") ?? "";
    if (idRe.test(id)) {
      app = as.find(owner, id);
      if (!app) throw new Coded(404, "that app has closed");
    } else {
      if (getPlatform() === "windows" && !g.admin) {
        const at = await consoleUser();
        const me = g.login.split("\\").pop()!.split("@")[0]!.toLowerCase();
        if (!at) throw new Coded(409, `no one is signed in at ${g.host}: a window app runs in the signed-in session`);
        if (at !== me)
          throw new Coded(403, `${g.host}'s window apps run as ${at}, who's signed in there; save a login as them`);
      }
      const link = localAfterglow();
      if (!link) throw new Coded(409, `afterglow isn't set up on ${g.host}: phos setup there installs it`);
      const live = afterglowBusy ? as.find(afterglowBusy.split("\n")[0]!, afterglowBusy.split("\n")[1]!) : undefined;
      if (live) throw new Coded(409, `${g.host} streams one app at a time: close ${live.title} first`);
      ws.json({ t: "opening", name: g.name });
      let mine = "";
      const src = new AfterglowSource({
        link,
        target: g.path,
        virtualDisplay: true,
        done: () => {
          if (afterglowBusy === mine) afterglowBusy = "";
        },
      });
      app = await as.launch(owner, src, startOf(q, [], g.name)).then(
        (a) => (note(g.user, "host_app_open", { host: g.host, app: g.path }), a),
        (err) => {
          note(g.user, "host_app_open", { host: g.host, app: g.path }, err);
          throw err;
        },
      );
      mine = `${owner}\n${app.id}`;
      afterglowBusy = mine;
    }
    if (!ws.open()) return;
    app.attach(v);
    take(app);
  } catch (e) {
    ws.json({ t: "error", s: errText(e) });
    ws.close(1000);
  }
}

// a viewer here, the app on a peer: its socket spliced onto the peer's, frames
// dropped here to a keyframe while the viewer is behind
async function forwardAfterglow(ws: Conn, g: StreamAsk, q: URLSearchParams) {
  const early: string[] = [];
  let up: Conn | undefined;
  ws.onMessage((d, bin) => {
    if (bin) return;
    if (up?.open()) up.text(String(d));
    else if (early.length < 64) early.push(String(d));
  });
  ws.onClose(() => up?.close(1000));
  const ip = peers.peerIPs()[g.host] ?? (await tailnetIP(g.host));
  if (!ip) {
    ws.json({ t: "error", s: `${g.host} has no tailnet address here` });
    return ws.close(1000);
  }
  const fq = new URLSearchParams(q);
  fq.set("hop", "1");
  try {
    up = await dial(
      `ws://${ip}:${port}/api/hostdesk/${g.host}/stream?${fq}`,
      { [whoHeader]: users.SealGrant({ x: "stream", ...g }, 60_000) },
      10_000,
    );
  } catch (e) {
    ws.json({ t: "error", s: `${g.host}'s phosphorus didn't answer: ${errText(e)}` });
    return ws.close(1000);
  }
  if (!ws.open()) return up.close(1000);
  const u = up;
  const pass = as.relayFrames(
    { send: (d) => void (typeof d === "string" ? ws.text(d) : ws.binary(d)), queued: () => ws.queued() },
    { send: (d) => void (typeof d === "string" ? u.text(d) : u.binary(d)), queued: () => u.queued() },
  );
  u.onMessage((d, bin) => pass(bin ? (d as Uint8Array) : String(d), bin));
  u.onClose(() => ws.close(1000));
  for (const m of early.splice(0)) u.text(m);
}

// the apps a viewer has open on a peer's afterglow, asked of that peer
async function peerList(w: Who, login: string): Promise<{ id: string; title: string; name: string }[]> {
  const ip = peers.peerIPs()[w.host];
  if (!ip) return [];
  try {
    const r = await fetch(`http://${ip}:${port}/api/hostdesk/${w.host}/running?hop=1`, {
      headers: { [whoHeader]: users.SealGrant({ x: "running", user: w.s.user, host: w.host, login }, 30_000) },
      signal: AbortSignal.timeout(5000),
    });
    const j = (await r.json()) as { apps?: { id: string; title: string; name: string }[] };
    return Array.isArray(j.apps) ? j.apps : [];
  } catch {
    return [];
  }
}

// a peer asking for its viewer's apps open here
async function hopList(c: Ctx, pathname: string): Promise<Response> {
  const m = deskRe.exec(pathname);
  if (!m || m[2] !== "running" || m[1] !== selfHost || !(await isTailnet(c)))
    return sendJSON(403, { error: "forbidden" });
  const g = users.OpenGrant(c.req.headers.get(whoHeader) ?? "");
  if (!g || g.x !== "running" || g.host !== selfHost) return sendJSON(403, { error: "forbidden" });
  const owner = `${str(g.user)}\0${selfHost}\0${str(g.login)}`;
  const apps = as.list(owner).map((a) => ({ id: a.id, title: a.title, name: a.start.name }));
  return sendJSON(200, { apps }, { "Cache-Control": "no-store" });
}

// /api/hostdesk/<host>/stream: one app's window; ?path= a desktop entry, shortcut or
// program the host listed opens it, ?id= takes up one already open. ?hop=1: a peer's
// viewer, the app on this machine
export async function streamSocket(
  c: Ctx,
  pathname: string,
  q: URLSearchParams,
): Promise<Response | undefined | false> {
  const m = streamRe.exec(pathname);
  if (!m) return false;
  if (q.has("hop")) {
    if (m[1] !== selfHost || !(await isTailnet(c))) return refuse(403);
    const g = users.OpenGrant(c.req.headers.get(whoHeader) ?? "");
    if (!g || g.x !== "stream" || g.host !== selfHost) return refuse(403);
    const ask: StreamAsk = {
      user: str(g.user),
      admin: g.admin === true,
      host: selfHost,
      login: str(g.login),
      path: str(g.path),
      name: str(g.name),
    };
    const ok = upgrade(c, (ws) => {
      ws.keepAlive();
      void runAfterglow(ws, ask, q);
    });
    return ok ? undefined : refuse(400);
  }
  if (!sameOrigin(c)) return refuse(403);
  const u = await users.Soon(c);
  if (!u || u.boot) return refuse(401);
  const w: Who = { s: u, host: m[1]! };
  if (!known(w.host)) return refuse(404);
  const ok = upgrade(c, (ws) => {
    ws.keepAlive();
    void runStream(ws, w, q);
  });
  return ok ? undefined : refuse(400);
}

async function runStream(ws: Conn, w: Who, q: URLSearchParams) {
  // input that comes before a listener is set waits on the socket for the first one
  let s: hd.Session | undefined;
  try {
    if (osOf(w.host) !== "windows" && !(w.host === selfHost && getPlatform() === "windows")) s = await session(w);
    if (!s || s.os === "windows") return await streamWindows(ws, w, q);
  } catch (e) {
    ws.json({ t: "error", s: errText(e) });
    return ws.close(1000);
  }
  const v = viewerOf(ws);
  const take = inputOf(ws);
  let app: as.AppSession | undefined;
  ws.onClose(() => app?.detach(v));
  const path = q.get("path") ?? "";
  try {
    const [login] = await users.HostLogin(w.s, w.host);
    const owner = keyOf(w, login);
    const id = q.get("id") ?? "";
    if (idRe.test(id)) {
      app = as.find(owner, id);
      if (!app) throw new Coded(404, "that app has closed");
    } else {
      const p = allowed(s, path);
      const e = await entryOf(s, p);
      ws.json({ t: "opening", name: e.name });
      const st = startOf(q, e.argv, e.name);
      st.fps ??= 60;
      app = await as.launch(owner, runnerOf(s), st).then(
        (a) => (note(w.s.user, "host_app_open", { host: w.host, app: p }), a),
        (err) => {
          note(w.s.user, "host_app_open", { host: w.host, app: p }, err);
          throw err;
        },
      );
    }
    if (!ws.open()) return;
    app.attach(v);
    take(app);
  } catch (e) {
    ws.json({ t: "error", s: errText(e) });
    ws.close(1000);
  }
}

// a Windows host's window app: checked here against the viewer's login (its start menu
// listed it), run by that host's own phosphorus, this one's or a peer's
async function streamWindows(ws: Conn, w: Who, q: URLSearchParams): Promise<void> {
  if (!phosphorusOn(w.host))
    throw new Coded(409, `window apps stream from a Windows host through its own phosphorus; ${w.host} doesn't run it`);
  const [login, , saved] = await users.HostLogin(w.s, w.host);
  if (!saved) throw new Coded(403, `save a login for ${w.host} first: profile, the hosts you log into`);
  const g: StreamAsk = { user: w.s.user, admin: w.s.admin, host: w.host, login, path: "", name: "" };
  if (!idRe.test(q.get("id") ?? "")) {
    const s = await session(w);
    const p = allowed(s, q.get("path") ?? "");
    if (!winAppRe.test(p)) throw new Coded(400, "not a window app");
    g.path = p;
    g.name = (p.split(/[\/]/).pop() ?? p).replace(winAppRe, "");
  }
  if (w.host === selfHost) return runAfterglow(ws, g, q);
  return forwardAfterglow(ws, g, q);
}
