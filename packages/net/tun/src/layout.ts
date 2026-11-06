// the pure parts of each OS's tunnel: kernel structs, the macOS packet header,
// the commands that give the device its address, mtu and route

// linux: _IOW('T', 202, int), and struct ifreq's flags
export const TUNSETIFF = 0x400454ca;
export const IFF_TUN = 0x0001;
export const IFF_NO_PI = 0x1000;
export const IFREQ_SIZE = 40;
const IFNAMSIZ = 16;

// macOS: _IOWR('N', 3, struct ctl_info), the control socket's family and options
export const CTLIOCGINFO = 0xc0644e03;
export const PF_SYSTEM = 32;
export const AF_SYS_CONTROL = 2;
export const SYSPROTO_CONTROL = 2;
export const SOCK_DGRAM = 2;
export const UTUN_OPT_IFNAME = 2;
export const UTUN_CONTROL = "com.apple.net.utun_control";
export const CTL_INFO_SIZE = 100;
export const SOCKADDR_CTL_SIZE = 32;
// macOS address families, as the utun header carries them
export const AF_INET = 2;
export const AF_INET6 = 30;

// windows: the adapter's ring, its fixed GUID so Windows sees one network across restarts
export const RING_CAPACITY = 0x400000;
export const ADAPTER_GUID = "3f936173-c51f-4e83-83e8-5db30d34f7a0";

export const MESH_PREFIX = "100.64.0.0/10";
export const MTU = 1280;
export const WG_PORT = 41641;

// a NUL ended string out of a struct
export const cstr = (b: Uint8Array, at = 0, n = b.length) => {
  const s = b.subarray(at, at + n);
  const z = s.indexOf(0);
  return new TextDecoder().decode(z < 0 ? s : s.subarray(0, z));
};

const putName = (b: Uint8Array, at: number, max: number, name: string) => {
  const n = new TextEncoder().encode(name);
  if (n.length >= max) throw new Error(`interface name ${name} is too long`);
  b.set(n, at);
};

// struct ifreq: ifr_name[16], then ifr_flags as a short in host order
export function ifreq(name: string, flags = IFF_TUN | IFF_NO_PI): Uint8Array {
  const b = new Uint8Array(IFREQ_SIZE);
  putName(b, 0, IFNAMSIZ, name);
  new DataView(b.buffer).setInt16(IFNAMSIZ, flags, true);
  return b;
}

// the name the kernel gave, from an ifreq after TUNSETIFF
export const ifreqName = (b: Uint8Array) => cstr(b, 0, IFNAMSIZ);

// struct ctl_info: ctl_id, then ctl_name[96]
export function ctlInfo(name = UTUN_CONTROL): Uint8Array {
  const b = new Uint8Array(CTL_INFO_SIZE);
  putName(b, 4, CTL_INFO_SIZE - 4, name);
  return b;
}

export const ctlId = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset).getUint32(0, true);

// struct sockaddr_ctl: sc_len, sc_family, ss_sysaddr, sc_id, sc_unit, sc_reserved[5];
// unit 0 lets the kernel pick the next free utunN
export function sockaddrCtl(id: number, unit = 0): Uint8Array {
  const b = new Uint8Array(SOCKADDR_CTL_SIZE);
  const v = new DataView(b.buffer);
  v.setUint8(0, SOCKADDR_CTL_SIZE);
  v.setUint8(1, PF_SYSTEM);
  v.setUint16(2, AF_SYS_CONTROL, true);
  v.setUint32(4, id, true);
  v.setUint32(8, unit, true);
  return b;
}

// a packet as utun takes it: its family, big endian, ahead of the IP header
export function addAF(pkt: Uint8Array): Uint8Array {
  const b = new Uint8Array(pkt.length + 4);
  new DataView(b.buffer).setUint32(0, pkt[0]! >> 4 === 6 ? AF_INET6 : AF_INET);
  b.set(pkt, 4);
  return b;
}

// a utun packet's IP part, no copy
export const stripAF = (b: Uint8Array) => b.subarray(4);

// a GUID in its Windows layout: Data1 to Data3 little endian, Data4 as written
export function guidBytes(g: string): Uint8Array {
  const h = g.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(h)) throw new Error(`not a GUID: ${g}`);
  const b = new Uint8Array(16);
  const v = new DataView(b.buffer);
  v.setUint32(0, parseInt(h.slice(0, 8), 16), true);
  v.setUint16(4, parseInt(h.slice(8, 12), 16), true);
  v.setUint16(6, parseInt(h.slice(12, 16), 16), true);
  for (let i = 0; i < 8; i++) b[8 + i] = parseInt(h.slice(16 + i * 2, 18 + i * 2), 16);
  return b;
}

const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const isV4 = (ip: string) => v4.test(ip) && ip.split(".").every((p) => Number(p) <= 255);
const isV6 = (ip: string) => ip.includes(":") && /^[0-9a-f:.]+$/i.test(ip);

// an address checked as one, its host prefix length
export function hostBits(ip: string): number {
  if (isV4(ip)) return 32;
  if (isV6(ip)) return 128;
  throw new Error(`not an IP address: ${ip}`);
}

// a CIDR prefix checked as one
export function checkPrefix(p: string): string {
  const [a, n, more] = p.split("/");
  const bits = a ? hostBits(a) : 0;
  if (more !== undefined || !n || !/^\d+$/.test(n) || Number(n) > bits) throw new Error(`not a prefix: ${p}`);
  return p;
}

export type Setup = { name: string; ip: string; prefix: string; mtu: number };

// linux: address, mtu and link up, then the mesh's route through the device
export function linuxCommands(s: Setup): string[][] {
  return [
    ["ip", "addr", "replace", `${s.ip}/${hostBits(s.ip)}`, "dev", s.name],
    ["ip", "link", "set", "dev", s.name, "mtu", String(s.mtu), "up"],
    ["ip", "route", "replace", checkPrefix(s.prefix), "dev", s.name, "src", s.ip],
  ];
}

// macOS: utun is point to point, its address its own peer
export function darwinIfconfig(s: Setup): string[] {
  return hostBits(s.ip) === 32
    ? ["ifconfig", s.name, "inet", s.ip, s.ip, "mtu", String(s.mtu), "up"]
    : ["ifconfig", s.name, "inet6", s.ip, "prefixlen", "128", "mtu", String(s.mtu), "up"];
}

// macOS: the route added, or changed when one is there already
export function darwinRoute(s: Setup, verb: "add" | "change" = "add"): string[] {
  const p = checkPrefix(s.prefix);
  return ["route", "-n", verb, hostBits(p.split("/")[0]!) === 32 ? "-net" : "-inet6", p, "-interface", s.name];
}

export const psq = (s: string) => "'" + s.replaceAll("'", "''") + "'";

// windows: the adapter found by its LUID, then its address, mtu, route and the
// firewall's way in for WireGuard; prints the adapter's alias
export function windowsScript(s: Setup & { luid: bigint; port: number }): string {
  const bits = hostBits(s.ip);
  const fam = bits === 32 ? "IPv4" : "IPv6";
  const prefix = checkPrefix(s.prefix);
  const port = Math.trunc(s.port);
  if (!(port > 0 && port < 65536)) throw new Error(`not a port: ${s.port}`);
  return [
    "$ErrorActionPreference = 'Stop'",
    "$a = $null",
    `for ($n = 0; -not $a -and $n -lt 40; $n++) { $a = Get-NetAdapter -IncludeHidden | Where-Object { $_.NetLuid -eq ${s.luid} }; if (-not $a) { Start-Sleep -Milliseconds 250 } }`,
    `if (-not $a) { throw 'the wintun adapter never showed up' }`,
    "$i = $a.ifIndex",
    `Get-NetIPAddress -InterfaceIndex $i -AddressFamily ${fam} -ErrorAction SilentlyContinue | Remove-NetIPAddress -Confirm:$false`,
    `New-NetIPAddress -InterfaceIndex $i -IPAddress ${psq(s.ip)} -PrefixLength ${bits} -PolicyStore ActiveStore | Out-Null`,
    `Set-NetIPInterface -InterfaceIndex $i -NlMtuBytes ${Math.trunc(s.mtu)}`,
    `Get-NetRoute -InterfaceIndex $i -DestinationPrefix ${psq(prefix)} -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false`,
    `New-NetRoute -InterfaceIndex $i -DestinationPrefix ${psq(prefix)} -NextHop ${bits === 32 ? "'0.0.0.0'" : "'::'"} -RouteMetric 0 -PolicyStore ActiveStore | Out-Null`,
    "Remove-NetFirewallRule -Name 'phosphorus-wireguard' -ErrorAction SilentlyContinue",
    `New-NetFirewallRule -Name 'phosphorus-wireguard' -DisplayName 'phosphorus wireguard' -Direction Inbound -Protocol UDP -LocalPort ${port} -Action Allow | Out-Null`,
    "$a.Name",
  ].join("\n");
}
