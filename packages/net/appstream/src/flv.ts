// ffmpeg's FLV out of a pipe, cut into what a browser's VideoDecoder takes: the
// AVC decoder configuration once, then each frame's length-prefixed NAL units.
// FLV is used for its framing alone: every tag says its size up front, so a frame
// goes on the moment its last byte lands, never held for the next one's start code

export type Packet =
  | { kind: "config"; avcc: Uint8Array }
  | { kind: "frame"; key: boolean; data: Uint8Array; ts: number };

const headerLen = 9 + 4;
const tagHead = 11;

export class FlvReader {
  private buf = new Uint8Array(0);
  private off = 0;
  private started = false;
  // set when the stream isn't FLV, past which nothing is read
  bad = "";

  push(chunk: Uint8Array): Packet[] {
    if (this.bad) return [];
    const rest = this.buf.subarray(this.off);
    const b = new Uint8Array(rest.length + chunk.length);
    b.set(rest);
    b.set(chunk, rest.length);
    this.buf = b;
    this.off = 0;
    const out: Packet[] = [];
    if (!this.started) {
      if (b.length < headerLen) return out;
      if (b[0] !== 0x46 || b[1] !== 0x4c || b[2] !== 0x56) {
        this.bad = "not flv";
        return out;
      }
      const dataOff = ((b[5]! << 24) | (b[6]! << 16) | (b[7]! << 8) | b[8]!) >>> 0;
      this.off = dataOff + 4;
      this.started = true;
    }
    while (this.buf.length - this.off >= tagHead) {
      const p = this.off;
      const t = b[p]! & 0x1f;
      const size = (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!;
      const ts = ((b[p + 7]! << 24) | (b[p + 4]! << 16) | (b[p + 5]! << 8) | b[p + 6]!) >>> 0;
      const end = p + tagHead + size + 4;
      if (this.buf.length < end) break;
      this.off = end;
      if (t !== 9 || size < 5) continue;
      const d = b.subarray(p + tagHead, p + tagHead + size);
      const frameType = d[0]! >> 4;
      if ((d[0]! & 0x0f) !== 7) {
        this.bad = "not h.264";
        break;
      }
      const pkt = d[1];
      if (pkt === 0) out.push({ kind: "config", avcc: d.slice(5) });
      else if (pkt === 1) out.push({ kind: "frame", key: frameType === 1, data: d.slice(5), ts });
    }
    return out;
  }
}

// the codec string an avcC names: avc1.PPCCLL
export function codecOf(avcc: Uint8Array): string {
  const h = (n: number) => (avcc[n] ?? 0).toString(16).padStart(2, "0");
  return `avc1.${h(1)}${h(2)}${h(3)}`;
}
