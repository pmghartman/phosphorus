// icons: every platform's icon rendered from the tab icon apps/web/static/favicon.svg,
// the macOS menu bar's template its black silhouette; run after the mark changes
//   bun run icons
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const root = resolve(import.meta.dir, "..");
const src = readFileSync(join(root, "apps/web/static/favicon.svg"), "utf8");
// the connector's tile: the mesh's own dark, edge to edge (claude.ai frames icons on white)
const tile = "#141414";
// the menu bar template: one color, cropped to the glyph so it fills the bar's height
const template = src.replace('fill="url(#g)"', 'fill="#000"').replace('viewBox="0 0 64 64"', 'viewBox="12 12 40 40"');

const png = (size: number, svg = src, background?: string) =>
  new Resvg(svg, { fitTo: { mode: "width", value: size }, background }).render().asPng();

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
  "apps/web/static/connector-icon.png": png(192, src, tile),
  "packages/ai/mcp/assets/icon.png": png(128, src, tile),
  "plugin/.claude-plugin/icon.png": png(1024),
  "packaging/icons/icon.ico": ico([16, 24, 32, 48, 64, 256]),
  "apps/tray/assets/icon.ico": ico([16, 24, 32, 48, 64, 256]),
  "packaging/icons/icon.icns": icns(),
  "apps/tray/assets/tray.png": png(44, template),
};
for (const [rel, data] of Object.entries(out)) {
  writeFileSync(join(root, rel), data);
  console.log(`[icons] ${rel}`);
}
