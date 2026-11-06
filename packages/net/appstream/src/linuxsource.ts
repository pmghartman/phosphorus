// a Linux host's app: the agent (xsource.ts) where it has phosphorus and Xvfb, pixels and ffmpeg video;
// afterglow (`afterglow --stdio` over ssh) where it does not, video alone; the app as the viewer's login

import { AfterglowSource, type Transport } from "@phosphorus/afterglow";
import { missing, shq } from "./encode.ts";
import type { Chan, Opened, PixelSink, Runner, Sink, Source, Video, VideoSink } from "./session.ts";
import { caps, XSource } from "./xsource.ts";

// an ssh channel as afterglow's transport
export function chanTransport(ch: Chan): Transport {
  return {
    write: (b) => ch.write(b),
    onData: (f) => ch.onData(f),
    onClose: (f) => ch.onClose(f),
    close: () => ch.close(),
  };
}

// the command that serves one app over the channel's stdin and stdout
export const afterglowCmd = (path: string) => `exec ${shq(path)} --stdio`;

export class LinuxSource implements Source {
  private inner?: Source;

  constructor(private runner: Runner) {}

  // which one streams, once open: the agent's or afterglow's
  get via(): "afterglow" | "agent" | "" {
    return this.inner instanceof AfterglowSource ? "afterglow" : this.inner ? "agent" : "";
  }

  get keyframes() {
    return this.inner?.keyframes ?? false;
  }

  get label() {
    return this.inner?.label ?? "";
  }

  get restartGapMs() {
    return this.inner?.restartGapMs;
  }

  get canVideo() {
    return this.inner?.canVideo !== false;
  }

  get hasPixels() {
    return !!this.inner?.pixels && this.inner.hasPixels !== false;
  }

  async open(s: Opened, sink: Sink): Promise<void> {
    const c = await caps(this.runner);
    const need = missing(c);
    if (need) throw new Error(need);
    if (c.bun && c.xvfb) {
      this.inner = new XSource(this.runner);
      return this.inner.open(s, sink);
    }
    const path = c.afterglow;
    const src = new AfterglowSource({
      transport: async () => chanTransport(await this.runner.run(afterglowCmd(path))),
      target: "",
      argv: s.argv,
      dbus: c.dbus,
      virtualDisplay: true,
      fps: s.fps,
    });
    this.inner = src;
    return src.open(s, sink);
  }

  video(v: Video, sink: VideoSink) {
    this.inner?.video(v, sink);
  }

  stopVideo() {
    this.inner?.stopVideo();
  }

  keyframe() {
    this.inner?.keyframe();
  }

  pixels(sink: PixelSink) {
    this.inner?.pixels?.(sink);
  }

  stopPixels() {
    this.inner?.stopPixels?.();
  }

  refresh() {
    this.inner?.refresh?.();
  }

  motion(on: boolean) {
    this.inner?.motion?.(on);
  }

  input(m: unknown[], w: number, h: number) {
    this.inner?.input(m, w, h);
  }

  resize(w: number, h: number) {
    this.inner?.resize(w, h);
  }

  close() {
    this.inner?.close();
  }

  quit() {
    this.inner?.quit();
  }
}
