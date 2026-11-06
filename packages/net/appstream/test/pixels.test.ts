// the pixel path: the agent's rectangles read off its stdout, the session's size and
// rectangle messages, a viewer behind skipping to the whole view, and the choice
// between pixels and video by what moves; the agent's own merging of rectangles

import { describe, expect, test } from "bun:test";
import {
  AgentReader,
  AppSession,
  MsgConfig,
  MsgRect,
  MsgSize,
  type PixelSink,
  pixelTuning,
  RectHead,
  relayFrames,
  type Sink,
  type Source,
  type Video,
  type VideoSink,
  type Viewer,
} from "../src/index.ts";

const u16 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint16(at, true);

describe("agent reader", () => {
  test("json lines, and a line with n followed by that many bytes, cut anywhere", () => {
    const got: [Record<string, any>, Uint8Array | undefined][] = [];
    const r = new AgentReader((m, b) => void got.push([m, b]));
    const all = Buffer.concat([
      Buffer.from('{"t":"title","s":"x"}\n{"t":"rect","x":1,"y":2,"w":1,"h":1,"n":4,"z":0,"o":0}\n'),
      Buffer.from([9, 8, 7, 6]),
      Buffer.from('{"t":"size","w":3,"h":4}\n'),
    ]);
    for (const cut of [1, 20, 60, 61, 63, 70]) {
      got.length = 0;
      const rr = new AgentReader((m, b) => void got.push([m, b]));
      rr.push(all.subarray(0, cut));
      rr.push(all.subarray(cut));
      expect(got.map(([m]) => m.t)).toEqual(["title", "rect", "size"]);
      expect(Array.from(got[1]![1]!)).toEqual([9, 8, 7, 6]);
    }
    got.length = 0;
    r.push(all);
    expect(got.length).toBe(3);
  });
});

// a source with pixels and video both
class PixSource implements Source {
  readonly keyframes = true;
  readonly label = "pix";
  readonly restartGapMs = 0;
  pix?: PixelSink;
  vid?: VideoSink;
  videos: Video[] = [];
  refreshes = 0;
  stops = 0;
  async open(_s: unknown, _sink: Sink) {}
  pixels(s: PixelSink) {
    this.pix = s;
  }
  stopPixels() {
    this.pix = undefined;
    this.stops++;
  }
  refresh() {
    this.refreshes++;
  }
  video(v: Video, sink: VideoSink) {
    this.videos.push(v);
    this.vid = sink;
  }
  stopVideo() {
    this.vid = undefined;
  }
  keyframe() {}
  input() {}
  resize() {}
  close() {}
  quit() {}
}

const start = { argv: [], name: "app", w: 800, h: 600, sw: 1920, sh: 1080, scale: 1, full: false };

describe("session: pixels", () => {
  test("size and rectangles with their header; behind: skipped to the whole view, asked for once drained", async () => {
    const src = new PixSource();
    const s = new AppSession("p", src, { ...start });
    await s.open();
    expect(s.mode).toBe("pixels");
    let q = 0;
    const bins: Uint8Array[] = [];
    const msgs: any[] = [];
    const v: Viewer = { binary: (b) => void bins.push(b), json: (m) => void msgs.push(m), queued: () => q, close() {} };
    s.attach(v);
    expect(msgs[0]).toMatchObject({ t: "ready", mode: "pixels", pixels: true, video: true });
    const p = src.pix!;
    p.size(800, 600);
    p.rect(0, 0, 800, 600, new Uint8Array([1, 2, 3]), true, false);
    p.rect(10, 20, 30, 40, new Uint8Array([4]), false, true);
    expect(bins.length).toBe(3);
    expect(bins[0]![0]).toBe(MsgSize);
    expect(u16(bins[0]!, 4)).toBe(800);
    expect(bins[1]![0]).toBe(MsgRect);
    expect(bins[1]![1]).toBe(1);
    expect(u16(bins[1]!, 12)).toBe(800);
    expect(Array.from(bins[1]!.subarray(RectHead))).toEqual([1, 2, 3]);
    expect(bins[2]![1]).toBe(2);
    expect([u16(bins[2]!, 8), u16(bins[2]!, 10), u16(bins[2]!, 12), u16(bins[2]!, 14)]).toEqual([10, 20, 30, 40]);
    // behind: this one and the next skipped; drained, the whole view asked for, which goes through
    q = pixelTuning.behindBytes + 1;
    p.rect(1, 1, 2, 2, new Uint8Array([5]), false, false);
    q = 0;
    p.rect(1, 1, 2, 2, new Uint8Array([6]), false, false);
    expect(bins.length).toBe(3);
    await Bun.sleep(130);
    expect(src.refreshes).toBe(1);
    p.rect(0, 0, 800, 600, new Uint8Array([7]), false, false);
    p.rect(1, 1, 2, 2, new Uint8Array([8]), false, false);
    expect(bins.length).toBe(5);
    expect(s.stats.skipped).toBe(2);
    // a viewer back after a reload: the whole view again, no restart
    s.attach(v);
    expect(src.refreshes).toBe(2);
    s.end();
  });

  test("video when the pixels keep moving, pixels again when the video goes quiet; the viewer's own pick holds", async () => {
    const was = { ...pixelTuning };
    Object.assign(pixelTuning, {
      tickMs: 10,
      toVideoAfterMs: 25,
      toPixelsAfterMs: 25,
      toVideoRawBps: 1000,
      toPixelsKbps: 100,
    });
    try {
      const src = new PixSource();
      const s = new AppSession("a", src, { ...start });
      await s.open();
      const msgs: any[] = [];
      const v: Viewer = { binary() {}, json: (m) => void msgs.push(m), queued: () => 0, close() {} };
      s.attach(v);
      // a lot of pixels a second: video
      const t0 = Date.now();
      while (s.mode === "pixels" && Date.now() - t0 < 1000) {
        src.pix?.rect(0, 0, 100, 100, new Uint8Array(4), false, false);
        await Bun.sleep(5);
      }
      expect(s.mode).toBe("video");
      expect(src.stops).toBe(1);
      expect(src.videos.length).toBe(1);
      expect(msgs.at(-1)).toMatchObject({ t: "mode", mode: "video", why: "moving" });
      // thin video: pixels again
      src.vid!.config(new Uint8Array([1, 0x64, 0, 0x1f]), 800, 600);
      src.vid!.frame(true, new Uint8Array(8 + 2), true);
      await Bun.sleep(80);
      expect(s.mode).toBe("pixels");
      expect(msgs.at(-1)).toMatchObject({ t: "mode", mode: "pixels", why: "still" });
      // the viewer picks video: it holds through quiet
      s.input(["mode", "video"]);
      expect(s.mode).toBe("video");
      await Bun.sleep(80);
      expect(s.mode).toBe("video");
      s.input(["mode", "auto"]);
      s.end();
    } finally {
      Object.assign(pixelTuning, was);
    }
  });

  test("no video on the host: pixels whatever is asked", async () => {
    const src = new PixSource();
    (src as any).canVideo = false;
    const s = new AppSession("n", src, { ...start });
    await s.open();
    const v: Viewer = { binary() {}, json() {}, queued: () => 0, close() {} };
    s.attach(v);
    s.input(["mode", "video"]);
    expect(s.mode).toBe("pixels");
    expect(src.videos.length).toBe(0);
    s.end();
  });

  test("the relay: rectangles dropped to the whole view while the viewer is behind, a refresh asked", () => {
    let q = 0;
    const down: (string | Uint8Array)[] = [];
    const up: string[] = [];
    const pass = relayFrames(
      { send: (d) => void down.push(d), queued: () => q },
      { send: (d) => void up.push(String(d)), queued: () => 0 },
    );
    const size = new Uint8Array(8);
    size[0] = MsgSize;
    new DataView(size.buffer).setUint16(4, 100, true);
    new DataView(size.buffer).setUint16(6, 50, true);
    const rect = (x: number, y: number, w: number, h: number) => {
      const b = new Uint8Array(RectHead + 1);
      b[0] = MsgRect;
      const d = new DataView(b.buffer);
      d.setUint16(8, x, true);
      d.setUint16(10, y, true);
      d.setUint16(12, w, true);
      d.setUint16(14, h, true);
      return b;
    };
    pass(size, true);
    pass(rect(0, 0, 100, 50), true);
    q = pixelTuning.behindBytes + 1;
    pass(rect(1, 1, 2, 2), true);
    expect(up).toEqual(['["refresh"]']);
    q = 0;
    pass(rect(1, 1, 2, 2), true);
    expect(down.length).toBe(2);
    pass(rect(0, 0, 100, 50), true);
    pass(rect(1, 1, 2, 2), true);
    expect(down.length).toBe(4);
    // config frames pass untouched
    pass(new Uint8Array([MsgConfig, 0, 0, 0, 0, 0, 0, 0]), true);
    expect(down.length).toBe(5);
  });
});

const have = Bun.spawnSync(["sh", "-c", "command -v python3"]).exitCode === 0;

describe.skipIf(!have)("agent", () => {
  test("rectangles merged where they touch, the bounding box when still many", () => {
    const code = [
      "import sys, json; sys.argv = ['x']",
      `src = open(${JSON.stringify(`${import.meta.dir}/../src/agent.py`)}).read()`,
      "ns = {'__name__': 'agent'}; exec(compile(src, 'agent', 'exec'), ns)",
      "m = ns['merge_rects']",
      "print(json.dumps([m([(0,0,10,10),(5,5,10,10),(100,100,5,5)]), m([(0,0,1,1),(2,0,1,1)]), m([(i*20,0,5,5) for i in range(12)]), m([(0,0,0,5)])]))",
    ].join("\n");
    const p = Bun.spawnSync(["python3", "-c", code]);
    expect(p.stderr.toString()).toBe("");
    const [a, b, c, d] = JSON.parse(p.stdout.toString());
    expect([...a].sort()).toEqual([
      [0, 0, 15, 15],
      [100, 100, 5, 5],
    ]);
    expect(b).toEqual([[0, 0, 3, 1]]);
    expect(c).toEqual([[0, 0, 225, 5]]);
    expect(d).toEqual([]);
  });
});
