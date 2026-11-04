// one glow stream: launch (or resume) the app on the host, ignite's RTSP setup,
// spark's control stream, photon's video. Stopping it leaves the app running on the
// host, so the next stream (a new size, a new rate, a viewer back) resumes it

import { randomBytes } from "node:crypto";
import type { Identity } from "./cert.ts";
import { ignite, type Setup } from "./ignite.ts";
import { type Host, launch } from "./lumen.ts";
import { Photon, type PhotonOut } from "./photon.ts";
import { Spark } from "./spark.ts";

export type StreamOpts = {
  host: Host;
  id: Identity;
  app: number;
  w: number;
  h: number;
  fps: number;
  kbps: number;
  packetSize: number;
  yuv444: boolean;
  virtualDisplay: boolean;
  scale: number;
  resume: boolean;
};

export type StreamOut = PhotonOut & { ended(why: string): void };

// one RTP payload: 32 KB. A P-frame is one or two datagrams and an IDR a few dozen,
// each JS callback costing more than the kernel's copy of the padding
export const loopbackPacket = 32768;

export class GlowStream {
  private spark?: Spark;
  private photon?: Photon;
  private stopped = false;
  setup?: Setup;
  timings: Record<string, number> = {};

  constructor(
    private o: StreamOpts,
    private out: StreamOut,
  ) {}

  async start(): Promise<void> {
    const t0 = performance.now();
    const o = this.o;
    const key = randomBytes(16);
    const url = await launch(o.host, o.id, {
      app: o.app,
      w: o.w,
      h: o.h,
      fps: o.fps,
      rikey: key,
      rikeyid: randomBytes(4).readInt32BE(0),
      virtualDisplay: o.virtualDisplay,
      scale: o.scale,
      resume: o.resume,
    });
    const t1 = performance.now();
    if (this.stopped) return;
    const s = await ignite(url, {
      w: o.w,
      h: o.h,
      fps: o.fps,
      kbps: o.kbps,
      packetSize: o.packetSize,
      minFec: 0,
      yuv444: o.yuv444,
      slices: 1,
    });
    this.setup = s;
    const t2 = performance.now();
    if (this.stopped) return;
    const addr = /^rtsp:\/\/\[?([^\]/]+?)\]?:/.exec(url)?.[1] ?? o.host.addr;
    this.photon = new Photon(addr, s.videoPort, s.audioPort, s.ping, o.packetSize, this.out);
    await this.photon.open();
    this.spark = new Spark(addr, s.controlPort, key, s.controlV2, {
      ended: (why) => {
        if (!this.stopped) this.out.ended(why);
        this.stop();
      },
    });
    await this.spark.open(s.connectData);
    this.timings = { launch: t1 - t0, rtsp: t2 - t1, control: performance.now() - t2 };
  }

  idr() {
    this.spark?.idr();
  }

  input(channel: number, pkt: Uint8Array) {
    this.spark?.input(channel, pkt);
  }

  get stats() {
    return { frames: this.photon?.dp.frames ?? 0, dropped: this.photon?.dp.dropped ?? 0, rtt: this.spark?.rtt ?? 0 };
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.spark?.close();
    this.photon?.close();
  }
}
