// a stream relayed from the phosphorus that runs the app to the one the viewer is
// on: messages passed through untouched, except that when the viewer's socket is
// behind, frames are dropped here until a keyframe (asked for upstream at once)
// rather than queued, and a lower rate asked for when that keeps happening; pixel
// rectangles likewise until the whole view comes again. The session upstream only
// sees the hop's socket, never the viewer's

import { behindLimit, MsgFrame, MsgRect, MsgSize, pixelTuning } from "./session.ts";

export type End = {
  send(d: string | Uint8Array): void;
  queued(): number;
};

// what to do with one message from upstream: pass it on, or drop it (and ask)
export function relayFrames(down: End, up: End) {
  let needKey = false;
  let needFull = false;
  let lastBehind = 0;
  let lastKey = 0;
  let lastAsk = 0;
  let vw = 0;
  let vh = 0;
  return (d: string | Uint8Array, bin: boolean) => {
    if (!bin || typeof d === "string") return down.send(d);
    if (d[0] === MsgSize) {
      const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
      vw = v.getUint16(4, true);
      vh = v.getUint16(6, true);
      return down.send(d);
    }
    if (d[0] === MsgRect) {
      const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const whole =
        v.getUint16(8, true) === 0 &&
        v.getUint16(10, true) === 0 &&
        v.getUint16(12, true) >= vw &&
        v.getUint16(14, true) >= vh;
      if (needFull && !whole) return;
      if (down.queued() > pixelTuning.behindBytes) {
        needFull = true;
        const now = Date.now();
        if (now - lastAsk > 200) {
          lastAsk = now;
          up.send(JSON.stringify(["refresh"]));
        }
        return;
      }
      if (whole) needFull = false;
      return down.send(d);
    }
    if (d[0] !== MsgFrame) return down.send(d);
    const key = d[1] === 1;
    if (key) {
      needKey = false;
      lastKey = d.length;
    } else if (needKey) return;
    if (down.queued() > behindLimit(lastKey)) {
      needKey = true;
      const now = Date.now();
      up.send(JSON.stringify(now - lastBehind < 3000 ? ["slow"] : ["key"]));
      lastBehind = now;
      return;
    }
    down.send(d);
  };
}
