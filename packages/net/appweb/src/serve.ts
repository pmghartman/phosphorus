// the app's documents and files over http, and a page's sendSync: each URL carrying its key,
// since an app's page runs sandboxed with an origin of its own and no cookies.
// <prefix>/r/<rkey>/<scheme>/<host>/<path>   a resource, or a window's document with ?phos-w=
// <prefix>/x/<skey>/sync                     one ipcRenderer.sendSync

import { needsWrap, wrapImports } from "./dynimport.ts";
import { inject } from "./page.ts";
import { type AppWeb, byResourceKey, bySyncKey } from "./session.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

// the app's own URL of a path under r/<rkey>/
export function appUrlOf(rest: string, search: string): string {
  const i = rest.indexOf("/");
  const j = rest.indexOf("/", i + 1);
  if (i <= 0) throw new Error("no scheme");
  const scheme = rest.slice(0, i);
  const host = j < 0 ? rest.slice(i + 1) : rest.slice(i + 1, j);
  const path = j < 0 ? "/" : rest.slice(j);
  return `${scheme}://${host === "_" ? "" : host}${path}${search}`;
}

// a path the app ships: under its own install, never changing for this version
function shipped(s: AppWeb, url: string): boolean {
  const exe = s.info?.execPath ?? "";
  if (!exe) return false;
  const win = s.info?.platform === "win32";
  const dir = exe.replace(/[\\/][^\\/]*$/, "").replace(/\\/g, "/");
  let p = "";
  try {
    p = decodeURIComponent(new URL(url).pathname);
  } catch {
    return false;
  }
  if (win) p = p.replace(/^\/([a-z]:)/i, "$1");
  return win ? p.toLowerCase().startsWith(`${dir.toLowerCase()}/`) : p.startsWith(`${dir}/`);
}

export async function handle(req: Request, url: URL, prefix: string, origin: string): Promise<Response | undefined> {
  if (!url.pathname.startsWith(`${prefix}/`)) return;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const rest = url.pathname.slice(prefix.length + 1);
  const m = /^(r|x)\/([0-9a-f]{32})\/(.*)$/.exec(rest);
  if (!m) return;
  if (m[1] === "x") {
    const s = bySyncKey(m[2]!);
    if (!s || m[3] !== "sync" || req.method !== "POST") return new Response(null, { status: 404, headers: cors });
    try {
      const b = await s.sync(new Uint8Array(await req.arrayBuffer()));
      return new Response(b as Uint8Array<ArrayBuffer>, {
        headers: { ...cors, "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
      });
    } catch (e) {
      return new Response(String(e), { status: 502, headers: cors });
    }
  }
  const s = byResourceKey(m[2]!);
  if (!s) return new Response("that app has closed", { status: 404, headers: cors });
  const q = new URLSearchParams(url.search);
  const wc = Number(q.get("phos-w") || 0);
  const nonce = q.get("phos-n") || "";
  q.delete("phos-w");
  q.delete("phos-n");
  const search = q.size ? `?${q}` : "";
  let appUrl: string;
  try {
    appUrl = appUrlOf(m[3]!, search);
  } catch {
    return new Response(null, { status: 400, headers: cors });
  }
  const ask: Record<string, string> = {};
  const inm = req.headers.get("if-none-match");
  if (inm && !wc) ask["if-none-match"] = inm;
  let r: Awaited<ReturnType<AppWeb["fetch"]>>;
  try {
    r = await s.fetch(wc, appUrl, ask);
  } catch (e) {
    return new Response(String(e), { status: 502, headers: cors });
  }
  const h = new Headers(cors);
  for (const [k, v] of Object.entries(r.headers)) {
    const lk = k.toLowerCase();
    if (lk === "content-type" || lk === "etag" || lk === "last-modified" || lk === "content-language") h.set(k, v);
  }
  if (wc && s.info) {
    const w = s.windows.get(wc);
    const html = await new Response(r.body).text();
    const base = `${origin}${prefix}/r/${s.rkey}/`;
    const out = inject(
      html,
      {
        wc,
        nonce,
        url: appUrl,
        base,
        sync: `${origin}${prefix}/x/${s.skey}/sync`,
        origin,
        info: s.info,
        prefs: w?.prefs ?? { preloads: [], args: [], sandbox: true, isolation: true, node: false, zoom: 1 },
      },
      r.headers["content-security-policy"],
    );
    h.set("Content-Type", "text/html; charset=utf-8");
    h.set("Cache-Control", "no-store");
    if (out.csp) h.set("Content-Security-Policy", out.csp);
    return new Response(out.html, { status: r.status, headers: h });
  }
  if (r.status === 200)
    h.set("Cache-Control", shipped(s, appUrl) ? "private, max-age=31536000, immutable" : "private, no-cache");
  if (r.status === 200 && /javascript|ecmascript/i.test(r.headers["content-type"] ?? "")) {
    const key = `${s.rkey}\0${appUrl}\0${r.headers.etag ?? ""}`;
    let js = wrapped.get(key);
    if (js === undefined) {
      const text = await new Response(r.body).text();
      js = needsWrap(text) ? wrapImports(text) : text;
      remember(key, js);
    }
    h.delete("Content-Length");
    return new Response(js, { status: 200, headers: h });
  }
  return new Response(r.status === 304 ? null : r.body, { status: r.status, headers: h });
}

// scripts as served, import() wrapped, kept for the next viewer: the newest within a budget
const wrapped = new Map<string, string>();
let wrappedBytes = 0;
const wrappedMax = 192 << 20;
function remember(key: string, js: string) {
  wrapped.set(key, js);
  wrappedBytes += js.length;
  for (const [k, v] of wrapped) {
    if (wrappedBytes <= wrappedMax) break;
    wrapped.delete(k);
    wrappedBytes -= v.length;
  }
}
