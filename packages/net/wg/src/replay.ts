// the receive counter's sliding window, 2048 packets back (RFC 6479)

const bits = 2048;
const words = bits / 32;

export class Replay {
  private map = new Uint32Array(words);
  private top = -1;

  // a counter taken: false when seen already or too old
  check(c: number): boolean {
    if (c > this.top) {
      const cur = Math.floor(this.top / 32);
      const next = Math.floor(c / 32);
      const gap = Math.min(next - cur, words);
      for (let i = 1; i <= gap; i++) this.map[(cur + i) % words] = 0;
      this.top = c;
    } else if (this.top - c >= bits - 32) return false;
    const w = Math.floor(c / 32) % words;
    const b = 1 << (c % 32);
    if (this.map[w]! & b) return false;
    this.map[w]! |= b;
    return true;
  }
}
