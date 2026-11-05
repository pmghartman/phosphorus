// a Linux host's app, streamed the best way that host has: afterglow (its release's
// `afterglow --stdio`, run over ssh as the viewer's login) when the host has one, the
// agent and ffmpeg (xsource.ts) when it doesn't. afterglow reads only what the app
// drew, straight out of its X server's memory, and encodes it in-process: a key typed
// shows in a few milliseconds where ffmpeg's grab, mux and pipe took tens. Either way
// the app runs as the viewer's login on an X server of its own

import { AfterglowSource, type Transport } from "@phosphorus/afterglow";
import { missing, shq } from "./encode.ts";
import type { Chan, Opened, Runner, Sink, Source, Video, VideoSink } from "./session.ts";
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

  // which one streams, once open: afterglow's or the agent's
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

  async open(s: Opened, sink: Sink): Promise<void> {
    const c = await caps(this.runner);
    if (c.afterglow) {
      const need = missing(c);
      if (need) throw new Error(need);
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
      try {
        return await src.open(s, sink);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        // the app's own failure is the app's, whoever starts it
        if (why.startsWith("the app didn't start")) throw e;
        src.quit();
        sink.say({ t: "note", s: `afterglow didn't start here (${why}); streaming with ffmpeg` });
      }
    }
    const x = new XSource(this.runner);
    this.inner = x;
    return x.open(s, sink);
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
