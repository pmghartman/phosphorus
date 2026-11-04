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

// an area graph on a canvas, newest on the right: a line over a soft fill, in the hue of
// its peak; down hangs it from the top, for the second of a pair
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
  // a sample every half character, fine times more, so a window keeps its span of time
  const px = chWidth('0') / 2 / fine;
  const v = values.slice(-Math.max(2, Math.floor(w / px) + 1));
  if (v.length < 2) return;
  const x0 = w - (v.length - 1) * px;
  const edge = down ? 0.5 : h - 0.5;
  const at = (val: number) => {
    const f = max > 0 ? Math.min(Math.max(val, 0), max) / max : 0;
    return down ? 1 + f * (h - 2) : h - 1 - f * (h - 2);
  };
  const color = cssVar(hue(Math.min(1, Math.max(0, ...v) / (max || 1))));
  g.beginPath();
  g.moveTo(x0, at(v[0]!));
  v.forEach((val, i) => g.lineTo(x0 + i * px, at(val)));
  g.lineJoin = 'round';
  g.lineWidth = 1.5;
  g.strokeStyle = color;
  g.stroke();
  g.lineTo(w, edge);
  g.lineTo(x0, edge);
  g.closePath();
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16);
    const rgba = (a: number) => `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
    const fade = g.createLinearGradient(0, down ? h : 0, 0, edge);
    fade.addColorStop(0, rgba(0.32));
    fade.addColorStop(1, rgba(0.03));
    g.fillStyle = fade;
  } else {
    g.globalAlpha = 0.15;
    g.fillStyle = color;
  }
  g.fill();
  g.globalAlpha = 1;
}

export const rate = (n: number) => `${humanSize(n)}/s`;
export const pct = (f: number) => `${Math.round(f * 100)}%`;

export function uptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

// quick to grow, slow to shrink, no jumping graph
export function netScale(h: StHost): number {
  const peak = Math.max(1024, ...h.hist.rx!, ...h.hist.tx!);
  h.netMax = Math.max(peak, (h.netMax || 0) * 0.98);
  return h.netMax;
}
