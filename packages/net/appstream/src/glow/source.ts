// the glow source: an app a GameStream host (Sunshine, Apollo) runs and encodes,
// streamed to phosphorus over loopback. The first stream launches the app; every
// later one (a new size, a new rate, a viewer back) resumes it, the app running on
// through any gap. A keyframe is a control message away, never a restart

import type { Opened, Sink, Source, Video, VideoSink } from "../session.ts";
import type { Identity } from "./cert.ts";
import { InputPacker } from "./input.ts";
import { cancel, type Host, serverInfo } from "./lumen.ts";
import { GlowStream, loopbackPacket } from "./stream.ts";

export type GlowTarget = {
  host: Host;
  id: Identity;
  // the host's app to launch: its id, found (or set up) once the source opens
  app: () => Promise<number>;
  // the host makes a display per stream (Apollo): nothing needs a monitor
  virtualDisplay: boolean;
  label: string;
  // the capture rate when the viewer names none: above the screen's, so a change
  // waits half as long to be captured
  fps?: number;
  // called once the app has quit, the host free again
  done?: () => void;
  // never taken up running: phosphorus's launcher, whose running app is an earlier
  // stream's, quit first so the one asked for starts
  fresh?: boolean;
};

const clamp = (v: unknown, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

type Running = { s: GlowStream; v: Video; sink?: VideoSink };

export class GlowSource implements Source {
  readonly keyframes = true;
  // a resumed stream is up in a few hundred ms: a resize's is held back only that long
  readonly restartGapMs = 250;
  private app = 0;
  private cur?: Running;
  private launched = false;
  private sink?: Sink;
  private keys = new InputPacker((ch, pkt) => this.cur?.s.input(ch, pkt));
  private quitting = false;
  // the viewer's pixel ratio: a virtual display made at it
  private scale = 1;

  constructor(private t: GlowTarget) {}

  get label() {
    return this.t.label;
  }

  async open(s: Opened, sink: Sink): Promise<void> {
    this.sink = sink;
    this.scale = s.scale;
    this.app = await this.t.app();
    let info = await serverInfo(this.t.host, this.t.id, true);
    if (info.currentgame && info.currentgame !== this.app)
      throw new Error(`${info.hostname || "the host"} is streaming another app; close that one first`);
    if (info.currentgame && this.t.fresh) {
      await cancel(this.t.host, this.t.id);
      info = await serverInfo(this.t.host, this.t.id, true);
    }
    // the app launched now, its stream kept for the viewer about to attach
    const v: Video = { w: s.w, h: s.h, fps: this.fpsOf(s.fps), kbps: 20_000, full: s.full };
    await this.startStream(v, info.currentgame === this.app);
    sink.meta({ t: "title", s: s.name });
    // the host draws the pointer into its frames: the page's own hidden, so there's one
    sink.meta({ t: "cursor", name: "blank" });
  }

  private fpsOf(fps?: number) {
    return clamp(fps || this.t.fps || 120, 10, 240);
  }

  private async startStream(v: Video, resume: boolean): Promise<Running> {
    const r: Running = { v, s: undefined as unknown as GlowStream };
    r.s = new GlowStream(
      {
        host: this.t.host,
        id: this.t.id,
        app: this.app,
        w: v.w,
        h: v.h,
        fps: v.fps,
        kbps: v.kbps,
        packetSize: loopbackPacket,
        yuv444: v.full,
        virtualDisplay: this.t.virtualDisplay,
        scale: this.scale,
        resume: resume || this.launched,
      },
      {
        config: (avcc) => r.sink?.config(avcc, r.v.w, r.v.h),
        frame: (msg, key) => r.sink?.frame(key, msg, true),
        lost: () => r.s.idr(),
        ended: (why) => {
          if (this.cur === r) this.cur = undefined;
          if (/quit/.test(why)) return this.gone("");
          r.sink?.ended(true);
        },
      },
    );
    this.cur = r;
    try {
      await r.s.start();
    } catch (e) {
      r.s.stop();
      if (this.cur === r) this.cur = undefined;
      throw e;
    }
    this.launched = true;
    return r;
  }

  video(v: Video, sink: VideoSink) {
    v = { ...v, fps: this.fpsOf(v.fps) };
    const c = this.cur;
    // the stream the open started, at the size asked for: taken as it is, a keyframe asked
    if (c && !c.sink && c.v.w === v.w && c.v.h === v.h && c.v.fps === v.fps && c.v.full === v.full) {
      c.sink = sink;
      c.v.kbps = v.kbps;
      c.s.idr();
      return;
    }
    this.stopVideo();
    void this.startStream(v, true)
      .then((r) => {
        r.sink = sink;
        r.s.idr();
      })
      .catch(async (e) => {
        // a resume refused: the app gone from the host
        const info = await serverInfo(this.t.host, this.t.id, true).catch(() => undefined);
        if (info && info.currentgame !== this.app) return this.gone("");
        this.sink?.say({ t: "note", s: `the stream didn't start: ${e?.message ?? e}` });
        sink.ended(false);
      });
  }

  stopVideo() {
    const c = this.cur;
    this.cur = undefined;
    c?.s.stop();
  }

  keyframe() {
    this.cur?.s.idr();
  }

  input(m: unknown[], w: number, h: number) {
    const c = this.cur;
    if (!c) return;
    this.keys.input(m, c.v.w || w, c.v.h || h);
  }

  // the stream restarts at the new size when the session asks; the host's display
  // follows (Apollo's virtual one is made at the stream's size)
  resize() {}

  close() {
    void this.quitApp().then(() => this.gone(""));
  }

  private async quitApp() {
    if (this.quitting) return;
    this.quitting = true;
    this.stopVideo();
    await cancel(this.t.host, this.t.id).catch(() => {});
  }

  private finished = false;
  private finish() {
    if (this.finished) return;
    this.finished = true;
    this.t.done?.();
  }

  private gone(error: string) {
    this.stopVideo();
    this.finish();
    this.sink?.exit(error);
  }

  quit() {
    void this.quitApp().then(() => this.finish());
  }
}
