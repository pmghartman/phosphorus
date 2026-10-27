// one websocket, accepted or dialled, with a heartbeat and Node ws's close codes;
// and the request context every handler is given: the socket's address, whether
// the ingress handed it over, the server to upgrade on
import type { Server, ServerWebSocket } from "bun";

// a socket not answering pings dropped
export const HeartbeatMs = 3000;
// a peer's queued bytes past which it's dropped, as a full write queue was
const maxQueued = 64 << 20;

type Msg = (data: string | Uint8Array, binary: boolean) => void;

// one socket, either side
export class Conn {
  private onMsg: Msg[] = [];
  private onCloseFns: (() => void)[] = [];
  private closed = false;
  private closing = false;
  private pending: [string | Uint8Array, boolean][] = [];
  code = 1005;
  // the subprotocol the far side picked, a dialled socket's
  protocol = () => "";
  private pongAt = Date.now();
  private beat?: ReturnType<typeof setInterval>;

  constructor(
    private sendRaw: (d: string | Uint8Array) => number | void,
    private closeRaw: (code?: number) => void,
    private terminateRaw: () => void,
    private bufferedRaw: () => number,
    private pingRaw?: () => void,
  ) {}

  // while it can still send
  open() {
    return !this.closing && !this.closed;
  }

  private send(d: string | Uint8Array): boolean {
    if (!this.open()) return false;
    if (this.bufferedRaw() > maxQueued) {
      this.terminate();
      return false;
    }
    this.sendRaw(d);
    return true;
  }
  text = (s: string) => this.send(s);
  binary = (b: Uint8Array) => this.send(b);
  json = (v: unknown) => this.send(JSON.stringify(v));

  // each message, binary true for a binary frame; ones that came before a
  // listener was set handed to the first
  onMessage(fn: Msg) {
    this.onMsg.push(fn);
    const p = this.pending;
    this.pending = [];
    for (const [d, b] of p) fn(d, b);
  }
  // run once when the socket goes, in order
  onClose(fn: () => void) {
    if (this.closed) fn();
    else this.onCloseFns.push(fn);
  }

  // the socket's own events, from Bun or a dialled WebSocket
  _message(d: string | Uint8Array, binary: boolean) {
    if (!this.onMsg.length) this.pending.push([d, binary]);
    for (const fn of this.onMsg) fn(d, binary);
  }
  _pong() {
    this.pongAt = Date.now();
  }
  _closed(code: number) {
    if (this.closed) return;
    this.closed = this.closing = true;
    this.code = code || 1005;
    clearInterval(this.beat);
    for (const fn of this.onCloseFns) {
      try {
        fn();
      } catch {}
    }
  }

  // closed with a code, queued frames flushed first
  close(code = 1000) {
    if (this.closing) return;
    this.closing = true;
    this.closeRaw(code);
  }
  // dropped at once
  terminate() {
    this.closing = true;
    this.terminateRaw();
    this._closed(1006);
  }
  // bytes waiting to go out, a long replay paced by it
  queued() {
    return this.bufferedRaw();
  }
  // a promise settled once the socket is gone
  done(): Promise<void> {
    return new Promise((r) => this.onClose(r));
  }

  // pings every HeartbeatMs, a socket that never answers dropped
  keepAlive() {
    if (!this.pingRaw || this.beat) return;
    this.pongAt = Date.now();
    this.beat = setInterval(() => {
      if (Date.now() - this.pongAt > 2 * HeartbeatMs) return this.terminate();
      this.pingRaw!();
    }, HeartbeatMs);
  }
}

// what a server socket carries: its Conn, and what to do once it opens
export type WSData = { conn?: Conn; ready: (c: Conn) => void; headers?: Record<string, string> };

// Bun.serve's websocket handlers, every socket's events onto its Conn
export const websocket = {
  maxPayloadLength: 32 << 20,
  idleTimeout: 0,
  sendPings: false,
  perMessageDeflate: false,
  open(ws: ServerWebSocket<WSData>) {
    const c = new Conn(
      (d) => ws.send(d as any),
      (code) => ws.close(code),
      () => ws.terminate(),
      () => ws.getBufferedAmount(),
      () => ws.ping(),
    );
    ws.data.conn = c;
    ws.data.ready(c);
  },
  message(ws: ServerWebSocket<WSData>, m: string | Buffer) {
    ws.data.conn?._message(typeof m === "string" ? m : new Uint8Array(m), typeof m !== "string");
  },
  pong(ws: ServerWebSocket<WSData>) {
    ws.data.conn?._pong();
  },
  close(ws: ServerWebSocket<WSData>, code: number) {
    ws.data.conn?._closed(code);
  },
};

// a peer's socket, the handshake capped at timeoutMs
export function dial(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 10_000,
  protocols?: string[],
  tls?: { rejectUnauthorized?: boolean },
): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, protocols: protocols?.length ? protocols : undefined, tls } as any);
    ws.binaryType = "arraybuffer";
    const c = new Conn(
      (d) => ws.send(d as string | Uint8Array<ArrayBuffer>),
      (code) => ws.close(code),
      () => (ws as any).terminate?.() ?? ws.close(),
      () => ws.bufferedAmount,
      () => (ws as any).ping?.(),
    );
    c.protocol = () => ws.protocol;
    const t = setTimeout(() => {
      ws.close();
      reject(new Error("timed out"));
    }, timeoutMs);
    ws.onopen = () => {
      clearTimeout(t);
      resolve(c);
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error("couldn't connect"));
    };
    ws.onmessage = (e) => c._message(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer), typeof e.data !== "string");
    ws.addEventListener("pong", () => c._pong());
    ws.onclose = (e) => {
      clearTimeout(t);
      c._closed(e.code);
    };
  });
}

// one request's context: the socket's address, the ingress's mark, the server
export type Ctx = {
  req: Request;
  url: URL;
  // the socket's address, ::ffff: dropped
  ip: string;
  // a request the ingress handed the frontend
  ingress: boolean;
  server: Server<WSData>;
};

// the frontend's handlers: a response, or undefined once upgraded
export type Handler = (c: Ctx) => Response | undefined | Promise<Response | undefined>;

// the request upgraded, ready run with its Conn once it opens; false when it wasn't an upgrade
export function upgrade(c: Ctx, ready: (conn: Conn) => void, headers?: Record<string, string>): boolean {
  return c.server.upgrade(c.req, { data: { ready }, headers });
}

// an Upgrade request, as Node's 'upgrade' event
export function isUpgrade(req: Request): boolean {
  return !!req.headers.get("upgrade") && headerHas(req.headers, "connection", "upgrade");
}

export const headerHas = (h: Headers, k: string, token: string) =>
  (h.get(k) ?? "").split(",").some((t) => t.trim().toLowerCase() === token);

export const remoteIP = (server: Server<any>, req: Request) => (server.requestIP(req)?.address ?? "").replace(/^::ffff:/, "");
