// every request on the frontend port, and the ingress's leftovers
import * as catalog from "@phosphorus/catalog";
import { Keys as envKeys } from "@phosphorus/envfile";
import * as files from "@phosphorus/files";
import { type Caller, handle as mcpHandle, skill } from "@phosphorus/mcp";
import { Assign, EraseSlots, ServeChat, ServeMessages, ServeModels } from "@phosphorus/model";
import * as peers from "@phosphorus/peers";
import { favicon, faviconWhy, requestURI } from "@phosphorus/proxy";
import { setPublic } from "@phosphorus/services";
import * as stacks from "@phosphorus/stacks";
import * as term from "@phosphorus/term";
import * as update from "@phosphorus/update";
import * as users from "@phosphorus/users";
import { errText, intervalMS, markHot, peerCall, tailnetIP } from "@phosphorus/util";
import { blocks, highlight, markdown } from "@phosphorus/web-md";
import * as webapps from "@phosphorus/webapps";
import { serveStatic } from "@phosphorus/webstatic";
import { type Ctx, isUpgrade } from "@phosphorus/wsock";
import { appRoute } from "./apps.ts";
import { adminPass, port, selfHost, selfInfo, setUpdating, whoHeader } from "./config.ts";
import { haRoute } from "./ha.ts";
import { configOp, hostConfig, hostLogs, localUI } from "./hostops.ts";
import {
  crossSite,
  forbidden,
  isBrowser,
  isLocalOrPeer,
  isLoopback,
  isTailnet,
  maxJSONBody,
  maxSaveBody,
  maxTextBody,
  onJSON,
  pageUser,
  plain,
  type Res,
  readRaw,
  sameOrigin,
  sendJSON,
} from "./http.ts";
import { decode, obj, str, truthy } from "./js.ts";
import { mcpCallsMesh, peerOp } from "./mcpops.ts";
import { oauthRoute, Unauthorized } from "./oauth.ts";
import { buildState, chainAction, mintGuestKey, noteState, stackServing } from "./server.ts";
import { filesHere, forwardFiles, homeWho, openShare, pingPeer, sendFile, serveRun, withHop } from "./shares.ts";
import { copyTree } from "./transfer.ts";
import { onUpgrade } from "./ws.ts";

const runRe = /^\/api\/run\/([a-z0-9][a-z0-9-]*)\/([A-Za-z0-9_-]+)\/(.*)$/;
const stacksAppRe = /^\/api\/stacks\/app\/([a-z]+)\/(.+)$/;
const appsTarRe = /^\/internal\/apps\/([a-z][a-z0-9-]*)\/(\d+(?:\.\d+){0,3})$/;
const appsIconRe = /^\/api\/apps\/([a-z][a-z0-9-]*)\/icon$/;
const hostRe = /^[a-z0-9][a-z0-9-]*$/;
const stackOpRe = /^\/api\/stacks\/([a-z][a-z0-9-]{0,39})\/(update|remove)$/;
const pingRe = /^\/api\/ping\/([a-z0-9-]+)$/;
const filesRe =
  /^\/api\/files\/([a-z0-9][a-z0-9-]*)\/(info|list|tree|search|read|download|upload|save|mkdir|rename|delete|run|copy)$/;
const publicRe = /^\/api\/services\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)\/public$/;
const publishRe = /^\/api\/services\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)\/publish$/;
const hostCfgRe = /^\/api\/hosts\/([a-z0-9][a-z0-9-]*)\/config$/;
const faviconRe = /^\/api\/favicon\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/;

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
  // the key in use as a url, an agent's whole connector: pasted in, no sign-in
  "POST /api/me/mcp-url": (s, p, c) => users.MCPURL(s, p, c),
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

  if (
    method === "GET" &&
    (pathname === "/api/state" || pathname === "/api/self" || pathname === "/api/update/local/status")
  ) {
    if (!(await isLocalOrPeer(c))) return forbidden();
    if (pathname === "/api/state") {
      const s = buildState();
      noteState(s);
      s.pollMs = intervalMS();
      return sendJSON(200, s);
    }
    // this host as a peer's update asks it: version, platform, boot id
    if (pathname === "/api/self") return sendJSON(200, selfInfo());
    return sendJSON(200, update.status());
  }
  if (pathname === "/api/me/wallpaper" && method === "GET") {
    if (!(await isLocalOrPeer(c))) return forbidden();
    const [t, b] = users.Wallpaper(users.Of(c));
    if (!b) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    return new Response(b as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: {
        "Content-Type": t,
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  // the claude skill, no key in it: the user's connector does the calling
  if (pathname === "/api/me/mcp-skill" && method === "POST") {
    if (!(await isLocalOrPeer(c)) || !sameOrigin(c)) return forbidden();
    const s = await users.Soon(c);
    if (!s || s.boot) return sendJSON(403, { error: "log in as a user" });
    let b: Uint8Array;
    try {
      b = await skill(users.MCPBase(c));
    } catch (e) {
      return sendJSON(500, { error: errText(e) });
    }
    return new Response(b as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="phosphorus-skill.zip"',
        "Cache-Control": "no-store",
      },
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

  if (pathname.startsWith("/api/ha/") || pathname.startsWith("/api/stacks/")) {
    const r = await haRoute(c, pathname, method, q);
    if (r) return r;
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
        user: s.user,
        admin: s.admin,
        via,
        login: (host) => {
          const [user, pass, has] = users.MCPLogin(k, host);
          return has ? { user, pass } : undefined;
        },
        pages: () => users.MCPPages(k),
        hosts: () =>
          Object.entries(users.MCPLogins(k) ?? {})
            .filter(([, l]) => str(obj(l)?.user) !== "")
            .map(([h]) => h),
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
    return ServeMessages(
      c.req,
      p,
      pathname.slice("/api/model/v1/messages".length),
      isLoopback(c) || (await isTailnet(c)),
      pageUser(c),
    );
  }
  if (pathname === "/api/model/v1/models" && method === "GET")
    return ServeModels(c.req, isLoopback(c) || (await isTailnet(c)) || pageUser(c));
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
  // the installer's catalogue: apps from the catalogues and opened repos, and
  // whether each installs; for anyone logged in
  if (pathname.startsWith("/api/stacks/")) {
    const r = await stacksCatalogRoute(c, pathname, q, method);
    if (r) return r;
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
    return onJSON(c, 1024, true, (p) =>
      pathname === "/api/apps/install" ? webapps.Install(str(p.id)) : webapps.Remove(str(p.id)),
    );
  }
  // the installed services: an admin's install, update or removal, every host following
  let m = stackOpRe.exec(pathname);
  if ((m || pathname === "/api/stacks/install" || pathname === "/api/stacks/docker") && method === "POST") {
    const s = users.Of(c);
    if (!isBrowser(c) || !((!!s && s.admin) || (adminPass === "" && isLoopback(c)))) return forbidden();
    const by = s?.user ?? "admin";
    if (pathname === "/api/stacks/install") return onJSON(c, 512 << 10, true, (p) => stacks.Install(p, by));
    if (pathname === "/api/stacks/docker") return onJSON(c, 1024, true, (p) => stacks.AskDocker(str(p.host), by));
    const [id, op] = [m![1]!, m![2]!];
    return onJSON(c, 1024, true, (p) =>
      op === "update" ? stacks.Update(id, by) : stacks.Remove(id, p.keepData !== false, by),
    );
  }
  // an app's icon off its repository, kept here
  m = appsIconRe.exec(pathname);
  if (m && method === "GET") {
    if (!(await isLocalOrPeer(c))) return forbidden();
    const ic = await webapps.AppIcon(m[1]!);
    if (!ic) return new Response(null, { status: 404, headers: { "Cache-Control": "max-age=600" } });
    return new Response(ic.data as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: {
        "Content-Type": ic.type,
        // a reload's copy at once, the next fetched behind it
        "Cache-Control": "max-age=3600, stale-while-revalidate=604800",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
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

  // a host's shares and model, read and written for an admin (settings › hosts)
  m = hostCfgRe.exec(pathname);
  if (m && (method === "GET" || method === "POST")) {
    const s = users.Of(c);
    if (!isBrowser(c) || !sameOrigin(c) || !((!!s && s.admin) || (adminPass === "" && isLoopback(c))))
      return forbidden();
    const host = m[1]!;
    // only a host the admin is signed into: their own login for it saved
    if (s && !(await users.HostLogin(s, host))[2])
      return sendJSON(403, { error: `sign in to ${host} first: profile, the hosts you log into` });
    if (method === "GET") return sendJSON(...(await hostConfig(host, { op: "get" })));
    return onJSON(c, 16 * 1024, true, (p) =>
      ["shares", "model"].includes(str(p.op)) ? hostConfig(host, p) : [400, { error: "op is shares or model" }],
    );
  }

  m = publicRe.exec(pathname);
  if (m && method === "POST") {
    // the tailnet and this machine, the public side admins only
    const s = users.Of(c);
    if (!(await isLocalOrPeer(c)) || !sameOrigin(c) || (c.ingress && (!s || !s.admin))) return forbidden();
    const host = m[1]!,
      name = m[2]!;
    return onJSON(c, 1024, true, async (p) => {
      if (typeof p.public !== "boolean") return [400, { error: "public is true or false" }];
      const on = p.public;
      if (host === selfHost) return setPublic(name, on);
      if (q.has("hop")) return hopErr(host);
      const ip = await tailnetIP(host);
      if (!ip) return noPeer(host);
      return peerCall(host, {
        host: ip,
        method: "POST",
        path: `/api/services/${host}/${name}/public?hop=1`,
        body: { public: on },
        timeoutMs: 10000,
      });
    });
  }

  m = publishRe.exec(pathname);
  if (m && method === "POST") {
    // a found page written into its host's services.export as name, its port
    // alone: the scheme sniffed, the mode picked when published
    const s = users.Of(c);
    if (!(await isLocalOrPeer(c)) || !sameOrigin(c) || (c.ingress && (!s || !s.admin))) return forbidden();
    const host = m[1]!,
      name = m[2]!;
    return onJSON(c, 1024, true, (p) => {
      const port = p.port;
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
        return [400, { error: "port is 1-65535" }];
      return hostConfig(host, { op: "service", name, fields: { port: String(port) } });
    });
  }

  m = runRe.exec(pathname);
  if (m && method === "GET") {
    if (!(await isLocalOrPeer(c))) return forbidden();
    return serveRun(c, m[1]!, m[2]!, m[3]!, q.has("hop"));
  }

  // a peer's sync fetching a home file, with the mesh's grant
  if (pathname === "/internal/home" && method === "GET") {
    if (
      (!(await isTailnet(c)) && !isLoopback(c)) ||
      str(users.OpenGrant(c.req.headers.get(whoHeader) ?? "")?.s) !== "home"
    )
      return forbidden();
    const abs = files.downloadPath(files.shareOf("home"), q.get("path") ?? "");
    return abs ? sendFile(abs, true) : sendJSON(404, { error: "no such file" });
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
  if (
    method === "POST" &&
    (pathname === "/internal/logs" || pathname === "/internal/config" || pathname === "/internal/ui")
  ) {
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
        "Content-Type": v.type,
        // a reload's copy at once, the next fetched behind it
        "Cache-Control": "max-age=3600, stale-while-revalidate=604800",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  }

  const app = await appRoute(c, pathname);
  if (app) return app;
  if (pathname.startsWith("/api/") || pathname.startsWith("/internal/")) return sendJSON(404, { error: "not found" });
  // an installed app under its mount; the desktop's own files, then an app's root files
  if (webapps.mounted(pathname)) return webapps.serve(c.req) ?? serveStatic(c.req);
  const res = await serveStatic(c.req);
  return res.status === 404 ? (webapps.serve(c.req) ?? res) : res;
}

// the files API: a host's own ops here, another's carried to it; a copy run here, between any two
async function filesRoute(c: Ctx, host: string, op: string, q: URLSearchParams): Promise<Response> {
  if (!(await isLocalOrPeer(c))) return forbidden();
  const m = c.req.method;
  if (op === "copy" && m === "POST") {
    const who = await homeWho(c);
    const caller = who && { user: who.user, admin: who.admin };
    return onJSON(c, maxJSONBody, true, (p) => {
      const loc = (v: unknown) => {
        const o = obj(v);
        return { host: str(o?.host), share: str(o?.share), path: str(o?.path) };
      };
      const from = loc(p.from),
        to = loc(p.to);
      if (!hostRe.test(from.host) || !hostRe.test(to.host) || !from.path || !to.path)
        return [400, { error: "a from and a to, each a host, share and path" }];
      return copyTree(caller, from, to, p.move === true);
    });
  }
  // a tree only for a peer's hop: the agents' files_list on another host
  if (op === "tree" && !q.has("hop")) return sendJSON(404, { error: "not found" });
  if (host !== selfHost) {
    if (q.has("hop")) {
      const [st, b] = hopErr(host);
      return sendJSON(st, b);
    }
    return forwardFiles(host, c, withHop(requestURI(c)));
  }
  const who = await homeWho(c);
  const share = q.get("share") ?? "";
  const rel = q.get("path") ?? "";
  if (m === "GET" && op === "download") {
    const [sh, bad] = openShare(who, share, rel);
    if (bad) return sendJSON(bad[0], bad[1]);
    const abs = files.downloadPath(sh, rel);
    if (!abs) return sendJSON(404, { error: "no such file" });
    return sendFile(abs, !q.has("inline"));
  }
  if (m === "POST" && op === "upload") {
    const [sh, bad] = openShare(who, share, rel);
    if (bad) {
      await c.req.body?.cancel().catch(() => {});
      return sendJSON(bad[0], bad[1]);
    }
    const qv = (k: string) => (q.has(k) ? q.get(k)! : undefined);
    const [st, out] = await files.write(sh, rel, c.req.body, {
      id: q.get("id") ?? "",
      offset: qv("offset"),
      total: qv("total"),
    });
    return sendJSON(st, out);
  }
  if (m === "GET" && ["info", "list", "tree", "search", "read"].includes(op)) {
    const [st, b] = await filesHere(who, op, share, Object.fromEntries(q));
    return sendJSON(st, b);
  }
  if (m === "POST" && op !== "info")
    return onJSON(c, op === "save" ? maxTextBody : maxJSONBody, op === "save", (p) => filesHere(who, op, share, p));
  return sendJSON(405, { error: "method not allowed" });
}

// the catalogue half of /api/stacks (packages/catalog), undefined for the rest
async function stacksCatalogRoute(c: Ctx, pathname: string, q: URLSearchParams, method: string) {
  const get = method === "GET";
  const m = get ? stacksAppRe.exec(pathname) : null;
  const post = method === "POST" && (pathname === "/api/stacks/repo" || pathname === "/api/stacks/check");
  if (!(get && (pathname === "/api/stacks/catalog" || m)) && !post) return;
  if (!(await isLocalOrPeer(c)) || (post && (!isBrowser(c) || !sameOrigin(c)))) return forbidden();
  const s = await users.Soon(c);
  if (!s || s.boot) return sendJSON(403, { error: "log in as a user" });
  if (pathname === "/api/stacks/catalog") {
    const [st, b] = catalog.catalogRoute(q);
    return sendJSON(st, b, { "Cache-Control": "no-store" });
  }
  if (m) {
    let ref: string;
    try {
      ref = decodeURIComponent(m[2]!);
    } catch {
      return plain(400, "bad request");
    }
    const [st, b] = await catalog.appRoute(m[1]!, ref);
    return sendJSON(st, b, { "Cache-Control": "no-store" });
  }
  return onJSON(c, 16 * 1024, true, (p) =>
    pathname === "/api/stacks/repo" ? catalog.repoRoute(p) : catalog.checkRoute(p),
  );
}
