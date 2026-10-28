// every request on the frontend port, and the ingress's leftovers
import { join } from "node:path";
import * as chatmedia from "@phosphorus/chatmedia";
import { intervalMS, markHot } from "@phosphorus/util";
import { Write as collabWrite } from "@phosphorus/collab";
import { Keys as envKeys } from "@phosphorus/envfile";
import * as files from "@phosphorus/files";
import * as git from "@phosphorus/git";
import { type Caller, handle as mcpHandle } from "@phosphorus/mcp";
import * as peers from "@phosphorus/peers";
import * as mirror from "@phosphorus/mirror";
import { Assign, EraseSlots, ServeChat, ServeMessages, ServeModels } from "@phosphorus/model";
import { favicon, faviconWhy, requestURI } from "@phosphorus/proxy";
import { setPublic } from "@phosphorus/services";
import * as store from "@phosphorus/store";
import * as term from "@phosphorus/term";
import * as update from "@phosphorus/update";
import * as users from "@phosphorus/users";
import * as webapps from "@phosphorus/webapps";
import { errText, peerCall, tailnetIP } from "@phosphorus/util";
import { blocks, highlight, markdown } from "@phosphorus/web-md";
import { serveStatic } from "@phosphorus/webstatic";
import { type Ctx, isUpgrade } from "@phosphorus/wsock";
import { codeRoute } from "./code.ts";
import { adminPass, port, selfHost, setUpdating } from "./config.ts";
import { configOp, hostLogs, localUI } from "./hostops.ts";
import {
  crossSite, forbidden, isBrowser, isLocalOrPeer, isLoopback, isTailnet, maxJSONBody, maxSaveBody, maxTextBody, onJSON, pageUser, plain, readRaw, type Res,
  sameOrigin, sendJSON,
} from "./http.ts";
import { decode, obj, str, truthy } from "./js.ts";
import { mcpCallsMesh, peerOp } from "./mcpops.ts";
import { oauthRoute, Unauthorized } from "./oauth.ts";
import { buildState, chainAction, forwardGame, mintGuestKey, noteState, runGameLocally, snapshot } from "./server.ts";
import { filesInfo, forwardFiles, homeFilterResults, homeWho, pingPeer, runGrant, sendFile, serveRun, withHop, writeP } from "./shares.ts";
import { onUpgrade } from "./ws.ts";

const gitForceRe = /^\/api\/githosts\/([A-Za-z0-9-]{1,63})\/force$/;
const gameRe = /^\/api\/games\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)\/(start|stop)$/;
const mediaRe = /^\/api\/chat\/media\/([a-z0-9][a-z0-9-]*)\/([0-9a-f]{32})$/;
const runRe = /^\/api\/run\/([a-z0-9][a-z0-9-]*)\/([A-Za-z0-9_-]+)\/(.*)$/;
const mirrorRe = /^\/internal\/mirror\/([0-9a-f]{24})$/;
const appsTarRe = /^\/internal\/apps\/([a-z][a-z0-9-]*)\/(\d+(?:\.\d+){0,3})$/;
const appsSvcRe = /^\/api\/apps\/services\/(install|update|remove)$/;
const appsSvcIconRe = /^\/api\/apps\/services\/([a-z][a-z0-9-]*)\/icon$/;
const appsIconRe = /^\/api\/apps\/([a-z][a-z0-9-]*)\/icon$/;
const hostRe = /^[a-z0-9][a-z0-9-]*$/;
const pingRe = /^\/api\/ping\/([a-z0-9-]+)$/;
const filesRe = /^\/api\/files\/([a-z0-9][a-z0-9-]*)\/(info|list|tree|search|read|download|upload|save|mkdir|rename|delete|run|mirror|own)$/;
const publicRe = /^\/api\/services\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)\/public$/;
const faviconRe = /^\/api\/favicon\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/;

// loginRe a machine account's name, as a home is handed to one
const loginRe = /^[a-z_][a-z0-9_.-]{0,31}$/;

type UserCall = (s: users.Session | undefined, p: Record<string, any>, c: Ctx) => users.R | Promise<users.R>;

const userCalls: Record<string, UserCall> = {
  "GET /api/me": async (s, _p, c) => {
    if (!s) return { status: 401, body: { error: "log in", setup: await users.Setup() } };
    return { status: 200, body: await users.Me(s), cookie: users.Refresh(c, s) };
  },
  "POST /api/login": (_s, p, c) => users.Login(p, c),
  "POST /api/logout": (_s, _p, c) => ({ status: 200, body: { ok: true }, cookie: users.ClearCookie(c) }),
  "POST /api/me/vault": (s, p) => users.SetVault(s, p),
  "POST /api/me/prefs": (s, p) => users.SetPrefs(s, p),
  "POST /api/me/wallpaper": (s, p) => users.SetWallpaper(s, p),
  "POST /api/me/password": (s, p, c) => users.ChangePass(s, p, c),
  "GET /api/me/mcp": async (s) => {
    if (!s || s.boot) return { status: 403, body: { error: "log in as a user" } };
    const out = await mcpCallsMesh(s.user);
    out.configured = users.HasMCPKey(s.user);
    return { status: 200, body: out };
  },
  "POST /api/me/mcp-revoke": (s, p) => users.MCPRevoke(s, p),
  "POST /api/me/anthropic": (s, p) => users.SetAnthropic(s, p),
  "GET /api/users": (s) => users.List(s),
  "POST /api/users": (s, p) => users.Create(s, p),
  "POST /api/users/admin": (s, p) => users.SetAdmin(s, p),
  "POST /api/users/delete": (s, p) => users.Remove(s, p),
};

const hopErr = (host: string): Res => [421, { error: `sent to ${selfHost}, which isn't ${host}` }];

const noPeer = (host: string): Res => [502, { error: `can't find ${host} on the tailnet` }];

// appHandler every request on the frontend port, and the ingress's leftovers
export async function appHandler(c: Ctx): Promise<Response | undefined> {
  const pathname = c.url.pathname;
  const q = c.url.searchParams;
  const method = c.req.method;

  if (crossSite(c)) return forbidden();
  if (isUpgrade(c.req)) return onUpgrade(c, pathname, q);

  if (method === "GET" && (pathname === "/api/state" || pathname === "/api/mesh/snapshot" || pathname === "/api/update/local/status")) {
    if (!(await isLocalOrPeer(c))) return forbidden();
    if (pathname === "/api/state") {
      const s = buildState();
      noteState(s);
      s.pollMs = intervalMS();
      return sendJSON(200, s);
    }
    if (pathname === "/api/mesh/snapshot") return sendJSON(200, snapshot(q));
    return sendJSON(200, update.status());
  }
  if (pathname === "/api/sys/stamps" && method === "GET") {
    if (!(await isTailnet(c))) return forbidden();
    return sendJSON(200, store.stamps());
  }
  if (pathname === "/api/sys/sync" && method === "GET") {
    if (!(await isTailnet(c))) return forbidden();
    let rels: string[] | undefined;
    const v = q.get("rels");
    if (v) rels = v.split(",").slice(0, 200);
    return sendJSON(200, store.dump(rels));
  }
  if (pathname === "/api/me/wallpaper" && method === "GET") {
    if (!(await isLocalOrPeer(c))) return forbidden();
    const [t, b] = users.Wallpaper(users.Of(c));
    if (!b) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    return new Response(b as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: { "Content-Type": t, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
    });
  }

  // an agent's sign-in: from anywhere, the ingress included
  if (pathname.startsWith("/.well-known/oauth-") || pathname.startsWith("/oauth/")) {
    const r = await oauthRoute(c, pathname);
    if (r) return r;
  }
  const call = userCalls[method + " " + pathname];
  if (call) {
    if (!(await isLocalOrPeer(c)) || (method === "POST" && !sameOrigin(c))) return forbidden();
    const reply = (o: users.R) => {
      // live state, never served from a cache
      const res = sendJSON(o.status, o.body, { "Cache-Control": "no-store" });
      for (const ck of o.cookie ?? []) res.headers.append("Set-Cookie", ck);
      return res;
    };
    if (method === "GET") return reply(await call(await users.Soon(c), {}, c));
    let max = maxJSONBody;
    if (pathname === "/api/me/wallpaper") max = Math.trunc((users.MaxWall * 14 + 9) / 10) + 1024;
    const b = await readRaw(c, max);
    if (b === undefined) return plain(400, "bad request");
    const p = obj(decode(b)) ?? {};
    return reply(await call(await users.Soon(c), p, c));
  }

  if (pathname.startsWith("/api/code/")) {
    const r = await codeRoute(c, pathname, q);
    if (r) return r;
  }

  if (pathname.startsWith("/api/git/")) {
    if (!(await isTailnet(c))) return forbidden();
    if (pathname === "/api/git/vote" && method === "POST") return onJSON(c, maxJSONBody, true, git.vote);
    if (pathname === "/api/git/view" && method === "GET") return sendJSON(200, { states: git.view(), pollMs: intervalMS(), offlineMs: peers.offlineMS() });
    if (pathname === "/api/git/promote" && method === "POST") {
      return onJSON(c, maxJSONBody, false, (p) => {
        const [st, out] = git.promote(p);
        if (st === 200) markHot();
        return [st, out];
      });
    }
  }

  // mesh-wide model picks: this machine, the tailnet, ingress admins
  if (pathname.startsWith("/api/model/") && !isLoopback(c) && !(await isTailnet(c))) {
    const pick = method === "POST" && pathname === "/api/model/agent";
    const s = users.Of(c);
    if (!c.ingress || (pick && (!s || !s.admin))) return forbidden();
  }

  if (pathname === "/api/model/agent" && method === "POST") {
    return onJSON(c, maxJSONBody, true, (p) => {
      const [st, out] = Assign(p);
      if (st === 200) markHot();
      return [st, out];
    });
  }
  if (pathname === "/api/terms/shared" && method === "GET") {
    if (!isLoopback(c) && !(await isTailnet(c))) return forbidden();
    return sendJSON(200, await term.screens(q.get("by") ?? ""));
  }
  if (pathname === "/api/terms/type" && method === "POST") {
    if (!isLoopback(c) && !(await isTailnet(c))) return forbidden();
    return onJSON(c, maxJSONBody, true, async (p) => {
      let ws = Math.trunc(files.jsNumber(p.wait_s)) || 0;
      if (ws < 1) ws = 60;
      try {
        return [200, await term.typeIn(str(p.by), str(p.id), str(p.text), ws, p.run === true)];
      } catch (e) {
        return [500, { error: errText(e) }];
      }
    });
  }
  if (pathname === "/api/mcp" || pathname.startsWith("/api/mcp/")) {
    // a user's key from anywhere, the ingress included; else the mesh's own, unkeyed
    // in the path for a client with no headers of its own, an agent's url connector
    let caller: Caller | undefined;
    const auth = c.req.headers.get("authorization") ?? "";
    let ok = auth.startsWith("Bearer ");
    let key = ok ? auth.slice(7) : "";
    const via = (c.req.headers.get("x-phosphorus-via") ?? "").trim().toLowerCase();
    const inPath = pathname.slice("/api/mcp".length).replace(/^\/+|\/+$/g, "");
    if (inPath) {
      key = inPath;
      ok = true;
    }
    if (ok) {
      const k = key.trim();
      const [s, why] = users.CheckMCPKey(k);
      // the client shown needs-auth, never connected on a refused key, and sent to sign in again
      if (!s) return Unauthorized(c, "key " + why);
      caller = {
        user: s.user, admin: s.admin, via,
        login: (host) => {
          const [user, pass, has] = users.MCPLogin(k, host);
          return has ? { user, pass } : undefined;
        },
        pages: () => users.MCPPages(k),
        hosts: () => Object.entries(users.MCPLogins(k) ?? {}).filter(([, l]) => str(obj(l)?.user) !== "").map(([h]) => h),
      };
    } else if (!isLoopback(c) && !(await isTailnet(c))) return Unauthorized(c);
    if (method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const b = await readRaw(c, maxJSONBody);
    if (b === undefined) return plain(400, "bad request");
    const v = decode(b.length ? b : "{}");
    if (v === undefined || v === null) return sendJSON(400, { error: "invalid json" });
    const [st, body] = await mcpHandle(v, isLoopback(c) && !caller, caller);
    return sendJSON(st, body ?? {});
  }
  if (pathname === "/api/model/v1/chat/completions" && method === "POST") {
    if (!isLoopback(c) && !(await isTailnet(c))) return forbidden();
    const b = await readRaw(c, 16 * 1024 * 1024);
    const p = b === undefined ? undefined : b.length === 0 ? {} : obj(decode(b));
    if (!p) return sendJSON(400, { error: "bad request" });
    return ServeChat(c.req, p, isLoopback(c));
  }
  if (pathname.startsWith("/api/model/v1/messages") && method === "POST") {
    // claude code's Anthropic API on the mesh's models, a user's key its pass
    const b = await readRaw(c, 32 * 1024 * 1024);
    const p = b === undefined ? undefined : obj(decode(b));
    if (!p) return sendJSON(400, { type: "error", error: { type: "invalid_request_error", message: "bad request" } });
    return ServeMessages(c.req, p, pathname.slice("/api/model/v1/messages".length), isLoopback(c) || (await isTailnet(c)), pageUser(c));
  }
  if (pathname === "/api/model/v1/models" && method === "GET") return ServeModels(c.req, isLoopback(c) || (await isTailnet(c)) || pageUser(c));
  if (pathname === "/api/model/purge" && method === "POST") {
    if (!isLoopback(c) && !(await isTailnet(c))) return forbidden();
    try {
      return sendJSON(200, await EraseSlots());
    } catch (e) {
      return sendJSON(502, { error: errText(e) });
    }
  }
  if (pathname === "/api/md" && method === "POST") {
    // the page's own markdown, no parser in the browser
    if (!isBrowser(c)) return forbidden();
    return onJSON(c, maxSaveBody, true, (p) => {
      if (Array.isArray(p.items)) {
        const items = p.items.slice(0, 500);
        return [200, { html: items.map((x) => markdown(str(obj(x)?.text), obj(x)?.breaks !== false)) }];
      }
      const text = str(p.text);
      if (typeof p.highlight === "string") return [200, { html: highlight(text, p.highlight) }];
      if (p.blocks === true) return [200, { blocks: blocks(text) }];
      return [200, { html: markdown(text, p.breaks !== false) }];
    });
  }

  let m = gitForceRe.exec(pathname);
  if (m && method === "POST") {
    // the tailnet and this machine, the public side admins only
    const s = users.Of(c);
    if (c.ingress && (!s || !s.admin)) return forbidden();
    markHot();
    const [st, b] = await git.force(m[1]!);
    return sendJSON(st, b);
  }

  if (pathname === "/api/update/local" && method === "POST") {
    if (!(await isTailnet(c))) return forbidden();
    try {
      return sendJSON(202, { id: update.ask().id });
    } catch (e) {
      return sendJSON(500, { error: errText(e) });
    }
  }
  if (pathname === "/api/update/check" && method === "GET") {
    if (!(await isLocalOrPeer(c))) return forbidden();
    return sendJSON(200, await update.check(q.has("fresh")));
  }
  if (pathname === "/api/update/chain" && method === "POST") {
    if (!isBrowser(c)) return forbidden();
    return onJSON(c, 1024, false, (p) => {
      markHot();
      const s = users.Of(c);
      const admin = (!!s && s.admin) || (adminPass === "" && isLoopback(c));
      return chainAction(str(p.action), str(p.password), admin);
    });
  }
  // the optional apps: the catalogue, what the mesh wants and this host has;
  // an admin's pick followed by every host
  if (pathname === "/api/apps" && method === "GET") {
    if (!(await isLocalOrPeer(c))) return forbidden();
    return sendJSON(200, await webapps.summary(q.has("fresh")));
  }
  if ((pathname === "/api/apps/install" || pathname === "/api/apps/remove") && method === "POST") {
    const s = users.Of(c);
    if (!isBrowser(c) || !((!!s && s.admin) || (adminPass === "" && isLoopback(c)))) return forbidden();
    return onJSON(c, 1024, true, (p) => (pathname === "/api/apps/install" ? webapps.Install(str(p.id)) : webapps.Remove(str(p.id))));
  }
  // a service onto, updated on or off one host, run there as the person's saved login
  // for that host: anyone who logged into the host, admin or not
  m = appsSvcRe.exec(pathname);
  if (m && method === "POST") {
    if (!isBrowser(c) || !sameOrigin(c)) return forbidden();
    const s = await users.Soon(c);
    if (!s || s.boot) return sendJSON(403, { error: "log in as a user" });
    const op = m[1]!;
    return onJSON(c, 1024, true, async (p) => {
      const host = str(p.host);
      if (!hostRe.test(host)) return [400, { error: "pick a host" }];
      const [user, pass, ok] = await users.HostLogin(s, host);
      if (!ok) return [403, { error: `no saved login for ${host}: log into it on the desktop first` }];
      return webapps.ServiceOp(op, str(p.id), host, { user, pass }, s.user, truthy(p.keep));
    });
  }
  // a service's icon, or an app's, off its repository, kept here
  const svcIc = appsSvcIconRe.exec(pathname);
  m = svcIc ?? appsIconRe.exec(pathname);
  if (m && method === "GET") {
    if (!(await isLocalOrPeer(c))) return forbidden();
    const ic = await (svcIc ? webapps.svcIcon(m[1]!) : webapps.AppIcon(m[1]!));
    if (!ic) return new Response(null, { status: 404, headers: { "Cache-Control": "max-age=600" } });
    return new Response(ic.data as Uint8Array<ArrayBuffer>, { status: 200, headers: { "Content-Type": ic.type, "Cache-Control": "max-age=3600", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" } });
  }
  m = appsTarRe.exec(pathname);
  if (m && method === "GET") {
    if (!(await isTailnet(c))) return forbidden();
    return webapps.Serve(m[1]!, m[2]!);
  }
  if (pathname === "/api/join-key" && method === "POST") {
    // admins, or this machine with no admin password
    const s = users.Of(c);
    if (!isBrowser(c) || !((!!s && s.admin) || (adminPass === "" && isLoopback(c)))) return forbidden();
    const [st, b] = await mintGuestKey();
    return sendJSON(st, b);
  }

  m = publicRe.exec(pathname);
  if (m && method === "POST") {
    // the tailnet and this machine, the public side admins only
    const s = users.Of(c);
    if (!(await isLocalOrPeer(c)) || !sameOrigin(c) || (c.ingress && (!s || !s.admin))) return forbidden();
    const host = m[1]!, name = m[2]!;
    return onJSON(c, 1024, true, async (p) => {
      if (typeof p.public !== "boolean") return [400, { error: "public is true or false" }];
      const on = p.public;
      if (host === selfHost) return setPublic(name, on);
      if (q.has("hop")) return hopErr(host);
      const ip = await tailnetIP(host);
      if (!ip) return noPeer(host);
      return peerCall(host, { host: ip, method: "POST", path: `/api/services/${host}/${name}/public?hop=1`, body: { public: on }, timeoutMs: 10000 });
    });
  }

  m = gameRe.exec(pathname);
  if (m && method === "POST") {
    if (!(await isLocalOrPeer(c))) return forbidden();
    const host = m[1]!, name = m[2]!, action = m[3]!;
    let r: Res;
    if (host === selfHost) r = await runGameLocally(name, action);
    else if (q.has("hop")) r = [421, { error: `${name} was sent to ${selfHost}, which isn't ${host}` }];
    else r = await forwardGame(host, name, action);
    return sendJSON(r[0], r[1]);
  }

  if (pathname === "/api/chat/upload" && method === "POST") {
    if (!isBrowser(c)) return forbidden();
    const [st, b] = await chatmedia.save(selfHost, c.req, q.get("name") ?? "", q.get("type") ?? "");
    return sendJSON(st, b);
  }

  m = mediaRe.exec(pathname);
  if (m && method === "GET") {
    if (!(await isLocalOrPeer(c))) return forbidden();
    const host = m[1]!, id = m[2]!;
    const dl = q.has("dl");
    const held = chatmedia.serve(host, id, dl);
    if (held) return held;
    if (host === selfHost || q.has("hop")) return sendJSON(404, { error: "no such attachment" });
    const ip = await tailnetIP(host);
    const got = !!ip && (await chatmedia.pull(host, id, ip, port)) ? chatmedia.serve(host, id, dl) : undefined;
    return got ?? sendJSON(502, { error: host + " has it and isn't answering" });
  }

  m = runRe.exec(pathname);
  if (m && method === "GET") {
    if (!(await isLocalOrPeer(c))) return forbidden();
    return serveRun(c, m[1]!, m[2]!, m[3]!, q.has("hop"));
  }

  m = mirrorRe.exec(pathname);
  if (m && method === "GET") {
    if (!(await isTailnet(c)) && !isLoopback(c)) return forbidden();
    return mirror.Serve(m[1]!);
  }

  m = filesRe.exec(pathname);
  if (m) return filesRoute(c, m[1]!, m[2]!, q);

  // a client's ping to a host: answered here, or relayed once to that host,
  // the client timing the whole round trip itself
  m = pingRe.exec(pathname);
  if (m && method === "GET") {
    if (!(await isLocalOrPeer(c))) return forbidden();
    const host = m[1]!;
    const noStore = { "Cache-Control": "no-store" };
    if (host !== selfHost) {
      if (q.has("hop")) {
        const [st, b] = hopErr(host);
        return sendJSON(st, b, noStore);
      }
      const why = await pingPeer(host, c.req.signal);
      if (why) return sendJSON(502, { error: why }, noStore);
    }
    return new Response(null, { status: 204, headers: noStore });
  }

  // a host joining with only TS_AUTHKEY: the rest from here, tailnet peers alone
  // a peer's calls for a keyed caller, already checked there: logs, config, page actions
  if (pathname === "/internal/op" && method === "POST") {
    if (!(await isTailnet(c))) return forbidden();
    // a grant sealing an exec's stdin, past a plain body's cap
    return onJSON(c, maxSaveBody, true, peerOp);
  }
  if (method === "POST" && (pathname === "/internal/logs" || pathname === "/internal/config" || pathname === "/internal/ui")) {
    if (!(await isTailnet(c))) return forbidden();
    return onJSON(c, maxJSONBody, true, (p) => {
      if (pathname === "/internal/logs") return hostLogs(p);
      if (pathname === "/internal/config") return configOp(p);
      const g = users.OpenGrant(str(p.grant));
      if (!g) return [403, { error: "bad grant" }];
      return [200, { ok: localUI(str(g.u), obj(g.a) ?? {}) }];
    });
  }

  if (pathname === "/internal/keys" && method === "GET") {
    if (!(await isTailnet(c))) return forbidden();
    const keys: Record<string, string> = {};
    for (const k of envKeys) if (k.mesh) keys[k.name] = process.env[k.name] ?? "";
    return sendJSON(200, keys, { "Cache-Control": "no-store" });
  }

  if (pathname === "/internal/status/updating" && method === "POST") {
    if (!isLoopback(c)) return forbidden();
    return onJSON(c, 1024, true, () => {
      setUpdating(true);
      return [200, { ok: true }];
    });
  }

  m = faviconRe.exec(pathname);
  if (m && method === "GET") {
    if (!(await isLocalOrPeer(c))) return forbidden();
    if (q.has("why")) return sendJSON(200, await faviconWhy(m[1]!, m[2]!));
    const v = await favicon(m[1]!, m[2]!);
    // none kept by the browser: the host holds a miss, a while or briefly when the service didn't answer
    if (!v) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    return new Response(v.body as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: {
        "Content-Type": v.type, "Cache-Control": "max-age=3600", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  }

  if (pathname.startsWith("/api/") || pathname.startsWith("/internal/")) return sendJSON(404, { error: "not found" });
  // an installed app under its mount; the desktop's own files, then an app's root files
  if (webapps.mounted(pathname)) return webapps.serve(c.req) ?? serveStatic(c.req);
  const res = await serveStatic(c.req);
  return res.status === 404 ? (webapps.serve(c.req) ?? res) : res;
}

async function filesRoute(c: Ctx, host: string, op: string, q: URLSearchParams): Promise<Response> {
  if (!(await isLocalOrPeer(c))) return forbidden();
  if (host !== selfHost) {
    if (q.has("hop")) {
      const [st, b] = hopErr(host);
      return sendJSON(st, b);
    }
    return forwardFiles(host, c, withHop(requestURI(c)));
  }
  if (op === "info") return sendJSON(200, filesInfo());
  if (!files.enabled()) return sendJSON(503, { error: selfHost + " publishes no files directory" });
  const sh = files.shareOf(q.get("share") ?? "");
  if (!sh) return sendJSON(404, { error: selfHost + " has no such share" });
  const rel = q.get("path") ?? "";
  const who = sh.id === "home" ? await homeWho(c) : undefined;
  const gate = (...rels: string[]): Res | undefined => {
    if (sh.id !== "home") return;
    for (const x of rels) {
      const why = files.homeGate(who, x, users.Exists);
      if (why) return [files.gateCode(who, why), { error: why }];
    }
    return;
  };
  const barred = (...rels: string[]) => {
    const r = gate(...rels);
    return r ? sendJSON(r[0], r[1]) : undefined;
  };
  const m = c.req.method;
  if (m === "GET" && (op === "list" || op === "tree" || op === "search" || op === "read" || op === "download")) {
    const b = barred(rel);
    if (b) return b;
  }
  if (m === "GET" && op === "list") {
    let [st, b] = await files.list(sh, rel);
    if (sh.id === "home" && st === 200) {
      const ents = files.homeFilterList(who, rel, b.entries, users.Exists);
      for (const e of ents) {
        const p = rel ? rel + "/" + e.name : e.name;
        if (!e.dir && mirror.IsMirrored(p)) e.all = true;
      }
      b.entries = ents;
    }
    [st, b] = files.quiet(q, [st, b]);
    return sendJSON(st, b);
  }
  if (m === "GET" && op === "tree") {
    const [st, b] = await files.tree(sh, rel, q.get("depth"), q.get("match") ?? "", q.get("skip") ?? "");
    if (sh.id === "home" && st === 200) b.entries = files.homeFilterTree(who, b.entries, users.Exists);
    return sendJSON(st, b);
  }
  if (m === "GET" && op === "search") {
    const [st, b] = await files.search(sh, rel, q.get("query") ?? "", q.get("content") === "true", q.get("glob") ?? "", q.get("skip") ?? "");
    if (sh.id === "home" && st === 200) b.results = homeFilterResults(who, b.results);
    return sendJSON(st, b);
  }
  if (m === "GET" && op === "read") {
    const [st, b] = files.quiet(q, await files.read(sh, rel));
    return sendJSON(st, b);
  }
  if (m === "GET" && op === "download") {
    const abs = files.downloadPath(sh, rel);
    if (!abs) return sendJSON(404, { error: "no such file" });
    return sendFile(abs, !q.has("inline"));
  }
  if (m === "POST" && op === "upload") {
    const b = barred(rel);
    if (b) {
      await c.req.body?.cancel().catch(() => {});
      return b;
    }
    const qv = (k: string) => (q.has(k) ? q.get(k)! : undefined);
    const [st, out] = await files.write(sh, rel, c.req.body, { id: q.get("id") ?? "", offset: qv("offset"), total: qv("total") });
    return sendJSON(st, out);
  }
  if (m === "POST" && op === "save") {
    return onJSON(c, maxTextBody, true, (p) => gate(str(p.path)) ?? collabWrite(sh, str(p.path), writeP(p)));
  }
  if (m === "POST" && op === "mirror") {
    return onJSON(c, maxJSONBody, false, (p) => {
      if (sh.id !== "home") return [400, { error: "only home files go to every host" }];
      const g = gate(str(p.path));
      if (g) return g;
      return truthy(p.on) ? mirror.Mark(str(p.path)) : mirror.Unmark(str(p.path));
    });
  }
  // a user's own home here handed to their own login on this machine, so its
  // builds and shells write in it as Phosphorus, root, does
  if (m === "POST" && op === "own") {
    return onJSON(c, maxJSONBody, true, async (p) => {
      if (sh.id !== "home" || !who || who.user === "") return [403, { error: "only your own home" }];
      let login = str(p.login);
      // none named: the login the user saved for this machine, as the Code service's
      const s = await users.Soon(c);
      if (login === "" && s) [login] = await users.HostLogin(s, selfHost);
      if (!loginRe.test(login)) return [400, { error: "a login's name" }];
      return files.own(join(files.homeDir(), who.user), login);
    });
  }
  if (m === "POST" && op === "run") {
    return onJSON(c, maxJSONBody, false, (p) => gate(str(p.path)) ?? runGrant(sh, str(p.path), who));
  }
  if (m === "POST") {
    return onJSON(c, maxJSONBody, false, (p) => {
      const g = op === "rename" ? gate(str(p.from), str(p.to)) : gate(str(p.path));
      if (g) return g;
      switch (op) {
        case "mkdir":
          return files.mkdir(sh, str(p.path));
        case "rename":
          return files.renamePath(sh, str(p.from), str(p.to));
        case "delete":
          return files.remove(sh, str(p.path));
      }
      return [405, { error: "method not allowed" }];
    });
  }
  return sendJSON(405, { error: "method not allowed" });
}
