// the desktop's page and its files, as scripts/webbuild.ts built them: hashed
// files kept only compressed, each text file's .gz beside it, served
// precompressed where the browser takes it
import { gunzipSync } from "bun";
import { files } from "./manifest.ts";

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".gif": "image/gif",
  ".wasm": "application/wasm", ".map": "application/json",
};

const etags = new Map<string, string>();
const etagOf = (name: string, b: Uint8Array) => {
  let e = etags.get(name);
  if (!e) etags.set(name, (e = `"${new Bun.CryptoHasher("sha256").update(b).digest("hex").slice(0, 16)}"`));
  return e;
};

// esbuild's [name]-[hash] files under assets/ and vendor/h/, cached for good
const hashed = (p: string) => p.startsWith("assets/") || p.startsWith("vendor/h/");

export function accepts(r: Request, enc: string): boolean {
  for (const part of (r.headers.get("accept-encoding") ?? "").split(",")) {
    const f = part.split(";");
    if (f[0]!.trim() !== enc) continue;
    for (const p of f.slice(1)) {
      const q = p.trim();
      if (q.startsWith("q=")) {
        const v = Number(q.slice(2));
        return Number.isFinite(v) && v > 0;
      }
    }
    return true;
  }
  return false;
}

const read = async (name: string) => (name in files ? new Uint8Array(await Bun.file(files[name]!).arrayBuffer()) : undefined);

// the page and its files; a path no file answers is 404
export async function serveStatic(r: Request): Promise<Response> {
  let p = new URL(r.url).pathname;
  if (p === "/" || p === "") p = "/index.html";
  const name = p.replace(/\/+/g, "/").replace(/^\//, "");
  if (!name || name.endsWith(".gz") || name.split("/").includes("..")) return new Response("not found", { status: 404 });
  let packed = false;
  let b = await read(name);
  if (!b) {
    b = await read(name + ".gz");
    packed = true;
  }
  if (!b) return new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  const ext = name.slice(name.lastIndexOf("."));
  const h = new Headers({ "Content-Type": types[ext] ?? "application/octet-stream", ETag: etagOf(name, b), Vary: "Accept-Encoding" });
  h.set("Cache-Control", hashed(name) ? "public, max-age=31536000, immutable" : ext === ".woff2" ? "public, max-age=86400" : "no-cache");
  if (r.headers.get("if-none-match") === h.get("ETag")) return new Response(null, { status: 304, headers: h });
  let body: Uint8Array | undefined;
  if (accepts(r, "gzip")) {
    const c = packed ? b : await read(name + ".gz");
    if (c) {
      h.set("Content-Encoding", "gzip");
      body = c;
    }
  }
  body ??= packed ? gunzipSync(b) : b;
  h.set("Content-Length", String(body.length));
  return new Response(r.method === "HEAD" ? null : (body as Uint8Array<ArrayBuffer>), { status: 200, headers: h });
}
