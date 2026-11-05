// one streamed app as its viewer sees it: the frames relayed as they arrive, never
// queued (over TCP a backlog is pure latency, so a viewer whose socket is behind
// skips frames until a fresh keyframe, at a lower rate), input handed on. Where the
// app runs and how its frames are made is its source's: an X display and ffmpeg on
// a Linux host (xsource.ts), or a Windows host's afterglow
// (@phosphorus/afterglow, whose source keeps the same Source contract)

import { XSource } from "./xsource.ts";

// a command running on the host: its stdin, its stdout, its end
export interface Chan {
  write(d: string): void;
  onData(fn: (b: Uint8Array) => void): void;
  onClose(fn: () => void): void;
  close(): void;
}
// how commands reach the host: an ssh connection, or this machine in tests
export interface Runner {
  run(cmd: string): Promise<Chan>;
  // the short answer of a command
  output(cmd: string): Promise<string>;
}

// who's watching: a socket, as the server hands it over
export interface Viewer {
  binary(b: Uint8Array): void;
  json(v: unknown): void;
  queued(): number;
  close(code?: number): void;
}

// message types to the viewer, its first byte
export const MsgConfig = 1;
export const MsgFrame = 2;
// the header in front of every binary message
export const HeadLen = 8;

export type Start = {
  argv: string[];
  name: string;
  // the viewer's window in device pixels, the screen it may grow to, its pixel ratio
  w: number;
  h: number;
  sw: number;
  sh: number;
  scale: number;
  full: boolean;
  fps?: number;
};

// what a source starts with: the start, its sizes kept to what's allowed
export type Opened = Start & { dpi: number };

// fps 0: the source's own choice
export type Video = { w: number; h: number; fps: number; kbps: number; full: boolean };

// one run of the video: stale once the session starts another
export interface VideoSink {
  config(avcc: Uint8Array, w: number, h: number): void;
  // data is AVCC; with room, data[0..8) is free for the header and the rest is AVCC
  frame(key: boolean, data: Uint8Array, room?: boolean): void;
  // the video stopped by itself; got: whether it ever made a frame
  ended(got: boolean): void;
}

// what a source tells the session besides frames
export interface Sink {
  // title, windows, cursor: kept and replayed to a viewer that comes later
  meta(m: { t: string } & Record<string, unknown>): void;
  // clip, note: to the viewer now, if there is one
  say(m: { t: string } & Record<string, unknown>): void;
  // the app is gone
  exit(error: string, log?: string, code?: number): void;
}

export interface Source {
  // a keyframe can be asked of the running video; otherwise a fresh video makes one
  readonly keyframes: boolean;
  // the encoder's name for the viewer's stats
  readonly label: string;
  // the least time between two fresh videos: what one costs the host to start
  readonly restartGapMs?: number;
  open(s: Opened, sink: Sink): Promise<void>;
  // a fresh video at this size and rate, replacing any running; its first frame a keyframe
  video(v: Video, sink: VideoSink): void;
  stopVideo(): void;
  keyframe(): void;
  // one input message from the viewer, already checked as an array; w, h the video's size
  input(m: unknown[], w: number, h: number): void;
  // the viewer's window resized: the app's to match (the video restarts after)
  resize(w: number, h: number): void;
  // the app asked to close, politely: it may ask to save first
  close(): void;
  // everything ended
  quit(): void;
}

const maxW = 3840;
const maxH = 2160;
const startKbps = 20_000;
const minKbps = 1_500;
// bytes behind past which a frame is skipped: a frame or two at the start rate, or
// twice the last keyframe, which alone can be bigger than that (1080p text is ~150 KiB)
// and would otherwise have the frame after it skipped and another keyframe asked for,
// over and over
const behindBytes = 96 * 1024;
export const behindLimit = (lastKey: number) => Math.max(behindBytes, lastKey * 2);
const restartGapMs = 1000;
const rampAfterMs = 20_000;
const resizeQuietMs = 120;
// a source that makes keyframes on request: asked at most this often
const keyGapMs = 50;

const clamp = (v: unknown, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
const even = (n: number) => n & ~1;

export type Stats = { frames: number; bytes: number; skipped: number; restarts: number; kbps: number; enc: string };

const isRunner = (x: Source | Runner): x is Runner => typeof (x as Runner).run === "function";

export class AppSession {
  readonly source: Source;
  private gen = 0;
  private seq = 0;
  private viewer?: Viewer;
  private needKey = true;
  private opened = false;
  private videoOn = false;
  private w = 0;
  private h = 0;
  private sw = 0;
  private sh = 0;
  private kbps = startKbps;
  private lastRestart = 0;
  private lastKeyAsk = 0;
  private lastBehind = 0;
  private lastKeyBytes = 0;
  private cleanSince = Date.now();
  private resizeT?: ReturnType<typeof setTimeout>;
  private restartT?: ReturnType<typeof setTimeout>;
  private lastMeta: Record<string, Record<string, unknown>> = {};
  private ended = false;
  readonly created = Date.now();
  title = "";
  lastSeen = Date.now();
  stats: Stats = { frames: 0, bytes: 0, skipped: 0, restarts: 0, kbps: startKbps, enc: "" };
  onEnd?: (why: string) => void;

  constructor(
    public id: string,
    source: Source | Runner,
    public start: Start,
  ) {
    this.source = isRunner(source) ? new XSource(source) : source;
    this.title = start.name;
  }

  get alive() {
    return !this.ended;
  }

  get size() {
    return { w: this.w, h: this.h };
  }

  async open(): Promise<void> {
    const s = this.start;
    this.sw = even(clamp(Math.max(s.sw, s.w), 320, maxW));
    this.sh = even(clamp(Math.max(s.sh, s.h), 240, maxH));
    this.w = even(clamp(s.w, 64, this.sw));
    this.h = even(clamp(s.h, 64, this.sh));
    await this.source.open(
      { ...s, w: this.w, h: this.h, sw: this.sw, sh: this.sh, dpi: Math.round(96 * Math.max(1, s.scale)) },
      {
        meta: (m) => {
          if (m.t === "title") this.title = String(m.s || this.start.name);
          this.lastMeta[m.t] = m;
          this.viewer?.json(m);
        },
        say: (m) => this.viewer?.json(m),
        exit: (error, log, code) => {
          this.viewer?.json({ t: "exit", error, log: log ?? "", code });
          this.end(error || "exited");
        },
      },
    );
    this.stats.enc = this.source.label;
    this.opened = true;
    this.restart("start");
  }

  // a viewer takes over: the one before told why and let go
  attach(v: Viewer) {
    if (this.viewer && this.viewer !== v) {
      this.viewer.json({ t: "taken" });
      this.viewer.close(4000);
    }
    this.viewer = v;
    this.lastSeen = Date.now();
    v.json({ t: "ready", id: this.id, w: this.w, h: this.h, enc: this.source.label, title: this.title });
    for (const m of Object.values(this.lastMeta)) v.json(m);
    this.needKey = true;
    if (this.videoOn && this.source.keyframes) this.askKey();
    else this.restart("viewer");
  }

  detach(v: Viewer) {
    if (this.viewer !== v) return;
    this.viewer = undefined;
    this.lastSeen = Date.now();
    // nobody to send to: the video stopped until someone comes back
    this.stopVideo();
  }

  get watched() {
    return !!this.viewer;
  }

  // one message from the viewer
  input(m: unknown) {
    if (!Array.isArray(m) || this.ended) return;
    this.lastSeen = Date.now();
    switch (m[0]) {
      case "r":
        return this.resize(Math.round(Number(m[1]) || 0), Math.round(Number(m[2]) || 0));
      case "full":
        // full-colour chroma for sharp text, from the next keyframe
        if (!!m[1] === this.start.full) return;
        this.start.full = !!m[1];
        this.needKey = true;
        return this.restart("full");
      case "key":
        // the decoder lost its place: a fresh keyframe
        this.needKey = true;
        if (this.source.keyframes && this.videoOn) return this.askKey(true);
        return this.restart("decoder");
      case "p":
        return this.viewer?.json({ t: "pong", n: m[1], q: this.viewer.queued() });
      case "slow":
        // a relay between here and the viewer fell behind more than once: a lower rate
        this.needKey = true;
        this.kbps = Math.max(minKbps, Math.round(this.kbps * 0.6));
        this.cleanSince = Date.now();
        return this.restart("slow");
      case "close":
        return this.source.close();
      default:
        return this.source.input(m, this.w, this.h);
    }
  }

  private askKey(force = false) {
    const now = Date.now();
    if (!force && now - this.lastKeyAsk < keyGapMs) return;
    this.lastKeyAsk = now;
    this.source.keyframe();
  }

  private resize(w: number, h: number) {
    const nw = even(clamp(w, 64, this.sw));
    const nh = even(clamp(h, 64, this.sh));
    if (nw === this.w && nh === this.h) return;
    this.w = nw;
    this.h = nh;
    this.source.resize(nw, nh);
    clearTimeout(this.resizeT);
    this.resizeT = setTimeout(() => this.restart("resize"), resizeQuietMs);
  }

  private stopVideo() {
    clearTimeout(this.restartT);
    this.gen++;
    this.videoOn = false;
    this.source.stopVideo();
  }

  // a fresh video at the viewer's size: its first frame a keyframe. Kept to one a
  // second; one asked sooner runs when the second is up
  private restart(why: string) {
    if (this.ended || !this.viewer || !this.opened) return;
    const wait = this.lastRestart + (this.source.restartGapMs ?? restartGapMs) - Date.now();
    clearTimeout(this.restartT);
    if (wait > 0 && this.videoOn) {
      this.restartT = setTimeout(() => this.restart(why), wait);
      return;
    }
    this.lastRestart = Date.now();
    this.stopVideo();
    const gen = this.gen;
    this.videoOn = true;
    this.stats.kbps = this.kbps;
    this.stats.restarts++;
    this.needKey = true;
    let got = false;
    const live = () => gen === this.gen && !this.ended;
    this.source.video(
      {
        w: this.w,
        h: this.h,
        fps: this.start.fps ? clamp(this.start.fps, 10, 240) : 0,
        kbps: this.kbps,
        full: this.start.full,
      },
      {
        config: (avcc, w, h) => live() && this.sendConfig(gen, w, h, avcc),
        frame: (key, data, room) => {
          if (!live()) return;
          got = true;
          this.frame(gen, key, data, !!room);
        },
        ended: (g) => {
          if (!live()) return;
          this.videoOn = false;
          this.stats.enc = this.source.label;
          // a video that ran a while comes straight back; one that never made a frame waits its second
          if (g || got) this.lastRestart = 0;
          this.restart("video ended");
        },
      },
    );
  }

  private sendConfig(gen: number, w: number, h: number, avcc: Uint8Array) {
    const v = this.viewer;
    if (!v) return;
    const b = new Uint8Array(HeadLen + avcc.length);
    const d = new DataView(b.buffer);
    b[0] = MsgConfig;
    d.setUint16(2, gen & 0xffff, true);
    d.setUint16(4, w, true);
    d.setUint16(6, h, true);
    b.set(avcc, HeadLen);
    v.binary(b);
  }

  private frame(gen: number, key: boolean, data: Uint8Array, room: boolean) {
    const v = this.viewer;
    if (!v) return;
    this.lastSeen = Date.now();
    if (key) this.needKey = false;
    else if (this.needKey) {
      this.stats.skipped++;
      if (this.source.keyframes) this.askKey();
      return;
    }
    const now = Date.now();
    if (v.queued() > behindLimit(this.lastKeyBytes)) {
      // behind: this frame and the ones after it skipped until a keyframe. A source
      // that makes one on request is asked; the rate drops when it happens again soon
      this.stats.skipped++;
      this.needKey = true;
      const again = now - this.lastBehind < 3000;
      this.lastBehind = now;
      this.cleanSince = now;
      if (this.source.keyframes && !again) return this.askKey(true);
      this.kbps = Math.max(minKbps, Math.round(this.kbps * 0.6));
      this.restart("behind");
      return;
    }
    if (this.kbps < startKbps && now - this.cleanSince > rampAfterMs * (this.source.keyframes ? 3 : 1)) {
      this.kbps = Math.min(startKbps, Math.round(this.kbps * 1.5));
      this.cleanSince = now;
      this.restart("ramp");
    }
    const n = room ? data.length - HeadLen : data.length;
    if (key) this.lastKeyBytes = n;
    const b = room ? data : new Uint8Array(HeadLen + n);
    const d = new DataView(b.buffer, b.byteOffset, HeadLen);
    b[0] = MsgFrame;
    b[1] = key ? 1 : 0;
    d.setUint16(2, gen & 0xffff, true);
    d.setUint32(4, ++this.seq, true);
    if (!room) b.set(data, HeadLen);
    v.binary(b);
    this.stats.frames++;
    this.stats.bytes += n;
  }

  // the app asked to close politely; quit kills it
  end(why = "closed") {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.resizeT);
    this.stopVideo();
    this.source.quit();
    this.viewer?.json({ t: "ended", why });
    this.viewer?.close(1000);
    this.viewer = undefined;
    this.onEnd?.(why);
  }
}
