// host desktop: any computer on the tailnet opened as its own desktop, as the
// viewer's saved login for it; open to every signed in user with one

import * as hd from "@phosphorus/hostdesk";
import { auditRow } from "@phosphorus/mcp";
import * as peers from "@phosphorus/peers";
import * as users from "@phosphorus/users";
import { errText, tailnetIP } from "@phosphorus/util";
import type { Ctx } from "@phosphorus/wsock";
import { getPlatform, hostSSHHost, hostSSHPort, selfHost } from "./config.ts";
import { isLocalOrPeer, maxJSONBody, maxSaveBody, type Res, readRaw, sameOrigin, sendJSON } from "./http.ts";
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
