// the afterglow source: a window app on a Windows host, run in the session signed in
// at its console and captured and encoded by afterglow, phosphorus's own fork of
// Apollo installed beside it, over one loopback link. Against glow's GameStream
// path: no pairing, no HTTPS or RTSP round trips before the first frame, no RTP to
// rebuild frames from, no AES; the frame the encoder made is the one the viewer
// gets, copied once. The app runs on between videos and viewers, as with glow

import { InputPacker } from "../glow/input.ts";
import type { Opened, Sink, Source, Video, VideoSink } from "../session.ts";
import { configOf, frameOf, In, jsonOf, Link, type LinkAddr, Out } from "./link.ts";

export type AfterglowTarget = {
  link: LinkAddr;
  // the app: a shortcut or program the host's desk listed
  target: string;
  // the app gets a display of its own at the viewer's size (afterglow's virtual
  // display): no monitor needed, the console's own left alone
  virtualDisplay: boolean;
  // the capture rate when the viewer names none
  fps?: number;
  // called once the app has quit, the host free again
  done?: () => void;
  // a link opened for us, for tests
  connect?: (addr: LinkAddr, ev: ConstructorParameters<typeof Link>[1]) => Link;
};

const clamp = (v: unknown, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

type Running = { gen: number; v: Video; sink?: VideoSink; got: boolean };

export class AfterglowSource implements Source {
  readonly keyframes = true;
  // a new video is a message away: a resize waits only for the encoder's start
  readonly restartGapMs = 150;
  readonly label = "afterglow";
  private link?: Link;
  private sink?: Sink;
  private cur?: Running;
  private gen = 0;
  private finished = false;
  private keys = new InputPacker((_ch, pkt) => this.cur && this.link?.send(In.input, pkt));
  timings: Record<string, number> = {};

  constructor(private t: AfterglowTarget) {}

  async open(s: Opened, sink: Sink): Promise<void> {
    this.sink = sink;
    const t0 = performance.now();
    const ev = {
      message: (m: Uint8Array) => this.got(m),
      closed: (why: string) => this.lost(why),
    };
    this.link = this.t.connect ? this.t.connect(this.t.link, ev) : new Link(this.t.link, ev);
    await this.link.open();
    const t1 = performance.now();
    const fps = this.fpsOf(s.fps);
    const answer = this.link.next(Out.launched, 60_000);
    this.link.json(In.launch, {
      cmd: this.t.target,
      name: s.name,
      w: s.w,
      h: s.h,
      fps,
      virtual_display: this.t.virtualDisplay,
      fresh: true,
    });
    const r = jsonOf(await answer);
    if (r.ok !== true) {
      this.link.close("launch refused");
      throw new Error(`the app didn't start: ${String(r.error ?? "afterglow refused it")}`);
    }
    this.timings = { link: t1 - t0, launch: performance.now() - t1 };
    // the video started now, kept for the viewer about to attach
    this.startVideo({ w: s.w, h: s.h, fps, kbps: 20_000, full: s.full });
    sink.meta({ t: "title", s: s.name });
    // the host draws the pointer into its frames: the page's own hidden, so there's one
    sink.meta({ t: "cursor", name: "blank" });
  }

  private fpsOf(fps?: number) {
    return clamp(fps || this.t.fps || 120, 10, 240);
  }

  private startVideo(v: Video, sink?: VideoSink): Running {
    this.gen = (this.gen + 1) & 0xffff;
    const r: Running = { gen: this.gen, v, sink, got: false };
    this.cur = r;
    this.link?.json(In.video, { gen: r.gen, w: v.w, h: v.h, fps: v.fps, kbps: v.kbps, yuv444: v.full });
    return r;
  }

  private got(m: Uint8Array) {
    switch (m[0]) {
      case Out.frame: {
        const f = frameOf(m);
        const c = this.cur;
        if (!c || f.gen !== c.gen) return;
        c.got = true;
        c.sink?.frame(f.key, m, true);
        return;
      }
      case Out.config: {
        const c = configOf(m);
        if (this.cur && c.gen === this.cur.gen) this.cur.sink?.config(c.avcc, c.w, c.h);
        return;
      }
      case Out.videoEnded: {
        const j = jsonOf(m);
        const c = this.cur;
        if (!c || Number(j.gen) !== c.gen) return;
        this.cur = undefined;
        c.sink?.ended(c.got);
        return;
      }
      case Out.exited:
        return this.gone("");
    }
  }

  video(v: Video, sink: VideoSink) {
    v = { ...v, fps: this.fpsOf(v.fps) };
    const c = this.cur;
    // the video the open started, at the size asked for: taken as it is, a keyframe asked
    if (c && !c.sink && c.v.w === v.w && c.v.h === v.h && c.v.fps === v.fps && c.v.full === v.full) {
      c.sink = sink;
      c.v.kbps = v.kbps;
      this.link?.send(In.idr);
      return;
    }
    this.startVideo(v, sink);
  }

  stopVideo() {
    // the open's video, no viewer's yet: kept for the video() that comes straight after
    if (!this.cur || !this.cur.sink) return;
    this.cur = undefined;
    this.link?.send(In.stopVideo);
  }

  keyframe() {
    this.link?.send(In.idr);
  }

  input(m: unknown[], w: number, h: number) {
    const c = this.cur;
    if (!c) return;
    this.keys.input(m, c.v.w || w, c.v.h || h);
  }

  // the video restarts at the new size when the session asks; afterglow's display follows
  resize() {}

  close() {
    this.cur = undefined;
    this.link?.send(In.quit);
  }

  private lost(why: string) {
    if (this.finished) return;
    this.gone(`afterglow went away: ${why}`);
  }

  private gone(error: string) {
    this.cur = undefined;
    if (this.finished) return;
    this.finished = true;
    this.link?.close();
    this.t.done?.();
    this.sink?.exit(error);
  }

  quit() {
    if (this.finished) return;
    this.finished = true;
    this.cur = undefined;
    this.link?.send(In.quit);
    // the quit written before the link closes
    setTimeout(() => this.link?.close(), 50);
    this.t.done?.();
  }
}
