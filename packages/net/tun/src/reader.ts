// the blocking reads, in a worker of their own from an inline Blob so the build
// needs no entry point; packets come back in batches, their buffers moved

// unix: poll the fd a fifth of a second at a time, the gate saying when to stop;
// windows: wintun's ring drained, its read event waited on between
const READER = `import { dlopen, ptr, toArrayBuffer } from "bun:ffi";
const BATCH = 64;
function unix(m, gate, send) {
  const c = dlopen(m.lib, {
    poll: { args: ["ptr", "u64", "i32"], returns: "i32" },
    read: { args: ["i32", "ptr", "u64"], returns: "i64" },
  }).symbols;
  const p = new Uint8Array(8);
  const v = new DataView(p.buffer);
  v.setInt32(0, m.fd, true);
  v.setInt16(4, 1, true);
  const buf = new Uint8Array(65536);
  const bp = ptr(buf);
  while (!Atomics.load(gate, 0)) {
    const out = [];
    let wait = 200;
    while (out.length < BATCH) {
      v.setInt16(6, 0, true);
      if (c.poll(p, 1, wait) <= 0) break;
      if (v.getInt16(6, true) & 0x38) throw new Error("the tunnel device went away");
      const n = Number(c.read(m.fd, bp, buf.length));
      if (n <= 0) break;
      out.push(buf.slice(0, n).buffer);
      wait = 0;
    }
    if (out.length) send(out);
  }
}
function windows(m, gate, send) {
  const w = dlopen(m.lib, {
    WintunReceivePacket: { args: ["ptr", "ptr"], returns: "ptr" },
    WintunReleaseReceivePacket: { args: ["ptr", "ptr"], returns: "void" },
  }).symbols;
  const k = dlopen("kernel32.dll", {
    WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
    GetLastError: { args: [], returns: "u32" },
  }).symbols;
  const size = new Uint32Array(1);
  while (!Atomics.load(gate, 0)) {
    const out = [];
    while (out.length < BATCH) {
      const p = w.WintunReceivePacket(m.session, size);
      if (!p) {
        if (k.GetLastError() === 38) throw new Error("the wintun adapter went away");
        break;
      }
      out.push(new Uint8Array(toArrayBuffer(p, 0, size[0])).slice().buffer);
      w.WintunReleaseReceivePacket(m.session, p);
    }
    if (out.length) send(out);
    else k.WaitForSingleObject(m.event, 200);
  }
}
self.onmessage = (e) => {
  const m = e.data;
  const gate = new Int32Array(m.sab);
  try {
    (m.os === "win32" ? windows : unix)(m, gate, (out) => postMessage(out, out));
    postMessage("done");
  } catch (err) {
    postMessage({ error: String(err && err.message ? err.message : err) });
  }
};`;

export type ReaderInit =
  | { os: "unix"; lib: string; fd: number }
  | { os: "win32"; lib: string; session: number; event: number };

export type Reader = { stop(): Promise<void> };

// a reader on its worker, each packet to onPacket, a failure to onError once
export function startReader(init: ReaderInit, onPacket: (b: Uint8Array) => void, onError: (e: Error) => void): Reader {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const w = new Worker(URL.createObjectURL(new Blob([READER], { type: "application/javascript" })));
  let finished: () => void = () => {};
  const done = new Promise<void>((r) => (finished = r));
  let over = false;
  const end = () => {
    if (over) return;
    over = true;
    finished();
    w.terminate();
  };
  w.onmessage = (e: MessageEvent) => {
    const d = e.data;
    if (Array.isArray(d)) {
      for (const b of d as ArrayBuffer[]) onPacket(new Uint8Array(b));
      return;
    }
    const failed = d !== "done" && !Atomics.load(gate, 0);
    end();
    if (failed) onError(new Error(d?.error ?? "the tunnel reader stopped"));
  };
  w.onerror = (e: ErrorEvent) => {
    const failed = !Atomics.load(gate, 0);
    end();
    if (failed) onError(new Error(e.message || "the tunnel reader failed"));
  };
  w.postMessage({ ...init, sab: gate.buffer });
  return {
    stop() {
      Atomics.store(gate, 0, 1);
      // a poll or wait ends within 200ms; past a second the worker is just ended
      const t = setTimeout(end, 1000);
      return done.finally(() => clearTimeout(t));
    },
  };
}
