// afterglow driven through an AppSession, against the stand-in afterglow its package
// ships for tests (a real loopback socket): the open's video taken up when the viewer
// attaches, frames to the viewer with their header put in place, a keyframe asked for
// without a restart, input at the video's size, a resize as a fresh video, the app's
// exit. The link and source on their own are tested in github.com/pmghartman/afterglow

import { afterEach, describe, expect, test } from "bun:test";
import { AfterglowSource, In, Out } from "@phosphorus/afterglow";
import { configMessage, FakeAfterglow, frameMessage, jsonMessage } from "@phosphorus/afterglow/testing";
import { AppSession, HeadLen, MsgConfig, MsgFrame, type Viewer } from "../src/index.ts";

const settle = () => new Promise((r) => setTimeout(r, 30));

let fake: FakeAfterglow | undefined;
afterEach(() => fake?.stop());

describe("afterglow through a session", () => {
  test("launch, frames with their header in place, gen filtering, a keyframe asked, input, exit", async () => {
    fake = new FakeAfterglow("t0ken-t0ken-t0ken-1", (f, type, body) => {
      if (type === In.launch) f.send(jsonMessage(Out.launched, { ok: true, resumed: false }));
      if (type === In.video) {
        const j = JSON.parse(new TextDecoder().decode(body));
        f.send(configMessage(j.gen, j.w, j.h, [1, 0x64, 0, 0x1f]));
        f.send(frameMessage(j.gen, true, [0, 0, 0, 2, 0x65, 0x88]));
        // a frame of a video already given up: dropped
        f.send(frameMessage(j.gen - 1, false, [0, 0, 0, 1, 0x41]));
      }
    });
    let done = 0;
    const src = new AfterglowSource({
      link: { port: fake.port, token: fake.token },
      target: "C:\\Users\\me\\Desktop\\App.lnk",
      virtualDisplay: true,
      done: () => done++,
    });
    const app = new AppSession("a1", src, {
      argv: [],
      name: "App",
      w: 1280,
      h: 720,
      sw: 1920,
      sh: 1080,
      scale: 1,
      full: false,
      fps: 60,
    });
    await app.open();
    const launch = JSON.parse(new TextDecoder().decode(fake.sent(In.launch)[0]!.body));
    expect(fake.hello).toBe(fake.token);
    expect(launch).toMatchObject({
      cmd: "C:\\Users\\me\\Desktop\\App.lnk",
      w: 1280,
      h: 720,
      fps: 60,
      virtual_display: true,
    });

    const bins: Uint8Array[] = [];
    const msgs: Record<string, unknown>[] = [];
    const v: Viewer = {
      binary: (b) => bins.push(b),
      json: (m) => msgs.push(m as Record<string, unknown>),
      queued: () => 0,
      close: () => {},
    };
    app.attach(v);
    await settle();
    // one video: the open's, taken up with a keyframe asked rather than a second one
    expect(fake.sent(In.video).length).toBe(1);
    expect(fake.sent(In.idr).length).toBeGreaterThanOrEqual(1);
    const cfg = bins.find((b) => b[0] === MsgConfig)!;
    expect(Array.from(cfg.subarray(HeadLen))).toEqual([1, 0x64, 0, 0x1f]);
    const frames = bins.filter((b) => b[0] === MsgFrame);
    expect(frames.length).toBe(1);
    expect(frames[0]![1]).toBe(1);
    expect(Array.from(frames[0]!.subarray(HeadLen))).toEqual([0, 0, 0, 2, 0x65, 0x88]);

    // input: GameStream packets, a mouse move at the video's size
    app.input(["m", 640, 360]);
    app.input(["k", true, "KeyA", "a", false]);
    await settle();
    const inputs = fake.sent(In.input).map((g) => g.body);
    expect(inputs.length).toBe(2);
    const mv = new DataView(inputs[0]!.buffer, inputs[0]!.byteOffset);
    expect(mv.getUint32(4, true)).toBe(0x05);
    expect(mv.getInt16(8, false)).toBe(640);
    expect(mv.getInt16(14, false)).toBe(1279);

    // the decoder lost its place: a keyframe asked, the video not restarted
    const idrs = fake.sent(In.idr).length;
    app.input(["key"]);
    await settle();
    expect(fake.sent(In.idr).length).toBe(idrs + 1);
    expect(fake.sent(In.video).length).toBe(1);

    // the app quits on the host
    fake.send(jsonMessage(Out.exited, {}));
    await settle();
    expect(msgs.some((m) => m.t === "exit")).toBe(true);
    expect(app.alive).toBe(false);
    expect(done).toBe(1);
  });

  test("a resize: a fresh video at the new size, the old one's late frames dropped", async () => {
    let lastGen = 0;
    fake = new FakeAfterglow("t0ken-t0ken-t0ken-3", (f, type, body) => {
      if (type === In.launch) f.send(jsonMessage(Out.launched, { ok: true }));
      if (type === In.video) {
        const j = JSON.parse(new TextDecoder().decode(body));
        // the video before's frame still in flight
        if (lastGen) f.send(frameMessage(lastGen, true, [0, 0, 0, 1, 9]));
        lastGen = j.gen;
        f.send(configMessage(j.gen, j.w, j.h, [1, 2, 3]));
        f.send(frameMessage(j.gen, true, [0, 0, 0, 1, 0x65]));
      }
    });
    const src = new AfterglowSource({
      link: { port: fake.port, token: fake.token },
      target: "C:\\x.lnk",
      virtualDisplay: true,
    });
    const app = new AppSession("a2", src, {
      argv: [],
      name: "x",
      w: 800,
      h: 600,
      sw: 1920,
      sh: 1080,
      scale: 1,
      full: false,
      fps: 60,
    });
    await app.open();
    const bins: Uint8Array[] = [];
    app.attach({ binary: (b) => bins.push(b), json: () => {}, queued: () => 0, close: () => {} });
    await settle();
    bins.length = 0;
    app.input(["r", 1024, 768]);
    await new Promise((r) => setTimeout(r, 400));
    const videos = fake.sent(In.video).map((g) => JSON.parse(new TextDecoder().decode(g.body)));
    expect(videos.at(-1)).toMatchObject({ w: 1024, h: 768 });
    const cfg = bins.filter((b) => b[0] === MsgConfig);
    expect(cfg.length).toBe(1);
    const d = new DataView(cfg[0]!.buffer, cfg[0]!.byteOffset);
    expect([d.getUint16(4, true), d.getUint16(6, true)]).toEqual([1024, 768]);
    const frames = bins.filter((b) => b[0] === MsgFrame);
    expect(frames.length).toBe(1);
    expect(frames[0]![HeadLen + 4]).toBe(0x65);
    app.end();
  });
});
