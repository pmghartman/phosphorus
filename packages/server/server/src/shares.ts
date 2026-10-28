// this host's shares over HTTP: a file streamed, a page run from a grant, and
// the same calls for a peer's shares carried over the tailnet
import { statSync } from "node:fs";
import { basename, extname, posix } from "node:path";
import { Write as collabWrite, type WriteP } from "@phosphorus/collab";
import * as files from "@phosphorus/files";
import type { Caller } from "@phosphorus/mcp";
import { requestURI } from "@phosphorus/proxy";
import { Exists, IsAdmin, OpenGrant, SealGrant, Soon } from "@phosphorus/users";
import { errText, peerCall, tailnetIP } from "@phosphorus/util";
import type { Ctx } from "@phosphorus/wsock";
import { port, runMS, runSandbox, selfHost, whoHeader } from "./config.ts";
import { isTailnet, type Res, sendJSON } from "./http.ts";
import { jsString, obj, str, truthy } from "./js.ts";

const mimeByExt: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const runMime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

export function sendFile(abs: string, download: boolean, extra: Record<string, string> = {}): Response {
  const name = basename(abs);
  const ext = extname(name).toLowerCase();
  let size: number;
  try {
    size = statSync(abs).size;
  } catch {
    return sendJSON(404, { error: "no such file" });
  }
  const h = new Headers({
    "Content-Type": mimeByExt[ext] ?? "application/octet-stream",
    "Content-Length": String(size),
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (!download && ext === ".svg") h.set("Content-Security-Policy", "sandbox");
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Response(Bun.file(abs), { status: 200, headers: h });
}

function runKind(rel: string, dir: boolean): string {
  if (dir) return "app";
  if (/\.html?$/i.test(rel)) return "html";
  if (/\.wasm$/i.test(rel)) return "wasm";
  return "";
}

export async function homeWho(c: Ctx): Promise<files.Who | undefined> {
  // a login from another host: the mesh's sys pulled when it's not here yet
  const s = await Soon(c);
  if (!s) {
    // a peer's call for a keyed caller
    const g = OpenGrant(c.req.headers.get(whoHeader) ?? "");
    if (g && (await isTailnet(c)) && Exists(str(g.u))) return { user: str(g.u), admin: IsAdmin(str(g.u)) };
    return;
  }
  return { user: s.boot ? "" : s.user, admin: s.admin };
}

export function runGrant(sh: files.Share, rel: string, who: files.Who | undefined): Res {
  const st = files.statPath(sh, rel);
  if (!st) return [404, { error: "no such file" }];
  const kind = runKind(rel, st.dir);
  if (!kind) return [400, { error: "not runnable: a page, a .wasm or a folder with an index.html" }];
  let dir = st.rel,
    entry = "index.html";
  if (!st.dir) {
    dir = posix.dirname(st.rel);
    if (dir === ".") dir = "";
    entry = posix.basename(st.rel);
  }
  if (st.dir && !files.statPath(sh, st.rel + "/index.html")) return [400, { error: "no index.html in that folder" }];
  const token = SealGrant({ h: selfHost, s: sh.id, d: dir, u: who?.user ?? "" }, runMS);
  return [200, { kind, url: `/api/run/${selfHost}/${token}/${encodeURIComponent(entry)}` }];
}

export async function serveRun(c: Ctx, host: string, token: string, rest: string, hop: boolean): Promise<Response> {
  if (host !== selfHost) {
    if (hop) return sendJSON(421, { error: `sent to ${selfHost}, which isn't ${host}` });
    return forwardFiles(host, c, withHop(requestURI(c)));
  }
  const g = OpenGrant(token);
  const sh = g && g.h === selfHost ? files.shareOf(str(g.s)) : undefined;
  if (!sh) return sendJSON(403, { error: "that run link expired" });
  const parts: string[] = [];
  for (const p of rest.split("/")) {
    try {
      parts.push(decodeURIComponent(p));
    } catch {
      return sendJSON(400, { error: "bad path" });
    }
  }
  const d = str(g!.d);
  const rel = posix
    .normalize("/" + d + "/" + parts.join("/"))
    .replace(/\/$/, "")
    .replace(/^\//, "");
  if (d !== "" && rel !== d && !rel.startsWith(d + "/")) return sendJSON(403, { error: "outside the app" });
  if (sh.id === "home") {
    const u = str(g!.u);
    const who = u !== "" && Exists(u) ? { user: u, admin: IsAdmin(u) } : undefined;
    const why = files.homeGate(who, rel, Exists);
    if (why) return sendJSON(files.gateCode(who, why), { error: why });
  }
  const st = files.statPath(sh, rel);
  const abs = st ? files.downloadPath(sh, st.dir ? st.rel + "/index.html" : st.rel) : "";
  if (!abs) return sendJSON(404, { error: "no such file" });
  const extra: Record<string, string> = {
    "Content-Security-Policy": runSandbox,
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
  };
  // a .wasm asked as an app: the console page running it, beside it
  if (c.url.searchParams.has("console") && extname(abs).toLowerCase() === ".wasm") {
    return new Response(wasiConsole, {
      status: 200,
      headers: { ...extra, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const t = runMime[extname(abs).toLowerCase()];
  if (t) extra["Content-Type"] = t;
  return sendFile(abs, false, extra);
}

const wasiConsole = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
body{margin:0;padding:.6rem;background:var(--bg);color:var(--fg);font:13px ui-monospace,monospace}
#out{white-space:pre-wrap;margin:0 0 2rem}.err{color:#e57373}.dim{opacity:.6}
#in{position:fixed;left:0;right:0;bottom:0;box-sizing:border-box;width:100%;padding:.4rem .6rem;border:0;border-top:1px solid #8884;background:var(--bg);color:var(--fg);font:inherit;outline:0}
</style><pre id="out"></pre><input id="in" placeholder="stdin, enter reruns with it" autocomplete="off">
<script src="/wasi.js"></script>
`;

export const withHop = (u: string) => u + (u.includes("?") ? "&hop=1" : "?hop=1");

// pingPeer the client's ping carried on to host over the tailnet
export async function pingPeer(host: string, signal?: AbortSignal): Promise<string> {
  const ip = await tailnetIP(host);
  if (!ip) return `can't find ${host} on the tailnet`;
  let res: Response;
  try {
    const signals = [AbortSignal.timeout(5000), ...(signal ? [signal] : [])];
    res = await fetch(`http://${ip}:${port}/api/ping/${host}?hop=1`, { signal: AbortSignal.any(signals) });
  } catch {
    return `${host} didn't answer`;
  }
  await res.body?.cancel().catch(() => {});
  if (res.status !== 204) return `${host} answered ${res.status}`;
  return "";
}

// forwardFiles streams a request on to the host that owns the share
export async function forwardFiles(host: string, c: Ctx, urlPath: string): Promise<Response> {
  const ip = await tailnetIP(host);
  if (!ip) return sendJSON(502, { error: `can't find ${host} on the tailnet` });
  const h = new Headers(c.req.headers);
  // the origin checked here already, the peer's own Host never matching it
  for (const k of ["accept-encoding", "connection", "origin", "host", "transfer-encoding"]) h.delete(k);
  const method = c.req.method;
  let res: Response;
  try {
    res = await fetch(`http://${ip}:${port}${urlPath}`, {
      method,
      headers: h,
      body: method === "GET" || method === "HEAD" ? undefined : c.req.body,
      redirect: "manual",
      decompress: false,
      signal: AbortSignal.any([c.req.signal, AbortSignal.timeout(120000)]),
      duplex: "half",
    } as RequestInit);
  } catch (e) {
    return sendJSON(502, { error: `${host} didn't answer: ${errText(e)}` });
  }
  return new Response(res.body, { status: res.status, headers: res.headers });
}

export function filesInfo(): Record<string, any> {
  const shares = files.shares().map(files.shareJSON);
  return {
    host: selfHost,
    enabled: shares.length > 0,
    shares,
    home: files.homeDir(),
    wantDir: files.pending() ? files.configuredDirs().join(", ") : "",
  };
}

// homeFilterResults a search's hits cut to what who may reach
export function homeFilterResults(who: files.Who | undefined, rs: Record<string, any>[]): Record<string, any>[] {
  return rs.filter((r) => files.homeGate(who, str(r.path).replace(/\/$/, ""), Exists) === "");
}

// filesCall a files call, here or on its host; homes only for a keyed caller, as their user
export async function filesCall(
  c: Caller | undefined,
  host: string,
  op: string,
  share: string,
  body: Record<string, any>,
): Promise<Res> {
  if (host === selfHost) {
    if (op === "info") return [200, filesInfo()];
    if (!files.enabled()) return [503, { error: selfHost + " publishes no files directory" }];
    const sh = files.shareOf(share);
    if (!sh) return [404, { error: selfHost + " has no such share" }];
    const p = str(body.path);
    let who: files.Who | undefined;
    if (sh.id === "home") {
      if (!c) return [403, { error: "the homes are for their users only" }];
      who = { user: c.user, admin: !!c.admin };
      const rels = op === "rename" ? [str(body.from), str(body.to)] : [p];
      for (const x of rels) {
        const why = files.homeGate(who, x, Exists);
        if (why) return [files.gateCode(who, why), { error: why }];
      }
    }
    switch (op) {
      case "list": {
        const [st, b] = await files.list(sh, p);
        if (who && st === 200) b.entries = files.homeFilterList(who, p, b.entries, Exists);
        return [st, b];
      }
      case "tree": {
        const [st, b] = await files.tree(sh, p, body.depth, str(body.match));
        if (who && st === 200) b.entries = files.homeFilterTree(who, b.entries, Exists);
        return [st, b];
      }
      case "search": {
        const [st, b] = await files.search(sh, p, str(body.query), truthy(body.content), str(body.glob));
        if (who && st === 200) b.results = homeFilterResults(who, b.results);
        return [st, b];
      }
      case "read":
        return files.read(sh, p);
      case "save":
        return collabWrite(sh, p, writeP(body));
      case "mkdir":
        return files.mkdir(sh, p);
      case "rename":
        return files.renamePath(sh, str(body.from), str(body.to));
      case "delete":
        return files.remove(sh, p);
    }
    return [400, { error: "no op " + op }];
  }
  const ip = await tailnetIP(host);
  if (!ip) return [502, { error: `can't find ${host} on the tailnet` }];
  const get = op === "info" || op === "list" || op === "tree" || op === "search" || op === "read";
  const q = "share=" + encodeURIComponent(share);
  let params = "";
  if (get)
    for (const k of ["path", "depth", "match", "query", "content", "glob"])
      if (truthy(body[k])) params += "&" + k + "=" + encodeURIComponent(jsString(body[k]));
  const headers = c ? { [whoHeader]: SealGrant({ u: c.user, a: !!c.admin }, 60 * 1000) } : undefined;
  return peerCall(host, {
    host: ip,
    method: get ? "GET" : "POST",
    timeoutMs: 15000,
    body: get ? undefined : body,
    path: `/api/files/${host}/${op}?${q}${params}&hop=1`,
    headers,
  });
}

const strPtr = (v: unknown) => (typeof v === "string" ? v : undefined);

export function writeP(p: Record<string, any>): WriteP {
  const by = obj(p.by);
  return {
    text: strPtr(p.text),
    old: strPtr(p.old),
    new: strPtr(p.new),
    byName: str(by?.name),
    byColor: str(by?.color),
  };
}
