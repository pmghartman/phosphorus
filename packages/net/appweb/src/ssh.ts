// a host over the viewer's own ssh connection: commands as exec channels, the app's
// loopback ports through direct-tcpip; ssh2's client, typed only as far as used

import type { Host, Pipe, Proc } from "./pipe.ts";

type Stream = {
  write(d: Uint8Array | string): unknown;
  on(ev: "data", f: (b: Uint8Array) => void): unknown;
  on(ev: "close" | "error", f: () => void): unknown;
  end(): unknown;
  close?(): unknown;
  setNoDelay?(on: boolean): unknown;
};
type Channel = Stream & { stderr: { on(ev: "data", f: (b: Uint8Array) => void): unknown } };

export type SshClient = {
  exec(cmd: string, cb: (err: Error | undefined, ch: Channel) => void): unknown;
  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    cb: (err: Error | undefined, ch: Stream) => void,
  ): unknown;
};

function pipeOf(ch: Stream): Pipe {
  const data: ((b: Uint8Array) => void)[] = [];
  const done: (() => void)[] = [];
  const early: Uint8Array[] = [];
  let closed = false;
  ch.on("data", (b) => {
    if (!data.length) early.push(b);
    for (const f of data) f(b);
  });
  const end = () => {
    if (closed) return;
    closed = true;
    for (const f of done) f();
  };
  ch.on("close", end);
  ch.on("error", end);
  return {
    write: (b) => void ch.write(b),
    onData: (f) => {
      data.push(f);
      for (const b of early.splice(0)) f(b);
    },
    onClose: (f) => {
      if (closed) f();
      else done.push(f);
    },
    close: () => {
      try {
        ch.end();
        ch.close?.();
      } catch {}
    },
  };
}

export function sshHost(c: SshClient, os: "windows" | "linux"): Host {
  return {
    os,
    run: (cmd) =>
      new Promise<Proc>((ok, no) => {
        c.exec(cmd, (err, ch) => {
          if (err) return no(err);
          const err_: ((b: Uint8Array) => void)[] = [];
          ch.stderr.on("data", (b) => {
            for (const f of err_) f(b);
          });
          ok({ ...pipeOf(ch), onErr: (f) => void err_.push(f) });
        });
      }),
    connect: (port) =>
      new Promise<Pipe>((ok, no) => {
        c.forwardOut("127.0.0.1", 0, "127.0.0.1", port, (err, ch) => (err ? no(err) : ok(pipeOf(ch))));
      }),
  };
}
