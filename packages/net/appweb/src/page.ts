// an app window's document as the browser gets it: the runtime first, inline, an import map
// taking the app's schemes to the server, and its CSP widened only for those

import { randomBytes } from "node:crypto";
import { codecText, opsText } from "./frames.ts";
import runtimeSrc from "./inject/runtime.js" with { type: "text" };
import type { Prefs, Ready } from "./session.ts";

const fetchDirs = new Set([
  "default-src",
  "script-src",
  "script-src-elem",
  "style-src",
  "style-src-elem",
  "img-src",
  "font-src",
  "connect-src",
  "media-src",
  "worker-src",
  "frame-src",
  "child-src",
  "manifest-src",
]);

// one policy widened: the server's origin wherever the app allowed itself, our inline script by
// its nonce, blob workers, and our trusted types policy
export function editCsp(policy: string, origin: string, nonce: string, schemes: string[]): string {
  const dirs = policy
    .split(";")
    .map((d) => d.trim().split(/\s+/).filter(Boolean))
    .filter((d) => d.length);
  const names = new Set(dirs.map((d) => d[0]!.toLowerCase()));
  const own = new Set(schemes.map((s) => `${s.toLowerCase()}:`));
  for (const d of dirs) {
    const name = d[0]!.toLowerCase();
    const src = d.slice(1);
    if (fetchDirs.has(name)) {
      const selfish = src.some((s) => s === "'self'" || own.has(s.toLowerCase()) || /^[a-z-]+:\/\//i.test(s));
      if (selfish && !src.includes(origin)) d.push(origin);
      const scripts =
        name === "script-src" || name === "script-src-elem" || (name === "default-src" && !names.has("script-src"));
      if (scripts) {
        if (!src.includes("'unsafe-inline'")) d.push(`'nonce-${nonce}'`);
        if (!src.includes("blob:")) d.push("blob:");
      }
      if (name === "worker-src" && !src.includes("blob:")) d.push("blob:");
    }
    if (name === "trusted-types" && !src.includes("'none'")) d.push("phosphorus");
  }
  return dirs.map((d) => d.join(" ")).join("; ");
}

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const unattr = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
// JSON safe inside a script element: no tag openings, no line separators
const scriptJSON = (v: unknown) =>
  JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028")
    .replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");

export type Doc = {
  wc: number;
  nonce: string;
  // the app's own URL of this document, and where its resources come from
  url: string;
  base: string;
  sync: string;
  origin: string;
  info: Ready;
  prefs: Prefs;
};

// the runtime's config: everything the app's renderer side reads synchronously
export function cfgOf(d: Doc) {
  return {
    wc: d.wc,
    nonce: d.nonce,
    base: d.base,
    sync: d.sync,
    doc: d.url,
    schemes: d.info.schemes,
    execPath: d.info.execPath,
    env: d.info.env,
    platform: d.info.platform,
    arch: d.info.arch,
    versions: d.info.versions,
    pid: d.info.pid,
    args: d.prefs.args,
    preloads: d.prefs.preloads,
    sandbox: d.prefs.sandbox,
    isolation: d.prefs.isolation,
    zoom: d.prefs.zoom,
  };
}

// the import map: each scheme to its place on the server, root paths to the document's own root
export function importMap(d: Doc): string {
  const imports: Record<string, string> = {};
  for (const s of d.info.schemes) {
    imports[`${s}://`] = `${d.base}${s}/`;
    if (s === "file") imports["file:///"] = `${d.base}file/_/`;
  }
  const u = new URL(d.url);
  const prefix = new URL(d.base).pathname.split("/").slice(0, 3).join("/");
  imports[`${prefix}/`] = `${prefix}/`;
  imports["/"] = `${d.base}${u.protocol.slice(0, -1)}/${u.host || "_"}/`;
  return JSON.stringify({ imports });
}

export function runtimeScript(d: Doc): string {
  return `(function(){\n${codecText}\n${opsText}\n${runtimeSrc}\nphosRuntime(${scriptJSON(cfgOf(d))}, phosCodec, phosOps);\n})();`;
}

// the document with ours in front of everything it runs
export function inject(html: string, d: Doc, headerCsp?: string): { html: string; csp?: string } {
  const nonce = randomBytes(12).toString("base64").replace(/[+/=]/g, "");
  const ours =
    `<script nonce="${nonce}">${runtimeScript(d).replace(/<\/script/gi, "<\\/script")}</script>` +
    `<script type="importmap" nonce="${nonce}">${importMap(d)}</script>`;
  const schemes = d.info.schemes;
  let out = html.replace(
    /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi,
    (tag) =>
      tag.replace(
        /\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i,
        (_m, _q, a, b) => `content="${attr(editCsp(unattr(a ?? b ?? ""), d.origin, nonce, schemes))}"`,
      ),
  );
  const head = /<head\b[^>]*>/i.exec(out);
  if (head) out = out.slice(0, head.index + head[0].length) + ours + out.slice(head.index + head[0].length);
  else {
    const h = /<html\b[^>]*>/i.exec(out);
    const at = h ? h.index + h[0].length : (/<!doctype[^>]*>/i.exec(out)?.[0].length ?? 0);
    out = `${out.slice(0, at)}<head>${ours}</head>${out.slice(at)}`;
  }
  return { html: out, csp: headerCsp ? editCsp(headerCsp, d.origin, nonce, schemes) : undefined };
}
