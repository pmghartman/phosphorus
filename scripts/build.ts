// build: the host and tray binaries compiled by bun for a target, into OUT
//   bun scripts/build.ts TARGET OUT [VERSION]
// TARGET: linux-x64 linux-arm64 darwin-x64 darwin-arm64 windows-x64; the web
// client must be built first (bun run web). The tray's feed comes from
// FEED_URL and FEED_PUBKEY, baked in like the Go -X flags were.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const [target, out, version = "dev"] = process.argv.slice(2);
if (!target || !out) {
  console.error("usage: bun scripts/build.ts TARGET OUT [VERSION]");
  process.exit(2);
}
const root = resolve(import.meta.dir, "..");
const win = target.startsWith("windows");
mkdirSync(out, { recursive: true });

const define = {
  "process.env.PHOSPHORUS_VERSION": JSON.stringify(version),
  "process.env.FEED_URL": JSON.stringify(process.env.FEED_URL ?? ""),
  "process.env.FEED_PUBKEY": JSON.stringify(process.env.FEED_PUBKEY ?? ""),
};
const compile = async (entry: string, name: string, gui: boolean) => {
  const res = await Bun.build({
    entrypoints: [join(root, entry)],
    compile: {
      target: `bun-${target}` as any,
      outfile: join(out, name),
      windows: win ? { hideConsole: gui, icon: join(root, "packaging/icons/icon.ico") } : undefined,
      autoloadBunfig: false,
      autoloadDotenv: false,
    },
    minify: true,
    sourcemap: "none",
    define,
  });
  for (const l of res.logs) console.error(String(l));
  if (!res.success) process.exit(1);
  console.log(`[build] ${name} for ${target}`);
};
await compile("apps/host/src/main.ts", win ? "phosphorus-host.exe" : "phosphorus-host", false);
// Linux has no tray; its hosts run as a systemd service alone
if (!target.startsWith("linux")) await compile("apps/tray/src/main.ts", win ? "Phosphorus.exe" : "Phosphorus", true);
