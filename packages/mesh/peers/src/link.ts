// one socket between two hosts: the lexically smaller name dials, the larger
// accepts; a hello each way first, then frames; a dropped socket dialled again
// with a growing wait

import { FrontendPort, now } from "@phosphorus/util";
import {
  PeerCloseDuplicate,
  PeerCloseWrongHost,
  type PeerFrame,
  type PeerHello,
  type PeerReq,
  type PeerRes,
} from "@phosphorus/wire";
import { type Conn, dial } from "@phosphorus/wsock";

const dialTimeoutMs = 5000;
const helloTimeoutMs = 5000;
const backoffMinMs = 1000;
const backoffMaxMs = 30_000;
const reqTimeoutMs = 10_000;

// a hello before the far side's name is known is refused with this
export const PeerCloseNoHello = 4000;

// what a link reports to the mesh
export type LinkEvents = {
  // this host's hello for the far side
  hello: () => PeerHello;
  // the far side's hello; false refuses the link
  onHello: (link: Link, hello: PeerHello) => boolean;
  // a frame after the hellos
  onFrame: (link: Link, frame: PeerFrame) => void;
  // a request's answer, or a throw for a refusal
  onReq: (link: Link, req: PeerReq) => Promise<unknown>;
  onUp: (link: Link) => void;
  onDown: (link: Link) => void;
  // a dial that failed, with why
  onDialError: (link: Link, why: string) => void;
};

// the one in-process-wide header a dialler names itself with
export const HostHeader = "x-phosphorus-host";

export class Link {
  conn?: Conn;
  // hellos exchanged, frames flowing
  up = false;
  // the far side's hello, while up
  hello?: PeerHello;
  // last time the link was up, 0 for never
  upAt = 0;
  private stopped = false;
  private dialling = false;
  private backoff = backoffMinMs;
  private wake: () => void = () => {};
  private reqId = 0;
  private pending = new Map<
    number,
    { ok: (v: unknown) => void; fail: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  // the store's head as last sent to the far side; -1 until its hello says
  sent = -1;
  // the far side's log head as last applied here
  cursor = -1;

  constructor(
    readonly host: string,
    public ip: string,
    private ev: LinkEvents,
  ) {}

  // the dialling side's loop: connect, serve the socket, wait, again
  startDialling() {
    if (this.dialling || this.stopped) return;
    this.dialling = true;
    void (async () => {
      while (!this.stopped) {
        try {
          const c = await dial(
            `ws://${this.ip}:${FrontendPort}/api/peer`,
            { [HostHeader]: this.ev.hello().host },
            dialTimeoutMs,
          );
          if (this.stopped) {
            c.terminate();
            return;
          }
          this.attach(c);
          await c.done();
        } catch (e) {
          this.ev.onDialError(this, (e as Error)?.message ?? String(e));
        }
        if (this.stopped) return;
        await new Promise<void>((r) => {
          this.wake = r;
          setTimeout(r, this.backoff * (0.8 + Math.random() * 0.4));
        });
        this.backoff = Math.min(backoffMaxMs, this.backoff * 2);
      }
      this.dialling = false;
    })();
  }

  // the dialling side told of a new address: the next dial goes there
  redial(ip: string) {
    if (ip === this.ip) return;
    this.ip = ip;
    this.conn?.terminate();
    this.wake();
  }

  // a socket for this link, either side; a second one while the first lives is refused
  attach(c: Conn): boolean {
    if (this.conn?.open()) {
      c.close(PeerCloseDuplicate);
      return false;
    }
    this.conn = c;
    let greeted = false;
    const helloTimer = setTimeout(() => {
      if (!greeted) c.close(PeerCloseNoHello);
    }, helloTimeoutMs);
    c.onMessage((d) => {
      let f: PeerFrame;
      try {
        f = JSON.parse(typeof d === "string" ? d : new TextDecoder().decode(d));
      } catch {
        return;
      }
      if (!f || typeof f !== "object" || typeof f.type !== "string") return;
      if (!greeted) {
        if (f.type !== "hello") return;
        clearTimeout(helloTimer);
        if (!this.ev.onHello(this, f)) {
          c.close(PeerCloseWrongHost);
          return;
        }
        greeted = true;
        this.hello = f;
        this.up = true;
        this.upAt = now();
        this.backoff = backoffMinMs;
        this.ev.onUp(this);
        return;
      }
      if (f.type === "res") {
        const p = this.pending.get(f.id);
        if (!p) return;
        this.pending.delete(f.id);
        clearTimeout(p.timer);
        if (f.ok) p.ok(f.body);
        else p.fail(new Error(typeof f.body === "string" ? f.body : "refused"));
        return;
      }
      if (f.type === "req") {
        this.ev
          .onReq(this, f)
          .then((body) => this.send({ type: "res", id: f.id, ok: true, body }))
          .catch((e) => this.send({ type: "res", id: f.id, ok: false, body: (e as Error)?.message ?? String(e) }));
        return;
      }
      this.ev.onFrame(this, f);
    });
    c.onClose(() => {
      clearTimeout(helloTimer);
      if (this.conn !== c) return;
      this.conn = undefined;
      const was = this.up;
      if (!was) this.ev.onDialError(this, `closed with code ${c.code} before the hellos`);
      this.up = false;
      this.hello = undefined;
      this.sent = -1;
      this.cursor = -1;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.fail(new Error("link closed"));
        this.pending.delete(id);
      }
      if (was) this.ev.onDown(this);
    });
    c.json(this.ev.hello());
    return true;
  }

  // a frame to the far side, false when the link is down
  send(f: PeerFrame): boolean {
    return !!this.conn?.open() && this.conn.json(f);
  }

  // a request answered by the far side
  request(op: string, body?: unknown, timeoutMs = reqTimeoutMs): Promise<unknown> {
    return new Promise((ok, fail) => {
      if (!this.up || !this.conn?.open()) return fail(new Error("link down"));
      const id = ++this.reqId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`${op} timed out`));
      }, timeoutMs);
      this.pending.set(id, { ok, fail, timer });
      if (!this.send({ type: "req", id, op, body })) {
        this.pending.delete(id);
        clearTimeout(timer);
        fail(new Error("link down"));
      }
    });
  }

  // the socket dropped; a dialling side dials again at once
  drop() {
    this.conn?.terminate();
    this.backoff = backoffMinMs;
    this.wake();
  }

  // the link ended for good
  stop() {
    this.stopped = true;
    this.conn?.close(1000);
    this.wake();
  }
}
