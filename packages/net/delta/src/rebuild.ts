// a file made again from its chunk list on the receiving host: each chunk taken from a local
// folder that holds it, only the rest fetched; and the sending host's side of that ask

import { type FileHandle, open } from "node:fs/promises";
import { type Chunk, chunkName } from "./chunk.ts";
import type { Chunks } from "./tree.ts";

// the sender's chunks by name, in the order asked; none when it no longer holds them all
export type Fetch = (want: Chunk[]) => Promise<Uint8Array[] | undefined>;

// a file built this many bytes at a time, a sender asked at most this many chunks at once
const windowBytes = 4 << 20;
export const maxAsk = 1024;

// tmp written as list says from the local folders' chunks and fetched ones, each checked by its
// name; fetched told the bytes that crossed; false unless every chunk came
export async function rebuild(
  tmp: string,
  list: Chunk[],
  local: Chunks[],
  fetch: Fetch,
  fetched?: (bytes: number) => void,
): Promise<boolean> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(tmp, "w");
    for (let i = 0; i < list.length; ) {
      let j = i;
      let bytes = 0;
      while (j < list.length && j - i < maxAsk && (j === i || bytes + list[j]![1] <= windowBytes))
        bytes += list[j++]![1];
      const win = list.slice(i, j);
      const got = new Map<string, Uint8Array>();
      for (const tree of local) {
        const left = win.filter(([h]) => !got.has(h)).map(([h]) => h);
        if (!left.length) break;
        for (const [h, b] of await tree.read(left)) got.set(h, b);
      }
      const need = new Map<string, number>();
      for (const [h, n] of win) if (!got.has(h)) need.set(h, n);
      if (need.size) {
        const want = [...need];
        const bs = await fetch(want);
        if (!bs || bs.length !== want.length) return false;
        let moved = 0;
        for (let k = 0; k < want.length; k++) {
          const [h, n] = want[k]!;
          const b = bs[k]!;
          if (b.length !== n || chunkName(b) !== h) return false;
          got.set(h, b);
          moved += n;
        }
        fetched?.(moved);
      }
      for (const [h] of win) await fh.write(got.get(h)!);
      i = j;
    }
    return true;
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

// the sender's answer to an ask: the chunks end to end in the order asked, none unless it holds
// every one; want as the wire carries it, checked here
export async function serveChunks(tree: Chunks, want: unknown): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (!Array.isArray(want) || want.length > maxAsk) return;
  const names = want.map((w) => (Array.isArray(w) && typeof w[0] === "string" ? w[0] : ""));
  if (names.some((n) => !n)) return;
  const got = await tree.read(names);
  const parts = names.map((n) => got.get(n));
  if (parts.some((b) => !b)) return;
  const out = new Uint8Array(parts.reduce((n, b) => n + b!.length, 0));
  let at = 0;
  for (const b of parts) {
    out.set(b!, at);
    at += b!.length;
  }
  return out;
}

// an answer cut back into its chunks by the lengths asked, none when it doesn't add up
export function splitChunks(all: Uint8Array, want: Chunk[]): Uint8Array[] | undefined {
  const out: Uint8Array[] = [];
  let at = 0;
  for (const [, n] of want) {
    if (at + n > all.length) return;
    out.push(all.subarray(at, at + n));
    at += n;
  }
  return at === all.length ? out : undefined;
}
