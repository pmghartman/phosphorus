// content-defined chunks (a gear hash, FastCDC's cuts), each named by its bytes' hash; the table,
// sizes and hash the hosts' shared format, changed only by every host at once

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";

// [name, bytes]
export type Chunk = [string, number];

export const chunkMin = 4096;
export const chunkAvg = 16384;
export const chunkMax = 65536;
// cut tests on the hash's high bits: harder before the average, easier past it
const maskHard = 0xfffe0000 >>> 0;
const maskEasy = 0xfff80000 >>> 0;

// 256 fixed random words (mulberry32 from a fixed seed)
const gear = (() => {
  const t = new Uint32Array(256);
  let s = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    t[i] = (z ^ (z >>> 14)) >>> 0;
  }
  return t;
})();

// the next chunk's length in buf from at, end the bytes there are; eof lets a short tail stand
export function cutAt(buf: Uint8Array, at: number, end: number, eof: boolean): number {
  const left = end - at;
  if (left <= chunkMin) return eof ? left : 0;
  const stop = Math.min(left, chunkMax);
  if (stop < chunkMax && !eof) return 0;
  const mid = Math.min(stop, chunkAvg);
  let h = 0;
  let i = chunkMin;
  for (; i < mid; i++) {
    h = ((h << 1) + gear[buf[at + i]!]!) >>> 0;
    if ((h & maskHard) === 0) return i + 1;
  }
  for (; i < stop; i++) {
    h = ((h << 1) + gear[buf[at + i]!]!) >>> 0;
    if ((h & maskEasy) === 0) return i + 1;
  }
  return stop;
}

// a chunk's name: 128 bits of its sha-256
export const chunkName = (b: Uint8Array) => createHash("sha256").update(b).digest("hex").slice(0, 32);

const readBlock = 4 << 20;

// len bytes of path from pos, the file open only for the read: never held across an await, as
// Windows refuses to swap a new version over a file left open
function readAt(path: string, buf: Uint8Array, at: number, len: number, pos: number): number {
  const fd = openSync(path, "r");
  try {
    return readSync(fd, buf, at, len, pos);
  } finally {
    closeSync(fd);
  }
}

// a file's chunks in order, a block at a time with the event loop turning between
export async function chunkFile(path: string): Promise<Chunk[]> {
  const out: Chunk[] = [];
  let buf = new Uint8Array(readBlock + chunkMax);
  let have = 0;
  let pos = 0;
  let eof = false;
  for (;;) {
    if (!eof && have < chunkMax) {
      if (buf.length - have < readBlock) {
        const grown = new Uint8Array(have + readBlock);
        grown.set(buf.subarray(0, have));
        buf = grown;
      }
      const n = readAt(path, buf, have, readBlock, pos);
      have += n;
      pos += n;
      if (n === 0) eof = true;
      await new Promise<void>((r) => setImmediate(r));
      continue;
    }
    let at = 0;
    for (;;) {
      const n = cutAt(buf, at, have, eof);
      if (n === 0) break;
      out.push([chunkName(buf.subarray(at, at + n)), n]);
      at += n;
    }
    if (eof) break;
    buf.copyWithin(0, at, have);
    have -= at;
  }
  return out;
}
