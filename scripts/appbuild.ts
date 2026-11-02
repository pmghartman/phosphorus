// appbuild: one first-party app's signed bundle and its feed, from
// packages/apps/<id>/: web/index.html and what it loads, web/static/ as it is,
// server/index.ts bundled whole into server/index.js
//   bun scripts/appbuild.ts ID OUT [VERSION]
// OUT gets <id>-<version>.tar.gz and <id>.json, the feed entry naming it under
// APPS_FEED_BASE (the release's download url, http://127.0.0.1:<port> for a feed
// made here). Signed with UPDATE_SIGNING_KEY, as feedsign signs the host's; an app
// with a server half is refused unsigned. For a dev build: feedsign -keygen, sign
// with its secret, and give the host its public half as APPS_PUBKEY.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { encrypted, parseSecretKey } from "@phosphorus/minisign";
import { tarGz } from "@phosphorus/tools";
import { appOf } from "@phosphorus/webapps";

const [id, out, version = "0.0.0"] = process.argv.slice(2);
const die = (msg: string, code = 1): never => {
  console.error("appbuild:", msg);
  process.exit(code);
};
if (!id || !out) die("usage: bun scripts/appbuild.ts ID OUT [VERSION]", 2);
if (!/^\d+(\.\d+){0,3}$/.test(version)) die(`${version} isn't a version: numbers and dots`);
const app = appOf(id!) ?? die(`${id} isn't in the catalogue (packages/mesh/webapps)`);
const root = resolve(import.meta.dir, "..");
const src = join(root, "packages", "apps", id!);
const mount = app.mount.replace(/^\/+|\/+$/g, "");
if (!existsSync(join(src, "web", "index.html"))) die(`no ${relative(root, join(src, "web", "index.html"))}`);

const stage = mkdtempSync(join(tmpdir(), `phos-app-${id}-`));
try {
  const web = join(stage, mount);
  const res = await Bun.build({
    entrypoints: [join(src, "web", "index.html")],
    outdir: web,
    minify: true,
    sourcemap: "none",
  });
  for (const l of res.logs) console.error(String(l));
  if (!res.success) die("the page didn't build");
  if (existsSync(join(src, "web", "static"))) cpSync(join(src, "web", "static"), web, { recursive: true });

  const server = join(src, "server", "index.ts");
  if (!!app.server !== existsSync(server))
    die(
      app.server
        ? `the catalogue says ${id} runs code, and there's no server/index.ts`
        : `${id} has a server/index.ts the catalogue doesn't mark server: true`,
    );
  if (app.server) {
    const s = await Bun.build({
      entrypoints: [server],
      outdir: join(stage, "server"),
      target: "bun",
      format: "esm",
      naming: "index.js",
      minify: true,
      sourcemap: "none",
    });
    for (const l of s.logs) console.error(String(l));
    if (!s.success) die("the server half didn't build");
  }

  const files: [string, Uint8Array][] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(["./" + relative(stage, p).replaceAll("\\", "/"), readFileSync(p)]);
    }
  };
  walk(stage);
  const data = tarGz(files);

  const key = process.env.UPDATE_SIGNING_KEY ?? "";
  let signature = "";
  if (key) {
    if (encrypted(key)) die("UPDATE_SIGNING_KEY is password protected; make a new one with feedsign -keygen");
    signature = parseSecretKey(key, "").sign(data, `${id}-${version}.tar.gz`);
  } else if (app.server) die(`${id} runs code in phosphorus: set UPDATE_SIGNING_KEY, no host takes it unsigned`);
  else console.error(`appbuild: ${id} unsigned, taken on its hash alone`);

  mkdirSync(out!, { recursive: true });
  const tar = `${id}-${version}.tar.gz`;
  writeFileSync(join(out!, tar), data);
  const base = (process.env.APPS_FEED_BASE ?? "").replace(/\/+$/, "");
  if (!base) console.error("appbuild: no APPS_FEED_BASE, the feed's url is the tarball's name alone");
  const sha256 = createHash("sha256").update(data).digest("hex");
  writeFileSync(
    join(out!, `${id}.json`),
    JSON.stringify({ version, url: base ? `${base}/${tar}` : tar, sha256, signature }, null, 2) + "\n",
  );
  console.log(
    `[appbuild] ${id} v${version}: ${files.length} files, ${data.length} bytes${signature ? ", signed" : ""}`,
  );
} finally {
  rmSync(stage, { recursive: true, force: true });
}
