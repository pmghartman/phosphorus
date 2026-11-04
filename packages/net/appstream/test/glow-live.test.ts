// glow against a real Sunshine, run headless here: phosphorus's own instance on its
// own Xvfb, an xterm streamed through the session as a viewer would see it, and the
// set-up a Windows host gets (our certificate added, the launcher added, one
// restart) played against an instance that has never seen us. Skipped where
// Sunshine, Xvfb or xterm isn't installed

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppSession,
  GlowHost,
  GlowSource,
  hostApps,
  type Instance,
  MsgConfig,
  MsgFrame,
  makeIdentity,
  type Platform,
  serverInfo,
  startInstance,
  type Viewer,
} from "../src/index.ts";

const have = (c: string) => Bun.spawnSync(["sh", "-c", `command -v ${c}`]).exitCode === 0;
const canRun = process.platform === "linux" && have("sunshine") && have("Xvfb") && have("xterm");

const until = async (f: () => boolean, ms = 8000) => {
  const t = Date.now() + ms;
  while (!f() && Date.now() < t) await Bun.sleep(5);
  return f();
};
const freePort = async () => {
  for (let p = 42000 + Math.floor(Math.random() * 200) * 100; ; p += 100) {
    try {
      await fetch(`http://127.0.0.1:${p}/serverinfo`, { signal: AbortSignal.timeout(200) });
    } catch {
      return p;
    }
  }
};

describe.skipIf(!canRun)("live sunshine", () => {
  const dirs: string[] = [];
  const insts: Instance[] = [];
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "glow-"));
    dirs.push(d);
    return d;
  };
  afterAll(async () => {
    for (const i of insts) await i.stop().catch(() => {});
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("a headless instance streams an app to the viewer, keyframes on request, resizes, closes", async () => {
    const id = makeIdentity();
    const inst = await startInstance({
      bin: "sunshine",
      dir: dir(),
      port: await freePort(),
      id,
      apps: [{ name: "xterm", cmd: "xterm -geometry 80x24+0+0" }],
      encoder: "software",
      screen: { w: 1280, h: 720 },
    });
    insts.push(inst);
    expect((await serverInfo(inst.host, id, true)).paired).toBe(true);
    // the host's certificate pinned: another one refused
    expect(serverInfo({ ...inst.host, cert: makeIdentity().cert }, id, true)).rejects.toThrow();
    const src = new GlowSource({
      host: inst.host,
      id,
      app: async () => (await hostApps(inst.host, id)).find((a) => a.title === "xterm")!.id,
      virtualDisplay: false,
      label: "sunshine",
    });
    const s = new AppSession("live1", src, {
      argv: [],
      name: "xterm",
      w: 800,
      h: 600,
      sw: 1280,
      sh: 720,
      scale: 1,
      full: false,
    });
    let ended = "";
    s.onEnd = (w) => void (ended = w);
    await s.open();
    const bins: Uint8Array[] = [];
    const js: any[] = [];
    const v: Viewer = {
      binary: (b) => void bins.push(b.slice()),
      json: (m) => void js.push(m),
      queued: () => 0,
      close: () => {},
    };
    s.attach(v);
    const keyAfter = (n: number) => bins.slice(n).some((b) => b[0] === MsgFrame && b[1] === 1);
    expect(await until(() => keyAfter(0))).toBe(true);
    const cfg = bins.find((b) => b[0] === MsgConfig)!;
    expect(new DataView(cfg.buffer).getUint16(4, true)).toBe(800);
    expect(js.find((m) => m.t === "cursor")?.name).toBe("blank");
    // a keyframe on request comes in well under a restart's time
    await Bun.sleep(200);
    const n0 = bins.length;
    const t0 = performance.now();
    s.input(["key"]);
    expect(await until(() => keyAfter(n0), 2000)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(500);
    // input reaches the host's control stream without ending it
    s.input(["m", 10, 10]);
    s.input(["b", 1, 1]);
    s.input(["b", 1, 0]);
    s.input(["k", 1, "KeyA", "a", 0]);
    s.input(["k", 0, "KeyA", "a", 0]);
    s.input(["x", "héllo"]);
    s.input(["w", 0, 1]);
    // a new size: a stream resumed at it
    const n1 = bins.length;
    s.input(["r", 640, 480]);
    expect(
      await until(() =>
        bins.slice(n1).some((b) => b[0] === MsgConfig && new DataView(b.buffer).getUint16(4, true) === 640),
      ),
    ).toBe(true);
    expect(await until(() => keyAfter(n1))).toBe(true);
    // gone and back: the app ran on, the stream resumed
    s.detach(v);
    await Bun.sleep(300);
    const n2 = bins.length;
    s.attach(v);
    expect(await until(() => keyAfter(n2))).toBe(true);
    // the window's close quits the app on the host
    s.input(["close"]);
    expect(await until(() => ended !== "", 10_000)).toBe(true);
    expect((await serverInfo(inst.host, id, true)).currentgame).toBe(0);
  }, 60_000);

  test("a host that has never seen phosphorus: certificate and launcher added, one restart, no PIN", async () => {
    const id = makeIdentity();
    const d = dir();
    const port = await freePort();
    const inst = await startInstance({
      bin: "sunshine",
      dir: d,
      port,
      id,
      trust: false,
      apps: [{ name: "Desktop", cmd: "" }],
      encoder: "software",
      screen: { w: 1280, h: 720 },
    });
    insts.push(inst);
    expect((await serverInfo(inst.host, id, true).catch(() => ({ paired: false }))).paired).toBe(false);
    let restarts = 0;
    const plat: Platform = {
      os: "linux",
      files: () => ({
        dir: d,
        state: join(d, "state.json"),
        apps: join(d, "apps.json"),
        cert: join(d, "cert.pem"),
        service: "test",
        kind: "sunshine",
      }),
      restart: async () => {
        restarts++;
        await inst.restart();
      },
      launcher: (ldir) => ({
        cmd: `sh ${join(ldir, "next.sh")}`,
        aim: (t) => Bun.write(join(ldir, "next.sh"), `exec ${t}\n`) as unknown as void,
      }),
    };
    const gh = new GlowHost(join(d, "phos"), plat, "127.0.0.1", port);
    // the identity GlowHost keeps is its own: made fresh on first use
    const notes: string[] = [];
    const r = await gh.ready((s) => void notes.push(s));
    expect(restarts).toBe(1);
    expect(notes.join(" ")).toContain("restarts once");
    expect(r.info.paired).toBe(true);
    const titles = (await hostApps(r.host, r.id)).map((a) => a.title);
    expect(titles).toContain("phosphorus");
    expect(await gh.listed()).toEqual(["Desktop"]);
    // ready again: nothing to change, no restart
    gh.forget();
    await gh.ready(() => {});
    expect(restarts).toBe(1);
    // the launcher aimed at an app, streamed
    const src = new GlowSource({
      host: r.host,
      id: r.id,
      app: () => gh.appFor(r, { target: "xterm -geometry 60x20+0+0" }),
      virtualDisplay: false,
      label: "sunshine",
    });
    const s = new AppSession("live2", src, {
      argv: [],
      name: "xterm",
      w: 640,
      h: 480,
      sw: 1280,
      sh: 720,
      scale: 1,
      full: false,
    });
    await s.open();
    const bins: Uint8Array[] = [];
    s.attach({ binary: (b) => void bins.push(b), json: () => {}, queued: () => 0, close: () => {} });
    expect(await until(() => bins.some((b) => b[0] === MsgFrame && b[1] === 1))).toBe(true);
    expect(await until(() => Bun.spawnSync(["pgrep", "-f", "xterm -geometry 60x20"]).exitCode === 0, 3000)).toBe(true);
    s.end("done");
  }, 90_000);
});
