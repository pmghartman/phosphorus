// commands on this machine, as a runner: the tests', and a host streaming to itself
// without ssh

import type { Chan, Runner } from "./session.ts";

export const localRunner: Runner = {
  async run(cmd) {
    const p = Bun.spawn(["sh", "-c", cmd], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    const closers: (() => void)[] = [];
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      for (const f of closers) f();
    };
    void p.exited.then(done);
    const datas: ((b: Uint8Array) => void)[] = [];
    void (async () => {
      for await (const c of p.stdout) for (const f of datas) f(c);
      done();
    })();
    const ch: Chan = {
      write: (d) => {
        try {
          p.stdin.write(d);
          p.stdin.flush();
        } catch {}
      },
      onData: (f) => void datas.push(f),
      onClose: (f) => (closed ? f() : void closers.push(f)),
      close: () => {
        try {
          p.stdin.end();
        } catch {}
        p.kill();
      },
    };
    return ch;
  },
  async output(cmd) {
    const p = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "ignore" });
    return await new Response(p.stdout).text();
  },
};
