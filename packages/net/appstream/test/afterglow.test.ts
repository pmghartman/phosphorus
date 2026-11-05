// afterglow's local link: the framing against the layout native/afterglow/src/phos_wire.h
// writes, and the source end to end through an AppSession against a fake afterglow on
// a real loopback socket: the token said first, the app launched, frames to the viewer
// with their header put in place, an earlier video's frames dropped, a keyframe asked
// for without a restart, input as GameStream packets, the app's exit

import { afterEach, describe, expect, test } from "bun:test";
import {
  AfterglowSource,
  AppSession,
  HeadLen,
  In,
  LinkReader,
  linkMessage,
  MsgConfig,
  MsgFrame,
  Out,
  type Viewer,
} from "../src/index.ts";

const u16 = (v: number) => [v & 0xff, v >> 8];

// a frame message as afterglow's shaper makes it: [type][key][gen][pad 4] AVCC
const frameMsg = (gen: number, key: boolean, avcc: number[]) =>
  linkMessage(Out.frame, new Uint8Array([key ? 1 : 0, ...u16(gen), 0, 0, 0, 0, ...avcc]));
const configMsg = (gen: number, w: number, h: number, avcc: number[]) =>
  linkMessage(Out.config, new Uint8Array([0, ...u16(gen), ...u16(w), ...u16(h), ...avcc]));
const json = (type: number, v: unknown) => linkMessage(type, JSON.stringify(v));

describe("link framing", () => {
  test("messages out of a stream cut anywhere, each its own array", () => {
    const a = json(Out.ready, { version: "1" });
    const b = frameMsg(3, true, [0, 0, 0, 1, 0x65]);
    const all = new Uint8Array([...a, ...b, ...a]);
    for (const cut of [1, 3, 7, all.length]) {
      const got: Uint8Array[] = [];
      const r = new LinkReader((m) => got.push(m));
      for (let i = 0; i < all.length; i += cut) r.feed(all.subarray(i, i + cut));
      expect(got.map((m) => m[0])).toEqual([Out.ready, Out.frame, Out.ready]);
      expect(Array.from(got[1]!)).toEqual([Out.frame, 1, 3, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0x65]);
      expect(got[1]!.byteOffset).toBe(0);
    }
  });
  test("a length past the limit breaks the link", () => {
    const r = new LinkReader(() => {});
    r.feed(new Uint8Array([0xff, 0xff, 0xff, 0xff, 1]));
    expect(r.broken).toBe(true);
  });
  test("a message bigger than the buffer", () => {
    const big = new Uint8Array(3 << 20).fill(7);
    const m = linkMessage(Out.frame, big);
    const got: Uint8Array[] = [];
    const r = new LinkReader((x) => got.push(x));
    for (let i = 0; i < m.length; i += 65536) r.feed(m.subarray(i, i + 65536));
    expect(got.length).toBe(1);
    expect(got[0]!.length).toBe(1 + big.length);
  });
});

// afterglow as phosphorus sees it over the link: what it was sent, and its answers
class FakeAfterglow {
  server: Bun.TCPSocketListener<undefined>;
  got: { type: number; body: Uint8Array }[] = [];
  sock?: { write(b: Uint8Array): number };
  hello = "";
  constructor(
    readonly token: string,
    private onMsg: (f: FakeAfterglow, type: number, body: Uint8Array) => void,
  ) {
    this.server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (s) => {
          this.sock = s;
        },
        data: (_s, d) => this.reader.feed(d),
      },
    });
  }
  private reader = new LinkReader((m) => {
    const type = m[0]!;
    const body = m.subarray(1);
    this.got.push({ type, body });
    if (type === In.hello) {
      this.hello = new TextDecoder().decode(body);
      if (this.hello !== this.token) return;
      this.send(json(Out.ready, { version: "test", virtual_display: true, hostname: "box", running: false }));
      return;
    }
    this.onMsg(this, type, body);
  });
  send(m: Uint8Array) {
    this.sock?.write(m);
  }
  sent(type: number) {
    return this.got.filter((g) => g.type === type);
  }
  stop() {
    this.server.stop(true);
  }
}

const settle = () => new Promise((r) => setTimeout(r, 30));

let fake: FakeAfterglow | undefined;
afterEach(() => fake?.stop());

describe("afterglow source", () => {
  test("launch, frames with their header in place, gen filtering, a keyframe asked, input, exit", async () => {
    fake = new FakeAfterglow("t0ken-t0ken-t0ken-1", (f, type, body) => {
      if (type === In.launch) f.send(json(Out.launched, { ok: true, resumed: false }));
      if (type === In.video) {
        const j = JSON.parse(new TextDecoder().decode(body));
        f.send(configMsg(j.gen, j.w, j.h, [1, 0x64, 0, 0x1f]));
        f.send(frameMsg(j.gen, true, [0, 0, 0, 2, 0x65, 0x88]));
        // a frame of a video already given up: dropped
        f.send(frameMsg(j.gen - 1, false, [0, 0, 0, 1, 0x41]));
      }
    });
    let done = 0;
    const src = new AfterglowSource({
      link: { port: fake.server.port, token: fake.token },
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
    fake.send(json(Out.exited, {}));
    await settle();
    expect(msgs.some((m) => m.t === "exit")).toBe(true);
    expect(app.alive).toBe(false);
    expect(done).toBe(1);
  });

  test("a launch refused: the open fails with afterglow's reason", async () => {
    fake = new FakeAfterglow("t0ken-t0ken-t0ken-2", (f, type) => {
      if (type === In.launch) f.send(json(Out.launched, { ok: false, error: "not an app this host can start" }));
    });
    const src = new AfterglowSource({
      link: { port: fake.server.port, token: fake.token },
      target: "C:\\x.lnk",
      virtualDisplay: false,
    });
    const s = { argv: [], name: "x", w: 640, h: 480, sw: 640, sh: 480, scale: 1, full: false, dpi: 96 };
    await expect(src.open(s, { meta() {}, say() {}, exit() {} })).rejects.toThrow("not an app this host can start");
  });

  test("a wrong token: no answer, the open times out", async () => {
    fake = new FakeAfterglow("the-right-token-xx", () => {});
    const src = new AfterglowSource({
      link: { port: fake.server.port, token: "the-wrong-token-xx" },
      target: "C:\\x.lnk",
      virtualDisplay: false,
    });
    const s = { argv: [], name: "x", w: 640, h: 480, sw: 640, sh: 480, scale: 1, full: false, dpi: 96 };
    await expect(src.open(s, { meta() {}, say() {}, exit() {} })).rejects.toThrow();
  }, 10_000);

  test("a resize: a fresh video at the new size, the old one's late frames dropped", async () => {
    let lastGen = 0;
    fake = new FakeAfterglow("t0ken-t0ken-t0ken-3", (f, type, body) => {
      if (type === In.launch) f.send(json(Out.launched, { ok: true }));
      if (type === In.video) {
        const j = JSON.parse(new TextDecoder().decode(body));
        // the video before's frame still in flight
        if (lastGen) f.send(frameMsg(lastGen, true, [0, 0, 0, 1, 9]));
        lastGen = j.gen;
        f.send(configMsg(j.gen, j.w, j.h, [1, 2, 3]));
        f.send(frameMsg(j.gen, true, [0, 0, 0, 1, 0x65]));
      }
    });
    const src = new AfterglowSource({
      link: { port: fake.server.port, token: fake.token },
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
