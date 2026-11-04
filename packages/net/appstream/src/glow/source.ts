// the glow source: an app a GameStream host (Sunshine, Apollo) runs and encodes,
// streamed to phosphorus over loopback. The first stream launches the app; every
// later one (a new size, a new rate, a viewer back) resumes it, the app running on
// through any gap. A keyframe is a control message away, never a restart

import type { Opened, Sink, Source, Video, VideoSink } from "../session.ts";
import type { Identity } from "./cert.ts";
import { cancel, type Host, serverInfo } from "./lumen.ts";
import { Channel, pack } from "./spark.ts";
import { GlowStream, loopbackPacket } from "./stream.ts";
import { asText, modOf, utf8Chunks, vkOf } from "./vk.ts";

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

// GameStream's mouse buttons: X's 8 and 9 are its 4 and 5
const buttons: Record<number, number> = { 1: 1, 2: 2, 3: 3, 8: 4, 9: 5 };
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
  private mods = 0;
  // keys typed as text: their key-up isn't sent
  private texted = new Set<string>();
  private clip?: { s: string; at: number };
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

  private key(down: boolean, code: string) {
    const v = vkOf(code);
    if (!v) return;
    const m = modOf(code);
    if (m) this.mods = down ? this.mods | m : this.mods & ~m;
    this.cur?.s.input(Channel.keyboard, pack.key(down, v, this.mods));
  }

  private text(s: string) {
    for (const c of utf8Chunks(s)) this.cur?.s.input(Channel.utf8, pack.utf8(c));
  }

  input(m: unknown[], w: number, h: number) {
    const s = this.cur?.s;
    if (!s) return;
    const sw = this.cur!.v.w || w;
    const sh = this.cur!.v.h || h;
    switch (m[0]) {
      case "m":
        return s.input(Channel.mouse, pack.mouseAbs(clamp(m[1], 0, sw - 1), clamp(m[2], 0, sh - 1), sw, sh));
      case "b": {
        const b = buttons[clamp(m[1], 1, 9)];
        if (b) s.input(Channel.mouse, pack.button(!!m[2], b));
        return;
      }
      case "w": {
        const dx = clamp(m[1], -20, 20);
        const dy = clamp(m[2], -20, 20);
        if (dy) s.input(Channel.mouse, pack.scroll(-dy * 120));
        if (dx) s.input(Channel.mouse, pack.hscroll(dx * 120));
        return;
      }
      case "k": {
        const down = !!m[1];
        const code = String(m[2] ?? "").slice(0, 32);
        const key = String(m[3] ?? "").slice(0, 32);
        const chord = !!m[4];
        if (!down && this.texted.delete(code)) return;
        // a paste: the page's clipboard typed, not the host's pasted
        if (down && code === "KeyV" && chord && this.clip && Date.now() - this.clip.at < 1000) {
          const t = this.clip.s;
          this.clip = undefined;
          for (const c of ["ControlLeft", "ControlRight", "MetaLeft", "MetaRight"])
            if (this.mods & modOf(c)) this.key(false, c);
          this.texted.add(code);
          return this.text(t);
        }
        if (down && asText(code, key, chord, (this.mods & 0x01) !== 0)) {
          this.texted.add(code);
          return this.text(key);
        }
        return this.key(down, code);
      }
      case "x":
        return this.text(String(m[1] ?? "").slice(0, 4096));
      case "clip":
        this.clip = { s: String(m[1] ?? "").slice(0, 64 << 10), at: Date.now() };
        return;
    }
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
