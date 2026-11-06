// icons: every platform's icon rendered from the tab icon apps/web/static/favicon.svg,
// the macOS menu bar's template its black silhouette; run after the mark changes
//   bun run icons
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const root = resolve(import.meta.dir, "..");
const src = await Bun.file(join(root, "apps/web/static/favicon.svg")).text();
// the connector's: clear, the mark cropped to fill most of it as other connectors' logos do
const connector = src.replace('viewBox="0 0 64 64"', 'viewBox="8 8 48 48"');
// the menu bar template: one color, cropped to the glyph so it fills the bar's height
const template = src.replace('fill="url(#g)"', 'fill="#000"').replace('viewBox="0 0 64 64"', 'viewBox="12 12 40 40"');

// --- the rasterizer: the SVG the mark is, paths filled nonzero, solid or a linear gradient ---

type Pt = [number, number];
type Affine = [number, number, number, number, number, number];
type Stop = { at: number; rgb: [number, number, number] };
type Grad = { p1: Pt; p2: Pt; stops: Stop[] };
type Paint = { rgb: [number, number, number] } | Grad;

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const nums = (s: string) => (s.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
const hex = (s: string): [number, number, number] => {
  const h = s.replace("#", "");
  const f = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  if (!/^[0-9a-f]{6}$/i.test(f)) throw new Error(`icons: color ${s} isn't #rgb or #rrggbb`);
  return [0, 2, 4].map((i) => Number.parseInt(f.slice(i, i + 2), 16)) as [number, number, number];
};
const apply = (m: Affine, [x, y]: Pt): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const mul = (a: Affine, b: Affine): Affine => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

// translate, scale and matrix, left to right as SVG composes them
function transform(s = ""): Affine {
  let m: Affine = [1, 0, 0, 1, 0, 0];
  for (const [, fn, args] of s.matchAll(/(\w+)\(([^)]*)\)/g)) {
    const a = nums(args!);
    let t: Affine;
    if (fn === "translate") t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
    else if (fn === "scale") t = [a[0]!, 0, 0, a[1] ?? a[0]!, 0, 0];
    else if (fn === "matrix") t = a.slice(0, 6) as Affine;
    else throw new Error(`icons: transform ${fn} isn't drawn here`);
    m = mul(m, t);
  }
  return m;
}

// a path's outline as closed polygons in its own units, curves cut fine enough for 1024px
function outline(d: string): Pt[][] {
  const polys: Pt[][] = [];
  let cur: Pt[] = [];
  let p: Pt = [0, 0];
  let start: Pt = [0, 0];
  let ctrl: Pt | null = null;
  const toks = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  let i = 0;
  let cmd = "";
  const n = () => Number(toks[i++]);
  const close = () => {
    if (cur.length > 2) polys.push(cur);
    cur = [];
  };
  const curve = (pts: Pt[]) => {
    const steps = 32;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      let q = pts;
      while (q.length > 1) {
        const r = q;
        q = r.slice(1).map((b, k): Pt => [r[k]![0] + (b[0] - r[k]![0]) * t, r[k]![1] + (b[1] - r[k]![1]) * t]);
      }
      cur.push(q[0]!);
    }
  };
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i]!)) cmd = toks[i++]!;
    const rel = cmd === cmd.toLowerCase();
    const at = (x: number, y: number): Pt => (rel ? [p[0] + x, p[1] + y] : [x, y]);
    switch (cmd.toUpperCase()) {
      case "M":
        close();
        p = start = at(n(), n());
        cur.push(p);
        cmd = rel ? "l" : "L";
        ctrl = null;
        break;
      case "L":
        p = at(n(), n());
        cur.push(p);
        ctrl = null;
        break;
      case "H":
        p = [rel ? p[0] + n() : n(), p[1]];
        cur.push(p);
        ctrl = null;
        break;
      case "V":
        p = [p[0], rel ? p[1] + n() : n()];
        cur.push(p);
        ctrl = null;
        break;
      case "Q": {
        const c = at(n(), n());
        const e = at(n(), n());
        curve([p, c, e]);
        ctrl = c;
        p = e;
        break;
      }
      case "T": {
        const c: Pt = ctrl ? [2 * p[0] - ctrl[0], 2 * p[1] - ctrl[1]] : p;
        const e = at(n(), n());
        curve([p, c, e]);
        ctrl = c;
        p = e;
        break;
      }
      case "C": {
        const c1 = at(n(), n());
        const c2 = at(n(), n());
        const e = at(n(), n());
        curve([p, c1, c2, e]);
        ctrl = null;
        p = e;
        break;
      }
      case "Z":
        close();
        p = start;
        ctrl = null;
        break;
      default:
        throw new Error(`icons: path command ${cmd} isn't drawn here`);
    }
  }
  close();
  return polys;
}

// RGBA, straight alpha: coverage from 16 sub rows a pixel, each span's ends exact in x
function rasterize(svg: string, size: number): Uint8Array {
  const vb = nums(attr(svg.match(/<svg[^>]*>/)![0], "viewBox") ?? "0 0 64 64");
  const k = size / vb[2]!;
  const view: Affine = [k, 0, 0, k, -vb[0]! * k, -vb[1]! * k];
  const grads = new Map<string, { x1: number; y1: number; x2: number; y2: number; stops: Stop[] }>();
  for (const [, tag, body] of svg.matchAll(/(<linearGradient[^>]*>)([\s\S]*?)<\/linearGradient>/g)) {
    if (attr(tag!, "gradientUnits") !== "userSpaceOnUse") throw new Error("icons: gradients are userSpaceOnUse here");
    const stops = [...body!.matchAll(/<stop[^>]*>/g)].map(([s]) => ({
      at: Number(attr(s, "offset")),
      rgb: hex(attr(s, "stop-color")!),
    }));
    const [x1, y1, x2, y2] = ["x1", "y1", "x2", "y2"].map((a) => Number(attr(tag!, a)));
    grads.set(attr(tag!, "id")!, { x1: x1!, y1: y1!, x2: x2!, y2: y2!, stops });
  }
  const out = new Float64Array(size * size * 4);
  for (const [tag] of svg.matchAll(/<path[^>]*>/g)) {
    const m = mul(view, transform(attr(tag, "transform")));
    const fill = attr(tag, "fill") ?? "#000";
    let paint: Paint;
    const ref = /^url\(#(.+)\)$/.exec(fill);
    if (ref) {
      const g = grads.get(ref[1]!);
      if (!g) throw new Error(`icons: no gradient ${ref[1]}`);
      paint = { p1: apply(m, [g.x1, g.y1]), p2: apply(m, [g.x2, g.y2]), stops: g.stops };
    } else paint = { rgb: hex(fill) };
    const edges = outline(attr(tag, "d")!).flatMap((poly) =>
      poly.map((a, j) => [apply(m, a), apply(m, poly[(j + 1) % poly.length]!)] as const),
    );
    const cover = coverage(edges, size);
    for (let px = 0; px < size * size; px++) {
      const a = cover[px]!;
      if (!a) continue;
      const rgb = colorAt(paint, (px % size) + 0.5, Math.floor(px / size) + 0.5);
      // source over, straight alpha kept in floats
      const o = px * 4;
      const da = out[o + 3]!;
      const na = a + da * (1 - a);
      for (let c = 0; c < 3; c++) out[o + c] = (rgb[c]! * a + out[o + c]! * da * (1 - a)) / na;
      out[o + 3] = na;
    }
  }
  const px = new Uint8Array(size * size * 4);
  for (let i = 0; i < px.length; i++) px[i] = Math.round(i % 4 === 3 ? out[i]! * 255 : out[i]!);
  return px;
}

function coverage(edges: (readonly [Pt, Pt])[], size: number): Float64Array {
  const S = 16;
  const cover = new Float64Array(size * size);
  const xs: [number, number][] = [];
  for (let sy = 0; sy < size * S; sy++) {
    const y = (sy + 0.5) / S;
    xs.length = 0;
    for (const [a, b] of edges) {
      if (a[1] === b[1] || y < Math.min(a[1], b[1]) || y >= Math.max(a[1], b[1])) continue;
      xs.push([a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), b[1] > a[1] ? 1 : -1]);
    }
    xs.sort((p, q) => p[0] - q[0]);
    const row = Math.floor(sy / S) * size;
    let wind = 0;
    for (let j = 0; j < xs.length - 1; j++) {
      wind += xs[j]![1];
      if (!wind) continue;
      const x0 = Math.max(0, xs[j]![0]);
      const x1 = Math.min(size, xs[j + 1]![0]);
      for (let x = Math.floor(x0); x < x1; x++) cover[row + x]! += (Math.min(x + 1, x1) - Math.max(x, x0)) / S;
    }
  }
  for (let i = 0; i < cover.length; i++) cover[i] = Math.min(1, cover[i]!);
  return cover;
}

// the gradient padded at its ends, mixed in sRGB as SVG does by default
function colorAt(p: Paint, x: number, y: number): number[] {
  if ("rgb" in p) return p.rgb;
  const dx = p.p2[0] - p.p1[0];
  const dy = p.p2[1] - p.p1[1];
  const t = Math.max(0, Math.min(1, ((x - p.p1[0]) * dx + (y - p.p1[1]) * dy) / (dx * dx + dy * dy)));
  const s = p.stops;
  if (t <= s[0]!.at) return s[0]!.rgb;
  for (let i = 1; i < s.length; i++) {
    if (t > s[i]!.at) continue;
    const f = (t - s[i - 1]!.at) / (s[i]!.at - s[i - 1]!.at || 1);
    return s[i]!.rgb.map((v, c) => s[i - 1]!.rgb[c]! + (v - s[i - 1]!.rgb[c]!) * f);
  }
  return s[s.length - 1]!.rgb;
}

// --- the PNG: 8 bit RGBA, each row filtered by Paeth ---

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const v of b) c = CRC[(c ^ v) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const h = Buffer.alloc(4);
  h.writeUInt32BE(data.length);
  const t = Buffer.alloc(4);
  t.writeUInt32BE(crc32(body));
  return Buffer.concat([h, body, t]);
}
function encodePNG(rgba: Uint8Array, size: number): Uint8Array {
  const stride = size * 4;
  const raw = new Uint8Array((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 4;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? rgba[y * stride + i - 4]! : 0;
      const b = y ? rgba[(y - 1) * stride + i]! : 0;
      const c = i >= 4 && y ? rgba[(y - 1) * stride + i - 4]! : 0;
      const pa = Math.abs(b - c);
      const pb = Math.abs(a - c);
      const pc = Math.abs(a + b - 2 * c);
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      raw[y * (stride + 1) + 1 + i] = (rgba[y * stride + i]! - pred) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

const png = (size: number, svg = src) => encodePNG(rasterize(svg, size), size);

// an .ico of PNG entries, read by Vista and later; 256 is written as 0
function ico(sizes: number[]): Uint8Array {
  const pngs = sizes.map((s) => png(s));
  const head = new Uint8Array(6 + 16 * sizes.length);
  const dv = new DataView(head.buffer);
  dv.setUint16(2, 1, true);
  dv.setUint16(4, sizes.length, true);
  let off = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head[e] = s & 255;
    head[e + 1] = s & 255;
    dv.setUint16(e + 4, 1, true);
    dv.setUint16(e + 6, 32, true);
    dv.setUint32(e + 8, pngs[i]!.length, true);
    dv.setUint32(e + 12, off, true);
    off += pngs[i]!.length;
  });
  return Buffer.concat([head, ...pngs]);
}

// an .icns of PNG entries, each type its point size and scale
const ICNS: Record<string, number> = {
  icp4: 16,
  icp5: 32,
  icp6: 64,
  ic07: 128,
  ic08: 256,
  ic09: 512,
  ic10: 1024,
  ic11: 32,
  ic12: 64,
  ic13: 256,
  ic14: 512,
};
function icns(): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [type, size] of Object.entries(ICNS)) {
    const data = png(size);
    const h = Buffer.alloc(8);
    h.write(type, 0, "ascii");
    h.writeUInt32BE(8 + data.length, 4);
    parts.push(h, data);
  }
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.write("icns", 0, "ascii");
  h.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([h, body]);
}

const out: Record<string, Uint8Array | string> = {
  "apps/web/static/favicon.ico": ico([32]),
  "apps/web/static/icon-192.png": png(192),
  "apps/web/static/apple-touch-icon.png": png(180),
  "apps/web/static/connector-icon.png": png(192, connector),
  "packages/ai/mcp/assets/icon.png": png(128, connector),
  "packaging/icons/icon.ico": ico([16, 24, 32, 48, 64, 256]),
  "apps/tray/assets/icon.ico": ico([16, 24, 32, 48, 64, 256]),
  "packaging/icons/icon.icns": icns(),
  "apps/tray/assets/tray.png": png(44, template),
};
for (const [rel, data] of Object.entries(out)) {
  writeFileSync(join(root, rel), data);
  console.log(`[icons] ${rel}`);
}
