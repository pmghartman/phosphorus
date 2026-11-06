// IPv4 prefixes and the addresses in a packet's header

export type Prefix = { net: number; bits: number };

export const v4 = (s: string): number | undefined => {
  const p = s.split(".");
  if (p.length !== 4) return undefined;
  let n = 0;
  for (const x of p) {
    const v = Number(x);
    if (!/^\d{1,3}$/.test(x) || v > 255) return undefined;
    n = n * 256 + v;
  }
  return n;
};

export const v4Text = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

const maskOf = (bits: number) => (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0);

// "a.b.c.d/n", or a bare address as /32
export function prefix(s: string): Prefix | undefined {
  const [a, b] = s.split("/");
  const net = v4(a ?? "");
  const bits = b === undefined ? 32 : Number(b);
  if (net === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) return undefined;
  return { net: (net & maskOf(bits)) >>> 0, bits };
}

export const contains = (p: Prefix, ip: number) => (ip & maskOf(p.bits)) >>> 0 === p.net;

// an IPv4 packet's source and destination, undefined for anything else
export function addrs(pkt: Uint8Array): { src: number; dst: number } | undefined {
  if (pkt.length < 20 || pkt[0]! >> 4 !== 4) return undefined;
  const v = new DataView(pkt.buffer, pkt.byteOffset);
  return { src: v.getUint32(12), dst: v.getUint32(16) };
}

// an IPv4 packet's own length, padding cut off
export function ipLength(pkt: Uint8Array): number {
  if (pkt.length >= 20 && pkt[0]! >> 4 === 4) return Math.min(pkt.length, (pkt[2]! << 8) | pkt[3]!);
  if (pkt.length >= 40 && pkt[0]! >> 4 === 6) return Math.min(pkt.length, 40 + ((pkt[4]! << 8) | pkt[5]!));
  return 0;
}
