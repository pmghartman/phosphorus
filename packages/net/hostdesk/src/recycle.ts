// Windows' recycle bin records: a $I file per deleted item, its $R the item itself

export type BinInfo = { path: string; size: number; deleted: number };

// 100ns ticks from 1601 to 1970
const epochTicks = 116444736000000000n;

const toFiletime = (ms: number) => BigInt(Math.round(ms)) * 10000n + epochTicks;

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
