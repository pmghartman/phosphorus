// Windows' recycle bin records: a $I file per deleted item, its $R the item itself;
// version 1 (Vista to 8.1) a fixed 260 char path, version 2 a counted one

export type BinInfo = { path: string; size: number; deleted: number };

// 100ns ticks from 1601 to 1970
const epochTicks = 116444736000000000n;

export const toFiletime = (ms: number) => BigInt(Math.round(ms)) * 10000n + epochTicks;
export const fromFiletime = (t: bigint) => Number((t - epochTicks) / 10000n);

// one $I file's bytes read, undefined when it isn't one
export function parseInfo(b: Uint8Array): BinInfo | undefined {
  if (b.length < 24) return;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ver = v.getBigInt64(0, true);
  const size = Number(v.getBigInt64(8, true));
  const deleted = fromFiletime(v.getBigInt64(16, true));
  let raw: Uint8Array;
  if (ver === 1n) raw = b.subarray(24, Math.min(b.length, 24 + 520));
  else if (ver === 2n) {
    if (b.length < 28) return;
    const n = v.getUint32(24, true);
    if (n > 32768 || 28 + n * 2 > b.length) return;
    raw = b.subarray(28, 28 + n * 2);
  } else return;
  let path = Buffer.from(raw).toString("utf16le");
  const z = path.indexOf("\0");
  if (z >= 0) path = path.slice(0, z);
  if (!path) return;
  return { path, size, deleted };
}

// a version 2 $I file for path, as Windows 10 and 11 write them
export function writeInfo(i: BinInfo): Uint8Array {
  const name = Buffer.from(i.path + "\0", "utf16le");
  const b = new Uint8Array(28 + name.length);
  const v = new DataView(b.buffer);
  v.setBigInt64(0, 2n, true);
  v.setBigInt64(8, BigInt(Math.max(0, Math.trunc(i.size))), true);
  v.setBigInt64(16, toFiletime(i.deleted), true);
  v.setUint32(24, name.length / 2, true);
  b.set(name, 28);
  return b;
}

const binChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// the six character name both files share, the item's extension kept
export function binName(path: string, pick: (n: number) => number = (n) => Math.floor(Math.random() * n)): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += binChars[pick(binChars.length)];
  const base = path.split("\\").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? s + base.slice(dot) : s;
}

export const binRe = /^\$I[A-Z0-9]{6}(\.[^\\/:*?"<>|]{1,64})?$/i;
