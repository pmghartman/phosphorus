// the mesh's last day by the hour: each host's hours summed by their end, drawn as one graph
// of cpu, memory, disk and gpu out of 100% with each hour's peak, net's 24h totals under it
import { esc, humanSize, when } from '../../lib/util.ts';
import { dotJoin, panelHead, setHtml } from './cards.ts';
import type { Panel, StHost } from './state.ts';

type Series = (number | null)[];
const keys = ['rx', 'tx', 'cpu', 'mem', 'disk', 'gpu', 'cpuPeak', 'memPeak', 'gpuPeak'] as const;
type Key = (typeof keys)[number];
export type MeshTrend = { at: number; step: number; since: number } & Record<Key, Series>;

// net added, cpu weighted by cores, memory and disk by size, gpu the mean of hosts reading one
export function meshTrend(live: StHost[]): MeshTrend | null {
  const all = live.filter((h) => h.trend?.rx.length);
  if (!all.length) return null;
  const step = all[0]!.trend!.step;
  const ts = all.filter((h) => h.trend!.step === step);
  const at = Math.max(...ts.map((h) => h.trend!.at));
  const n = Math.max(...ts.map((h) => h.trend!.rx.length));
  const out = { at, step, since: at } as MeshTrend;
  for (const k of keys) out[k] = [];
  for (const h of ts) if (h.trend!.since !== null) out.since = Math.min(out.since, h.trend!.since);
  for (let i = 0; i < n; i++) {
    const mark = at - (n - 1 - i) * step;
    let rx: number | null = null;
    let tx: number | null = null;
    const acc: Partial<Record<Key, [number, number]>> = {};
    const add = (k: Key, v: number | null | undefined, w: number) => {
      if (v == null || !w) return;
      const a = (acc[k] ??= [0, 0]);
      a[0] += w;
      a[1] += w * v;
    };
    for (const h of ts) {
      const t = h.trend!;
      const j = t.rx.length - 1 - Math.round((t.at - mark) / step);
      if (j < 0 || j >= t.rx.length) continue;
      if (t.rx[j] != null) rx = (rx ?? 0) + t.rx[j]!;
      if (t.tx[j] != null) tx = (tx ?? 0) + t.tx[j]!;
      const cores = h.s!.cpu.cores.length || 1;
      add('cpu', t.cpu[j], cores);
      add('cpuPeak', t.cpuPeak?.[j], cores);
      add('mem', t.mem[j], h.s!.mem.total || 0);
      add('memPeak', t.memPeak?.[j], h.s!.mem.total || 0);
      add('disk', t.disk?.[j], h.s!.disk.total || 0);
      add('gpu', t.gpu?.[j], 1);
      add('gpuPeak', t.gpuPeak?.[j], 1);
    }
    out.rx.push(rx);
    out.tx.push(tx);
    for (const k of keys.slice(2)) out[k].push(acc[k] ? acc[k]![1] / acc[k]![0] : null);
  }
  return out;
}

const last = (s: Series) => [...s].reverse().find((v) => v != null) ?? null;
const pctOf = (v: number | null) => (v == null ? '–' : `${v.toFixed(1)}%`);
const sizeOf = (v: number | null) => (v == null ? '–' : humanSize(v));
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).toLowerCase();

type Line = { k: string; name: string; s: Series; peak?: Series };
const usage = (t: MeshTrend): Line[] =>
  [
    { k: 'cpu', name: 'cpu', s: t.cpu, peak: t.cpuPeak },
    { k: 'mem', name: 'mem', s: t.mem, peak: t.memPeak },
    { k: 'disk', name: 'disk', s: t.disk },
    { k: 'gpu', name: 'gpu', s: t.gpu, peak: t.gpuPeak },
  ].filter((l) => l.s.some((v) => v != null));
const nets = (t: MeshTrend): Line[] => [
  { k: 'rx', name: '▼ in', s: t.rx },
  { k: 'tx', name: '▲ out', s: t.tx },
];

// a round top for bytes: 1, 2 or 5 of a power of ten in the unit humanSize reads it in
function niceBytes(v: number): number {
  if (v <= 0) return 1 << 20;
  const u = 1024 ** Math.max(0, Math.floor(Math.log(v) / Math.log(1024)));
  const e = 10 ** Math.floor(Math.log10(v / u));
  return ([1, 2, 5, 10].find((m) => m * e * u >= v) ?? 10) * e * u;
}

// the plot's frame: left gutter for the axis, the usage band, the net band under it
const G = { l: 46, r: 8, top: 6, h1: 150, gap: 22, h2: 64, axis: 18 };

// each hour a band, x its centre, one x axis for both plots
const frame = (n: number, W: number) => {
  const w = Math.max(40, W - G.l - G.r);
  const band = w / Math.max(1, n);
  return { w, band, x: (i: number) => G.l + (i + 0.5) * band };
};

// a series as polylines broken at gaps, a dot on every hour read
function path(s: Series, x: (i: number) => number, y: (v: number) => number, cls: string): string {
  const runs: string[][] = [[]];
  let dots = '';
  s.forEach((v, i) => {
    if (v == null) {
      if (runs.at(-1)!.length) runs.push([]);
      return;
    }
    const [px, py] = [x(i).toFixed(1), y(v).toFixed(1)];
    runs.at(-1)!.push(`${px},${py}`);
    dots += `<circle class="st-tr-${cls} st-tr-dot" cx="${px}" cy="${py}" r="2.5"/>`;
  });
  const lines = runs
    .filter((r) => r.length > 1)
    .map((r) => `<polyline class="st-tr-${cls}" points="${r.join(' ')}"/>`)
    .join('');
  return lines + dots;
}

// each hour's peak: a stem up from its average, capped
function peaks(l: Line, x: (i: number) => number, y: (v: number) => number): string {
  let out = '';
  l.peak?.forEach((p, i) => {
    const v = l.s[i];
    if (p == null || v == null || y(v) - y(p) < 2) return;
    const [cx, a, b] = [x(i).toFixed(1), y(v).toFixed(1), y(p).toFixed(1)];
    out +=
      `<line class="st-tr-${l.k} st-tr-peak" x1="${cx}" x2="${cx}" y1="${a}" y2="${b}"/>` +
      `<line class="st-tr-${l.k} st-tr-peak" x1="${(x(i) - 3).toFixed(1)}" x2="${(x(i) + 3).toFixed(1)}" y1="${b}" y2="${b}"/>`;
  });
  return out;
}

function svgOf(t: MeshTrend, W: number): string {
  const n = t.rx.length;
  const { w, band, x } = frame(n, W);
  const y1 = (v: number) => G.top + (1 - Math.min(Math.max(v, 0), 100) / 100) * G.h1;
  const b2 = G.top + G.h1 + G.gap;
  const base = b2 + G.h2;
  const top2 = niceBytes(Math.max(0, ...t.rx.map((v) => v ?? 0), ...t.tx.map((v) => v ?? 0)));
  const y2 = (v: number) => b2 + (1 - Math.min(v / top2, 1)) * G.h2;
  const H = base + G.axis;
  const grid = (yy: number, label: string) =>
    `<line class="st-tr-grid" x1="${G.l}" x2="${G.l + w}" y1="${yy}" y2="${yy}"/>` +
    `<text class="st-tr-tick" x="${G.l - 6}" y="${yy + 3.5}" text-anchor="end">${label}</text>`;
  let out = [100, 75, 50, 25, 0].map((v) => grid(y1(v), `${v}%`)).join('');
  out += [top2, top2 / 2, 0].map((v) => grid(y2(v), v ? humanSize(v) : '0')).join('');
  // an hour's start every six on the clock, kept off the right edge's now
  const startOf = (i: number) => t.at - (n - i) * t.step;
  for (let i = 0; i < n; i++) {
    const d = new Date(startOf(i));
    if (d.getMinutes() || d.getHours() % 6) continue;
    const gx = G.l + i * band;
    out += `<line class="st-tr-grid st-tr-v" x1="${gx}" x2="${gx}" y1="${G.top}" y2="${base}"/>`;
    if (gx < G.l + w - 40)
      out += `<text class="st-tr-tick" x="${gx}" y="${H - 4}" text-anchor="middle">${clock(startOf(i))}</text>`;
  }
  out += `<text class="st-tr-tick" x="${G.l + w}" y="${H - 4}" text-anchor="end">now</text>`;
  const ls = usage(t);
  for (const l of ls) out += peaks(l, x, y1);
  for (const l of ls) out += path(l.s, x, y1, l.k);
  // net: the day's in and out as each hour ended
  for (const l of nets(t)) out += path(l.s, x, y2, l.k);
  const label = `the last 24 hours: ${ls.map((l) => `${l.name} ${pctOf(last(l.s))}`).join(', ')}; net in ${sizeOf(last(t.rx))}, out ${sizeOf(last(t.tx))}`;
  return (
    `<svg class="st-tr-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">` +
    `<rect class="st-tr-hl" x="0" y="${G.top}" width="${band}" height="${base - G.top}" visibility="hidden"/>` +
    `${out}</svg>`
  );
}

const key = (k: string, name: string, v: string) =>
  `<span class="st-tr-key"><i class="st-tr-sw st-tr-${k}"></i>${esc(name)} <b>${v}</b></span>`;

// each line's last hour, net's last 24h
function legendOf(t: MeshTrend): string {
  return (
    usage(t)
      .map((l) => key(l.k, l.name, pctOf(last(l.s))))
      .join('') +
    '<span class="st-tr-sep"></span>' +
    nets(t)
      .map((l) => key(l.k, `${l.name} 24h`, sizeOf(last(l.s))))
      .join('')
  );
}

// an hour's figures beside it: each average, its peak of 5 minutes, the day's bytes to then
function tipOf(t: MeshTrend, i: number): string {
  const end = t.at - (t.rx.length - 1 - i) * t.step;
  const rows = usage(t).map((l) => [
    l.k,
    l.name,
    pctOf(l.s[i] ?? null),
    l.peak?.[i] != null ? `peak ${pctOf(l.peak[i]!)}` : '',
  ]);
  for (const l of nets(t)) rows.push([l.k, l.name, sizeOf(l.s[i] ?? null), '24h to then']);
  return (
    `<div class="st-dim">${clock(end - t.step)} to ${i === t.rx.length - 1 ? 'now' : clock(end)}</div>` +
    rows
      .map(
        ([k, n, v, p]) =>
          `<div class="st-tr-row"><i class="st-tr-sw st-tr-${k}"></i>${esc(n!)}<b>${v}</b><span class="st-dim">${p}</span></div>`,
      )
      .join('')
  );
}

type View = { legend: HTMLElement; plot: HTMLElement; tip: HTMLElement; t?: MeshTrend; w: number };
const views = new WeakMap<Panel, View>();

function viewOf(p: Panel): View {
  const had = views.get(p);
  if (had) return had;
  p.body.innerHTML =
    '<div class="st-tr-legend"></div><div class="st-tr-plot"></div><div class="st-tr-tip" hidden></div>';
  const [legend, plot, tip] = p.body.children as unknown as HTMLElement[];
  const v: View = { legend: legend!, plot: plot!, tip: tip!, w: 0 };
  views.set(p, v);
  new ResizeObserver(() => {
    if (v.t && plot!.clientWidth !== v.w) paint(v);
  }).observe(plot!);
  plot!.addEventListener('pointermove', (e) => hover(v, e));
  plot!.addEventListener('pointerleave', () => hover(v));
  return v;
}

function paint(v: View) {
  v.w = v.plot.clientWidth;
  if (!v.w || !v.t) return;
  setHtml(v.plot, svgOf(v.t, v.w));
}

function hover(v: View, e?: PointerEvent) {
  const hl = v.plot.querySelector('.st-tr-hl');
  const t = v.t;
  const n = t?.rx.length ?? 0;
  const r = v.plot.getBoundingClientRect();
  const { band, x } = frame(n, r.width);
  const px = e ? e.clientX - r.left : -1;
  if (!t || !hl || !e || !n || px < G.l || px > r.width - G.r) {
    hl?.setAttribute('visibility', 'hidden');
    v.tip.hidden = true;
    return;
  }
  const i = Math.max(0, Math.min(n - 1, Math.floor((px - G.l) / band)));
  hl.setAttribute('x', String(G.l + i * band));
  hl.setAttribute('visibility', 'visible');
  v.tip.innerHTML = tipOf(t, i);
  v.tip.hidden = false;
  // beside the hour, flipped left past the middle
  const cx = x(i);
  const left = cx > r.width / 2;
  v.tip.style.left = left ? '' : `${cx + band / 2 + 8}px`;
  v.tip.style.right = left ? `${r.width - cx + band / 2 + 8}px` : '';
  v.tip.style.top = `${v.plot.offsetTop + G.top}px`;
}

export function drawTrend(p: Panel, t: MeshTrend | null) {
  if (!t) {
    panelHead(p, '24h');
    if (views.delete(p) || !p.body.querySelector('.st-tr-none'))
      p.body.innerHTML = '<div class="st-dim st-tr-none">no day counted yet</div>';
    return;
  }
  // a window starting before the first hour only part of a day
  const partial = t.since > t.at - t.rx.length * t.step;
  panelHead(p, '24h', dotJoin(['by the hour', partial && `counted since ${esc(when(t.since))}`]));
  const v = viewOf(p);
  v.t = t;
  setHtml(v.legend, legendOf(t));
  paint(v);
}
