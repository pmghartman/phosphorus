// a layer 3 tunnel device on each OS: raw IPv4 and IPv6 packets in and out,
// read on a worker so nothing blocks; linux phos0, windows wintun, macOS utunN
import { MESH_PREFIX, MTU, type Setup, WG_PORT } from "./layout.ts";
import { startReader } from "./reader.ts";
import type { Device } from "./run.ts";

export * from "./layout.ts";

export type TunOptions = {
  ip: string;
  // linux phos0, windows Phosphorus; macOS takes the next utunN whatever this says
  name?: string;
  prefix?: string;
  mtu?: number;
  // windows: the port the firewall lets WireGuard in on, and where wintun.dll is
  port?: number;
  dll?: string;
  // each packet handed here as it comes, in place of read()
  onPacket?: (pkt: Uint8Array) => void;
  onError?: (e: Error) => void;
};

// the packet I/O a WireGuard device runs over; a fake one stands in for tests
export type PacketIO = {
  read(): Promise<Uint8Array>;
  write(pkt: Uint8Array): boolean;
  close(): Promise<void>;
};

export type Tun = PacketIO & { name: string };

// packets held for read() past this are dropped, the reader too far behind
const QUEUE = 4096;

const defaultName = () =>
  process.platform === "win32" ? "Phosphorus" : process.platform === "darwin" ? "utun" : "phos0";

// the device made and configured; root or admin needed
export async function open(o: TunOptions): Promise<Tun> {
  const s: Setup = { name: o.name ?? defaultName(), ip: o.ip, prefix: o.prefix ?? MESH_PREFIX, mtu: o.mtu ?? MTU };
  let dev: Device;
  if (process.platform === "linux") dev = await (await import("./unix.ts")).openLinux(s);
  else if (process.platform === "darwin") dev = await (await import("./unix.ts")).openDarwin(s);
  else if (process.platform === "win32")
    dev = await (await import("./windows.ts")).openWindows({
      ...s,
      dll: o.dll ?? "wintun.dll",
      port: o.port ?? WG_PORT,
    });
  else throw new Error(`no tunnel device on ${process.platform}`);
  return wrap(dev, o);
}

// a device behind the queue and the reader worker
function wrap(dev: Device, o: Pick<TunOptions, "onPacket" | "onError"> = {}): Tun {
  const queue: Uint8Array[] = [];
  const waiting: { ok: (p: Uint8Array) => void; no: (e: Error) => void }[] = [];
  let failure: Error | undefined;
  let closing: Promise<void> | undefined;
  const fail = (e: Error) => {
    failure ??= e;
    for (const w of waiting.splice(0)) w.no(failure);
  };
  const reader = startReader(
    dev.reader,
    (b) => {
      if (closing) return;
      const p = dev.unwrap(b);
      if (o.onPacket) return o.onPacket(p);
      const w = waiting.shift();
      if (w) w.ok(p);
      else if (queue.length < QUEUE) queue.push(p);
    },
    (e) => {
      fail(e);
      o.onError?.(e);
    },
  );
  return {
    name: dev.name,
    read() {
      const p = queue.shift();
      if (p) return Promise.resolve(p);
      if (failure) return Promise.reject(failure);
      return new Promise((ok, no) => waiting.push({ ok, no }));
    },
    write(pkt) {
      if (closing || failure || !pkt.length) return false;
      return dev.write(pkt);
    },
    close() {
      closing ??= reader.stop().then(() => {
        dev.close();
        queue.length = 0;
        fail(new Error("the tunnel is closed"));
      });
      return closing;
    },
  };
}
