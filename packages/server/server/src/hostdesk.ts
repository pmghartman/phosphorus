// host desktop: any computer on the tailnet opened as its own desktop, as the
// viewer's saved login for it; open to every signed in user with one

import { join } from "node:path";
import { AfterglowSource, Link, type Proc, pathsOf, readLink } from "@phosphorus/afterglow";
import * as as from "@phosphorus/appstream";
import * as hd from "@phosphorus/hostdesk";
import { auditRow } from "@phosphorus/mcp";
import * as peers from "@phosphorus/peers";
import * as users from "@phosphorus/users";
import { DataDir, errText, logf as log, tailnetIP } from "@phosphorus/util";
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

const deskRe = /^\/api\/hostdesk\/([a-z0-9][a-z0-9-]*)\/([a-z-]+)$/;
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

type Cached = { desk: hd.Desk; apps?: hd.Item[]; icons: string[] };

async function session(w: Who): Promise<hd.Session> {
  const [user, pass, ok] = await users.HostLogin(w.s, w.host);
  if (!ok) throw new Coded(403, `save a login for ${w.host} first: profile, the hosts you log into`);
  const t0 = Date.now();
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
    log("[hostdesk] %s: ssh and probes up in %dms", w.host, Date.now() - t0);
    note(w.s.user, "host_desktop", { host: w.host, login: user });
    // what an earlier visit issued, so the cache draws before the probe answers
    const k = hd.cacheJSON<Cached>(w.host, cacheKey(w));
    if (k?.desk) {
      for (const i of k.icons ?? []) c.icons.add(i);
      c.desk = k.desk;
    }
  }
  return s;
}

function remember(w: Who, s: hd.Session) {
  const c = hd.ctxOf(s);
  if (!c.desk) return;
  const k: Cached = { desk: c.desk, apps: c.apps, icons: [...c.icons] };
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

// the path asked for made clean; the host's own permissions for the login decide the rest
function allowed(s: hd.Session, p: string): string {
  const ok = hd.norm(p, s.os === "windows");
  if (!ok) throw new Coded(400, "not a full path");
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
  if (q.has("hop")) return await hopRoute(c, pathname, method);
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
    if (method === "POST") return await postOp(w, op, c, q);
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
      const t0 = Date.now();
      const desk = await hd.desktop(s);
      log("[hostdesk] %s: desktop read in %dms", w.host, Date.now() - t0);
      remember(w, s);
      void hd.prefetch(s, w.host, [...desk.icons, ...desk.pins]).catch(() => {});
      return sendJSON(200, { desk }, nc);
    }
    case "apps": {
      const apps = await hd.apps(s);
      remember(w, s);
      // every app's icon read from the host in one go, cached before the apps menu asks
      void hd.prefetch(s, w.host, apps, true).catch(() => {});
      return sendJSON(200, { apps }, nc);
    }
    case "icon": {
      const b = await hd.icon(s, w.host, q.get("k") ?? "", q.get("v") ?? "");
      // a miss never kept, so the page's retry asks again
      if (!b) return new Response(null, { status: 404, headers: nc });
      return blobRes(b, "private, max-age=31536000, immutable");
    }
    case "wallpaper": {
      const t0 = Date.now();
      const b = await hd.wallpaper(s, w.host);
      if (!b) return new Response(null, { status: 404, headers: nc });
      log("[hostdesk] %s: wallpaper %dKB in %dms", w.host, Math.round(b.bytes.length / 1024), Date.now() - t0);
      return blobRes(b, "private, max-age=31536000, immutable");
    }
    case "roots":
      return sendJSON(200, { roots: await hd.roots(s) }, nc);
    case "tasks":
      // a Windows host's windows as its own task bar has them, from its afterglow
      return sendJSON(200, await deskOp(w, { op: "tasks" }), nc);
    case "running": {
      const [login] = await users.HostLogin(w.s, w.host);
      // a Windows host's apps run on its own phosphorus: asked there
      if (w.host !== selfHost && osOf(w.host) === "windows" && phosphorusOn(w.host))
        return sendJSON(200, { apps: await peerList(w, login) }, nc);
      const apps = as.list(keyOf(w, login)).map((a) => ({ id: a.id, title: a.title, name: a.start.name }));
      return sendJSON(200, { apps }, nc);
    }
    case "read": {
      const p = allowed(s, q.get("path") ?? "");
      const st = await hd.statOf(s, p);
      if (st.dir) throw new Coded(400, "a folder");
      if (st.size > maxText) return sendJSON(200, { path: p, size: st.size, tooBig: true }, nc);
      const b = await hd.readAll(s, p, maxText);
      if (b.subarray(0, 8000).includes(0)) return sendJSON(200, { path: p, size: st.size, binary: true }, nc);
      return sendJSON(200, { path: p, size: st.size, text: Buffer.from(b).toString("utf8") }, nc);
    }
    case "fs-list": {
      const rel = q.get("path") ?? "";
      // a Windows host's top: its drives
      if (!rel && s.os === "windows") {
        const entries = (await hd.roots(s)).map((r) => ({ name: r.name, dir: true, size: null, mtime: null }));
        return sendJSON(200, { path: "", entries }, nc);
      }
      const ents = await hd.ls(s, allowed(s, deskAbs(rel)));
      const entries = ents.map((e) => ({ name: e.name, dir: e.dir, size: e.dir ? null : e.size, mtime: e.mtime }));
      return sendJSON(200, { path: rel, entries }, nc);
    }
    case "fs-download":
    case "download": {
      const p = allowed(s, op === "fs-download" ? deskAbs(q.get("path") ?? "") : (q.get("path") ?? ""));
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

async function postOp(w: Who, op: string, c: Ctx, q: URLSearchParams): Promise<Response> {
  if (op === "fs-upload") return upload(w, c, q);
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
    case "open": {
      const it = await hd.open(s, allowed(s, str(p.path)));
      return sendJSON(200, { item: it, phosphorus: phosphorusOn(w.host) });
    }
    case "fs-mkdir": {
      const path = allowed(s, deskAbs(str(p.path)));
      return audited("host_files_mkdir", { path }, async () => (await hd.mkdir(s, path), {}));
    }
    case "fs-rename":
    case "fs-copy": {
      const from = allowed(s, deskAbs(str(p.from)));
      const to = allowed(s, deskAbs(str(p.to)));
      if (op === "fs-copy")
        return audited("host_files_copy", { from, to }, async () => (await hd.copyFile(s, from, to), {}));
      return audited("host_files_move", { from, to }, async () => (await hd.rename(s, from, to), {}));
    }
    case "end": {
      const pid = Number(p.pid);
      const started = Number(p.started) || 0;
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Coded(400, "bad pid");
      const a: DeskAsk = { op: "end", pid, started, kill: p.kill === true, shell: p.shell === true };
      return audited("host_app_end", { pid, name: str(p.name), kill: a.kill, shell: a.shell }, () => deskOp(w, a));
    }
    case "recycle": {
      // a desk icon's own file (a shortcut, never what it names) to the host user's Recycle
      // Bin, by afterglow as them: only what the desktop shows, read again now
      const path = allowed(s, str(p.path));
      if (!deskWin(w.host)) throw new Coded(409, `only a Windows host's desk icons go to its Recycle Bin`);
      const desk = await hd.desktop(s);
      remember(w, s);
      const own = (i: hd.Item) => hd.norm(i.file ?? i.path ?? "", true);
      if (!desk.icons.some((i) => i.kind !== "bin" && own(i) === path))
        throw new Coded(400, `${path} isn't on ${w.host}'s desktop`);
      return audited("host_files_recycle", { path }, () => deskOp(w, { op: "recycle", path }));
    }
    case "fs-delete": {
      const path = allowed(s, deskAbs(str(p.path)));
      return audited("host_files_delete", { path }, async () => (await hd.remove(s, path), {}));
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

// a host's disk as the files app names it: C:/Users/ann, home/ann; the path as the host does
const deskAbs = (rel: string) =>
  /^[A-Za-z]:/.test(rel) ? `${rel.slice(0, 2)}\\${rel.slice(3).replace(/\//g, "\\")}` : `/${rel}`;

const maxPiece = 8 << 20;

// one piece of an upload to a host's disk, written at its offset over the viewer's login
async function upload(w: Who, c: Ctx, q: URLSearchParams): Promise<Response> {
  const s = await session(w);
  const path = allowed(s, deskAbs(q.get("path") ?? ""));
  const offset = Number(q.get("offset") ?? 0);
  const total = Number(q.get("total") ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Coded(400, "bad offset");
  const raw = await readRaw(c, maxPiece);
  if (raw === undefined) return sendJSON(413, { error: "too big" });
  await hd.writeAt(s, path, offset, raw);
  if (offset + raw.length >= total) note(w.s.user, "host_files_upload", { host: w.host, path, size: total });
  return sendJSON(200, { path: q.get("path") ?? "", size: offset + raw.length });
}

// --- app streaming ---------------------------------------------------------------------

const streamRe = /^\/api\/hostdesk\/([a-z0-9][a-z0-9-]*)\/stream$/;
const idRe = /^[0-9a-f]{24}$/;

// the host's connection as commands to run: the stream's afterglow, or its agent and encoder
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
// pid and started: a process already running taken up in place of path (attached to)
type StreamAsk = {
  user: string;
  admin: boolean;
  host: string;
  login: string;
  path: string;
  name: string;
  pid?: number;
  started?: number;
};

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
      await asConsole(g);
      const link = localAfterglow();
      if (!link)
        throw new Coded(409, `afterglow isn't set up on ${g.host} yet: its next phosphorus update installs it`);
      const live = afterglowBusy ? as.find(afterglowBusy.split("\n")[0]!, afterglowBusy.split("\n")[1]!) : undefined;
      if (live) throw new Coded(409, `${g.host} streams one app at a time: close ${live.title} first`);
      ws.json({ t: "opening", name: g.name });
      let mine = "";
      // the desktop's own link let go first: afterglow takes one driver at a time
      await idleOpening?.catch(() => {});
      dropIdle();
      const src: AfterglowSource = new AfterglowSource({
        link,
        target: g.pid ? "" : g.path,
        ...(g.pid ? { attach: { pid: g.pid, ...(g.started ? { started: g.started } : {}) } } : {}),
        virtualDisplay: true,
        done: () => {
          if (afterglowBusy === mine) afterglowBusy = "";
          if (liveSrc === src) liveSrc = undefined;
        },
      });
      liveSrc = src;
      const [tool, what] = g.pid
        ? ["host_app_attach", { host: g.host, pid: g.pid, app: g.name }]
        : ["host_app_open", { host: g.host, app: g.path }];
      const going = as.launch(owner, src, startOf(q, [], g.name));
      liveOpening = going;
      app = await going
        .then(
          (a) => (note(g.user, tool, what), a),
          (err) => {
            note(g.user, tool, what, err);
            if (liveSrc === src) liveSrc = undefined;
            throw err;
          },
        )
        .finally(() => {
          if (liveOpening === going) liveOpening = undefined;
        });
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

// a peer asking for its viewer's apps open here, or of this machine's desktop through afterglow
async function hopRoute(c: Ctx, pathname: string, method: string): Promise<Response> {
  const m = deskRe.exec(pathname);
  if (!m || (m[2] !== "running" && m[2] !== "desk") || m[1] !== selfHost || !(await isTailnet(c)))
    return sendJSON(403, { error: "forbidden" });
  const g = users.OpenGrant(c.req.headers.get(whoHeader) ?? "");
  if (!g || g.x !== m[2] || g.host !== selfHost) return sendJSON(403, { error: "forbidden" });
  if (m[2] === "desk") {
    if (method !== "POST") return sendJSON(405, { error: "method" });
    const a = deskAskOf(g);
    if (!a) return sendJSON(400, { error: "bad ask" });
    try {
      return sendJSON(200, await deskHere({ user: str(g.user), admin: g.admin === true, login: str(g.login) }, a), {
        "Cache-Control": "no-store",
      });
    } catch (e) {
      return sendJSON(...fail(e));
    }
  }
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
      pid: posInt(g.pid),
      started: posInt(g.started),
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
  const pid = posInt(q.get("pid"));
  if (pid && !idRe.test(q.get("id") ?? "")) {
    // a window already up on the host, taken up where it runs: its pid and start time from
    // the host's task list, afterglow refusing one that has gone or isn't the viewer's
    g.pid = pid;
    g.started = posInt(q.get("started"));
    g.name = (q.get("name") ?? "").slice(0, 120) || `pid ${pid}`;
  } else if (!idRe.test(q.get("id") ?? "")) {
    const s = await session(w);
    const p = allowed(s, q.get("path") ?? "");
    if (!winAppRe.test(p)) throw new Coded(400, "not a window app");
    g.path = p;
    g.name = (p.split(/[\/]/).pop() ?? p).replace(winAppRe, "");
  }
  if (w.host === selfHost) return runAfterglow(ws, g, q);
  return forwardAfterglow(ws, g, q);
}

// --- a Windows host's own desktop through its afterglow: the windows up on it listed, each
// ended as its close button would or killed, a desk icon's file put in the Recycle Bin. All
// as the user signed in at its console, the viewer's login checked against them as a stream is

const posInt = (v: unknown) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

// a host whose desktop afterglow serves: a Windows host running phosphorus
const deskWin = (h: string) =>
  h === selfHost ? getPlatform() === "windows" : osOf(h) === "windows" && phosphorusOn(h);

type DeskAsk =
  | { op: "tasks" }
  | { op: "end"; pid: number; started: number; kill: boolean; shell: boolean }
  | { op: "recycle"; path: string };

// one of the host's windows as the task bar shows it: the process, its windows topmost first
export type Task = {
  pid: number;
  started: number;
  name: string;
  exe: string;
  windows: [number, string][];
  // the desktop shell: ended only when the viewer says so, never streamed
  shell: boolean;
};

const shellRe = /^explorer\.exe$/i;
const taskOf = (p: Proc): Task => ({
  pid: p.pid,
  started: p.started,
  name: p.name,
  exe: p.exe,
  windows: p.windows.slice(0, 16).map(([id, t]) => [id, String(t).slice(0, 200)]),
  shell: shellRe.test(p.name),
});

function deskAskOf(g: Record<string, unknown>): DeskAsk | undefined {
  if (g.op === "tasks") return { op: "tasks" };
  if (g.op === "end" && posInt(g.pid))
    return {
      op: "end",
      pid: posInt(g.pid),
      started: posInt(g.started),
      kill: g.kill === true,
      shell: g.shell === true,
    };
  if (g.op === "recycle" && typeof g.path === "string" && g.path) return { op: "recycle", path: g.path };
}

// the viewer acts as whoever is signed in at this Windows machine's console, as an admin may
async function asConsole(g: { admin: boolean; login: string; host?: string }) {
  if (getPlatform() !== "windows" || g.admin) return;
  const h = g.host || selfHost;
  const at = await consoleUser();
  const me = g.login.split("\\").pop()!.split("@")[0]!.toLowerCase();
  if (!at) throw new Coded(409, `no one is signed in at ${h}: a window app runs in the signed-in session`);
  if (at !== me) throw new Coded(403, `${h}'s window apps run as ${at}, who's signed in there; save a login as them`);
}

// the link the desktop's asks take: the streaming app's own while one is up, else one of
// the desktop's, kept a minute after its last ask
let liveSrc: AfterglowSource | undefined;
let liveOpening: Promise<unknown> | undefined;
let idleLink: { link: Link; t: ReturnType<typeof setTimeout> } | undefined;
let idleOpening: Promise<Link> | undefined;
const idleMs = 60_000;

function dropIdle() {
  const i = idleLink;
  idleLink = undefined;
  if (!i) return;
  clearTimeout(i.t);
  i.link.close("a stream took the link");
}

async function deskLink(): Promise<Link> {
  // an app starting: its link, once it's up, never one opened over it
  if (liveOpening) await liveOpening.catch(() => {});
  const on = liveSrc?.linkNow;
  if (on) return on;
  const i = idleLink;
  if (i?.link.alive) {
    clearTimeout(i.t);
    i.t = setTimeout(() => i.link.close("idle"), idleMs);
    return i.link;
  }
  idleOpening ??= (async () => {
    const addr = localAfterglow();
    if (!addr)
      throw new Coded(409, `afterglow isn't set up on ${selfHost} yet: its next phosphorus update installs it`);
    const link: Link = new Link(addr, {
      message: () => {},
      closed: () => {
        if (idleLink?.link !== link) return;
        clearTimeout(idleLink.t);
        idleLink = undefined;
      },
    });
    await link.open();
    idleLink = { link, t: setTimeout(() => link.close("idle"), idleMs) };
    return link;
  })().finally(() => {
    idleOpening = undefined;
  });
  return idleOpening;
}

// an ask over the desktop's link, once more on a fresh one when a stream took it mid-ask;
// the host's refusal its own words
async function withLink<T>(f: (l: Link) => Promise<T>): Promise<T> {
  for (let n = 0; ; n++) {
    try {
      return await f(await deskLink());
    } catch (e) {
      if (e instanceof Coded) throw e;
      const why = errText(e);
      if (n === 0 && why.startsWith("afterglow closed the link")) continue;
      throw new Coded(409, why);
    }
  }
}

// an ask of this machine's afterglow, for a viewer here or one a peer checked
async function deskHere(
  g: { user: string; admin: boolean; login: string },
  a: DeskAsk,
): Promise<Record<string, unknown>> {
  if (getPlatform() !== "windows") throw new Coded(409, `${selfHost}'s desktop isn't served by afterglow`);
  await asConsole(g);
  return withLink(async (link) => {
    const can = new Set(link.ready?.features ?? []);
    const need = (f: string, what: string) => {
      if (!can.has(f)) throw new Coded(409, `${selfHost}'s afterglow can't ${what} yet: update afterglow`);
    };
    switch (a.op) {
      case "tasks": {
        const features = [...can];
        if (!can.has("processes")) return { features, list: [] };
        const list = (await link.processes()).filter((p) => p.windows.length > 0).map(taskOf);
        return { features, list };
      }
      case "end": {
        need("processes", "end an app");
        const r = await link.end(a.pid, { ...(a.started ? { started: a.started } : {}), kill: a.kill, shell: a.shell });
        return { how: r.how, gone: r.gone };
      }
      case "recycle":
        need("delete", "delete a file");
        return { recycled: (await link.delete(a.path)).recycled };
    }
  });
}

// the ask where the host's afterglow is: here, or the Windows host's own phosphorus
async function deskOp(w: Who, a: DeskAsk): Promise<Record<string, unknown>> {
  if (!deskWin(w.host)) {
    if (a.op === "tasks") return { features: [], list: [] };
    throw new Coded(409, `${w.host}'s desktop isn't served by afterglow: a Windows host running phosphorus is`);
  }
  const [login] = await users.HostLogin(w.s, w.host);
  if (w.host === selfHost) return deskHere({ user: w.s.user, admin: w.s.admin, login }, a);
  const ip = peers.peerIPs()[w.host] ?? (await tailnetIP(w.host));
  if (!ip) throw new Coded(404, `${w.host} has no tailnet address here`);
  const grant = users.SealGrant({ x: "desk", user: w.s.user, admin: w.s.admin, host: w.host, login, ...a }, 30_000);
  let r: Response;
  try {
    r = await fetch(`http://${ip}:${port}/api/hostdesk/${w.host}/desk?hop=1`, {
      method: "POST",
      headers: { [whoHeader]: grant },
      signal: AbortSignal.timeout(a.op === "recycle" ? 160_000 : 45_000),
    });
  } catch (e) {
    throw new Coded(502, `${w.host}'s phosphorus didn't answer: ${errText(e)}`);
  }
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Coded(r.status, String(j.error ?? `${w.host} refused it`));
  return j;
}
