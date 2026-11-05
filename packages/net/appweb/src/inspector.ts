// the app's main process taken while it waits at its first line (--inspect-brk): the hook
// evaluated over the inspector's websocket, the app let go, the inspector shut once the
// hook's own link is up. A minimal websocket client over any pipe, text frames only

import { randomBytes } from "node:crypto";
import codecSrc from "./inject/codec.js" with { type: "text" };
import hookSrc from "./inject/hook.js" with { type: "text" };
import opsSrc from "./inject/ops.js" with { type: "text" };
import type { Pipe } from "./pipe.ts";

export class Socket {
  private buf = new Uint8Array(0);
  private open = false;
  private onMsg: ((s: string) => void)[] = [];
  private parts: Uint8Array[] = [];
  closed = false;

  constructor(private p: Pipe) {}

  async handshake(path: string, host: string, ms = 10_000): Promise<void> {
    const key = randomBytes(16).toString("base64");
    const head = await new Promise<string>((ok, no) => {
      const t = setTimeout(() => no(new Error("the app's inspector didn't answer")), ms);
      let got = "";
      this.p.onClose(() => {
        this.closed = true;
        if (!this.open) no(new Error("the app's inspector closed"));
      });
      this.p.onData((b) => {
        if (this.open) return this.feed(b);
        got += Buffer.from(b).toString("latin1");
        const i = got.indexOf("\r\n\r\n");
        if (i < 0) return;
        clearTimeout(t);
        this.open = true;
        const rest = Buffer.from(got.slice(i + 4), "latin1");
        ok(got.slice(0, i));
        if (rest.length) this.feed(new Uint8Array(rest));
      });
      this.p.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    if (!/^HTTP\/1\.1 101/.test(head)) throw new Error(`the app's inspector refused: ${head.split("\r\n")[0]}`);
  }

  message(f: (s: string) => void) {
    this.onMsg.push(f);
  }

  private feed(b: Uint8Array) {
    const all = new Uint8Array(this.buf.length + b.length);
    all.set(this.buf);
    all.set(b, this.buf.length);
    let at = 0;
    for (;;) {
      if (all.length - at < 2) break;
      const b0 = all[at]!;
      const b1 = all[at + 1]!;
      let len = b1 & 0x7f;
      let h = 2;
      if (len === 126) {
        if (all.length - at < 4) break;
        len = (all[at + 2]! << 8) | all[at + 3]!;
        h = 4;
      } else if (len === 127) {
        if (all.length - at < 10) break;
        len = Number(new DataView(all.buffer, all.byteOffset + at + 2, 8).getBigUint64(0));
        h = 10;
      }
      if (all.length - at < h + len) break;
      const data = all.subarray(at + h, at + h + len);
      at += h + len;
      const op = b0 & 0x0f;
      if (op === 8) {
        this.close();
        break;
      }
      if (op === 9) {
        this.frame(10, data);
        continue;
      }
      if (op === 1 || op === 0 || op === 2) {
        this.parts.push(data.slice());
        if (b0 & 0x80) {
          const s = Buffer.concat(this.parts).toString("utf8");
          this.parts = [];
          for (const f of this.onMsg) f(s);
        }
      }
    }
    this.buf = all.slice(at);
  }

  private frame(op: number, data: Uint8Array) {
    const len = data.length;
    const h = len < 126 ? 2 : len < 65536 ? 4 : 10;
    const out = new Uint8Array(h + 4 + len);
    out[0] = 0x80 | op;
    if (h === 2) out[1] = 0x80 | len;
    else if (h === 4) {
      out[1] = 0x80 | 126;
      out[2] = len >> 8;
      out[3] = len & 0xff;
    } else {
      out[1] = 0x80 | 127;
      new DataView(out.buffer).setBigUint64(2, BigInt(len));
    }
    const mask = randomBytes(4);
    out.set(mask, h);
    for (let i = 0; i < len; i++) out[h + 4 + i] = data[i]! ^ mask[i & 3]!;
    this.p.write(out);
  }

  send(s: string) {
    this.frame(1, new Uint8Array(Buffer.from(s, "utf8")));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.p.close();
    } catch {}
  }
}

// the inspector's own line on stderr: where it listens
export const inspectorOf = (line: string) => {
  const m = /Debugger listening on ws:\/\/([\d.]+):(\d+)(\/[\w-]+)/.exec(line);
  return m ? { host: m[1]!, port: Number(m[2]), path: m[3]! } : undefined;
};

type Rpc = { call(method: string, params?: Record<string, unknown>): Promise<any>; events: (m: any) => void };

function rpc(ws: Socket): Rpc {
  let n = 0;
  const waiting = new Map<number, [(v: any) => void, (e: Error) => void]>();
  const r: Rpc = {
    events: () => {},
    call(method, params = {}) {
      const id = ++n;
      return new Promise((ok, no) => {
        waiting.set(id, [ok, no]);
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
  };
  ws.message((s) => {
    const m = JSON.parse(s);
    if (typeof m.id === "number") {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.error) w[1](new Error(m.error.message || "inspector error"));
      else w[0](m.result);
    } else r.events(m);
  });
  return r;
}

export type Hooked = { port: number; pid: number; token: string };

// the expression the inspector runs: the hook installed, its listening port parked for the second ask
export function hookExpr(token: string, lingerMs: number): string {
  const cfg = JSON.stringify({ token, lingerMs });
  return `(() => {
  const req = typeof require === "function" ? require
    : process.getBuiltinModule ? process.getBuiltinModule("module").createRequire(process.execPath)
    : process.mainModule.require.bind(process.mainModule);
  ${codecSrc}
  ${opsSrc}
  ${hookSrc}
  globalThis.__phosHook = phosHook(req, ${cfg}, phosCodec, phosOps);
  return true;
})()`;
}

// the hook put in while the app waits, then the app let go
export async function inject(p: Pipe, at: { host: string; port: number; path: string }, lingerMs = 120_000) {
  const ws = new Socket(p);
  await ws.handshake(at.path, `${at.host}:${at.port}`);
  const r = rpc(ws);
  const paused = new Promise<void>((ok) => {
    r.events = (m) => {
      if (m.method === "Debugger.paused") ok();
    };
  });
  await r.call("Runtime.enable");
  await r.call("Debugger.enable");
  await r.call("Runtime.runIfWaitingForDebugger");
  await Promise.race([paused, Bun.sleep(5000)]);
  const token = randomBytes(32).toString("hex");
  const first = await r.call("Runtime.evaluate", {
    expression: hookExpr(token, lingerMs),
    includeCommandLineAPI: true,
    returnByValue: true,
  });
  if (first.exceptionDetails)
    throw new Error(`the hook failed in the app: ${first.exceptionDetails.exception?.description ?? first.exceptionDetails.text}`);
  await r.call("Debugger.resume");
  await r.call("Debugger.disable").catch(() => {});
  const second = await r.call("Runtime.evaluate", {
    expression: "globalThis.__phosHook",
    awaitPromise: true,
    returnByValue: true,
  });
  if (second.exceptionDetails)
    throw new Error(`the hook's link failed: ${second.exceptionDetails.exception?.description ?? "unknown"}`);
  // nobody else to come in after us
  await r
    .call("Runtime.evaluate", {
      expression: `setTimeout(() => { try { (typeof require === "function" ? require : process.getBuiltinModule ? process.getBuiltinModule("module").createRequire(process.execPath) : process.mainModule.require.bind(process.mainModule))("inspector").close(); } catch {} }, 300); delete globalThis.__phosHook; 1`,
      includeCommandLineAPI: true,
    })
    .catch(() => {});
  ws.close();
  const v = second.result?.value ?? {};
  return { port: Number(v.port), pid: Number(v.pid), token } satisfies Hooked;
}
