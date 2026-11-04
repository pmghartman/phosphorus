// the Viewer app as a host takes it: built by appbuild from optional/viewer with a
// key of the test's own, verified, unpacked and served at its mount; the files it
// opens carried in the mesh's wants for the desktop, and the file api sending
// those files' bytes typed
import "./env.ts";
import { expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const M = await import("@phosphorus/minisign");
const W = await import("@phosphorus/webapps");
const store = await import("@phosphorus/store");
const A = await import("../src/apps.ts");
const { sendFile } = await import("../src/shares.ts");

const root = resolve(import.meta.dir, "../../../..");
const out = join(process.env.STATE_DIR!, "..", "appbuild-viewer");

test("the viewer app: built, signed, verified, served, opening its files", async () => {
  const pair = M.generate();
  const build = Bun.spawnSync(["bun", "scripts/appbuild.ts", "viewer", out, "1.0.0"], {
    cwd: root,
    env: { ...process.env, UPDATE_SIGNING_KEY: pair.secret, APPS_FEED_BASE: "https://example.test/feed" },
  });
  expect(build.exitCode, build.stderr.toString()).toBe(0);
  const rel = JSON.parse(readFileSync(join(out, "viewer.json"), "utf8"));
  const data = readFileSync(join(out, "viewer-1.0.0.tar.gz"));
  const app = W.appOf("viewer")!;
  expect(app.server).toBeFalsy();
  expect(app.opens).toEqual(expect.arrayContaining(["png", "mp4", "mp3", "pdf", "txt", "ts"]));

  process.env.APPS_PUBKEY = M.generate().public;
  expect(() => W.verify(app, rel, data)).toThrow(/signature/);
  process.env.APPS_PUBKEY = pair.public;
  W.verify(app, rel, data);
  W.unpack(app, { ...rel, from: "testhost", at: 0 }, data);
  W.reset();
  // a page only: nothing of it run in phosphorus
  await A.settleApp("viewer");
  expect(A.runningApps()).toEqual([]);

  // its page at its mount, a file's route its index, its script and icon beside it
  const page = W.serve(new Request("http://127.0.0.1/app/viewer/"))!;
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('id="vw-main"');
  const script = /src="\.?\/?([^"]+\.js)"/.exec(html)![1]!;
  const js = W.serve(new Request(`http://127.0.0.1/app/viewer/${script}`))!;
  expect([js.status, js.headers.get("content-type")]).toEqual([200, "text/javascript; charset=utf-8"]);
  expect(await js.text()).toContain("/api/files/");
  const routed = W.serve(
    new Request("http://127.0.0.1/app/viewer/?host=testhost&share=home&path=a.png", {
      headers: { accept: "text/html" },
    }),
  )!;
  expect(routed.status).toBe(200);
  expect(W.serve(new Request("http://127.0.0.1/app/viewer/icon.svg"))!.status).toBe(200);

  // the mesh wanting it: its extensions told to every desktop
  store.write("etc/apps/viewer.json", { ...rel, from: "testhost", at: 1 });
  expect(W.wants().viewer).toMatchObject({ version: "1.0.0", mount: "/app/viewer/", opens: app.opens });
  store.remove("etc/apps/viewer.json");
  expect(W.wants().viewer).toBeUndefined();

  // what it plays sent as what it is, not octet-stream behind nosniff
  const types: Record<string, string> = {
    "a.mp3": "audio/mpeg",
    "a.flac": "audio/flac",
    "a.m4a": "audio/mp4",
    "a.mkv": "video/x-matroska",
    "a.mov": "video/quicktime",
    "a.avif": "image/avif",
    "a.bmp": "image/bmp",
    "a.ico": "image/x-icon",
  };
  for (const [n, t] of Object.entries(types)) {
    const f = join(out, n);
    writeFileSync(f, "x");
    expect([n, sendFile(f, false).headers.get("content-type")]).toEqual([n, t]);
  }

  rmSync(join(process.env.STATE_DIR!, "data", "apps", "viewer", "current.json"));
  W.reset();
  delete process.env.APPS_PUBKEY;
}, 120000);
