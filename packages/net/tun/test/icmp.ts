// an IPv4 echo request answered in place of the far end, for the smoke test

// the internet checksum over b
export function checksum(b: Uint8Array): number {
  let s = 0;
  for (let i = 0; i + 1 < b.length; i += 2) s += (b[i]! << 8) | b[i + 1]!;
  if (b.length & 1) s += b[b.length - 1]! << 8;
  while (s > 0xffff) s = (s & 0xffff) + (s >>> 16);
  return ~s & 0xffff;
}

// the reply to an IPv4 ICMP echo request; undefined for anything else
export function echoReply(pkt: Uint8Array): Uint8Array | undefined {
  if (pkt.length < 28 || pkt[0]! >> 4 !== 4 || pkt[9] !== 1) return;
  const hl = (pkt[0]! & 15) * 4;
  if (pkt.length < hl + 8 || pkt[hl] !== 8) return;
  const r = pkt.slice();
  const v = new DataView(r.buffer);
  r.set(pkt.subarray(16, 20), 12);
  r.set(pkt.subarray(12, 16), 16);
  v.setUint16(10, 0);
  v.setUint16(10, checksum(r.subarray(0, hl)));
  r[hl] = 0;
  v.setUint16(hl + 2, 0);
  v.setUint16(hl + 2, checksum(r.subarray(hl)));
  return r;
}

// a minimal IPv4 echo request, for the unit test
export function echoRequest(src: string, dst: string, id: number, seq: number, data: Uint8Array): Uint8Array {
  const r = new Uint8Array(28 + data.length);
  const v = new DataView(r.buffer);
  r[0] = 0x45;
  v.setUint16(2, r.length);
  r[8] = 64;
  r[9] = 1;
  r.set(src.split(".").map(Number), 12);
  r.set(dst.split(".").map(Number), 16);
  v.setUint16(10, checksum(r.subarray(0, 20)));
  r[20] = 8;
  v.setUint16(24, id);
  v.setUint16(26, seq);
  r.set(data, 28);
  v.setUint16(22, checksum(r.subarray(20)));
  return r;
}
