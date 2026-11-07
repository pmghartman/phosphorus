// a question outside the zone passed whole to an upstream resolver over UDP,
// its answer handed back as it came
import type { udp } from "bun";

export type Forward = (q: Uint8Array) => Promise<Uint8Array | undefined>;

export function forwarder(servers: () => string[], timeoutMs = 3000): Forward {
  return async (q) => {
    for (const server of servers().slice(0, 3)) {
      const got = await exchange(server, q, timeoutMs).catch(() => undefined);
      if (got) return got;
    }
    return undefined;
  };
}

function exchange(server: string, q: Uint8Array, timeoutMs: number): Promise<Uint8Array | undefined> {
  const id = (q[0]! << 8) | q[1]!;
  return new Promise((res) => {
    let done = false;
    let sock: udp.Socket<"uint8array"> | undefined;
    const finish = (v: Uint8Array | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock?.close();
      res(v);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    Bun.udpSocket<"uint8array">({
      binaryType: "uint8array",
      socket: {
        data(_s, buf) {
          if (buf.length >= 2 && ((buf[0]! << 8) | buf[1]!) === id) finish(buf.slice());
        },
        error() {
          finish(undefined);
        },
      },
    })
      .then((s) => {
        sock = s;
        if (done) s.close();
        else s.send(q, 53, server);
      })
      .catch(() => finish(undefined));
  });
}
