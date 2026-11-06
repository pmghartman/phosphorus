import { expect, test } from "bun:test";
import type { Socket } from "bun";

// the package read once per test run: the same domain proxy.test.ts sets
process.env.BASE_DOMAIN = "mulab.dev";
const { forwardPorts, sniOf, split } = await import("@phosphorus/proxy");
const { splitClient } = await import("../src/edge.ts");

// a ClientHello naming server, as a browser's first bytes
function hello(server: string | undefined): Uint8Array {
  const name = new TextEncoder().encode(server ?? "");
  const sni =
    server === undefined
      ? []
      : [
          0,
          0,
          (name.length + 5) >> 8,
          (name.length + 5) & 0xff,
          (name.length + 3) >> 8,
          (name.length + 3) & 0xff,
          0,
          name.length >> 8,
          name.length & 0xff,
          ...name,
        ];
  const exts = [...sni, 0, 0x17, 0, 0];
  const body = [
    3,
    3,
    ...new Array(32).fill(7),
    0,
    0,
    2,
    0x13,
    0x01,
    1,
    0,
    exts.length >> 8,
    exts.length & 0xff,
    ...exts,
  ];
  const hs = [1, 0, body.length >> 8, body.length & 0xff, ...body];
  return new Uint8Array([0x16, 3, 1, hs.length >> 8, hs.length & 0xff, ...hs]);
}

test("the server name read from a ClientHello, in pieces, or not TLS at all", () => {
  const h = hello("App.Example.com");
  expect(sniOf(h)).toBe("app.example.com");
  expect(sniOf(h.subarray(0, 20))).toBeUndefined();
  expect(sniOf(hello(undefined))).toBe("");
  expect(sniOf(new TextEncoder().encode("GET / HTTP/1.1\r\n"))).toBeNull();
});

// an echo server tagging what it got, and the client address it saw through the splitter
function echo(tag: string) {
  let seen: { address: string; port: number } | undefined;
  const l = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(s, d) {
        seen = { address: s.remoteAddress, port: s.remotePort };
        s.write(new TextEncoder().encode(tag));
        s.write(d);
      },
    },
  });
  return { port: l.port, stop: () => l.stop(true), seen: () => seen };
}

async function through(port: number, bytes: Uint8Array): Promise<Uint8Array> {
  return new Promise((res, rej) => {
    const got: Uint8Array[] = [];
    let timer: ReturnType<typeof setTimeout>;
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(s) {
          s.write(bytes);
        },
        data(s, d) {
          got.push(new Uint8Array(d));
          clearTimeout(timer);
          timer = setTimeout(() => {
            s.end();
            res(new Uint8Array(got.flatMap((g) => [...g])));
          }, 100);
        },
        close() {},
        error(_s, e) {
          rej(e);
        },
        connectError(_s, e) {
          rej(e);
        },
      },
    });
  });
}

test("443 split by server name: the control's bytes to it, the rest to the ingress, the client remembered", async () => {
  const ingress = echo("I:");
  const control = echo("C:");
  const sp = split(0, "127.0.0.1");
  sp.setIngress(ingress.port);
  sp.setControl("Control.Example.com", control.port);
  try {
    const text = (b: Uint8Array) => new TextDecoder("latin1").decode(b);
    const a = await through(sp.port, hello("control.example.com"));
    expect(text(a).startsWith("C:\x16")).toBe(true);
    const b = await through(sp.port, hello("app.example.com"));
    expect(text(b).startsWith("I:\x16")).toBe(true);
    const c = await through(sp.port, new TextEncoder().encode("GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
    expect(text(c).startsWith("I:GET")).toBe(true);
    // the ingress saw the splitter on loopback; the client behind that port is known
    expect(ingress.seen()!.address).toBe("127.0.0.1");
    expect(splitClient(null)).toBe("");
    // a hello cut short arrives in two writes and still routes
    const h = hello("control.example.com");
    const d = await new Promise<string>((res) => {
      let got = "";
      Bun.connect({
        hostname: "127.0.0.1",
        port: sp.port,
        socket: {
          open(s) {
            s.write(h.subarray(0, 10));
            setTimeout(() => s.write(h.subarray(10)), 50);
          },
          data(s, d) {
            got += new TextDecoder("latin1").decode(d);
            if (got.length >= 2 + h.length) {
              s.end();
              res(got);
            }
          },
        },
      });
    });
    expect(d.startsWith("C:")).toBe(true);
  } finally {
    sp.stop();
    ingress.stop();
    control.stop();
  }
});

test("public ports: TCP and UDP carried to the service, a dropped spec closed", async () => {
  const svc = echo("S:");
  const udpSvc = await Bun.udpSocket<"uint8array">({
    hostname: "127.0.0.1",
    port: 0,
    binaryType: "uint8array",
    socket: {
      data(s, b, port, addr) {
        s.send(new TextEncoder().encode("U:" + new TextDecoder().decode(b)), port, addr);
      },
    },
  });
  // each protocol picks its own free port (Windows excludes ranges per protocol)
  const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const tcpPub = l.port;
  l.stop(true);
  const u = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0 });
  const udpPub = u.port;
  u.close();
  let fw = await forwardPorts(
    [
      { name: "a", proto: "tcp", pub: tcpPub, ip: "127.0.0.1", port: svc.port },
      { name: "b", proto: "udp", pub: udpPub, ip: "127.0.0.1", port: udpSvc.port },
    ],
    undefined,
    "127.0.0.1",
  );
  try {
    expect(fw.status()).toEqual({ [`tcp:${tcpPub}`]: "", [`udp:${udpPub}`]: "" });
    const got = await through(tcpPub, new TextEncoder().encode("hello"));
    expect(new TextDecoder().decode(got)).toBe("S:hello");
    const back = await new Promise<string>(async (res) => {
      const c = await Bun.udpSocket<"uint8array">({
        binaryType: "uint8array",
        socket: {
          data(s, b) {
            res(new TextDecoder().decode(b));
            s.close();
          },
        },
      });
      c.send("ping", udpPub, "127.0.0.1");
    });
    expect(back).toBe("U:ping");
    // the TCP port dropped: its listener gone, the UDP one kept
    fw = await forwardPorts(
      [{ name: "b", proto: "udp", pub: udpPub, ip: "127.0.0.1", port: udpSvc.port }],
      fw,
      "127.0.0.1",
    );
    expect(Object.keys(fw.status())).toEqual([`udp:${udpPub}`]);
    const closed = await through(tcpPub, new Uint8Array([1]))
      .then(() => false)
      .catch(() => true);
    expect(closed).toBe(true);
  } finally {
    fw.stop();
    svc.stop();
    udpSvc.close();
  }
});

// a server sending these bytes once anything arrives, minding its own backpressure
function bulk(big: Uint8Array) {
  // off -1: nothing asked yet, a drain before the request writing nothing
  const pump = (s: Socket<{ off: number }>) => {
    if (s.data.off < 0) return;
    while (s.data.off < big.length) {
      // a view, not write's byteOffset: Linux's Bun takes the whole buffer's length as the default byteLength
      const n = s.write(big.subarray(s.data.off));
      if (n <= 0) return;
      s.data.off += n;
    }
    s.end();
  };
  const l = Bun.listen<{ off: number }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        s.data = { off: -1 };
      },
      data(s) {
        if (s.data.off >= 0) return;
        s.data.off = 0;
        pump(s);
      },
      drain: pump,
    },
  });
  return { port: l.port, stop: () => l.stop(true) };
}

// everything a client reading nothing for its first moments gets, until the far side closes
function slowRead(port: number, first: Uint8Array): Promise<Uint8Array> {
  return new Promise((res, rej) => {
    const got: Uint8Array[] = [];
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(s) {
          s.write(first);
          s.pause();
          setTimeout(() => s.resume(), 300);
        },
        data(_s, d) {
          got.push(new Uint8Array(d));
        },
        close() {
          const out = new Uint8Array(got.reduce((n, g) => n + g.length, 0));
          let i = 0;
          for (const g of got) {
            out.set(g, i);
            i += g.length;
          }
          res(out);
        },
        error(_s, e) {
          rej(e);
        },
        connectError(_s, e) {
          rej(e);
        },
      },
    });
  });
}

test("a reply bigger than the kernel's buffers reaches a slow client whole, through 443 and a public port", async () => {
  const big = new Uint8Array(16 << 20);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 13)) & 0xff;
  const svc = bulk(big);
  const sp = split(0, "127.0.0.1");
  sp.setIngress(svc.port);
  const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const pub = l.port;
  l.stop(true);
  const fw = await forwardPorts(
    [{ name: "big", proto: "tcp", pub, ip: "127.0.0.1", port: svc.port }],
    undefined,
    "127.0.0.1",
  );
  try {
    const viaEdge = await slowRead(sp.port, new TextEncoder().encode("GET /big HTTP/1.1\r\n\r\n"));
    expect(viaEdge.length).toBe(big.length);
    expect(Bun.hash(viaEdge)).toBe(Bun.hash(big));
    const viaPort = await slowRead(pub, new TextEncoder().encode("go"));
    expect(viaPort.length).toBe(big.length);
    expect(Bun.hash(viaPort)).toBe(Bun.hash(big));
  } finally {
    fw.stop();
    sp.stop();
    svc.stop();
  }
}, 30_000);
