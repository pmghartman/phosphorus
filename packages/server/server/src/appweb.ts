// a host's Electron app served to the browser: its own renderer runs in the page, its own
// main process on the host is the backend, reached over the viewer's saved ssh login
// /api/appweb/<host>/socket   the app's link: ?path= a launcher the host listed, ?id= one open
// /api/appweb/r|x/<key>/...   its documents, files and sendSync, by the keys the socket gave

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as aw from "@phosphorus/appweb";
import * as hd from "@phosphorus/hostdesk";
import * as users from "@phosphorus/users";
import { DataDir, errText, logf as log } from "@phosphorus/util";
import { type Conn, type Ctx, upgrade } from "@phosphorus/wsock";
import { allowed, Coded, keyOf, known, note, session, type Who } from "./hostdesk.ts";
import { isLocalOrPeer, refuse, sameOrigin } from "./http.ts";
import { originOf } from "./oauth.ts";

const prefix = "/api/appweb";
const sockRe = /^\/api\/appweb\/([a-z0-9][a-z0-9-]*)\/socket$/;
const idRe = /^[0-9a-f]{24}$/;
const perOwner = 6;

// the resource keys' secret, kept so a browser's cache of an app's files outlives a restart
function loadSecret() {
  const f = join(DataDir, "appweb.key");
  try {
    const b = readFileSync(f);
    if (b.length === 32) return aw.setSecret(b);
  } catch {}
  const b = randomBytes(32);
  try {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, b, { mode: 0o600 });
  } catch {}
  aw.setSecret(b);
}
loadSecret();

// the app's documents and files: their keys are the grant, the page that asks has no cookie
export async function appwebRoute(c: Ctx, pathname: string): Promise<Response | undefined> {
  if (!pathname.startsWith(`${prefix}/r/`) && !pathname.startsWith(`${prefix}/x/`)) return;
  if (!(await isLocalOrPeer(c))) return refuse(403);
  return aw.handle(c.req, c.url, prefix, originOf(c));
}

// the host as the app's launcher reaches it: its ssh connection, kept on the session
function hostOf(s: hd.Session) {
  s.extra.appweb ??= {
    ...aw.sshHost(s.client as unknown as aw.SshClient, s.os),
    output: (cmd: string) => s.exec(cmd),
  };
  return s.extra.appweb as aw.Host & { output(cmd: string): Promise<string> };
}

// a launcher the host listed: a shortcut or program on Windows, a desktop entry on Linux
async function targetOf(s: hd.Session, path: string): Promise<aw.Target> {
  if (s.os === "windows") {
    if (!/\.(lnk|exe)$/i.test(path)) throw new Coded(400, "not a program or shortcut");
    return aw.resolve(hostOf(s), path);
  }
  if (!/\.desktop$/.test(path)) throw new Coded(400, "not a desktop entry");
  const e = hd.parseEntry(Buffer.from(await hd.readAll(s, path, 256 << 10)).toString("utf8"));
  if (!e || e.type !== "Application" || e.terminal || !e.exec) throw new Coded(400, "not a window app");
  const t = await aw.resolve(hostOf(s), path, e.exec);
  return { ...t, name: e.name || t.name };
}

const viewerOf = (ws: Conn): aw.Viewer => ({
  binary: (b) => void ws.binary(b),
  json: (m) => void ws.json(m),
  queued: () => ws.queued(),
  close: (code) => ws.close(code),
});

const num = (q: URLSearchParams, k: string, d: number) => {
  const v = Number(q.get(k));
  return Number.isFinite(v) && v > 0 ? v : d;
};

export async function appwebSocket(c: Ctx, pathname: string, q: URLSearchParams): Promise<Response | undefined | false> {
  const m = sockRe.exec(pathname);
  if (!m) return false;
  if (!(await isLocalOrPeer(c)) || !sameOrigin(c)) return refuse(403);
  const u = await users.Soon(c);
  if (!u || u.boot) return refuse(401);
  const w: Who = { s: u, host: m[1]! };
  if (!known(w.host)) return refuse(404);
  const base = `${originOf(c)}${prefix}`;
  const ok = upgrade(c, (ws) => {
    ws.keepAlive();
    void run(ws, w, q, base);
  });
  return ok ? undefined : refuse(400);
}

async function run(ws: Conn, w: Who, q: URLSearchParams, base: string) {
  const v = viewerOf(ws);
  let app: aw.AppWeb | undefined;
  // the page's frames as they come, held while the app starts
  const early: Uint8Array[] = [];
  ws.onMessage((d, bin) => {
    if (!bin) return;
    if (app) app.fromViewer(d as Uint8Array);
    else if (early.length < 256) early.push(d as Uint8Array);
  });
  ws.onClose(() => app?.detach(v));
  const vi: aw.ViewerInfo = {
    w: num(q, "w", 1600),
    h: num(q, "h", 900),
    dpr: Math.min(4, num(q, "dpr", 1)),
    dark: q.get("dark") === "1",
  };
  try {
    const s = await session(w);
    const [login] = await users.HostLogin(w.s, w.host);
    const owner = keyOf(w, login);
    const id = q.get("id") ?? "";
    if (idRe.test(id)) {
      app = aw.find(owner, id);
      if (!app) throw new Coded(404, "that app has closed");
    } else {
      const path = allowed(s, q.get("path") ?? "");
      if (aw.list(owner).length >= perOwner)
        throw new Coded(409, `${perOwner} apps are open on ${w.host} already; close one`);
      const t0 = Date.now();
      const t = await targetOf(s, path);
      if (!t.electron || !t.exe) {
        ws.json({ t: "error", code: "native", s: `${t.name} isn't a web app inside` });
        return ws.close(1000);
      }
      ws.json({ t: "opening", name: t.name });
      const st = await aw.start(hostOf(s), t.exe, t.args).catch((e) => {
        note(w.s.user, "host_app_open", { host: w.host, app: path, via: "web" }, e);
        throw e;
      });
      app = new aw.AppWeb(owner, t.exe, st.link, st.token, st.proc);
      const a = app;
      const born = Date.now();
      a.onEnd = (why) => {
        // gone at once with no window: a copy already open there took it over
        if (Date.now() - born < 8000 && !a.windows.size)
          ws.json({ t: "error", s: `${t.name} is already open on ${w.host}; close it there to open it here` });
        log("[appweb] %s on %s ended: %s", t.name, w.host, why);
      };
      note(w.s.user, "host_app_open", { host: w.host, app: path, via: "web" });
      log("[appweb] %s on %s hooked in %dms", t.name, w.host, Date.now() - t0);
    }
    if (!ws.open()) return;
    await app.attach(v, vi, base);
    for (const b of early.splice(0)) app.fromViewer(b);
  } catch (e) {
    ws.json({ t: "error", s: errText(e) });
    ws.close(1000);
  }
}

// the apps a viewer has open on a host, for the desk to offer back after a reload
export function running(owner: string) {
  return aw.list(owner).map((a) => ({ id: a.id, title: a.title, name: a.info?.name ?? "", web: true }));
}
