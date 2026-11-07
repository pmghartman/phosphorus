// the tools run beside phosphorus, pinned and checked: wintun on Windows, the
// tunnel's driver; fetched into state/cache/tools when a pin moves
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { untar, unzip } from "@phosphorus/tools";
import { errText, fail, fileExists, isWindows, say, sleep } from "./base.ts";
import { replace } from "./install.ts";
import { os } from "./os.ts";

export const Wintun = "0.14.1";

// one pinned download: its files, out of a .tgz or .zip when members names them
export type Pin = { name: string; ver: string; url: string; sha256: string; files: Record<string, string> };

// the pins for this OS and arch: wintun on Windows
export function pins(platform = process.platform, arch = process.arch): Pin[] {
  const a = arch === "arm64" ? "arm64" : "amd64";
  const out: Pin[] = [];
  if (platform === "win32") {
    // the tunnel's driver, signed by WireGuard LLC; one zip for every arch
    out.push({
      name: "wintun",
      ver: Wintun,
      url: `https://www.wintun.net/builds/wintun-${Wintun}.zip`,
      sha256: "07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51",
      files: { "wintun.dll": `wintun/bin/${a}/wintun.dll` },
    });
  }
  return out;
}

const versionsFile = () => join(os.libexec(), "versions.json");

function versions(): Record<string, string> {
  try {
    const v = JSON.parse(readFileSync(versionsFile(), "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// a pin's bytes, checked, a few tries over a blip
async function download(p: Pin): Promise<Uint8Array> {
  let last = "";
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(p.url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (res.status !== 200) throw new Error(`${res.status} ${res.statusText}`);
      const b = new Uint8Array(await res.arrayBuffer());
      const got = sha256(b);
      if (got !== p.sha256) throw new Error(`checksum mismatch (got ${got})`);
      return b;
    } catch (e) {
      last = errText(e);
      if (i < 3) await sleep(2000 * i);
    }
  }
  throw fail(`couldn't fetch ${p.name} ${p.ver} from ${p.url}: ${last}`);
}

// one pin's files into dir, each replacing the last (a running Windows exe moved aside)
async function install(p: Pin, dir: string) {
  const b = await download(p);
  const tmp = join(dir, `.phosphorus-${p.name}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    if (p.url.endsWith(".tgz")) untar(b, tmp, 0);
    else if (p.url.endsWith(".zip")) unzip(b, tmp, 0);
    for (const [out, member] of Object.entries(p.files)) {
      const src = member ? join(tmp, member) : join(tmp, out);
      if (!member) writeFileSync(src, b);
      if (!fileExists(src)) throw fail(`${p.url} has no ${member}`);
      if (!isWindows) chmodSync(src, 0o755);
      replace(src, join(dir, out));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// every pin here at its version, fetched only when it moved or a file went missing;
// the names fetched
export async function ensureTools(): Promise<string[]> {
  const got: string[] = [];
  for (const p of pins(process.platform, process.arch)) if (await ensurePin(p)) got.push(p.name);
  return got;
}

// one pin here at its version; true when it was fetched
export async function ensurePin(p: Pin): Promise<boolean> {
  const dir = os.libexec();
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const have = versions();
  if (have[p.name] === p.ver && Object.keys(p.files).every((f) => fileExists(join(dir, f)))) return false;
  say(`fetching ${p.name} ${p.ver}`);
  await install(p, dir);
  // read again, another pin may have landed meanwhile
  writeFileSync(versionsFile(), JSON.stringify({ ...versions(), [p.name]: p.ver }) + "\n", { mode: 0o644 });
  return true;
}
