// a QR code for text: byte mode, low error correction, the smallest version that
// holds it, the mask with the least penalty; for a device's WireGuard config

const eccPerBlock = [
  -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30,
  30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
];
const blocksOf = [
  -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19,
  19, 20, 21, 22, 24, 25,
];
// low error correction's format bits
const eclBits = 1;

function rawModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const a = Math.floor(ver / 7) + 2;
    n -= (25 * a - 10) * a - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

const dataCodewords = (ver: number) => Math.floor(rawModules(ver) / 8) - eccPerBlock[ver]! * blocksOf[ver]!;

// GF(256) over 0x11D
function mul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function divisor(degree: number): number[] {
  const r = new Array<number>(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = mul(r[j]!, root);
      if (j + 1 < r.length) r[j]! ^= r[j + 1]!;
    }
    root = mul(root, 0x02);
  }
  return r;
}

function remainder(data: number[], div: number[]): number[] {
  const r = new Array<number>(div.length).fill(0);
  for (const b of data) {
    const f = b ^ r.shift()!;
    r.push(0);
    for (let i = 0; i < r.length; i++) r[i]! ^= mul(div[i]!, f);
  }
  return r;
}

function withEcc(data: number[], ver: number): number[] {
  const n = blocksOf[ver]!;
  const eccLen = eccPerBlock[ver]!;
  const raw = Math.floor(rawModules(ver) / 8);
  const short = n - (raw % n);
  const shortLen = Math.floor(raw / n);
  const div = divisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < n; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < short ? 0 : 1));
    k += dat.length;
    const ecc = remainder(dat, div);
    if (i < short) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++)
    for (let j = 0; j < blocks.length; j++) if (i !== shortLen - eccLen || j >= short) out.push(blocks[j]![i]!);
  return out;
}

function alignPositions(ver: number, size: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const r = [6];
  for (let pos = size - 7; r.length < n; pos -= step) r.splice(1, 0, pos);
  return r;
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

const masks: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// the modules, true dark, rows of columns
export function qrModules(text: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 1;
  for (; ver <= 40; ver++) if (4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  if (ver > 40) throw new Error('too long for a QR code');
  const cap = dataCodewords(ver) * 8;
  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(4, 4);
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const words = withEcc(data, ver);

  const size = ver * 4 + 17;
  const mods = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    mods[y]![x] = dark;
    fn[y]![x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const)
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx,
          y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
  const al = alignPositions(ver, size);
  for (let i = 0; i < al.length; i++)
    for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) set(al[i]! + dx, al[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  const format = (mask: number) => {
    const d = (eclBits << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const b = ((d << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) set(8, i, bit(b, i));
    set(8, 7, bit(b, 6));
    set(8, 8, bit(b, 7));
    set(7, 8, bit(b, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(b, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(b, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(b, i));
    set(8, size - 8, true);
  };
  format(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const b = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3),
        c = Math.floor(i / 3);
      set(a, c, bit(b, i));
      set(c, a, bit(b, i));
    }
  }
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
        if (!fn[y]![x] && k < words.length * 8) {
          mods[y]![x] = bit(words[k >>> 3]!, 7 - (k & 7));
          k++;
        }
      }
  }
  const apply = (m: number) => {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) if (!fn[y]![x] && masks[m]!(x, y)) mods[y]![x] = !mods[y]![x];
  };
  let best = 0;
  let least = Number.POSITIVE_INFINITY;
  for (let m = 0; m < 8; m++) {
    apply(m);
    format(m);
    const p = penalty(mods);
    if (p < least) [best, least] = [m, p];
    apply(m);
  }
  apply(best);
  format(best);
  return mods;
}

// runs of five or more, two by two blocks, and the dark share's distance from half
function penalty(m: boolean[][]): number {
  const n = m.length;
  let p = 0;
  let dark = 0;
  for (let a = 0; a < n; a++) {
    let runR = 1,
      runC = 1;
    for (let b = 0; b < n; b++) {
      if (m[a]![b]) dark++;
      if (b > 0) {
        if (m[a]![b] === m[a]![b - 1]) runR++;
        else runR = 1;
        if (m[b]![a] === m[b - 1]![a]) runC++;
        else runC = 1;
        if (runR === 5) p += 3;
        else if (runR > 5) p++;
        if (runC === 5) p += 3;
        else if (runC > 5) p++;
      }
      if (a > 0 && b > 0) {
        const c = m[a]![b];
        if (c === m[a - 1]![b] && c === m[a]![b - 1] && c === m[a - 1]![b - 1]) p += 3;
      }
    }
  }
  p += Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
  return p;
}

// the code as an svg, a four module quiet zone round it
export function qrSVG(text: string): SVGSVGElement {
  const m = qrModules(text);
  const n = m.length + 8;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  let d = '';
  m.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x + 4} ${y + 4}h1v1h-1z`)));
  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('width', String(n));
  bg.setAttribute('height', String(n));
  bg.setAttribute('fill', '#fff');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.append(bg, path);
  return svg;
}
