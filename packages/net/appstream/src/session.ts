// one streamed app: its agent on the host (the X server, the app, the input), its
// encoder, and the viewer watching it. Frames go to the viewer as they arrive and
// never queue: over TCP a backlog is pure latency, so a viewer whose socket is
// behind skips frames until a fresh encoder's keyframe, at a lower rate

import agentPy from "./agent.py" with { type: "text" };
import { type Caps, type Encoder, encodeCmd, missing, parseCaps, probeCmd } from "./encode.ts";
import { FlvReader } from "./flv.ts";
import { keycodeOf, keysymOf } from "./keys.ts";

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

const maxW = 3840;
const maxH = 2160;
const startKbps = 20_000;
const minKbps = 1_500;
// bytes behind past which a frame is skipped: a frame or two at the start rate
const behindBytes = 96 * 1024;
const restartGapMs = 1000;
const rampAfterMs = 20_000;
const resizeQuietMs = 120;

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
const even = (n: number) => n & ~1;

export type Stats = { frames: number; bytes: number; skipped: number; restarts: number; kbps: number; enc: Encoder };

export class AppSession {
  agent?: Chan;
  private enc?: Chan;
  private gen = 0;
  private seq = 0;
  private viewer?: Viewer;
  private needKey = true;
  private display = "";
  private auth = "";
  private w = 0;
  private h = 0;
  private sw = 0;
  private sh = 0;
  private kbps = startKbps;
  private encoders: Encoder[] = ["x264"];
  private lastRestart = 0;
  private cleanSince = Date.now();
  private resizeT?: ReturnType<typeof setTimeout>;
  private restartT?: ReturnType<typeof setTimeout>;
  private gotFrame = false;
  private lastMeta: Record<string, any> = {};
  private ended = false;
  readonly created = Date.now();
  title = "";
  lastSeen = Date.now();
  stats: Stats = { frames: 0, bytes: 0, skipped: 0, restarts: 0, kbps: startKbps, enc: "x264" };
  onEnd?: (why: string) => void;

  constructor(
    public id: string,
    private runner: Runner,
    public start: Start,
  ) {
    this.title = start.name;
  }

  get alive() {
    return !this.ended;
  }

  async open(): Promise<void> {
    const c = await caps(this.runner);
    const need = missing(c);
    if (need) throw new Error(need);
    this.encoders = c.encoders;
    this.stats.enc = this.encoders[0]!;
    const s = this.start;
    this.sw = even(clamp(Math.max(s.sw, s.w), 320, maxW));
    this.sh = even(clamp(Math.max(s.sh, s.h), 240, maxH));
    this.w = even(clamp(s.w, 64, this.sw));
    this.h = even(clamp(s.h, 64, this.sh));
    agentCmd ||= python(agentPy);
    const a = await this.runner.run(agentCmd);
    this.agent = a;
    let rest = "";
    const ready = new Promise<void>((ok, no) => {
      const t = setTimeout(() => no(new Error("the host didn't start the app in 20s")), 20_000);
      a.onData((b) => {
        rest += Buffer.from(b).toString("utf8");
        let i: number;
        while ((i = rest.indexOf("\n")) >= 0) {
          const line = rest.slice(0, i);
          rest = rest.slice(i + 1);
          let m: any;
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          if (m.t === "ready") {
            clearTimeout(t);
            this.display = String(m.display);
            this.auth = String(m.auth);
            ok();
          } else if (m.t === "exit" && !this.display) {
            clearTimeout(t);
            no(new Error(m.error || "the app exited"));
          }
          this.fromAgent(m);
        }
      });
      a.onClose(() => {
        clearTimeout(t);
        no(new Error("the host closed the app's session"));
        this.end("closed");
      });
    });
    a.write(
      `${JSON.stringify({
        argv: s.argv,
        w: this.w,
        h: this.h,
        sw: this.sw,
        sh: this.sh,
        dpi: Math.round(96 * Math.max(1, s.scale)),
        scale: s.scale,
        dbus: c.dbus,
      })}\n`,
    );
    await ready;
    this.restart("start");
  }

  private fromAgent(m: any) {
    switch (m.t) {
      case "title":
        this.title = String(m.s || this.start.name);
        this.lastMeta.title = { t: "title", s: this.title };
        break;
      case "windows":
        this.lastMeta.windows = { t: "windows", list: m.list, main: m.main };
        break;
      case "cursor":
        this.lastMeta.cursor = { t: "cursor", name: m.name, png: m.png, x: m.x, y: m.y };
        break;
      case "clip":
        this.viewer?.json({ t: "clip", s: String(m.s ?? "") });
        return;
      case "log":
        this.viewer?.json({ t: "note", s: String(m.s ?? "") });
        return;
      case "exit":
        this.viewer?.json({ t: "exit", error: m.error ?? "", log: m.log ?? "", code: m.code });
        this.end(m.error || "exited");
        return;
      default:
        return;
    }
    const k = m.t === "title" ? "title" : m.t;
    this.viewer?.json(this.lastMeta[k]);
  }

  // a viewer takes over: the one before told why and let go
  attach(v: Viewer) {
    if (this.viewer && this.viewer !== v) {
      this.viewer.json({ t: "taken" });
      this.viewer.close(4000);
    }
    this.viewer = v;
    this.lastSeen = Date.now();
    v.json({ t: "ready", id: this.id, w: this.w, h: this.h, enc: this.stats.enc, title: this.title });
    for (const m of Object.values(this.lastMeta)) v.json(m);
    this.needKey = true;
    this.restart("viewer");
  }

  detach(v: Viewer) {
    if (this.viewer !== v) return;
    this.viewer = undefined;
    this.lastSeen = Date.now();
    // nobody to send to: the encoder stopped until someone comes back
    this.stopEncoder();
  }

  get watched() {
    return !!this.viewer;
  }

  // one message from the viewer
  input(m: unknown) {
    if (!Array.isArray(m) || !this.agent) return;
    this.lastSeen = Date.now();
    const n = (i: number) => Math.round(Number(m[i]) || 0);
    const send = (a: unknown[]) => this.agent?.write(`${JSON.stringify(a)}\n`);
    switch (m[0]) {
      case "m":
        return send(["m", clamp(m[1], 0, this.w - 1), clamp(m[2], 0, this.h - 1)]);
      case "b":
        return send(["b", clamp(m[1], 1, 9), m[2] ? 1 : 0]);
      case "w":
        return send(["w", clamp(m[1], -20, 20), clamp(m[2], -20, 20)]);
      case "k": {
        const code = String(m[2] ?? "").slice(0, 32);
        const key = String(m[3] ?? "").slice(0, 32);
        const kc = keycodeOf(code);
        const sym = m[1] ? keysymOf(key, code, !!m[4]) : 0;
        if (!kc && !sym) return;
        return send(["k", m[1] ? 1 : 0, kc, sym, code || key]);
      }
      case "x":
        return send(["x", String(m[1] ?? "").slice(0, 4096)]);
      case "clip":
        return send(["clip", String(m[1] ?? "").slice(0, 1 << 20)]);
      case "raise":
        return send(["raise", n(1)]);
      case "close":
        return send(["close"]);
      case "r":
        return this.resize(n(1), n(2));
      case "full":
        // full-colour chroma for sharp text, from the next keyframe
        if (!!m[1] === this.start.full) return;
        this.start.full = !!m[1];
        this.needKey = true;
        return this.restart("full");
      case "key":
        // the decoder lost its place: a fresh keyframe
        this.needKey = true;
        return this.restart("decoder");
      case "p":
        return this.viewer?.json({ t: "pong", n: m[1], q: this.viewer.queued() });
    }
  }

  private resize(w: number, h: number) {
    const nw = even(clamp(w, 64, this.sw));
    const nh = even(clamp(h, 64, this.sh));
    if (nw === this.w && nh === this.h) return;
    this.w = nw;
    this.h = nh;
    this.agent?.write(`${JSON.stringify(["r", nw, nh])}\n`);
    clearTimeout(this.resizeT);
    this.resizeT = setTimeout(() => this.restart("resize"), resizeQuietMs);
  }

  private stopEncoder() {
    clearTimeout(this.restartT);
    this.gen++;
    this.enc?.close();
    this.enc = undefined;
  }

  // a fresh encoder at the viewer's size: its first frame a keyframe. Kept to one a
  // second; one asked sooner runs when the second is up
  private restart(_why: string) {
    if (this.ended || !this.viewer || !this.display) return;
    const wait = this.lastRestart + restartGapMs - Date.now();
    clearTimeout(this.restartT);
    if (wait > 0 && this.enc) {
      this.restartT = setTimeout(() => this.restart(_why), wait);
      return;
    }
    this.lastRestart = Date.now();
    this.stopEncoder();
    const gen = this.gen;
    const enc = this.encoders[0]!;
    this.stats.enc = enc;
    this.stats.kbps = this.kbps;
    this.stats.restarts++;
    this.gotFrame = false;
    const reader = new FlvReader();
    const cmd = encodeCmd({
      display: this.display,
      auth: this.auth,
      w: this.w,
      h: this.h,
      fps: clamp(this.start.fps ?? 60, 10, 120),
      kbps: this.kbps,
      enc,
      full: this.start.full && enc === "x264",
    });
    const w = this.w;
    const h = this.h;
    void this.runner
      .run(cmd)
      .then((ch) => {
        if (gen !== this.gen) return ch.close();
        this.enc = ch;
        ch.onData((b) => {
          if (gen !== this.gen) return;
          for (const p of reader.push(b)) {
            if (p.kind === "config") {
              this.sendConfig(gen, w, h, p.avcc);
            } else this.frame(gen, p.key, p.data);
          }
          if (reader.bad) this.viewer?.json({ t: "note", s: `the encoder sent ${reader.bad}` });
        });
        ch.onClose(() => {
          if (gen !== this.gen || this.ended) return;
          this.enc = undefined;
          // a hardware encoder that never made a frame: the next one down
          if (!this.gotFrame && this.encoders.length > 1) {
            this.viewer?.json({ t: "note", s: `${enc} didn't start here, encoding with ${this.encoders[1]}` });
            this.encoders.shift();
          }
          this.lastRestart = 0;
          this.restart("encoder exited");
        });
      })
      .catch((e) => this.viewer?.json({ t: "note", s: `the encoder didn't start: ${e?.message ?? e}` }));
  }

  private sendConfig(gen: number, w: number, h: number, avcc: Uint8Array) {
    const v = this.viewer;
    if (!v) return;
    const b = new Uint8Array(8 + avcc.length);
    const d = new DataView(b.buffer);
    b[0] = MsgConfig;
    d.setUint16(2, gen & 0xffff, true);
    d.setUint16(4, w, true);
    d.setUint16(6, h, true);
    b.set(avcc, 8);
    v.binary(b);
  }

  private frame(gen: number, key: boolean, data: Uint8Array) {
    const v = this.viewer;
    if (!v) return;
    this.gotFrame = true;
    this.lastSeen = Date.now();
    if (key) this.needKey = false;
    else if (this.needKey) {
      this.stats.skipped++;
      return;
    }
    if (v.queued() > behindBytes) {
      // behind: this frame and the ones after it skipped, a keyframe at a lower rate
      this.stats.skipped++;
      this.needKey = true;
      this.kbps = Math.max(minKbps, Math.round(this.kbps * 0.6));
      this.cleanSince = Date.now();
      this.restart("behind");
      return;
    }
    if (this.kbps < startKbps && Date.now() - this.cleanSince > rampAfterMs) {
      this.kbps = Math.min(startKbps, Math.round(this.kbps * 1.5));
      this.cleanSince = Date.now();
      this.restart("ramp");
    }
    const b = new Uint8Array(8 + data.length);
    const d = new DataView(b.buffer);
    b[0] = MsgFrame;
    b[1] = key ? 1 : 0;
    d.setUint16(2, gen & 0xffff, true);
    d.setUint32(4, ++this.seq, true);
    b.set(data, 8);
    v.binary(b);
    this.stats.frames++;
    this.stats.bytes += data.length;
  }

  // the app asked to close politely; quit kills it
  end(why = "closed") {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.resizeT);
    this.stopEncoder();
    try {
      this.agent?.write(`${JSON.stringify(["quit"])}\n`);
    } catch {}
    this.agent?.close();
    this.viewer?.json({ t: "ended", why });
    this.viewer?.close(1000);
    this.viewer = undefined;
    this.onEnd?.(why);
  }
}
