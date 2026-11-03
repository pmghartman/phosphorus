// a gzipped tar read as it streams: the entries whose path is wanted, never
// written out, the rest skipped (a catalogue's tarball runs to hundreds of MB)

const cstr = (b: Uint8Array, at: number, n: number) => {
  let end = at;
  while (end < at + n && b[end]) end++;
  return Buffer.from(b.subarray(at, end)).toString("utf8");
};
const octal = (b: Uint8Array, at: number, n: number) => Number.parseInt(cstr(b, at, n).trim() || "0", 8);

class Reader {
  private chunks: Uint8Array[] = [];
  private len = 0;
  private done = false;
  constructor(private it: AsyncIterator<Uint8Array>) {}
  private async fill(n: number) {
    while (this.len < n && !this.done) {
      const r = await this.it.next();
      if (r.done) this.done = true;
      else if (r.value.length) {
        this.chunks.push(r.value);
        this.len += r.value.length;
      }
    }
    return this.len >= n;
  }
  // n bytes, or undefined at the end
  async take(n: number): Promise<Uint8Array | undefined> {
    if (!(await this.fill(n))) return;
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const c = this.chunks[0]!;
      const k = Math.min(c.length, n - at);
      out.set(c.subarray(0, k), at);
      at += k;
      if (k === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
    this.len -= n;
    return out;
  }
  async skip(n: number) {
    while (n > 0) {
      if (!this.len && !(await this.fill(1))) return;
      const c = this.chunks[0]!;
      const k = Math.min(c.length, n);
      n -= k;
      this.len -= k;
      if (k === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
  }
}

export interface Entry {
  path: string;
  dir: boolean;
  size: number;
  data?: Uint8Array;
}

// the regular files and folders of a gzipped tar, paths with the top folder
// (codeload's <repo>-<ref>/) dropped; data read only when want says so
export async function* entries(gz: ReadableStream<Uint8Array>, want: (path: string) => boolean): AsyncGenerator<Entry> {
  const r = new Reader(
    gz
      .pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
      [Symbol.asyncIterator](),
  );
  let longName = "";
  let pax: Record<string, string> = {};
  for (;;) {
    const h = await r.take(512);
    if (!h || h.every((x) => x === 0)) return;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const pad = Math.ceil(size / 512) * 512 - size;
    const meta = type === "L" || type === "x";
    const prefix = cstr(h, 257, 6).startsWith("ustar") ? cstr(h, 345, 155) : "";
    const name = pax.path || longName || (prefix ? prefix + "/" : "") + cstr(h, 0, 100);
    const path = meta ? "" : name.split("/").slice(1).join("/").replace(/\/$/, "");
    const file = type === "0" || type === "\0";
    const read = meta || (file && !!path && want(path));
    const data = read ? await r.take(size) : undefined;
    if (!read) await r.skip(size);
    await r.skip(pad);
    if (type === "L") {
      longName = cstr(data!, 0, data!.length);
      continue;
    }
    if (type === "x") {
      for (const rec of Buffer.from(data!).toString("utf8").split("\n")) {
        const m = /^\d+ ([^=]+)=(.*)$/.exec(rec);
        if (m) pax[m[1]!] = m[2]!;
      }
      continue;
    }
    longName = "";
    pax = {};
    if (!path || (!file && type !== "5")) continue;
    yield { path, dir: type === "5", size, data };
  }
}

// a gzipped tar of files under top/, as codeload sends: for tests
export function pack(files: Record<string, string>, top = "repo-HEAD"): Uint8Array<ArrayBuffer> {
  const blocks: Uint8Array[] = [];
  for (const [p, text] of Object.entries(files)) {
    const body = Buffer.from(text, "utf8");
    const h = new Uint8Array(512);
    h.set(Buffer.from(`${top}/${p}`.slice(0, 100)), 0);
    h.set(Buffer.from("0000644\0"), 100);
    h.set(Buffer.from(body.length.toString(8).padStart(11, "0") + "\0"), 124);
    h.set(Buffer.from("        "), 148);
    h[156] = 48;
    h.set(Buffer.from("ustar\0"), 257);
    let sum = 0;
    for (const x of h) sum += x;
    h.set(Buffer.from(sum.toString(8).padStart(6, "0") + "\0 "), 148);
    blocks.push(h, body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  return Bun.gzipSync(Buffer.concat(blocks));
}
