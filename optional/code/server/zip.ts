// a zip read whole from memory, stored or deflated entries, as archive/zip
// reads the skill; and one written, for the tests and whoever packs a skill
import { deflateRawSync, inflateRawSync } from "node:zlib";

// unzip every file in z by name, folders skipped
export function unzip(z: Uint8Array): Map<string, Uint8Array> {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
  let eocd = -1;
  for (let i = z.length - 22; i >= 0 && i >= z.length - 22 - 0xffff; i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip");
  const n = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let k = 0; k < n; k++) {
    if (p + 46 > z.length || v.getUint32(p, true) !== 0x02014b50) throw new Error("bad zip");
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true),
      extraLen = v.getUint16(p + 30, true),
      cmtLen = v.getUint16(p + 32, true);
    const at = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(z.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + cmtLen;
    if (name.endsWith("/")) continue;
    if (at + 30 > z.length || v.getUint32(at, true) !== 0x04034b50) throw new Error("bad zip");
    const start = at + 30 + v.getUint16(at + 26, true) + v.getUint16(at + 28, true);
    const raw = z.subarray(start, start + csize);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, new Uint8Array(inflateRawSync(raw)));
    else throw new Error(`zip method ${method}`);
  }
  return out;
}

// zipOf files by name, deflated
export function zipOf(files: Record<string, string | Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [],
    cd: Uint8Array[] = [];
  let off = 0;
  const hdr = (sig: number, n: number) => {
    const b = new Uint8Array(n);
    new DataView(b.buffer).setUint32(0, sig, true);
    return b;
  };
  for (const [name, body] of Object.entries(files)) {
    const data = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const nm = new TextEncoder().encode(name);
    const packed = new Uint8Array(deflateRawSync(data));
    const crc = Bun.hash.crc32(data);
    const fill = (b: Uint8Array, o: number) => {
      const v = new DataView(b.buffer);
      v.setUint16(o, 20, true);
      v.setUint16(o + 4, 8, true);
      v.setUint32(o + 10, crc, true);
      v.setUint32(o + 14, packed.length, true);
      v.setUint32(o + 18, data.length, true);
      v.setUint16(o + 22, nm.length, true);
    };
    const lh = hdr(0x04034b50, 30);
    fill(lh, 4);
    const ch = hdr(0x02014b50, 46);
    fill(ch, 6);
    new DataView(ch.buffer).setUint32(42, off, true);
    cd.push(ch, nm);
    parts.push(lh, nm, packed);
    off += 30 + nm.length + packed.length;
  }
  const cdLen = cd.reduce((n, b) => n + b.length, 0);
  const end = hdr(0x06054b50, 22);
  const v = new DataView(end.buffer);
  v.setUint16(8, Object.keys(files).length, true);
  v.setUint16(10, Object.keys(files).length, true);
  v.setUint32(12, cdLen, true);
  v.setUint32(16, off, true);
  return Buffer.concat([...parts, ...cd, end]);
}
