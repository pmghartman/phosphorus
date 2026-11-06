// one direction of a socket-to-socket relay: Bun's write takes only what fits in
// the kernel's buffer and says how much, the rest kept here and sent on drain, the
// source paused meanwhile so a slow reader never has a whole download held in memory

import type { Socket } from "bun";

// what's waiting to go out on one socket
export type Out = { q: Uint8Array[]; ending: boolean; paused?: Socket<any> };

export const outbox = (): Out => ({ q: [], ending: false });

// chunk to `to`, what it didn't take kept in o and `from` paused until it drains
export function send(to: Socket<any>, o: Out, chunk: Uint8Array, from?: Socket<any>) {
  if (o.q.length === 0) {
    const n = to.write(chunk);
    // closed, or all of it taken
    if (n < 0 || n === chunk.length) return;
    chunk = chunk.subarray(n);
  }
  // a copy: the chunk is the caller's buffer
  o.q.push(new Uint8Array(chunk));
  if (from && !o.paused) {
    o.paused = from;
    from.pause();
  }
}

// on `to`'s drain: as much of what's kept as it takes, the source resumed once it's all out
export function flush(to: Socket<any>, o: Out) {
  while (o.q.length) {
    const c = o.q[0]!;
    const n = to.write(c);
    if (n < 0) {
      o.q = [];
      break;
    }
    if (n < c.length) {
      o.q[0] = c.subarray(n);
      return;
    }
    o.q.shift();
  }
  if (o.paused) {
    o.paused.resume();
    o.paused = undefined;
  }
  if (o.ending) to.end();
}

// `to` ended once what's kept for it is out, the far side having closed
export function finish(to: Socket<any>, o: Out) {
  if (o.q.length) o.ending = true;
  else to.end();
}
