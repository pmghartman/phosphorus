// attachments, kept on the host they were sent to, pulled by any other host on
// first view and cached, oldest dropped past the cap
import { randomBytes } from "node:crypto";
import { type Dirent, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clipU, marshal, obj, readJSON } from "./util.ts";

const str = (v: unknown) => (typeof v === "string" ? v : "");

const envInt = (k: string, def: number) => {
  const n = Number(process.env[k]);
  return Number.isInteger(n) && n > 0 ? n : def;
};
export const MaxFile = envInt("CHAT_MEDIA_MAX_MB", 25) * 1024 * 1024;
const maxTotal = envInt("CHAT_MEDIA_TOTAL_MB", 1024) * 1024 * 1024;
const idRe = /^[0-9a-f]{32}$/;
const hostRe = /^[a-z0-9][a-z0-9-]{0,62}$/;
const typeRe = /^[\w.+-]+\/[\w.+-]+$/;
const badNameRe = /[/\\\x00]/g;
const inline = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/mp4",
  "audio/aac",
  "audio/flac",
  "application/pdf",
  "text/plain",
]);
const maxFiles = 8;

// a stored file's name, type and size
export type Meta = { name: string; type: string; size: number };

// a host and id
export const valid = (host: string, id: string) => hostRe.test(host) && idRe.test(id);

// a message's attachments as peers and browsers hand them over
export function clean(list: unknown): Record<string, any>[] | undefined {
  if (!Array.isArray(list)) return;
  const out: Record<string, any>[] = [];
  for (const x of list) {
    const f = obj(x);
    if (!f || !valid(str(f.host), str(f.id))) continue;
    if (out.length === maxFiles) break;
    const size = typeof f.size === "number" ? f.size : 0;
    out.push({ host: f.host, id: f.id, name: clipU(str(f.name) || "file", 200), type: clipU(str(f.type), 100), size });
  }
  return out.length ? out : undefined;
}

const rm = (file: string) => {
  try {
    rmSync(file, { force: true });
  } catch {}
};
const tooLarge = () => `over ${Math.trunc(MaxFile / 1048576)}MB`;

// the files under dir (dataDir/media), log told of what fails
export function media(dir: string, log: (f: string, ...a: unknown[]) => void) {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const where = (host: string, id: string) => join(dir, host, id);

  function meta(host: string, id: string): Meta | undefined {
    if (!valid(host, id)) return;
    const m = obj(readJSON(where(host, id) + ".json"));
    if (!m || typeof m.name !== "string" || typeof m.type !== "string" || typeof m.size !== "number") return;
    return { name: m.name, type: m.type, size: m.size };
  }

  function prune() {
    const all: { file: string; size: number; at: number }[] = [];
    let total = 0;
    let hosts: Dirent[] = [];
    try {
      hosts = readdirSync(dir, { withFileTypes: true });
    } catch {}
    for (const h of hosts) {
      if (!h.isDirectory()) continue;
      let ents: string[] = [];
      try {
        ents = readdirSync(join(dir, h.name));
      } catch {}
      for (const e of ents) {
        if (!idRe.test(e)) continue;
        const p = join(dir, h.name, e);
        try {
          const st = statSync(p);
          all.push({ file: p, size: st.size, at: st.mtimeMs });
          total += st.size;
        } catch {}
      }
    }
    all.sort((a, b) => a.at - b.at);
    for (const x of all) {
      if (total <= maxTotal) break;
      rm(x.file);
      rm(x.file + ".json");
      total -= x.size;
    }
  }

  async function keep(
    host: string,
    id: string,
    src: ReadableStream<Uint8Array> | null,
    name: string,
    typ: string,
  ): Promise<[number, any]> {
    mkdirSync(join(dir, host), { recursive: true, mode: 0o755 });
    const abs = where(host, id);
    const tmp = `${abs}.${process.pid}.tmp`;
    let n = 0;
    let big = false;
    try {
      const out = Bun.file(tmp).writer();
      try {
        if (src)
          for await (const chunk of src) {
            if (big) continue;
            n += chunk.length;
            if (n > MaxFile) {
              // the rest drained so the sender's upload completes
              big = true;
              continue;
            }
            out.write(chunk);
          }
      } finally {
        await out.end();
      }
      if (big) throw new Error("file too large");
      writeFileSync(abs + ".json", marshal({ name, type: typ, size: n }), { mode: 0o644 });
      renameSync(tmp, abs);
    } catch (e) {
      rm(tmp);
      if (big) return [413, { error: tooLarge() }];
      return [500, { error: e instanceof Error ? e.message : String(e) }];
    }
    setTimeout(() => {
      try {
        prune();
      } catch (e) {
        log("media prune: %s", e);
      }
    }, 0);
    return [200, { host, id, name, type: typ, size: n }];
  }

  // a browser's upload, kept as this host's
  async function save(host: string, req: Request, name: string, typ: string): Promise<[number, any]> {
    const cl = req.headers.get("content-length") ?? "";
    if (/^[+-]?\d+$/.test(cl) && Number(cl) > MaxFile) return [413, { error: tooLarge() }];
    const n = clipU((name || "file").replace(badNameRe, "_"), 200) || "file";
    const t = typeRe.test(typ) ? typ.toLowerCase() : "application/octet-stream";
    return keep(host, randomBytes(16).toString("hex"), req.body, n, t);
  }

  // one attachment, undefined when not held here
  function serve(host: string, id: string, download: boolean): Response | undefined {
    const m = meta(host, id);
    if (!m) return;
    try {
      if (!statSync(where(host, id)).isFile()) return;
    } catch {
      return;
    }
    const inl = !download && inline.has(m.type);
    const h = new Headers({
      "Content-Type": inl ? m.type : "application/octet-stream",
      "Content-Length": String(m.size),
      "Content-Disposition": `${inl ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(m.name)}`,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "X-Phosphorus-Media": encodeURIComponent(marshal(m)),
    });
    if (m.type !== "application/pdf") h.set("Content-Security-Policy", "sandbox");
    return new Response(Bun.file(where(host, id)), { status: 200, headers: h });
  }

  const pulling = new Map<string, Promise<boolean>>();

  // from the host it lives on, as get answers it, cached here; one pull per file
  function pull(host: string, id: string, get: () => Promise<Response>): Promise<boolean> {
    const key = host + "/" + id;
    let p = pulling.get(key);
    if (!p) {
      p = fetchOnce(host, id, get).finally(() => pulling.delete(key));
      pulling.set(key, p);
    }
    return p;
  }

  async function fetchOnce(host: string, id: string, get: () => Promise<Response>): Promise<boolean> {
    let res: Response;
    try {
      res = await get();
    } catch {
      return false;
    }
    let info: Record<string, any> | undefined;
    try {
      info = obj(JSON.parse(decodeURIComponent(res.headers.get("x-phosphorus-media") ?? "")));
    } catch {}
    if (res.status !== 200 || !info) {
      await res.body?.cancel().catch(() => {});
      return false;
    }
    const [s] = await keep(host, id, res.body, clipU(str(info.name) || "file", 200), str(info.type));
    return s === 200;
  }

  return { save, serve, pull };
}
