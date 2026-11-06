// questions asked of one server: UDP first, TCP when the answer was cut

import type { udp } from "bun";
import { type Parsed, parseReply, writeQuery } from "./wire.ts";

export type Ask = { server: string; port?: number; name: string; type: number; rd?: boolean; timeoutMs?: number };

const nextID = () => Math.floor(Math.random() * 65536);

async function udp(a: Ask, id: number): Promise<Parsed> {
  const q = writeQuery(id, a.name, a.type, a.rd);
  return new Promise<Parsed>((res, rej) => {
    let done = false;
    const finish = (f: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s?.close();
      f();
    };
    let s: udp.Socket<"uint8array"> | undefined;
    const timer = setTimeout(
      () => finish(() => rej(new Error(`${a.server}: no answer in ${a.timeoutMs ?? 3000}ms`))),
      a.timeoutMs ?? 3000,
    );
    Bun.udpSocket<"uint8array">({
      binaryType: "uint8array",
      socket: {
        data(_s, buf) {
          try {
            const p = parseReply(buf);
            if (p.id !== id) return;
            finish(() => res(p));
          } catch (e) {
            finish(() => rej(e));
          }
        },
        error(_s, e) {
          finish(() => rej(e));
        },
      },
    })
      .then((sock) => {
        s = sock;
        if (done) sock.close();
        else sock.send(q, a.port ?? 53, a.server);
      })
      .catch((e) => finish(() => rej(e)));
  });
}

async function tcp(a: Ask, id: number): Promise<Parsed> {
  const q = writeQuery(id, a.name, a.type, a.rd);
  const framed = new Uint8Array(2 + q.length);
  framed[0] = q.length >> 8;
  framed[1] = q.length & 0xff;
  framed.set(q, 2);
  return new Promise<Parsed>((res, rej) => {
    let buf = new Uint8Array(0);
    let done = false;
    const finish = (f: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      f();
    };
    const timer = setTimeout(
      () => finish(() => rej(new Error(`${a.server}: no answer in ${a.timeoutMs ?? 3000}ms`))),
      a.timeoutMs ?? 3000,
    );
    Bun.connect({
      hostname: a.server,
      port: a.port ?? 53,
      socket: {
        open(s) {
          s.write(framed);
        },
        data(s, chunk) {
          const j = new Uint8Array(buf.length + chunk.length);
          j.set(buf);
          j.set(chunk, buf.length);
          buf = j;
          if (buf.length < 2) return;
          const n = (buf[0]! << 8) | buf[1]!;
          if (buf.length < 2 + n) return;
          try {
            finish(() => res(parseReply(buf.slice(2, 2 + n))));
          } catch (e) {
            finish(() => rej(e));
          }
          s.end();
        },
        close() {
          finish(() => rej(new Error(`${a.server}: closed before answering`)));
        },
        error(_s, e) {
          finish(() => rej(e));
        },
        connectError(_s, e) {
          finish(() => rej(e));
        },
      },
    }).catch((e) => finish(() => rej(e)));
  });
}

// one question answered, over TCP when UDP's reply was truncated
export async function query(a: Ask): Promise<Parsed> {
  const id = nextID();
  const p = await udp(a, id);
  return p.tc ? tcp(a, id) : p;
}
