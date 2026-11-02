// tar.gz and zip releases unpacked into a folder: each entry's leading strip
// parts dropped, nothing let out of the folder by a name or a link
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, posix } from "node:path";

// an entry's path under dir, undefined when stripped away or escaping it
function place(dir: string, name: string, strip: number): [string, string] | undefined {
  const parts = name.replaceAll("\\", "/").replace(/^\.\//, "").split("/");
  if (parts.length <= strip) return;
  const rel = posix.normalize(parts.slice(strip).join("/")).replace(/\/$/, "");
  if (!rel || rel === "." || rel.startsWith("..") || posix.isAbsolute(rel) || isAbsolute(rel)) return;
  return [join(dir, rel), rel];
}

const cstr = (b: Uint8Array, at: number, n: number) => {
  const s = b.subarray(at, at + n);
  const z = s.indexOf(0);
  return Buffer.from(z < 0 ? s : s.subarray(0, z)).toString("utf8");
};
const octal = (b: Uint8Array, at: number, n: number) => parseInt(cstr(b, at, n).trim() || "0", 8) || 0;

// a gzipped ustar of files, path -> bytes; a path past 100 bytes as GNU's long name
export function tarGz(files: [string, Uint8Array][]): Uint8Array {
  const blocks: Uint8Array[] = [];
  const pad = (n: number) => new Uint8Array(Math.ceil(n / 512) * 512 - n);
  const header = (name: string, size: number, type: string) => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0, 100, "utf8");
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(size.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write(type, 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
  };
  for (const [name, data] of files) {
    const n = Buffer.from(name);
    if (n.length > 100)
      blocks.push(header("././@LongLink", n.length + 1, "L"), n, new Uint8Array(1), pad(n.length + 1));
    blocks.push(header(name, data.length, "0"), data, pad(data.length));
  }
  blocks.push(new Uint8Array(1024));
  return Bun.gzipSync(Buffer.concat(blocks));
}

// a gzipped tar's entries written under dir
export function untar(gz: Uint8Array, dir: string, strip: number) {
  const b = Bun.gunzipSync(gz as Uint8Array<ArrayBuffer>);
  let longName = "",
    longLink = "";
  let pax: Record<string, string> = {};
  for (let at = 0; at + 512 <= b.length; ) {
    const h = b.subarray(at, at + 512);
    if (h.every((x) => x === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const data = b.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = cstr(data, 0, data.length);
      continue;
    }
    if (type === "K") {
      longLink = cstr(data, 0, data.length);
      continue;
    }
    if (type === "x") {
      for (const rec of Buffer.from(data).toString("utf8").split("\n")) {
        const m = /^\d+ ([^=]+)=(.*)$/.exec(rec);
        if (m) pax[m[1]!] = m[2]!;
      }
      continue;
    }
    if (type === "g") continue;
    const prefix = cstr(h, 257, 6).startsWith("ustar") ? cstr(h, 345, 155) : "";
    const name = pax.path || longName || (prefix ? prefix + "/" : "") + cstr(h, 0, 100);
    const link = pax.linkpath || longLink || cstr(h, 157, 100);
    longName = longLink = "";
    pax = {};
    const p = place(dir, name, strip);
    if (!p) continue;
    const [abs, rel] = p;
    if (type === "5") mkdirSync(abs, { recursive: true });
    else if (type === "2") {
      // links kept inside the folder, as llama's .so chains are
      if (isAbsolute(link) || posix.isAbsolute(link) || normalize(join(dirname(rel), link)).startsWith("..")) continue;
      mkdirSync(dirname(abs), { recursive: true });
      rmSync(abs, { force: true });
      symlinkSync(link, abs);
    } else if (type === "0" || type === "7") {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, data);
      chmodSync(abs, (octal(h, 100, 8) & 0o755) | 0o600);
    }
  }
}

// a zip's entries written under dir
export function unzip(z: Uint8Array, dir: string, strip: number) {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
  let eocd = -1;
  for (let i = z.length - 22; i >= Math.max(0, z.length - 65557); i--)
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("not a zip");
  const count = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  for (let n = 0; n < count; n++) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error("zip: bad central directory");
    const method = v.getUint16(at + 10, true);
    const csize = v.getUint32(at + 20, true);
    const nlen = v.getUint16(at + 28, true),
      elen = v.getUint16(at + 30, true),
      clen = v.getUint16(at + 32, true);
    const attr = v.getUint32(at + 38, true);
    const local = v.getUint32(at + 42, true);
    const name = Buffer.from(z.subarray(at + 46, at + 46 + nlen)).toString("utf8");
    at += 46 + nlen + elen + clen;
    const p = place(dir, name, strip);
    if (!p) continue;
    const [abs, rel] = p;
    if (name.endsWith("/")) {
      mkdirSync(abs, { recursive: true });
      continue;
    }
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = z.subarray(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? Bun.inflateSync(raw as Uint8Array<ArrayBuffer>) : undefined;
    if (!data) throw new Error(`zip: ${name}: compression ${method}`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
    chmodSync(abs, (attr >>> 16) & 0o111 || rel.endsWith(".exe") ? 0o755 : 0o644);
  }
}
