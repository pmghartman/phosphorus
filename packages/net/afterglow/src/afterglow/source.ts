// the afterglow source: a native app on a Windows or Linux host, run (on Windows in the
// session signed in at its console) and captured and encoded by afterglow, installed
// beside it, over one loopback link. One message launches, one starts a video; the
// frame the encoder made is the one the viewer gets, copied once. The app runs on
// between videos and viewers

import type { Opened, PixelSink, Sink, Source, Video, VideoSink } from "../source.ts";
import { InputPacker } from "./input.ts";
import {
  configOf,
  cursorOf,
  frameOf,
  In,
  jsonOf,
  Link,
  type LinkAddr,
  Out,
  rectOf,
  sizeOf,
  type Transport,
} from "./link.ts";

export type AfterglowTarget = {
  // where afterglow listens (its link file), or a stream to an `afterglow --stdio`
  // opened for this app (ssh's, as the viewer's login on a Linux host)
  link?: LinkAddr;
  transport?: () => Transport | Promise<Transport>;
  // the app: a shortcut or program the host's desk listed
  target: string;
  // Linux: the program and its arguments (a desktop entry's Exec), in place of target
  argv?: string[];
  // or, in place of target, a process already running taken as the app (Windows; its
  // pid and start time from Link.processes): nothing started, its windows streamed and
  // moved to a display of its own with virtualDisplay. Let go, it runs on; close asks
  // it to close
  attach?: { pid: number; started?: number; shell?: boolean };
  // Linux: a session bus of the app's own, so a single-instance app starts on the
  // stream rather than handing its window to a copy on the host's own screen
  dbus?: boolean;
  // the app gets a display of its own at the viewer's size (SudoVDA on Windows, an
  // Xvfb on Linux): no monitor needed, the console's own left alone
  virtualDisplay: boolean;
  // the capture rate when the viewer names none
  fps?: number;
  // the pointer drawn into the frames by the host. Otherwise (the default) its shape
  // comes as cursor metadata for the viewer to show as its own pointer: a move costs
  // no frame and shows with no latency at all
  drawCursor?: boolean;
  // called once the app has quit, the host free again
  done?: () => void;
  // a link opened for us, for tests
  connect?: (addr: LinkAddr, ev: ConstructorParameters<typeof Link>[1]) => Link;
};

const clamp = (v: unknown, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

// one run on the host: video, or the pixels as they change (afterglow's "pixels" feature)
type Running = {
  gen: number;
  v: Video;
  pixels: boolean;
  sink?: VideoSink;
  pix?: PixelSink;
  got: boolean;
  // the view's size the host said, for a sink that takes the run up later
  size?: { w: number; h: number };
};
// the rate pixels are gathered at: a slot of about 8 ms
const pixelFps = 120;

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
  // what the launched app can be asked: "clipboard", "raise", "close", "notes", "pixels"
  private features = new Set<string>();
  // the view's size, for a pixel run started without one
  private size = { w: 0, h: 0 };
  private keys = new InputPacker((pkt) => this.cur && this.link?.send(In.input, pkt));
  timings: Record<string, number> = {};
  private name = "";

  constructor(private t: AfterglowTarget) {}

  // the link while it's up: afterglow takes one driver at a time, so the desktop's asks
  // (Link.processes, end, delete) ride the stream's own link rather than a second one
  // taking over from it
  get linkNow(): Link | undefined {
    return !this.finished && this.link?.alive && this.link.ready ? this.link : undefined;
  }

  // whether this afterglow sends pixels, known once launched
  get hasPixels() {
    return this.features.has("pixels");
  }

  async open(s: Opened, sink: Sink): Promise<void> {
    this.sink = sink;
    const t0 = performance.now();
    const ev = {
      message: (m: Uint8Array) => this.got(m),
      closed: (why: string) => this.lost(why),
    };
    if (this.t.connect && this.t.link) this.link = this.t.connect(this.t.link, ev);
    else if (this.t.transport) this.link = new Link(await this.t.transport(), ev);
    else if (this.t.link) this.link = new Link(this.t.link, ev);
    else throw new Error("afterglow: neither a link nor a transport to reach it");
    await this.link.open(this.t.transport ? 15_000 : 3000);
    const t1 = performance.now();
    const fps = this.fpsOf(s.fps);
    const answer = this.link.next(Out.launched, 60_000);
    const at = this.t.attach;
    if (at) {
      this.link.json(In.attach, {
        pid: at.pid,
        ...(at.started !== undefined ? { started: at.started } : {}),
        shell: !!at.shell,
        name: s.name,
        w: s.w,
        h: s.h,
        fps,
        dpi: s.dpi,
        scale: s.scale,
        virtual_display: this.t.virtualDisplay,
      });
    } else {
      this.link.json(In.launch, {
        cmd: this.t.target,
        ...(this.t.argv?.length ? { argv: this.t.argv } : {}),
        name: s.name,
        w: s.w,
        h: s.h,
        fps,
        dpi: s.dpi,
        scale: s.scale,
        dbus: !!this.t.dbus,
        virtual_display: this.t.virtualDisplay,
        fresh: true,
      });
    }
    const r = jsonOf(await answer);
    if (r.ok !== true) {
      this.link.close(at ? "attach refused" : "launch refused");
      const why = String(r.error ?? "afterglow refused it");
      throw new Error(at ? `the app couldn't be attached to: ${why}` : `the app didn't start: ${why}`);
    }
    this.features = new Set(Array.isArray(r.features) ? r.features.map(String) : []);
    this.timings = { link: t1 - t0, launch: performance.now() - t1 };
    this.size = { w: s.w, h: s.h };
    // the picture started now, kept for the viewer about to attach: pixels where the
    // host sends them (the session's first choice), video otherwise
    if (this.hasPixels) this.startRun({ w: s.w, h: s.h, fps: pixelFps, kbps: 20_000, full: false }, true);
    else this.startRun({ w: s.w, h: s.h, fps, kbps: 20_000, full: s.full }, false);
    this.name = s.name;
    sink.meta({ t: "title", s: s.name });
    // drawn in by the host: the page's own hidden, so there's one. Otherwise the
    // host's shapes come as it changes them
    if (this.t.drawCursor) sink.meta({ t: "cursor", name: "blank" });
  }

  private fpsOf(fps?: number) {
    return clamp(fps || this.t.fps || 120, 10, 240);
  }

  private startRun(v: Video, pixels: boolean, sink?: VideoSink, pix?: PixelSink): Running {
    this.gen = (this.gen + 1) & 0xffff;
    const r: Running = { gen: this.gen, v, pixels, sink, pix, got: false };
    this.cur = r;
    this.link?.json(In.video, {
      gen: r.gen,
      w: v.w,
      h: v.h,
      fps: v.fps,
      kbps: v.kbps,
      yuv444: v.full,
      draw_cursor: !pixels && !!this.t.drawCursor,
      pixels,
    });
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
        if (c.pixels) {
          // the pixels stopped by themselves (a display lost): again, for the sink that has them
          if (c.pix) setTimeout(() => !this.finished && !this.cur && this.startRun(c.v, true, undefined, c.pix), 250);
          return;
        }
        c.sink?.ended(c.got);
        return;
      }
      case Out.size: {
        const s = sizeOf(m);
        const c = this.cur;
        if (!c || s.gen !== c.gen) return;
        c.size = { w: s.w, h: s.h };
        c.pix?.size(s.w, s.h);
        return;
      }
      case Out.rect: {
        const r = rectOf(m);
        const c = this.cur;
        if (!c?.pix || r.gen !== c.gen) return;
        c.got = true;
        c.pix.rect(r.x, r.y, r.w, r.h, r.data, r.deflated, r.msbFirst);
        return;
      }
      case Out.cursor: {
        if (this.t.drawCursor) return;
        const c = cursorOf(m);
        // an empty shape is a hidden pointer
        if (!c.visible || !c.png.length) return this.sink?.meta({ t: "cursor", name: "none" });
        return this.sink?.meta({ t: "cursor", png: Buffer.from(c.png).toString("base64"), x: c.x, y: c.y });
      }
      case Out.note: {
        const j = jsonOf(m);
        if (j.t === "title") return this.sink?.meta({ t: "title", s: String(j.s ?? "") || this.name });
        if (j.t === "windows") return this.sink?.meta({ t: "windows", list: j.list, main: j.main });
        if (j.t === "clip") return this.sink?.say({ t: "clip", s: String(j.s ?? "") });
        return;
      }
      case Out.exited: {
        const j = jsonOf(m);
        const code = typeof j.code === "number" ? j.code : undefined;
        return this.gone(String(j.error ?? ""), typeof j.log === "string" ? j.log : undefined, code);
      }
    }
  }

  video(v: Video, sink: VideoSink) {
    v = { ...v, fps: this.fpsOf(v.fps) };
    const c = this.cur;
    // the video the open started, at the size asked for: taken as it is, a keyframe asked
    if (c && !c.pixels && !c.sink && c.v.w === v.w && c.v.h === v.h && c.v.fps === v.fps && c.v.full === v.full) {
      c.sink = sink;
      c.v.kbps = v.kbps;
      this.link?.send(In.idr);
      return;
    }
    this.startRun(v, false, sink);
  }

  stopVideo() {
    // the open's video, no viewer's yet: kept for the video() that comes straight after
    if (!this.cur || this.cur.pixels || !this.cur.sink) return;
    this.cur = undefined;
    this.link?.send(In.stopVideo);
  }

  keyframe() {
    this.link?.send(In.idr);
  }

  // --- pixels: the host reads the rectangles that change and sends them ----------------

  pixels(sink: PixelSink) {
    if (!this.hasPixels) return;
    const c = this.cur;
    // the run the open started, nobody's yet: taken as it is, its size told, the whole
    // view asked for
    if (c?.pixels && !c.pix) {
      c.pix = sink;
      if (c.size) sink.size(c.size.w, c.size.h);
      this.link?.send(In.idr);
      return;
    }
    const v = c?.v ?? { w: this.size.w, h: this.size.h, fps: pixelFps, kbps: 20_000, full: false };
    this.startRun({ ...v, fps: pixelFps }, true, undefined, sink);
  }

  stopPixels() {
    if (!this.cur?.pixels || !this.cur.pix) return;
    this.cur = undefined;
    this.link?.send(In.stopVideo);
  }

  refresh() {
    if (this.cur?.pixels) this.link?.send(In.idr);
  }

  input(m: unknown[], w: number, h: number) {
    // the clipboard and the windows are the app's, video or not
    if (m[0] === "clip" && this.features.has("clipboard")) {
      return this.link?.send(In.clip, String(m[1] ?? "").slice(0, 256 << 10));
    }
    if (m[0] === "raise") {
      if (!this.features.has("raise")) return;
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, Math.max(0, Math.round(Number(m[1]) || 0)) >>> 0, true);
      return this.link?.send(In.raise, b);
    }
    const c = this.cur;
    if (!c) return;
    this.keys.input(m, c.v.w || w, c.v.h || h);
  }

  // video restarts at the new size when the session asks, afterglow's display following;
  // pixels go on at the new size from here, a fresh run for the same sink
  resize(w: number, h: number) {
    this.size = { w, h };
    const c = this.cur;
    if (c?.pixels && c.pix && (c.v.w !== w || c.v.h !== h)) this.startRun({ ...c.v, w, h }, true, undefined, c.pix);
  }

  // as the app's own close button: where afterglow can ask it that way, the app stays
  // until it closes (it may ask to save first); otherwise it's ended
  close() {
    if (this.features.has("close")) return this.link?.send(In.close);
    this.cur = undefined;
    this.link?.send(In.quit);
  }

  private lost(why: string) {
    if (this.finished) return;
    this.gone(`afterglow went away: ${why}`);
  }

  private gone(error: string, log?: string, code?: number) {
    this.cur = undefined;
    if (this.finished) return;
    this.finished = true;
    this.link?.close();
    this.t.done?.();
    this.sink?.exit(error, log, code);
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
