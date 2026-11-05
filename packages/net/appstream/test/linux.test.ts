// a Linux host's app through LinuxSource: the host probed, afterglow run over the
// runner (ssh's) as `afterglow --stdio` when it has one, here an afterglow of our own
// speaking the link on the channel. The app launched by its argv, frames to the viewer
// with their header in place, its title, the viewer's clipboard sent to the host, a
// polite close; the agent and ffmpeg when the host has no afterglow, or it won't start

import { describe, expect, test } from "bun:test";
import { In, LinkReader, linkMessage, Out } from "@phosphorus/afterglow";
import { configMessage, frameMessage, jsonMessage } from "@phosphorus/afterglow/testing";
import {
  AppSession,
  afterglowCmd,
  type Chan,
  HeadLen,
  LinuxSource,
  MsgFrame,
  parseCaps,
  type Runner,
  type Viewer,
} from "../src/index.ts";

const settle = () => new Promise((r) => setTimeout(r, 30));

const features = "afterglow 0.3 stdio argv notes clipboard raise close cursor";
const probe = (afterglow: boolean) =>
  [
    "have:Xvfb",
    "have:ffmpeg",
    "have:python3",
    "have:dbus-run-session",
    ...(afterglow ? [`afterglow:/var/lib/phosphorus/afterglow/afterglow ${features}`] : []),
  ].join("\n");

// an afterglow on the far end of a channel: what it was sent, by type
class StdioAfterglow {
  got: { type: number; body: Uint8Array }[] = [];
  private datas: ((b: Uint8Array) => void)[] = [];
  private closes: (() => void)[] = [];
  closed = false;
  private gen = 0;
  private reader = new LinkReader((m) => this.on(m[0]!, m.subarray(1)));

  chan: Chan = {
    write: (d) => this.reader.feed(typeof d === "string" ? new TextEncoder().encode(d) : d),
    onData: (f) => void this.datas.push(f),
    onClose: (f) => void this.closes.push(f),
    close: () => {
      this.closed = true;
      for (const f of this.closes) f();
    },
  };

  send(m: Uint8Array) {
    queueMicrotask(() => {
      for (const f of this.datas) f(m);
    });
  }

  sent(type: number) {
    return this.got.filter((g) => g.type === type);
  }

  private on(type: number, body: Uint8Array) {
    this.got.push({ type, body });
    const j = () => JSON.parse(new TextDecoder().decode(body));
    if (type === In.hello)
      this.send(jsonMessage(Out.ready, { version: "0.3", virtual_display: true, hostname: "lin", running: false }));
    if (type === In.launch)
      this.send(jsonMessage(Out.launched, { ok: true, features: ["notes", "clipboard", "raise", "close"] }));
    if (type === In.video) {
      const v = j();
      this.gen = v.gen;
      this.send(configMessage(v.gen, v.w, v.h, [1, 0x42, 0xc0, 0x1f]));
      this.send(frameMessage(v.gen, true, [0, 0, 0, 2, 0x65, 0x88]));
      this.send(linkMessage(Out.note, JSON.stringify({ t: "title", s: "notes.txt - gedit" })));
    }
    // a keyframe asked of the running video, as afterglow makes one
    if (type === In.idr) this.send(frameMessage(this.gen, true, [0, 0, 0, 2, 0x65, 0x88]));
    if (type === In.close) this.send(jsonMessage(Out.exited, { code: 0, log: "" }));
  }
}

function runner(afterglow: boolean, ag = new StdioAfterglow()) {
  const ran: string[] = [];
  const r: Runner = {
    async run(cmd) {
      ran.push(cmd);
      if (cmd.includes("--stdio")) return ag.chan;
      // the agent: never answers, which is all this test asks of it
      return { write() {}, onData() {}, onClose() {}, close() {} };
    },
    async output() {
      return probe(afterglow);
    },
  };
  return { r, ran, ag };
}

const start = {
  argv: ["/usr/bin/gedit", "--new-window"],
  name: "gedit",
  w: 1280,
  h: 720,
  sw: 1920,
  sh: 1080,
  scale: 1,
  full: false,
  fps: 60,
};

describe("a Linux host's app", () => {
  test("the probe finds afterglow, the one that serves --stdio", () => {
    expect(parseCaps(probe(true)).afterglow).toBe("/var/lib/phosphorus/afterglow/afterglow");
    expect(parseCaps(probe(false)).afterglow).toBe("");
    // an older afterglow, no --stdio: not it
    expect(parseCaps("afterglow:/x/afterglow afterglow 0.2 cursor").afterglow).toBe("");
  });

  test("through afterglow over the runner: argv, frames, the title, the clipboard, a polite close", async () => {
    const { r, ran, ag } = runner(true);
    const app = new AppSession("l1", r, start);
    await app.open();
    expect(ran).toContain(afterglowCmd("/var/lib/phosphorus/afterglow/afterglow"));
    expect((app.source as LinuxSource).via).toBe("afterglow");
    expect(app.source.label).toBe("afterglow");
    expect(app.source.keyframes).toBe(true);
    const launch = JSON.parse(new TextDecoder().decode(ag.sent(In.launch)[0]!.body));
    expect(launch).toMatchObject({
      argv: ["/usr/bin/gedit", "--new-window"],
      dbus: true,
      virtual_display: true,
      dpi: 96,
    });

    const bins: Uint8Array[] = [];
    const msgs: Record<string, unknown>[] = [];
    const v: Viewer = {
      binary: (b) => void bins.push(b),
      json: (m) => void msgs.push(m as never),
      queued: () => 0,
      close() {},
    };
    app.attach(v);
    await settle();
    const frame = bins.find((b) => b[0] === MsgFrame)!;
    expect(frame[1]).toBe(1);
    expect(Array.from(frame.subarray(HeadLen))).toEqual([0, 0, 0, 2, 0x65, 0x88]);
    expect(msgs).toContainEqual({ t: "title", s: "notes.txt - gedit" });
    expect(app.title).toBe("notes.txt - gedit");

    // the viewer's clipboard: the app's own at once
    app.input(["clip", "from the viewer"]);
    await settle();
    expect(new TextDecoder().decode(ag.sent(In.clip)[0]!.body)).toBe("from the viewer");

    // the window's close button: the app asked, and it closes
    app.input(["close"]);
    await settle();
    expect(ag.sent(In.close).length).toBe(1);
    expect(app.alive).toBe(false);
  });

  test("no afterglow on the host: the agent and ffmpeg", async () => {
    const { r, ran } = runner(false);
    const src = new LinuxSource(r);
    const opening = src.open({ ...start, dpi: 96 }, { meta() {}, say() {}, exit() {} });
    await settle();
    expect(src.via).toBe("agent");
    expect(ran.some((c) => c.includes("python3"))).toBe(true);
    expect(ran.some((c) => c.includes("--stdio"))).toBe(false);
    src.quit();
    void opening.catch(() => {});
  });

  test("an afterglow that won't start: the agent instead, and a note why", async () => {
    const dead = new StdioAfterglow();
    // it never says ready and its channel closes
    dead.chan.write = () => queueMicrotask(() => dead.chan.close());
    const { r, ran } = runner(true, dead);
    const src = new LinuxSource(r);
    const says: Record<string, unknown>[] = [];
    const opening = src.open({ ...start, dpi: 96 }, { meta() {}, say: (m) => void says.push(m), exit() {} });
    await new Promise((res) => setTimeout(res, 200));
    expect(src.via).toBe("agent");
    expect(says[0]?.s).toContain("afterglow didn't start here");
    expect(ran.some((c) => c.includes("python3"))).toBe(true);
    src.quit();
    void opening.catch(() => {});
  });
});
