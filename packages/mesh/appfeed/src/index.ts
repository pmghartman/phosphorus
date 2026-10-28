// a desktop app's own updates off the signed feed on the release `update`, a
// newer release downloaded and checked against the release key
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parsePublicKey } from "@phosphorus/minisign";

// one feed file: the newest version for a target, its file and signature
export type Release = { version: string; url: string; signature: string };

// this machine as the feed names it
export function target() {
  const arch = ({ arm64: "aarch64", x64: "x86_64" } as Record<string, string>)[process.arch] ?? "";
  const os = process.platform === "win32" ? "windows" : process.platform;
  return `${os}-${arch}`;
}

// numeric, part by part, missing parts 0
export function newer(a: string, b: string): boolean {
  const pa = a.split("."),
    pb = b.split(".");
  for (let i = 0; i < pa.length || i < pb.length; i++) {
    const x = parseInt(pa[i] ?? "0", 10) || 0,
      y = parseInt(pb[i] ?? "0", 10) || 0;
    if (x !== y) return x > y;
  }
  return false;
}

// where an app looks: the feed's base url, the key its files are signed with,
// the app's prefix on each target's file ("" for phosphorus)
export class Feed {
  constructor(
    public url: string,
    public pubkey: string,
    public app = "",
  ) {}

  // whether the feed is set, false for a dev build
  on() {
    return !!this.url && !!this.pubkey;
  }

  // the feed's release when newer than have, undefined when not or with no feed
  async check(have: string): Promise<Release | undefined> {
    if (!this.on()) return;
    const res = await fetch(`${this.url.replace(/\/+$/, "")}/${this.app}${target()}.json`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404) return;
    if (res.status !== 200) throw new Error(`feed answered ${res.status}`);
    const r = (await res.json()) as Release;
    if (!r.url || !newer(r.version, have)) return;
    return r;
  }

  // the release downloaded into a fresh temp folder, its signature checked; the file's path
  async fetch(r: Release): Promise<string> {
    const key = parsePublicKey(this.pubkey);
    const res = await fetch(r.url, { signal: AbortSignal.timeout(15 * 60_000) });
    if (res.status !== 200) throw new Error(`download answered ${res.status}`);
    const data = new Uint8Array(await res.arrayBuffer());
    try {
      key.verify(data, r.signature);
    } catch (e: any) {
      throw new Error("the download's signature doesn't match the release key: " + e.message);
    }
    const file = join(mkdtempSync(join(tmpdir(), "phosphorus-update-")), basename(new URL(r.url).pathname));
    writeFileSync(file, data, { mode: 0o755 });
    return file;
  }
}
