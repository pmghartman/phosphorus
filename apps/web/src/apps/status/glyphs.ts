// glyphs
import { cssVar } from '../../lib/dom.ts';
import { humanSize } from '../../lib/util.ts';
import { type StHost, stView } from './state.ts';

// low to high: sage, sand, rose
export const heat = (t: number) => (t < 0.5 ? 'st-lo' : t < 0.8 ? 'st-mid' : 'st-hi');

// a glyph's width in the view's font, measured again once a font lands
export const stCh = new Map<string, number>();
document.fonts.addEventListener('loadingdone', () => stCh.clear());
export function chWidth(glyph: string): number {
  if (stCh.has(glyph)) return stCh.get(glyph)!;
  const probe = document.createElement('span');
  probe.className = 'st-probe';
  probe.textContent = glyph.repeat(20);
  stView.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 20;
  probe.remove();
  if (w) stCh.set(glyph, w);
  return w || 8;
}
// a share as a thin bar, filled by heat unless a class is given
export function bar(frac: number, cls?: string): string {
  const f = Math.max(0, Math.min(1, frac || 0));
  return `<span class="st-bar"><i class="${cls || heat(f)}" style="width:${(f * 100).toFixed(1)}%"></i></span>`;
}

// an area graph as dots on a canvas, newest on the right
export const HEAT_VAR: Record<string, string> = { 'st-lo': '--sage', 'st-mid': '--sand', 'st-hi': '--rose' };
export const heatVar = (t: number) => HEAT_VAR[heat(t)]!;
export function dotGraph(
  canvas: HTMLCanvasElement,
  values: number[],
  max: number,
  hue: (t: number) => string,
  down?: boolean,
  fine = 1,
) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  // two dot columns and four dot rows to a character cell, fine times more
  const px = chWidth('0') / 2 / fine;
  const cols = Math.floor(w / px);
  const rows = Math.max(1, Math.floor(h / (px * 1.4)));
  const py = h / rows;
  const colors = Array.from({ length: rows }, (_, d) => cssVar(hue(d / Math.max(1, rows - 1))));
  const v = values.slice(-cols);
  const x0 = w - v.length * px;
  v.forEach((val, i) => {
    const level = val > 0 ? Math.max(1, Math.round((Math.min(val, max) / max) * rows)) : 0;
    for (let d = 0; d < level; d++) {
      g.fillStyle = colors[d]!;
      const y = down ? d * py : h - (d + 1) * py;
      g.fillRect(x0 + i * px + px * 0.2, y + py * 0.2, px * 0.6, py * 0.6);
    }
  });
}

export const rate = (n: number) => `${humanSize(n)}/s`;
export const pct = (f: number) => `${Math.round(f * 100)}%`;

export function uptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

// relative: the graph's top its own recent peak so a quiet host still moves,
// one hue since height no longer means heat
export const cpuTop = (v: number[]) => Math.max(5, Math.ceil(Math.max(0, ...v) * 1.15));

// quick to grow, slow to shrink, no jumping graph
export function netScale(h: StHost): number {
  const peak = Math.max(1024, ...h.hist.rx!, ...h.hist.tx!);
  h.netMax = Math.max(peak, (h.netMax || 0) * 0.98);
  return h.netMax;
}
