// a stream relayed from the phosphorus that runs the app to the one the viewer is
// on: messages passed through untouched, except that when the viewer's socket is
// behind, frames are dropped here until a keyframe (asked for upstream at once)
// rather than queued, and a lower rate asked for when that keeps happening. The
// session upstream only sees the hop's socket, never the viewer's

import { MsgFrame } from "./session.ts";

export type End = {
  send(d: string | Uint8Array): void;
  queued(): number;
};

const behindBytes = 96 * 1024;

// what to do with one message from upstream: pass it on, or drop it (and ask)
export function relayFrames(down: End, up: End) {
  let needKey = false;
  let lastBehind = 0;
  return (d: string | Uint8Array, bin: boolean) => {
    if (!bin || typeof d === "string") return down.send(d);
    if (d[0] !== MsgFrame) return down.send(d);
    const key = d[1] === 1;
    if (key) needKey = false;
    else if (needKey) return;
    if (down.queued() > behindBytes) {
      needKey = true;
      const now = Date.now();
      up.send(JSON.stringify(now - lastBehind < 3000 ? ["slow"] : ["key"]));
      lastBehind = now;
      return;
    }
    down.send(d);
  };
}
