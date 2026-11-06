// the X source: a Linux host's app on its own headless X server, run by the agent
// (agent.py: the display's window manager, input through XTEST, title, cursor and
// clipboard, and the pixels as rectangles the moment they change); video, when wanted,
// from ffmpeg grabbing that display (encode.ts) into FLV cut into frames

import agentPy from "./agent.py" with { type: "text" };
import { type Caps, type Encoder, encodeCmd, missing, parseCaps, probeCmd } from "./encode.ts";
import { FlvReader } from "./flv.ts";
import { keycodeOf, keysymOf } from "./keys.ts";
import type { Chan, Opened, PixelSink, Runner, Sink, Source, Video, VideoSink } from "./session.ts";

const python = (src: string) => {
  const b64 = Buffer.from(Bun.deflateSync(new TextEncoder().encode(src), { level: 9 })).toString("base64");
  return `exec python3 -c "import base64,zlib;exec(compile(zlib.decompress(base64.b64decode('${b64}'),-15),'phosphorus-appstream','exec'))"`;
};

let agentCmd = "";

const capsCache = new WeakMap<Runner, Promise<Caps>>();
export function caps(r: Runner): Promise<Caps> {
  let p = capsCache.get(r);
  if (!p) {
    p = r.output(probeCmd).then(parseCaps);
    p.catch(() => capsCache.delete(r));
    capsCache.set(r, p);
  }
  return p;
}

const clamp = (v: unknown, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

// the agent's stdout: JSON lines, a line with n followed by that many bytes
export class AgentReader {
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private head?: Record<string, any>;

  constructor(private on: (m: Record<string, any>, bytes?: Uint8Array) => void) {}

  push(b: Uint8Array) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, b]) : Buffer.from(b.buffer, b.byteOffset, b.length);
    for (;;) {
      if (this.head) {
        const n = Number(this.head.n) || 0;
        if (this.buf.length < n) return;
        const bytes = new Uint8Array(this.buf.subarray(0, n));
        this.buf = this.buf.subarray(n);
        const h = this.head;
        this.head = undefined;
        this.on(h, bytes);
        continue;
      }
      const i = this.buf.indexOf(10);
      if (i < 0) return;
      const line = this.buf.subarray(0, i).toString("utf8");
      this.buf = this.buf.subarray(i + 1);
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof m?.n === "number" && m.n > 0) this.head = m;
      else this.on(m);
    }
  }
}

export class XSource implements Source {
  readonly keyframes = false;
  agent?: Chan;
  private enc?: Chan;
  private encGen = 0;
  private encoders: Encoder[] = ["x264"];
  private display = "";
  private auth = "";
  private pix?: PixelSink;
  canVideo = true;
  hasPixels = true;

  constructor(private runner: Runner) {}

  get label() {
    return this.pix ? "pixels" : this.encoders[0]!;
  }

  async open(s: Opened, sink: Sink): Promise<void> {
    this.note = (t) => sink.say({ t: "note", s: t });
    const c = await caps(this.runner);
    const need = missing(c);
    if (need) throw new Error(need);
    this.encoders = [...c.encoders];
    this.canVideo = c.ffmpeg;
    agentCmd ||= python(agentPy);
    const a = await this.runner.run(agentCmd);
    this.agent = a;
    let ready = false;
    await new Promise<void>((ok, no) => {
      const t = setTimeout(() => no(new Error("the host didn't start the app in 20s")), 20_000);
      const r = new AgentReader((m, bytes) => {
        if (m.t === "ready") {
          clearTimeout(t);
          this.display = String(m.display);
          this.auth = String(m.auth);
          this.hasPixels = m.pixels !== false;
          ready = true;
          ok();
        } else if (m.t === "exit" && !ready) {
          clearTimeout(t);
          no(new Error(m.error || "the app exited"));
        } else this.fromAgent(m, bytes, sink);
      });
      a.onData((b) => r.push(b));
      a.onClose(() => {
        clearTimeout(t);
        no(new Error("the host closed the app's session"));
        if (ready) sink.exit("closed");
      });
      a.write(
        `${JSON.stringify({ argv: s.argv, w: s.w, h: s.h, sw: s.sw, sh: s.sh, dpi: s.dpi, scale: s.scale, dbus: c.dbus })}\n`,
      );
    });
  }

  private fromAgent(m: any, bytes: Uint8Array | undefined, sink: Sink) {
    switch (m.t) {
      case "title":
        return sink.meta({ t: "title", s: String(m.s ?? "") });
      case "windows":
        return sink.meta({ t: "windows", list: m.list, main: m.main });
      case "cursor":
        return sink.meta({ t: "cursor", name: m.name, png: m.png, x: m.x, y: m.y });
      case "clip":
        return sink.say({ t: "clip", s: String(m.s ?? "") });
      case "log":
        return sink.say({ t: "note", s: String(m.s ?? "") });
      case "motion":
        return sink.motion?.(Math.max(0, Number(m.px) || 0) * 4);
      case "size":
        return this.pix?.size(clamp(m.w, 1, 16383), clamp(m.h, 1, 16383));
      case "rect":
        if (bytes && this.pix)
          this.pix.rect(
            clamp(m.x, 0, 16383),
            clamp(m.y, 0, 16383),
            clamp(m.w, 1, 16383),
            clamp(m.h, 1, 16383),
            bytes,
            !!m.z,
            m.o === 1,
          );
        return;
      case "exit":
        return sink.exit(m.error ?? "", m.log ?? "", m.code);
    }
  }

  private send(a: unknown[]) {
    this.agent?.write(`${JSON.stringify(a)}\n`);
  }

  input(m: unknown[], w: number, h: number) {
    const n = (i: number) => Math.round(Number(m[i]) || 0);
    switch (m[0]) {
      case "m":
        return this.send(["m", clamp(m[1], 0, w - 1), clamp(m[2], 0, h - 1)]);
      case "b":
        return this.send(["b", clamp(m[1], 1, 9), m[2] ? 1 : 0]);
      case "w":
        return this.send(["w", clamp(m[1], -20, 20), clamp(m[2], -20, 20)]);
      case "k": {
        const code = String(m[2] ?? "").slice(0, 32);
        const key = String(m[3] ?? "").slice(0, 32);
        const kc = keycodeOf(code);
        const sym = m[1] ? keysymOf(key, code, !!m[4]) : 0;
        if (!kc && !sym) return;
        return this.send(["k", m[1] ? 1 : 0, kc, sym, code || key]);
      }
      case "x":
        return this.send(["x", String(m[1] ?? "").slice(0, 4096)]);
      case "clip":
        return this.send(["clip", String(m[1] ?? "").slice(0, 1 << 20)]);
      case "raise":
        return this.send(["raise", n(1)]);
    }
  }

  resize(w: number, h: number) {
    this.send(["r", w, h]);
  }

  close() {
    this.send(["close"]);
  }

  keyframe() {}

  // --- pixels: the agent reads the rectangles that change and sends them ----------------

  pixels(sink: PixelSink) {
    this.pix = sink;
    this.send(["pixels", 1]);
  }

  stopPixels() {
    if (!this.pix) return;
    this.pix = undefined;
    this.send(["pixels", 0]);
  }

  refresh() {
    if (this.pix) this.send(["refresh"]);
  }

  // while video streams: how much changes, from the agent, for the way back to pixels
  motion(on: boolean) {
    this.send(["motion", on ? 1 : 0]);
  }

  // --- video: ffmpeg on the agent's display ------------------------------------------------

  stopVideo() {
    this.encGen++;
    this.enc?.close();
    this.enc = undefined;
  }

  video(v: Video, sink: VideoSink) {
    this.stopVideo();
    if (!this.canVideo) {
      this.note?.("ffmpeg isn't on this host: pixels only, no video");
      return sink.ended(false);
    }
    const gen = this.encGen;
    const enc = this.encoders[0]!;
    const reader = new FlvReader();
    let got = false;
    const cmd = encodeCmd({
      display: this.display,
      auth: this.auth,
      w: v.w,
      h: v.h,
      fps: clamp(v.fps || 60, 10, 120),
      kbps: v.kbps,
      enc,
      full: v.full && enc === "x264",
    });
    void this.runner
      .run(cmd)
      .then((ch) => {
        if (gen !== this.encGen) return ch.close();
        this.enc = ch;
        let said = "";
        ch.onData((b) => {
          if (gen !== this.encGen) return;
          for (const p of reader.push(b)) {
            if (p.kind === "config") sink.config(p.avcc, v.w, v.h);
            else {
              got = true;
              sink.frame(p.key, p.data);
            }
          }
          if (reader.bad && reader.bad !== said) {
            said = reader.bad;
            this.note?.(`the encoder sent ${reader.bad}`);
          }
        });
        ch.onClose(() => {
          if (gen !== this.encGen) return;
          this.enc = undefined;
          // a hardware encoder that never made a frame: the next one down
          if (!got && this.encoders.length > 1) {
            this.note?.(`${enc} didn't start here, encoding with ${this.encoders[1]}`);
            this.encoders.shift();
          }
          sink.ended(got);
        });
      })
      .catch((e) => {
        this.note?.(`the encoder didn't start: ${e?.message ?? e}`);
      });
  }

  // notes to the viewer, set by open's sink
  private note?: (s: string) => void;

  quit() {
    this.stopVideo();
    try {
      this.send(["quit"]);
    } catch {}
    this.agent?.close();
  }
}
