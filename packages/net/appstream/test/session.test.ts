// the session against sources of its own: frames with room get their header in place,
// a keyframe asked for rather than a restart, a lower rate when the viewer stays behind;
// and the relay between two phosphorus hosts dropping frames to a keyframe

import { describe, expect, test } from "bun:test";
import {
  AppSession,
  HeadLen,
  MsgConfig,
  MsgFrame,
  relayFrames,
  type Sink,
  type Source,
  type Video,
  type VideoSink,
  type Viewer,
} from "../src/index.ts";

describe("relay", () => {
  test("frames dropped to a keyframe while the viewer is behind, a keyframe then a lower rate asked", () => {
    let q = 0;
    const down: (string | Uint8Array)[] = [];
    const up: string[] = [];
    const pass = relayFrames(
      { send: (d) => void down.push(d), queued: () => q },
      { send: (d) => void up.push(String(d)), queued: () => 0 },
    );
    const fr = (key: boolean) => new Uint8Array([MsgFrame, key ? 1 : 0, 0, 0, 0, 0, 0, 0, 9]);
    pass(fr(true), true);
    pass('{"t":"title"}', false);
    q = 1 << 20;
    pass(fr(false), true);
    q = 0;
    pass(fr(false), true);
    expect(up).toEqual(['["key"]']);
    pass(fr(true), true);
    q = 1 << 20;
    pass(fr(false), true);
    expect(up).toEqual(['["key"]', '["slow"]']);
    expect(down.length).toBe(3);
  });
});

// --- the session with a source that makes keyframes on request ------------------------

class FakeSource implements Source {
  readonly keyframes = true;
  readonly label = "fake";
  readonly restartGapMs = 0;
  videos: Video[] = [];
  keys = 0;
  inputs: unknown[][] = [];
  sink?: VideoSink;
  async open(_s: unknown, _sink: Sink) {}
  video(v: Video, sink: VideoSink) {
    this.videos.push(v);
    this.sink = sink;
  }
  stopVideo() {}
  keyframe() {
    this.keys++;
  }
  input(m: unknown[]) {
    this.inputs.push(m);
  }
  resize() {}
  close() {}
  quit() {}
}

describe("session", () => {
  const start = { argv: [], name: "app", w: 801, h: 600, sw: 1920, sh: 1080, scale: 1, full: false };
  test("frames with room get their header in place; a keyframe asked, never a restart", async () => {
    const src = new FakeSource();
    const s = new AppSession("x", src, { ...start });
    await s.open();
    let q = 0;
    const bins: Uint8Array[] = [];
    const v: Viewer = { binary: (b) => void bins.push(b), json: () => {}, queued: () => q, close: () => {} };
    s.attach(v);
    expect(src.videos.length).toBe(1);
    expect(src.videos[0]!.w).toBe(800);
    expect(src.videos[0]!.fps).toBe(0);
    const k = src.sink!;
    k.config(new Uint8Array([1, 0x64, 0, 0x1f]), 800, 600);
    // a delta before any keyframe: skipped, a keyframe asked for
    k.frame(false, new Uint8Array(HeadLen + 4), true);
    expect(src.keys).toBe(1);
    const room = new Uint8Array(HeadLen + 5);
    room.set([0, 0, 0, 1, 0x65], HeadLen);
    k.frame(true, room, true);
    expect(bins.length).toBe(2);
    expect(bins[0]![0]).toBe(MsgConfig);
    expect(bins[1]).toBe(room);
    expect(bins[1]![0]).toBe(MsgFrame);
    expect(bins[1]![1]).toBe(1);
    // the decoder lost its place: a keyframe, the same video
    s.input(["key"]);
    expect(src.keys).toBe(2);
    expect(src.videos.length).toBe(1);
    k.frame(true, new Uint8Array(HeadLen + 4), true);
    // behind once: a keyframe; again soon: a lower rate, a fresh video
    q = 1 << 20;
    k.frame(false, new Uint8Array(HeadLen + 4), true);
    expect(src.keys).toBe(3);
    expect(src.videos.length).toBe(1);
    k.frame(true, new Uint8Array(HeadLen + 4), true);
    await Bun.sleep(5);
    expect(src.videos.length).toBe(2);
    expect(src.videos[1]!.kbps).toBeLessThan(src.videos[0]!.kbps);
    // input the session doesn't own goes to the source
    s.input(["m", 3, 4]);
    expect(src.inputs).toEqual([["m", 3, 4]]);
    s.end();
  });
});
