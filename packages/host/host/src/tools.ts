// the tools run beside phosphorus, pinned and checked: tailscale on Linux, cloudflared
// everywhere, headscale on the control host; fetched into state/cache/tools when a pin moves
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { untar } from "@phosphorus/tools";
import { errText, fail, fileExists, isLinux, isWindows, say, sleep } from "./base.ts";
import { replace } from "./install.ts";
import { os } from "./os.ts";

export const Tailscale = "1.104.1";
export const Cloudflared = "2026.10.4";
export const Headscale = "0.29.7";

const cf = `https://github.com/cloudflare/cloudflared/releases/download/${Cloudflared}`;

// one pinned download: its files, out of a .tgz when members names them
export type Pin = { name: string; ver: string; url: string; sha256: string; files: Record<string, string> };

// headscale, the mesh's control server, fetched on Linux only by the host running it
export function headscalePin(arch = process.arch): Pin {
  const a = arch === "arm64" ? "arm64" : "amd64";
  return {
    name: "headscale",
    ver: Headscale,
    url: `https://github.com/juanfont/headscale/releases/download/v${Headscale}/headscale_${Headscale}_linux_${a}`,
    sha256:
      a === "arm64"
        ? "4357b38ac63c1e425f190819fd2ee078f13e01a6d7559b15811154e2475df5e4"
        : "e827fc9b12d958bc95b081c4401dd63f8e0471d025b45b508535a920532150a8",
    files: { headscale: "" },
  };
}

// the pins for this OS and arch; tailscale only where phosphorus runs its own
export function pins(platform = process.platform, arch = process.arch, ownTailscale = true): Pin[] {
  const a = arch === "arm64" ? "arm64" : "amd64";
  const out: Pin[] = [];
  if (platform === "linux") {
    if (ownTailscale) {
      const d = `tailscale_${Tailscale}_${a}`;
      out.push({
        name: "tailscale",
        ver: Tailscale,
        url: `https://pkgs.tailscale.com/stable/${d}.tgz`,
        sha256:
          a === "arm64"
            ? "f60294374967f3dfd8cf57bbbd474d6cfce32d123e3a8ddeab82a87940daa806"
            : "108d1d96ecf410d305571e173516f27038f870919a9b89c914a167c6d33a4528",
        files: { tailscale: `${d}/tailscale`, tailscaled: `${d}/tailscaled` },
      });
    }
    out.push({
      name: "cloudflared",
      ver: Cloudflared,
      url: `${cf}/cloudflared-linux-${a}`,
      sha256:
        a === "arm64"
          ? "2b7203b4fb0ba28a0c1e12f8855ce2c25f76d266a8d5edafac5540b6812acff6"
          : "ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42",
      files: { cloudflared: "" },
    });
  } else if (platform === "darwin") {
    out.push({
      name: "cloudflared",
      ver: Cloudflared,
      url: `${cf}/cloudflared-darwin-arm64.tgz`,
      sha256: "68b6bc4080ac1330234db2a9002d07f98b000537a1bd531a687b660d4160fa7f",
      files: { cloudflared: "cloudflared" },
    });
  } else if (platform === "win32") {
    out.push({
      name: "cloudflared",
      ver: Cloudflared,
      url: `${cf}/cloudflared-windows-amd64.exe`,
      sha256: "411b16d40c8d872243efeb52c550053d00af0a8a97fbb32e730fb8aba429eaa8",
      files: { "cloudflared.exe": "" },
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
  for (const p of pins(process.platform, process.arch, !isLinux || os.ownTailscale()))
    if (await ensurePin(p)) got.push(p.name);
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
