import { expect, test } from "bun:test";
import {
  ADAPTER_GUID,
  AF_INET,
  AF_INET6,
  addAF,
  CTL_INFO_SIZE,
  CTLIOCGINFO,
  ctlId,
  ctlInfo,
  darwinIfconfig,
  darwinRoute,
  guidBytes,
  IFF_NO_PI,
  IFF_TUN,
  IFREQ_SIZE,
  ifreq,
  ifreqName,
  linuxCommands,
  MESH_PREFIX,
  SOCKADDR_CTL_SIZE,
  sockaddrCtl,
  stripAF,
  TUNSETIFF,
  windowsScript,
} from "../src/index.ts";
import { checksum, echoReply, echoRequest } from "./icmp.ts";

// _IOC: direction bits, size, type, number
const ioc = (dir: number, type: string, nr: number, size: number) =>
  ((dir << 30) | (size << 16) | (type.charCodeAt(0) << 8) | nr) >>> 0;

test("the ioctl numbers match their _IOW and _IOWR", () => {
  expect(TUNSETIFF).toBe(ioc(1, "T", 202, 4));
  expect(CTLIOCGINFO).toBe(ioc(3, "N", 3, CTL_INFO_SIZE));
});

test("struct ifreq: the name, then the flags at 16 in host order", () => {
  const b = ifreq("phos0");
  expect(b.length).toBe(IFREQ_SIZE);
  expect(Array.from(b.subarray(0, 6))).toEqual([0x70, 0x68, 0x6f, 0x73, 0x30, 0]);
  expect(b[16]).toBe((IFF_TUN | IFF_NO_PI) & 0xff);
  expect(b[17]).toBe((IFF_TUN | IFF_NO_PI) >> 8);
  expect(Array.from(b.subarray(18)).every((x) => x === 0)).toBe(true);
  expect(ifreqName(b)).toBe("phos0");
  // the kernel's name read back up to its NUL
  b.set(new TextEncoder().encode("phos12\0"), 0);
  expect(ifreqName(b)).toBe("phos12");
  expect(() => ifreq("a-name-sixteen-x")).toThrow(/too long/);
  expect(ifreq("fifteen-chars-x").subarray(0, 16).at(15)).toBe(0);
});

test("struct ctl_info and sockaddr_ctl packed as the macOS kernel wants", () => {
  const info = ctlInfo();
  expect(info.length).toBe(100);
  expect(new TextDecoder().decode(info.subarray(4, 4 + 26))).toBe("com.apple.net.utun_control");
  expect(info[30]).toBe(0);
  new DataView(info.buffer).setUint32(0, 0x01020304, true);
  expect(ctlId(info)).toBe(0x01020304);

  const a = sockaddrCtl(0x01020304);
  expect(a.length).toBe(SOCKADDR_CTL_SIZE);
  expect(Array.from(a.subarray(0, 12))).toEqual([32, 32, 2, 0, 4, 3, 2, 1, 0, 0, 0, 0]);
  expect(Array.from(a.subarray(12)).every((x) => x === 0)).toBe(true);
  expect(Array.from(sockaddrCtl(7, 3).subarray(8, 12))).toEqual([3, 0, 0, 0]);
});

test("the utun family header put on and taken off", () => {
  const v4 = new Uint8Array([0x45, 0, 0, 20, 9]);
  const v6 = new Uint8Array([0x60, 0, 0, 0]);
  expect(Array.from(addAF(v4))).toEqual([0, 0, 0, AF_INET, 0x45, 0, 0, 20, 9]);
  expect(Array.from(addAF(v6))).toEqual([0, 0, 0, AF_INET6, 0x60, 0, 0, 0]);
  expect(Array.from(stripAF(addAF(v4)))).toEqual(Array.from(v4));
  const b = addAF(v6);
  // no copy: the same buffer underneath
  expect(stripAF(b).buffer).toBe(b.buffer);
});

test("the adapter GUID in Windows' layout", () => {
  expect(Array.from(guidBytes("00112233-4455-6677-8899-aabbccddeeff"))).toEqual([
    0x33, 0x22, 0x11, 0x00, 0x55, 0x44, 0x77, 0x66, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
  ]);
  expect(guidBytes(ADAPTER_GUID).length).toBe(16);
  expect(() => guidBytes("nope")).toThrow();
});

const s = { name: "phos0", ip: "100.64.0.7", prefix: MESH_PREFIX, mtu: 1280 };

test("linux: address, mtu and route through ip", () => {
  expect(linuxCommands(s)).toEqual([
    ["ip", "addr", "replace", "100.64.0.7/32", "dev", "phos0"],
    ["ip", "link", "set", "dev", "phos0", "mtu", "1280", "up"],
    ["ip", "route", "replace", "100.64.0.0/10", "dev", "phos0", "src", "100.64.0.7"],
  ]);
  expect(linuxCommands({ ...s, ip: "fd7a:115c:a1e0::7", prefix: "fd7a:115c:a1e0::/48" })[0]![3]).toBe(
    "fd7a:115c:a1e0::7/128",
  );
  expect(() => linuxCommands({ ...s, ip: "100.64.0.300" })).toThrow(/not an IP/);
  expect(() => linuxCommands({ ...s, ip: "1.2.3.4; reboot" })).toThrow(/not an IP/);
  expect(() => linuxCommands({ ...s, prefix: "100.64.0.0/33" })).toThrow(/not a prefix/);
  expect(() => linuxCommands({ ...s, prefix: "100.64.0.0" })).toThrow(/not a prefix/);
});

test("macOS: ifconfig as point to point, the route on the interface", () => {
  const m = { ...s, name: "utun5" };
  expect(darwinIfconfig(m)).toEqual(["ifconfig", "utun5", "inet", "100.64.0.7", "100.64.0.7", "mtu", "1280", "up"]);
  expect(darwinRoute(m)).toEqual(["route", "-n", "add", "-net", "100.64.0.0/10", "-interface", "utun5"]);
  expect(darwinRoute(m, "change")[2]).toBe("change");
});

test("windows: the script finds the adapter by LUID and sets it up", () => {
  const w = windowsScript({ ...s, name: "Phosphorus", luid: 1234567890123n, port: 41641 });
  expect(w).toContain("$_.NetLuid -eq 1234567890123");
  expect(w).toContain("New-NetIPAddress -InterfaceIndex $i -IPAddress '100.64.0.7' -PrefixLength 32");
  expect(w).toContain("Set-NetIPInterface -InterfaceIndex $i -NlMtuBytes 1280");
  expect(w).toContain("New-NetRoute -InterfaceIndex $i -DestinationPrefix '100.64.0.0/10' -NextHop '0.0.0.0'");
  expect(w).toContain("-Direction Inbound -Protocol UDP -LocalPort 41641 -Action Allow");
  expect(w.trim().split("\n").at(-1)).toBe("$a.Name");
  expect(() => windowsScript({ ...s, ip: "x'; rm", luid: 1n, port: 41641 })).toThrow(/not an IP/);
  expect(() => windowsScript({ ...s, luid: 1n, port: 70000 })).toThrow(/not a port/);
});

test("the smoke test's echo reply", () => {
  const req = echoRequest("10.250.0.1", "10.250.0.2", 0x1234, 1, new Uint8Array([1, 2, 3, 4, 5]));
  expect(checksum(req.subarray(0, 20))).toBe(0);
  expect(checksum(req.subarray(20))).toBe(0);
  const r = echoReply(req)!;
  expect(Array.from(r.subarray(12, 16))).toEqual([10, 250, 0, 2]);
  expect(Array.from(r.subarray(16, 20))).toEqual([10, 250, 0, 1]);
  expect(r[20]).toBe(0);
  expect(checksum(r.subarray(0, 20))).toBe(0);
  expect(checksum(r.subarray(20))).toBe(0);
  expect(Array.from(r.subarray(24))).toEqual(Array.from(req.subarray(24)));
  expect(echoReply(r)).toBeUndefined();
});

test("the reader worker starts from its Blob and reports a failure once", async () => {
  const { startReader } = await import("../src/reader.ts");
  const init =
    process.platform === "win32"
      ? ({ os: "win32", lib: "no-such-wintun.dll", session: 0, event: 0 } as const)
      : ({ os: "unix", lib: "no-such-libc.so", fd: -1 } as const);
  const errors: Error[] = [];
  const failed = new Promise<void>((ok) => {
    const r = startReader(
      init,
      () => {},
      (e) => {
        errors.push(e);
        ok();
      },
    );
    setTimeout(() => void r.stop(), 5000);
  });
  await failed;
  expect(errors.length).toBe(1);
  expect(errors[0]!.message).toMatch(/no-such/);
});
