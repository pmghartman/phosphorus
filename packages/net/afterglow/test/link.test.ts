// afterglow's local link: the framing against the layout host/src/wire.rs writes,
// and AfterglowSource driven directly against a stand-in afterglow on a real loopback
// socket: the token said first, the app launched, frames handed on with their room in
// front, an earlier video's frames dropped, a keyframe asked for without a restart,
// input as afterglow's packets, the app's exit; the desktop's asks matched to their
// replies, a running process attached to

import { afterEach, describe, expect, test } from "bun:test";
import {
  AfterglowSource,
  FrameRoom,
  In,
  Link,
  LinkReader,
  linkMessage,
  type Opened,
  Out,
  type Sink,
  type VideoSink,
} from "../src/index.ts";
import { configMessage, cursorMessage, FakeAfterglow, frameMessage, jsonMessage } from "../src/testing.ts";

describe("link framing", () => {
  test("messages out of a stream cut anywhere, each its own array", () => {
    const a = jsonMessage(Out.ready, { version: "1" });
    const b = frameMessage(3, true, [0, 0, 0, 1, 0x65]);
    const all = new Uint8Array([...a, ...b, ...a]);
    for (const cut of [1, 3, 7, all.length]) {
      const got: Uint8Array[] = [];
      const r = new LinkReader((m) => got.push(m));
      for (let i = 0; i < all.length; i += cut) r.feed(all.subarray(i, i + cut));
      expect(got.map((m) => m[0])).toEqual([Out.ready, Out.frame, Out.ready]);
      expect(Array.from(got[1]!)).toEqual([Out.frame, 1, 3, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0x65]);
      expect(got[1]!.byteOffset).toBe(0);
    }
  });
  test("a length past the limit breaks the link", () => {
    const r = new LinkReader(() => {});
    r.feed(new Uint8Array([0xff, 0xff, 0xff, 0xff, 1]));
    expect(r.broken).toBe(true);
  });
  test("a message cut at every byte, the length prefix too, and several in one chunk", () => {
    const a = frameMessage(1, false, [0, 0, 0, 3, 0x41, 1, 2]);
    const b = jsonMessage(Out.pong, 7);
    const all = new Uint8Array([...a, ...b, ...a]);
    const got: Uint8Array[] = [];
    const r = new LinkReader((m) => got.push(m));
    for (const c of all) r.feed(new Uint8Array([c]));
    r.feed(all);
    expect(got.map((m) => m[0])).toEqual([Out.frame, Out.pong, Out.frame, Out.frame, Out.pong, Out.frame]);
    expect(Array.from(got[3]!)).toEqual(Array.from(got[0]!));
    // each its own buffer, not a view into what was fed
    expect(got[3]!.buffer).not.toBe(all.buffer);
  });
  test("a message bigger than the buffer", () => {
    const big = new Uint8Array(3 << 20).fill(7);
    const m = linkMessage(Out.frame, big);
    const got: Uint8Array[] = [];
    const r = new LinkReader((x) => got.push(x));
    for (let i = 0; i < m.length; i += 65536) r.feed(m.subarray(i, i + 65536));
    expect(got.length).toBe(1);
    expect(got[0]!.length).toBe(1 + big.length);
  });
});

// what a driver would be handed: the source's metadata, its video, its end
class Driver implements Sink, VideoSink {
  metas: Record<string, unknown>[] = [];
  exits: string[] = [];
  configs: { avcc: number[]; w: number; h: number }[] = [];
  frames: { key: boolean; data: Uint8Array; room?: boolean }[] = [];
  ends: boolean[] = [];
  meta(m: { t: string } & Record<string, unknown>) {
    this.metas.push(m);
  }
  say() {}
  exit(error: string) {
    this.exits.push(error);
  }
  config(avcc: Uint8Array, w: number, h: number) {
    this.configs.push({ avcc: Array.from(avcc), w, h });
  }
  frame(key: boolean, data: Uint8Array, room?: boolean) {
    this.frames.push({ key, data, room });
  }
  ended(got: boolean) {
    this.ends.push(got);
  }
}

const opened = (w: number, h: number): Opened => ({
  argv: [],
  name: "App",
  w,
  h,
  sw: 1920,
  sh: 1080,
  scale: 1,
  full: false,
  fps: 60,
  dpi: 96,
});
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const bodyJson = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));

let fake: FakeAfterglow | undefined;
afterEach(() => fake?.stop());

describe("afterglow source", () => {
  test("launch, frames with their room in place, gen filtering, a keyframe asked, input, exit", async () => {
    fake = new FakeAfterglow("t0ken-t0ken-t0ken-1", (f, type, body) => {
      if (type === In.launch) f.send(jsonMessage(Out.launched, { ok: true, resumed: false }));
      if (type === In.video) {
        const j = bodyJson(body);
        f.send(configMessage(j.gen, j.w, j.h, [1, 0x64, 0, 0x1f]));
        f.send(frameMessage(j.gen, true, [0, 0, 0, 2, 0x65, 0x88]));
        // a frame of a video already given up: dropped
        f.send(frameMessage(j.gen - 1, false, [0, 0, 0, 1, 0x41]));
      }
    });
    let done = 0;
    const src = new AfterglowSource({
      link: { port: fake.port, token: fake.token },
      target: "C:\\Users\\me\\Desktop\\App.lnk",
      virtualDisplay: true,
      done: () => done++,
    });
    const d = new Driver();
    await src.open(opened(1280, 720), d);
    expect(fake.hello).toBe(fake.token);
    expect(bodyJson(fake.sent(In.launch)[0]!.body)).toMatchObject({
      cmd: "C:\\Users\\me\\Desktop\\App.lnk",
      w: 1280,
      h: 720,
      fps: 60,
      virtual_display: true,
    });
    expect(d.metas).toContainEqual({ t: "title", s: "App" });

    // the open's video taken up as it is, a keyframe asked rather than a second video
    src.video({ w: 1280, h: 720, fps: 60, kbps: 20_000, full: false }, d);
    await settle();
    expect(fake.sent(In.video).length).toBe(1);
    expect(fake.sent(In.idr).length).toBe(1);
    // the pointer is the viewer's to draw: asked of the host, not drawn in, no blank one
    expect(bodyJson(fake.sent(In.video)[0]!.body)).toMatchObject({ draw_cursor: false });
    expect(d.metas.some((m) => m.t === "cursor")).toBe(false);
    fake.send(cursorMessage(true, 3, 4, 1, 1, [0x89, 0x50, 0x4e, 0x47]));
    fake.send(cursorMessage(false, 0, 0, 0, 0, []));
    await settle();
    expect(d.metas.filter((m) => m.t === "cursor")).toEqual([
      { t: "cursor", png: "iVBORw==", x: 3, y: 4 },
      { t: "cursor", name: "none" },
    ]);
    expect(d.configs).toEqual([{ avcc: [1, 0x64, 0, 0x1f], w: 1280, h: 720 }]);
    expect(d.frames.length).toBe(1);
    expect(d.frames[0]!.key).toBe(true);
    expect(d.frames[0]!.room).toBe(true);
    expect(Array.from(d.frames[0]!.data.subarray(FrameRoom))).toEqual([0, 0, 0, 2, 0x65, 0x88]);

    // input: afterglow's packets, a mouse move at the video's size
    src.input(["m", 640, 360], 1280, 720);
    src.input(["k", true, "KeyA", "a", false], 1280, 720);
    await settle();
    const inputs = fake.sent(In.input).map((g) => g.body);
    expect(inputs.length).toBe(2);
    const mv = new DataView(inputs[0]!.buffer, inputs[0]!.byteOffset);
    expect(mv.getUint32(4, true)).toBe(0x05);
    expect(mv.getInt16(8, false)).toBe(640);
    expect(mv.getInt16(14, false)).toBe(1279);

    // a keyframe asked: the video not restarted
    src.keyframe();
    await settle();
    expect(fake.sent(In.idr).length).toBe(2);
    expect(fake.sent(In.video).length).toBe(1);

    // the app quits on the host
    fake.send(jsonMessage(Out.exited, {}));
    await settle();
    expect(d.exits).toEqual([""]);
    expect(done).toBe(1);
  });

  test("a launch refused: the open fails with afterglow's reason", async () => {
    fake = new FakeAfterglow("t0ken-t0ken-t0ken-2", (f, type) => {
      if (type === In.launch) f.send(jsonMessage(Out.launched, { ok: false, error: "not an app this host can start" }));
    });
    const src = new AfterglowSource({
      link: { port: fake.port, token: fake.token },
      target: "C:\\x.lnk",
      virtualDisplay: false,
    });
    await expect(src.open(opened(640, 480), new Driver())).rejects.toThrow("not an app this host can start");
  });

  test("a wrong token: no answer, the open times out", async () => {
    fake = new FakeAfterglow("the-right-token-xx", () => {});
    const src = new AfterglowSource({
      link: { port: fake.port, token: "the-wrong-token-xx" },
      target: "C:\\x.lnk",
      virtualDisplay: false,
    });
    await expect(src.open(opened(640, 480), new Driver())).rejects.toThrow();
  }, 10_000);

  test("a new size: a fresh video, the old one's late frames dropped", async () => {
    let lastGen = 0;
    fake = new FakeAfterglow("t0ken-t0ken-t0ken-3", (f, type, body) => {
      if (type === In.launch) f.send(jsonMessage(Out.launched, { ok: true }));
      if (type === In.video) {
        const j = bodyJson(body);
        // the video before's frame still in flight
        if (lastGen) f.send(frameMessage(lastGen, true, [0, 0, 0, 1, 9]));
        lastGen = j.gen;
        f.send(configMessage(j.gen, j.w, j.h, [1, 2, 3]));
        f.send(frameMessage(j.gen, true, [0, 0, 0, 1, 0x65]));
      }
    });
    const src = new AfterglowSource({
      link: { port: fake.port, token: fake.token },
      target: "C:\\x.lnk",
      virtualDisplay: true,
      drawCursor: true,
    });
    const first = new Driver();
    await src.open(opened(800, 600), first);
    src.video({ w: 800, h: 600, fps: 60, kbps: 20_000, full: false }, first);
    await settle();
    const next = new Driver();
    src.video({ w: 1024, h: 768, fps: 60, kbps: 20_000, full: false }, next);
    await settle();
    expect(bodyJson(fake.sent(In.video).at(-1)!.body)).toMatchObject({ w: 1024, h: 768, draw_cursor: true });
    // drawn in by the host: the page's pointer hidden
    expect(first.metas).toContainEqual({ t: "cursor", name: "blank" });
    expect(next.configs).toEqual([{ avcc: [1, 2, 3], w: 1024, h: 768 }]);
    expect(next.frames.length).toBe(1);
    expect(next.frames[0]!.data[FrameRoom + 4]).toBe(0x65);
    src.quit();
  });

  test("notes, the clipboard, a window raised, a polite close and how the app ended", async () => {
    fake = new FakeAfterglow("t0ken-t0ken-t0ken-4", (f, type) => {
      if (type === In.launch)
        f.send(jsonMessage(Out.launched, { ok: true, features: ["notes", "clipboard", "raise", "close"] }));
      if (type === In.close) f.send(jsonMessage(Out.exited, { code: 0, log: "bye\n" }));
    });
    const src = new AfterglowSource({
      link: { port: fake.port, token: fake.token },
      target: "",
      argv: ["/usr/bin/gedit", "--new-window"],
      dbus: true,
      virtualDisplay: true,
    });
    const d = new Driver();
    await src.open(opened(1280, 720), d);
    expect(bodyJson(fake.sent(In.launch)[0]!.body)).toMatchObject({
      argv: ["/usr/bin/gedit", "--new-window"],
      dbus: true,
      dpi: 96,
      scale: 1,
    });
    const says: Record<string, unknown>[] = [];
    (d as unknown as { say: (m: Record<string, unknown>) => void }).say = (m) => void says.push(m);
    fake.send(jsonMessage(Out.note, { t: "title", s: "notes.txt" }));
    fake.send(jsonMessage(Out.note, { t: "windows", list: [[7, "notes.txt"]], main: 7 }));
    fake.send(jsonMessage(Out.note, { t: "clip", s: "copied on the host" }));
    await settle();
    expect(d.metas).toContainEqual({ t: "title", s: "notes.txt" });
    expect(d.metas).toContainEqual({ t: "windows", list: [[7, "notes.txt"]], main: 7 });
    expect(says).toEqual([{ t: "clip", s: "copied on the host" }]);
    // the viewer's clipboard goes to the host at once, not typed at the next paste
    src.input(["clip", "from the viewer"], 1280, 720);
    src.input(["raise", 7], 1280, 720);
    await settle();
    expect(new TextDecoder().decode(fake.sent(In.clip)[0]!.body)).toBe("from the viewer");
    expect(Array.from(fake.sent(In.raise)[0]!.body)).toEqual([7, 0, 0, 0]);
    // closed as its close button: the app ends when it's ready to, saying how
    src.close();
    await settle();
    expect(fake.sent(In.close).length).toBe(1);
    expect(fake.sent(In.quit).length).toBe(0);
    expect(d.exits).toEqual([""]);
  });

  test("a transport that closes before ready: the open fails at once", async () => {
    let closes: (() => void)[] = [];
    const t0 = performance.now();
    const src = new AfterglowSource({
      transport: () => ({
        write: () => queueMicrotask(() => closes.forEach((f) => f())),
        onData: () => {},
        onClose: (f) => void closes.push(f),
        close: () => {
          closes = [];
        },
      }),
      target: "",
      argv: ["x"],
      virtualDisplay: true,
    });
    await expect(src.open(opened(640, 480), new Driver())).rejects.toThrow("afterglow closed the link");
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("the desktop", () => {
  test("processes listed, ends and deletes matched to their asks by id, a refusal thrown", async () => {
    const ends: Record<string, unknown>[] = [];
    fake = new FakeAfterglow("t0ken-t0ken-t0ken-5", (f, type, body) => {
      const j = bodyJson(body);
      if (type === In.processes)
        f.send(
          jsonMessage(Out.processes, {
            ok: true,
            id: j.id,
            list: [{ pid: 7, ppid: 1, exe: "C:\\x\\a.exe", name: "a.exe", started: 5, windows: [[18, "A"]] }],
          }),
        );
      if (type === In.end) {
        ends.push(j);
        // the second answered first: each still reaches its own ask
        if (ends.length === 2)
          for (const e of [...ends].reverse())
            f.send(
              jsonMessage(Out.ended, { ok: true, id: e.id, pid: e.pid, how: e.kill ? "killed" : "closed", gone: true }),
            );
      }
      if (type === In.delete)
        f.send(
          j.path.startsWith("C:\\Windows")
            ? jsonMessage(Out.deleted, { ok: false, id: j.id, path: j.path, error: "outside the user's folders" })
            : jsonMessage(Out.deleted, { ok: true, id: j.id, path: j.path, recycled: !j.permanent }),
        );
    });
    const others: number[] = [];
    const link = new Link(
      { port: fake.port, token: fake.token },
      { message: (m) => others.push(m[0]!), closed: () => {} },
    );
    await link.open();
    const list = await link.processes(true);
    expect(list).toEqual([{ pid: 7, ppid: 1, exe: "C:\\x\\a.exe", name: "a.exe", started: 5, windows: [[18, "A"]] }]);
    expect(bodyJson(fake.sent(In.processes)[0]!.body)).toMatchObject({ all: true });

    const [closed, killed] = await Promise.all([
      link.end(7, { started: 5 }),
      link.end(8, { kill: true, shell: true, waitMs: 100 }),
    ]);
    expect(closed).toEqual({ how: "closed", gone: true });
    expect(killed).toEqual({ how: "killed", gone: true });
    expect(ends[0]).toMatchObject({ pid: 7, started: 5, kill: false, shell: false, wait_ms: 5000 });
    expect(ends[1]).toMatchObject({ pid: 8, kill: true, shell: true, wait_ms: 100 });
    expect(ends[1]!.started).toBeUndefined();

    expect(await link.delete("C:\\Users\\me\\Desktop\\x.txt")).toEqual({ recycled: true });
    expect(await link.delete("C:\\Users\\me\\y", true)).toEqual({ recycled: false });
    expect(bodyJson(fake.sent(In.delete)[1]!.body)).toMatchObject({ path: "C:\\Users\\me\\y", permanent: true });
    await expect(link.delete("C:\\Windows\\win.ini")).rejects.toThrow("outside the user's folders");
    // the replies never reached the link's other listeners
    expect(others).toEqual([]);

    // asks still open when the link closes fail at once
    const pending = link.processes();
    link.close("bye");
    await expect(pending).rejects.toThrow("afterglow closed the link");
  });

  test("a process attached to rather than launched, closed through its windows", async () => {
    fake = new FakeAfterglow("t0ken-t0ken-t0ken-6", (f, type, body) => {
      if (type === In.attach) {
        const j = bodyJson(body);
        f.send(
          jsonMessage(
            Out.launched,
            j.pid === 7
              ? { ok: true, attached: true, features: ["close", "processes", "attach", "delete"] }
              : { ok: false, attached: true, error: "pid 9 is another process now: list them again" },
          ),
        );
      }
      if (type === In.close) f.send(jsonMessage(Out.exited, {}));
    });
    const refused = new AfterglowSource({
      link: { port: fake.port, token: fake.token },
      target: "",
      attach: { pid: 9, started: 1 },
      virtualDisplay: true,
    });
    await expect(refused.open(opened(800, 600), new Driver())).rejects.toThrow(
      "the app couldn't be attached to: pid 9 is another process now",
    );

    const src = new AfterglowSource({
      link: { port: fake.port, token: fake.token },
      target: "",
      attach: { pid: 7, started: 1_700_000_000_000 },
      virtualDisplay: true,
    });
    const d = new Driver();
    await src.open(opened(1024, 768), d);
    expect(fake.sent(In.launch).length).toBe(0);
    expect(bodyJson(fake.sent(In.attach).at(-1)!.body)).toMatchObject({
      pid: 7,
      started: 1_700_000_000_000,
      shell: false,
      w: 1024,
      h: 768,
      virtual_display: true,
    });
    // the video starts as for a launched app
    await settle();
    expect(fake.sent(In.video).length).toBe(1);
    src.close();
    await settle();
    expect(fake.sent(In.close).length).toBe(1);
    expect(fake.sent(In.quit).length).toBe(0);
    expect(d.exits).toEqual([""]);
  });
});

describe("the desktop beside a stream", () => {
  test("the stream's link offered for the desktop's asks while it's up, never once it has quit", async () => {
    fake = new FakeAfterglow("t0ken-t0ken-t0ken-7", (f, type, body) => {
      if (type === In.launch) f.send(jsonMessage(Out.launched, { ok: true, features: ["processes"] }));
      if (type === In.processes) f.send(jsonMessage(Out.processes, { ok: true, id: bodyJson(body).id, list: [] }));
    });
    const src = new AfterglowSource({
      link: { port: fake.port, token: fake.token },
      target: "C:\\a.lnk",
      virtualDisplay: true,
    });
    expect(src.linkNow).toBeUndefined();
    await src.open(opened(800, 600), new Driver());
    const link = src.linkNow!;
    expect(link.ready?.version).toBeDefined();
    expect(await link.processes()).toEqual([]);
    src.quit();
    expect(src.linkNow).toBeUndefined();
  });
});
