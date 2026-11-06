// afterglow's pixels through a session: an afterglow that says "pixels" is started as
// pixels by the open, the viewer's attach takes that run up and asks for the whole view,
// its size and rectangles reach the viewer as the session's own messages, a resize is a
// fresh run at the new size, and video is a video message without pixels

import { afterEach, describe, expect, test } from "bun:test";
import { AfterglowSource, In, Out } from "@phosphorus/afterglow";
import {
  configMessage,
  FakeAfterglow,
  frameMessage,
  jsonMessage,
  rectMessage,
  sizeMessage,
} from "@phosphorus/afterglow/testing";
import { AppSession, MsgConfig, MsgFrame, MsgRect, MsgSize, RectHead, type Viewer } from "../src/index.ts";

const settle = () => new Promise((r) => setTimeout(r, 30));
const u16 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint16(at, true);

let fake: FakeAfterglow | undefined;
afterEach(() => fake?.stop());

describe("afterglow pixels through a session", () => {
  test("pixels from the open, taken up on attach; a resize; video on request", async () => {
    const videos: any[] = [];
    fake = new FakeAfterglow("t0ken-t0ken-t0ken-2", (f, type, body) => {
      if (type === In.launch)
        f.send(jsonMessage(Out.launched, { ok: true, resumed: false, features: ["notes", "close", "pixels"] }));
      if (type === In.video) {
        const j = JSON.parse(new TextDecoder().decode(body));
        videos.push(j);
        if (j.pixels) {
          f.send(sizeMessage(j.gen, j.w, j.h));
          f.send(rectMessage(j.gen, 1, [0, 0, j.w, j.h], [1, 2, 3, 4], 1));
        } else {
          f.send(configMessage(j.gen, j.w, j.h, [1, 0x64, 0, 0x1f]));
          f.send(frameMessage(j.gen, true, [0, 0, 0, 2, 0x65, 0x88]));
        }
      }
      if (type === In.idr) {
        const j = videos.at(-1);
        if (j?.pixels) f.send(rectMessage(j.gen, 2, [0, 0, j.w, j.h], [9], 0));
      }
    });
    const src = new AfterglowSource({
      link: { port: fake.port, token: fake.token },
      target: "C:\\Users\\me\\Desktop\\App.lnk",
      virtualDisplay: true,
    });
    const app = new AppSession("px", src, {
      argv: [],
      name: "App",
      w: 800,
      h: 600,
      sw: 1920,
      sh: 1080,
      scale: 1,
      full: false,
      fps: 60,
    });
    await app.open();
    await settle();
    expect(src.hasPixels).toBe(true);
    expect(app.mode).toBe("pixels");
    // the open started a pixel run at the window's size
    expect(videos.length).toBe(1);
    expect(videos[0]).toMatchObject({ pixels: true, w: 800, h: 600 });

    const bins: Uint8Array[] = [];
    const msgs: any[] = [];
    const v: Viewer = { binary: (b) => void bins.push(b), json: (m) => void msgs.push(m), queued: () => 0, close() {} };
    app.attach(v);
    await settle();
    expect(msgs[0]).toMatchObject({ t: "ready", mode: "pixels", pixels: true });
    // no second run: the open's taken up, its size told again, the whole view asked for
    // (idr) and sent again; what came before anyone watched is gone
    expect(videos.length).toBe(1);
    const sizes = bins.filter((b) => b[0] === MsgSize);
    const rects = bins.filter((b) => b[0] === MsgRect);
    expect(sizes.length).toBe(1);
    expect(u16(sizes[0]!, 4)).toBe(800);
    expect(rects.length).toBe(1);
    expect([u16(rects[0]!, 12), u16(rects[0]!, 14)]).toEqual([800, 600]);
    expect(Array.from(rects[0]!.subarray(RectHead))).toEqual([9]);
    // a second viewer (a reload): the size again and the whole view
    const bins2: Uint8Array[] = [];
    app.attach({ binary: (b) => void bins2.push(b), json() {}, queued: () => 0, close() {} });
    await settle();
    expect(bins2.filter((b) => b[0] === MsgSize).length).toBe(1);
    expect(bins2.filter((b) => b[0] === MsgRect).length).toBe(1);
    bins.length = 0;
    app.attach(v);
    await settle();

    // a resize: a fresh pixel run at the new size, no video
    app.input(["r", 640, 480]);
    await settle();
    expect(videos.length).toBe(2);
    expect(videos[1]).toMatchObject({ pixels: true, w: 640, h: 480 });
    expect(bins.filter((b) => b[0] === MsgSize).length).toBe(2);

    // video asked for: a video without pixels, frames to the viewer
    app.input(["mode", "video"]);
    await settle();
    expect(app.mode).toBe("video");
    expect(videos.at(-1)).toMatchObject({ pixels: false, w: 640, h: 480 });
    expect(bins.some((b) => b[0] === MsgConfig)).toBe(true);
    expect(bins.some((b) => b[0] === MsgFrame && b[1] === 1)).toBe(true);
    // and back to pixels
    app.input(["mode", "pixels"]);
    await settle();
    expect(app.mode).toBe("pixels");
    expect(videos.at(-1)).toMatchObject({ pixels: true });
    app.end();
  });

  test("an afterglow without pixels: video as before", async () => {
    fake = new FakeAfterglow("t0ken-t0ken-t0ken-3", (f, type, body) => {
      if (type === In.launch) f.send(jsonMessage(Out.launched, { ok: true, resumed: false, features: ["close"] }));
      if (type === In.video) {
        const j = JSON.parse(new TextDecoder().decode(body));
        expect(j.pixels).toBe(false);
        f.send(configMessage(j.gen, j.w, j.h, [1, 0x64, 0, 0x1f]));
        f.send(frameMessage(j.gen, true, [0, 0, 0, 2, 0x65, 0x88]));
      }
    });
    const src = new AfterglowSource({
      link: { port: fake.port, token: fake.token },
      target: "x",
      virtualDisplay: true,
    });
    const app = new AppSession("v", src, {
      argv: [],
      name: "App",
      w: 800,
      h: 600,
      sw: 1920,
      sh: 1080,
      scale: 1,
      full: false,
    });
    await app.open();
    expect(app.mode).toBe("video");
    const bins: Uint8Array[] = [];
    app.attach({ binary: (b) => void bins.push(b), json() {}, queued: () => 0, close() {} });
    await settle();
    expect(bins.some((b) => b[0] === MsgFrame)).toBe(true);
    app.end();
  });
});
