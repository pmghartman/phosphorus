import { describe, expect, test } from "bun:test";
import {
  AppSession,
  codecOf,
  FlvReader,
  ffmpegArgs,
  keycodeOf,
  keysymOf,
  localRunner,
  MsgConfig,
  MsgFrame,
  MsgRect,
  MsgSize,
  missing,
  parseCaps,
  parseExec,
  shq,
  type Viewer,
} from "../src/index.ts";

const ctx = { name: "Text Editor", icon: "org.gnome.TextEditor", path: "/usr/share/applications/x.desktop" };

describe("exec", () => {
  test("field codes dropped or filled", () => {
    expect(parseExec("gnome-text-editor %U", ctx)).toEqual(["gnome-text-editor"]);
    expect(parseExec("app %i --name=%c %k", ctx)).toEqual([
      "app",
      "--icon",
      "org.gnome.TextEditor",
      "--name=Text Editor",
      "/usr/share/applications/x.desktop",
    ]);
    expect(parseExec("app 100%%", ctx)).toEqual(["app", "100%"]);
  });
  test("quoting", () => {
    expect(parseExec('"/opt/My App/run" --x "a \\"b\\" \\$c" ""', ctx)).toEqual([
      "/opt/My App/run",
      "--x",
      'a "b" $c',
      "",
    ]);
    expect(parseExec("env  FOO=1   app", ctx)).toEqual(["env", "FOO=1", "app"]);
    expect(() => parseExec('app "open', ctx)).toThrow();
    expect(() => parseExec("%U", ctx)).toThrow();
  });
});

describe("keys", () => {
  test("codes as X keycodes", () => {
    expect(keycodeOf("KeyA")).toBe(38);
    expect(keycodeOf("KeyQ")).toBe(24);
    expect(keycodeOf("KeyZ")).toBe(52);
    expect(keycodeOf("Digit1")).toBe(10);
    expect(keycodeOf("Digit0")).toBe(19);
    expect(keycodeOf("Enter")).toBe(36);
    expect(keycodeOf("ShiftLeft")).toBe(50);
    expect(keycodeOf("F1")).toBe(67);
    expect(keycodeOf("F12")).toBe(96);
    expect(keycodeOf("ArrowUp")).toBe(111);
    expect(keycodeOf("MetaLeft")).toBe(133);
    expect(keycodeOf("Nope")).toBe(0);
  });
  test("keys as keysyms", () => {
    expect(keysymOf("a", "KeyA", false)).toBe(0x61);
    expect(keysymOf("A", "KeyA", false)).toBe(0x41);
    expect(keysymOf("é", "Digit2", false)).toBe(0xe9);
    expect(keysymOf("€", "KeyE", false)).toBe(0x010020ac);
    expect(keysymOf("Enter", "Enter", false)).toBe(0xff0d);
    expect(keysymOf("Shift", "ShiftRight", false)).toBe(0xffe2);
    expect(keysymOf("F5", "F5", false)).toBe(0xffc2);
    // a chord follows the physical key
    expect(keysymOf("c", "KeyC", true)).toBe(0);
    expect(keysymOf("Dead", "Quote", false)).toBe(0);
  });
});

describe("encode", () => {
  test("caps", () => {
    const c = parseCaps(
      "have:Xvfb\nhave:ffmpeg\nbun:/usr/lib/phosphorus/bin/phosphorus\nenc:h264_vaapi\ndri\nenc:h264_nvenc\n",
    );
    expect(c.encoders).toEqual(["vaapi", "x264"]);
    expect(c.bun).toBe("/usr/lib/phosphorus/bin/phosphorus");
    expect(missing(c)).toBe("");
    expect(missing(parseCaps("have:ffmpeg"))).toBe(
      "app streaming needs xvfb and phosphorus on the host (apt install xvfb)",
    );
    expect(missing(parseCaps("have:Xvfb"))).toBe("app streaming needs phosphorus on the host");
  });
  test("low-latency settings", () => {
    const a = ffmpegArgs({
      display: ":101",
      auth: "/x",
      w: 1281,
      h: 721,
      fps: 60,
      kbps: 12000,
      enc: "x264",
      full: true,
    });
    const s = a.join(" ");
    expect(s).toContain("-video_size 1280x720");
    expect(s).toContain("-tune zerolatency");
    expect(s).toContain("-bf 0");
    expect(s).toContain("-bufsize 200k");
    expect(s).toContain("-pix_fmt yuv444p");
    expect(s).toContain("-draw_mouse 0");
    expect(s).toEndWith("-f flv -");
  });
  test("shell quoting", () => {
    expect(shq("abc")).toBe("abc");
    expect(shq("it's")).toBe(`'it'\\''s'`);
  });
});

// a minimal FLV: header, an AVC sequence header, a keyframe and an inter frame
function flv(): Uint8Array {
  const parts: number[] = [0x46, 0x4c, 0x56, 1, 1, 0, 0, 0, 9, 0, 0, 0, 0];
  const tag = (data: number[], ts: number) => {
    const n = data.length;
    parts.push(9, n >> 16, (n >> 8) & 255, n & 255, (ts >> 16) & 255, (ts >> 8) & 255, ts & 255, ts >>> 24, 0, 0, 0);
    parts.push(...data);
    const total = n + 11;
    parts.push(total >>> 24, (total >> 16) & 255, (total >> 8) & 255, total & 255);
  };
  tag([0x17, 0, 0, 0, 0, 1, 0x64, 0, 0x1f, 0xff], 0);
  tag([0x17, 1, 0, 0, 0, 0, 0, 0, 2, 0x65, 0x88], 0);
  tag([0x27, 1, 0, 0, 0, 0, 0, 0, 2, 0x41, 0x9a], 17);
  return new Uint8Array(parts);
}

describe("flv", () => {
  test("cut at any byte", () => {
    const all = flv();
    for (const cut of [1, 5, 13, 20, 30, all.length - 1]) {
      const r = new FlvReader();
      const got = [...r.push(all.subarray(0, cut)), ...r.push(all.subarray(cut))];
      expect(got.map((p) => p.kind)).toEqual(["config", "frame", "frame"]);
      const [c, k, i] = got as any[];
      expect(codecOf(c.avcc)).toBe("avc1.64001f");
      expect(k.key).toBe(true);
      expect(i.key).toBe(false);
      expect(i.ts).toBe(17);
      expect([...i.data]).toEqual([0, 0, 0, 2, 0x41, 0x9a]);
    }
  });
  test("not flv", () => {
    const r = new FlvReader();
    r.push(new Uint8Array(20));
    expect(r.bad).toBe("not flv");
  });
});

const have = (c: string) => Bun.spawnSync(["sh", "-c", `command -v ${c}`]).exitCode === 0;
// a Linux machine with the lot; a Mac's XQuartz has no root-owned socket dir for Xvfb
const canRun = process.platform === "linux" && have("Xvfb") && have("ffmpeg") && have("bun") && have("xterm");

// the whole host half on this machine: xterm on its own display, encoded, typed into
describe.skipIf(!canRun)("live", () => {
  test("an app streams, takes input and closes", async () => {
    const got: any[] = [];
    const bins: Uint8Array[] = [];
    let closed = false;
    const v: Viewer = {
      binary: (b) => void bins.push(b),
      json: (m) => void got.push(m),
      queued: () => 0,
      close: () => void (closed = true),
    };
    const s = new AppSession("t1", localRunner, {
      argv: ["xterm"],
      name: "xterm",
      w: 640,
      h: 480,
      sw: 1280,
      sh: 720,
      scale: 1,
      full: false,
    });
    let ended = "";
    s.onEnd = (w) => void (ended = w);
    await s.open();
    s.attach(v);
    const until = async (f: () => boolean, ms = 8000) => {
      const t = Date.now() + ms;
      while (!f() && Date.now() < t) await Bun.sleep(20);
      return f();
    };
    // pixels first: the view's size, then the whole view as one rectangle
    expect(await until(() => bins.some((b) => b[0] === MsgSize))).toBe(true);
    const size = bins.find((b) => b[0] === MsgSize)!;
    expect(new DataView(size.buffer).getUint16(4, true)).toBe(640);
    expect(
      await until(() => bins.some((b) => b[0] === MsgRect && new DataView(b.buffer).getUint16(12, true) === 640)),
    ).toBe(true);
    // video when asked for
    s.input(["mode", "video"]);
    expect(await until(() => bins.some((b) => b[0] === MsgFrame && b[1] === 1))).toBe(true);
    const cfg = bins.find((b) => b[0] === MsgConfig)!;
    expect(new DataView(cfg.buffer).getUint16(4, true)).toBe(640);
    expect(await until(() => got.some((m) => m.t === "windows" && m.list.length === 1))).toBe(true);
    // typed into: the title follows the shell's prompt, a command run changes it (and
    // holds it a moment: a prompt that sets the title would put it straight back)
    // typed again until the shell is up to read it
    const typed = () => got.some((m) => m.t === "title" && m.s === "streamed-ok");
    for (let i = 0; i < 5 && !typed(); i++) {
      s.input(["x", "printf '\\033]0;streamed-ok\\007'; sleep 2\n"]);
      await until(typed, 1500);
    }
    expect(typed()).toBe(true);
    // a resize restarts the encoder at the new size
    const before = bins.length;
    s.input(["r", 500, 400]);
    expect(
      await until(() =>
        bins.slice(before).some((b) => b[0] === MsgConfig && new DataView(b.buffer).getUint16(4, true) === 500),
      ),
    ).toBe(true);
    s.input(["close"]);
    expect(await until(() => ended !== "")).toBe(true);
    expect(closed).toBe(true);
  }, 30_000);
});
