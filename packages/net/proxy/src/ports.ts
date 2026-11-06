// public ports on an edge host: a TCP or UDP port open to the internet, every
// connection carried over the tailnet to the service's own port on its host

import type { Socket, TCPSocketListener, udp } from "bun";
import { finish, flush, type Out, outbox, send } from "./pipe.ts";

export type PortSpec = { name: string; proto: "tcp" | "udp"; pub: number; ip: string; port: number };

export type Forwarded = {
  // "" when the port is open, else why it isn't, by `${proto}:${pub}`
  status(): Record<string, string>;
  stop(): void;
};

// out: what's waiting to be written to this side
type Pipe = { peer?: Socket<Pipe>; head: Uint8Array[]; out: Out };

const keyOf = (s: PortSpec) => `${s.proto}:${s.pub}`;
const same = (a: PortSpec, b: PortSpec) => a.ip === b.ip && a.port === b.port && a.name === b.name;

const udpIdleMs = 120_000;

type Open = { spec: PortSpec; close(): void };

function tcp(spec: PortSpec, hostname?: string): Open {
  const l: TCPSocketListener<Pipe> = Bun.listen<Pipe>({
    hostname: hostname ?? "0.0.0.0",
    port: spec.pub,
    socket: {
      open(down) {
        down.data = { head: [], out: outbox() };
        Bun.connect<Pipe>({
          hostname: spec.ip,
          port: spec.port,
          socket: {
            open(up) {
              up.data = { peer: down, head: [], out: outbox() };
              down.data.peer = up;
              for (const h of down.data.head) send(up, up.data.out, h, down);
              down.data.head = [];
            },
            data(up, chunk) {
              send(down, down.data.out, chunk, up);
            },
            close() {
              finish(down, down.data.out);
            },
            error() {
              finish(down, down.data.out);
            },
            connectError() {
              down.end();
            },
            drain(up) {
              flush(up, up.data.out);
            },
          },
        }).catch(() => down.end());
      },
      data(down, chunk) {
        const up = down.data.peer;
        if (up) send(up, up.data.out, chunk, down);
        // a copy: the chunk is Bun's buffer, held until the service answers
        else down.data.head.push(new Uint8Array(chunk));
      },
      close(down) {
        const up = down.data?.peer;
        if (up) finish(up, up.data.out);
      },
      error(down) {
        const up = down.data?.peer;
        if (up) finish(up, up.data.out);
      },
      drain(down) {
        flush(down, down.data.out);
      },
    },
  });
  return { spec, close: () => l.stop(true) };
}

type Flow = { sock: udp.ConnectedSocket<"uint8array">; at: number };

async function udpOpen(spec: PortSpec, hostname?: string): Promise<Open> {
  const flows = new Map<string, Flow>();
  const outer = await Bun.udpSocket<"uint8array">({
    hostname: hostname ?? "0.0.0.0",
    port: spec.pub,
    binaryType: "uint8array",
    socket: {
      async data(s, buf, port, addr) {
        const k = `${addr}:${port}`;
        let f = flows.get(k);
        if (!f) {
          // one connected socket per client, its answers sent back to that client
          const sock = await Bun.udpSocket<"uint8array">({
            binaryType: "uint8array",
            connect: { hostname: spec.ip, port: spec.port },
            socket: {
              data(_c, back) {
                s.send(back, port, addr);
                const cur = flows.get(k);
                if (cur) cur.at = Date.now();
              },
              error() {},
            },
          });
          f = { sock, at: Date.now() };
          flows.set(k, f);
        }
        f.at = Date.now();
        f.sock.send(buf);
      },
      error() {},
    },
  });
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, f] of flows)
      if (now - f.at > udpIdleMs) {
        f.sock.close();
        flows.delete(k);
      }
  }, 30_000);
  return {
    spec,
    close() {
      clearInterval(sweep);
      for (const f of flows.values()) f.sock.close();
      flows.clear();
      outer.close();
    },
  };
}

// the given ports opened, ones no longer asked for closed, a changed one reopened;
// hostname for tests, all interfaces otherwise
export async function forwardPorts(
  specs: PortSpec[],
  prev?: Forwarded & { opens?: Map<string, Open> },
  hostname?: string,
) {
  const opens = prev?.opens ?? new Map<string, Open>();
  const errs = new Map<string, string>();
  const want = new Map(specs.map((s) => [keyOf(s), s]));
  for (const [k, o] of opens)
    if (!want.has(k) || !same(want.get(k)!, o.spec)) {
      o.close();
      opens.delete(k);
    }
  for (const [k, s] of want) {
    if (opens.has(k)) continue;
    try {
      opens.set(k, s.proto === "tcp" ? tcp(s, hostname) : await udpOpen(s, hostname));
    } catch (e) {
      errs.set(k, (e as Error).message);
    }
  }
  const out: Forwarded & { opens: Map<string, Open> } = {
    opens,
    status: () => Object.fromEntries([...want.keys()].map((k) => [k, errs.get(k) ?? ""])),
    stop() {
      for (const o of opens.values()) o.close();
      opens.clear();
    },
  };
  return out;
}
