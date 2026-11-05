// this machine as the host: commands spawned here, its loopback ports dialled; for tests

import type { Host, Pipe, Proc } from "./pipe.ts";

export function localHost(): Host {
  return {
    os: process.platform === "win32" ? "windows" : "linux",
    async run(cmd: string): Promise<Proc> {
      const argv = process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", `"${cmd}"`] : ["sh", "-c", cmd];
      const p = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsVerbatimArguments: true });
      const data: ((b: Uint8Array) => void)[] = [];
      const err: ((b: Uint8Array) => void)[] = [];
      const done: (() => void)[] = [];
      const pump = async (s: ReadableStream<Uint8Array>, to: ((b: Uint8Array) => void)[]) => {
        for await (const b of s) for (const f of to) f(b);
      };
      void Promise.all([pump(p.stdout, data), pump(p.stderr, err)]).finally(() => {
        for (const f of done) f();
      });
      return {
        write: (b) => {
          p.stdin.write(b);
          p.stdin.flush();
        },
        onData: (f) => void data.push(f),
        onErr: (f) => void err.push(f),
        onClose: (f) => void done.push(f),
        close: () => p.kill(),
      };
    },
    async connect(port: number): Promise<Pipe> {
      const data: ((b: Uint8Array) => void)[] = [];
      const done: (() => void)[] = [];
      const early: Uint8Array[] = [];
      const s = await Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          data: (_s, b) => {
            if (!data.length) early.push(new Uint8Array(b));
            for (const f of data) f(new Uint8Array(b));
          },
          close: () => {
            for (const f of done) f();
          },
          error: () => {
            for (const f of done) f();
          },
        },
      });
      s.setNoDelay(true);
      let pending: Uint8Array[] = [];
      const flush = () => {
        while (pending.length) {
          const b = pending[0]!;
          const n = s.write(b);
          if (n < b.length) {
            pending[0] = b.subarray(n);
            return;
          }
          pending.shift();
        }
      };
      return {
        write: (b) => {
          const u = typeof b === "string" ? new TextEncoder().encode(b) : b;
          if (pending.length) return void pending.push(u);
          const n = s.write(u);
          if (n < u.length) {
            pending.push(u.subarray(n));
            const t = setInterval(() => {
              flush();
              if (!pending.length) clearInterval(t);
            }, 1);
          }
        },
        onData: (f) => {
          data.push(f);
          for (const b of early.splice(0)) f(b);
        },
        onClose: (f) => void done.push(f),
        close: () => s.end(),
      };
    },
  };
}
