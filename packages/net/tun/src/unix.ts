// linux's /dev/net/tun and macOS's utun control socket, over libc
import { dlopen, FFIType } from "bun:ffi";
import { constants, openSync } from "node:fs";
import {
  addAF,
  CTLIOCGINFO,
  cstr,
  ctlId,
  ctlInfo,
  darwinIfconfig,
  darwinRoute,
  ifreq,
  ifreqName,
  linuxCommands,
  PF_SYSTEM,
  type Setup,
  SOCK_DGRAM,
  SYSPROTO_CONTROL,
  sockaddrCtl,
  stripAF,
  TUNSETIFF,
  UTUN_OPT_IFNAME,
} from "./layout.ts";
import { type Device, run } from "./run.ts";

const { i32, i64, u64, u32, ptr: P } = FFIType;
const isMac = process.platform === "darwin";
export const libcName = () => (isMac ? "libSystem.B.dylib" : "libc.so.6");

// ioctl is variadic: Apple's arm64 puts the third argument on the stack, so
// six unused registers come first there
const ioctlArgs = isMac && process.arch === "arm64" ? [i32, u64, u64, u64, u64, u64, u64, u64, P] : [i32, u64, P];

let lib: ReturnType<typeof load> | undefined;
const load = () =>
  dlopen(libcName(), {
    ioctl: { args: ioctlArgs, returns: i32 },
    write: { args: [i32, P, u64], returns: i64 },
    close: { args: [i32], returns: i32 },
    socket: { args: [i32, i32, i32], returns: i32 },
    connect: { args: [i32, P, u32], returns: i32 },
    getsockopt: { args: [i32, i32, i32, P, P], returns: i32 },
  }).symbols;
const libc = () => (lib ??= load());

function ioctl(fd: number, req: number, arg: Uint8Array): number {
  const f = libc().ioctl as unknown as (...a: (number | Uint8Array)[]) => number;
  return ioctlArgs.length === 3 ? f(fd, req, arg) : f(fd, req, 0, 0, 0, 0, 0, 0, arg);
}

// a device's fd closed whatever happens next
async function guarded<T>(fd: number, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    libc().close(fd);
    throw e;
  }
}

export async function openLinux(s: Setup): Promise<Device> {
  let fd: number;
  try {
    fd = openSync("/dev/net/tun", constants.O_RDWR);
  } catch (e) {
    throw new Error(`couldn't open /dev/net/tun (needs root): ${(e as Error).message}`);
  }
  return guarded(fd, async () => {
    const r = ifreq(s.name);
    if (ioctl(fd, TUNSETIFF, r) < 0) throw new Error(`couldn't make the tunnel ${s.name} (needs root)`);
    const name = ifreqName(r);
    for (const c of linuxCommands({ ...s, name })) await run(c);
    return unixDevice(fd, name, false);
  });
}

export async function openDarwin(s: Setup): Promise<Device> {
  const c = libc();
  const fd = c.socket(PF_SYSTEM, SOCK_DGRAM, SYSPROTO_CONTROL);
  if (fd < 0) throw new Error("couldn't open a utun control socket (needs root)");
  return guarded(fd, async () => {
    const info = ctlInfo();
    if (ioctl(fd, CTLIOCGINFO, info) < 0) throw new Error("couldn't find the utun control");
    const addr = sockaddrCtl(ctlId(info));
    if (c.connect(fd, addr, addr.length) < 0) throw new Error("couldn't make a utun device (needs root)");
    const buf = new Uint8Array(32);
    const len = new Uint32Array([buf.length]);
    if (c.getsockopt(fd, SYSPROTO_CONTROL, UTUN_OPT_IFNAME, buf, len) < 0) throw new Error("couldn't name the utun");
    const name = new TextDecoder().decode(buf.subarray(0, Math.max(0, len[0]! - 1))).replace(/\0.*$/, "");
    await run(darwinIfconfig({ ...s, name }));
    await run(darwinRoute({ ...s, name })).catch(() => run(darwinRoute({ ...s, name }, "change")));
    return unixDevice(fd, name, true);
  });
}

function unixDevice(fd: number, name: string, af: boolean): Device {
  const c = libc();
  return {
    name,
    reader: { os: "unix", lib: libcName(), fd },
    unwrap: af ? stripAF : (b) => b,
    write(pkt) {
      const b = af ? addAF(pkt) : pkt;
      // a full queue drops the packet, as any link would
      return Number(c.write(fd, b, b.length)) === b.length;
    },
    close() {
      c.close(fd);
    },
  };
}
