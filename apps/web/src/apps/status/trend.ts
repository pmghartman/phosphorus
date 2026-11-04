// the mesh's last day by the hour: each host's rolling 24h summed by hour mark,
// its headline chip and its panel of lines
import { esc, humanSize, when } from '../../lib/util.ts';
import { dotJoin, panelHead, setHtml } from './cards.ts';
import { heat } from './glyphs.ts';
import type { Panel, StHost } from './state.ts';

type Series = (number | null)[];
export type MeshTrend = { at: number; step: number; rx: Series; tx: Series; cpu: Series; mem: Series; since: number };

// net added, cpu weighted by cores and memory by size, each at its host's own hour mark
export function meshTrend(live: StHost[]): MeshTrend | null {
  const ts = live.filter((h) => h.trend?.rx.length);
  if (!ts.length) return null;
  const at = Math.max(...ts.map((h) => h.trend!.at));
  const step = ts[0]!.trend!.step;
  const n = ts[0]!.trend!.rx.length;
  const out: MeshTrend = { at, step, rx: [], tx: [], cpu: [], mem: [], since: at };
  for (const h of ts) if (h.trend!.since !== null) out.since = Math.min(out.since, h.trend!.since);
  for (let i = 0; i < n; i++) {
    const mark = at - (n - 1 - i) * step;
    let rx: number | null = null;
    let tx: number | null = null;
    let cw = 0;
    let cs = 0;
    let mw = 0;
    let ms = 0;
    for (const h of ts) {
      const t = h.trend!;
      const j = t.rx.length - 1 - Math.round((t.at - mark) / t.step);
      if (j < 0 || j >= t.rx.length) continue;
      if (t.rx[j] != null) rx = (rx ?? 0) + t.rx[j]!;
      if (t.tx[j] != null) tx = (tx ?? 0) + t.tx[j]!;
      const c = h.s!.cpu.cores.length || 1;
      if (t.cpu[j] != null) [cw, cs] = [cw + c, cs + c * t.cpu[j]!];
      const m = h.s!.mem.total || 0;
      if (t.mem[j] != null && m) [mw, ms] = [mw + m, ms + m * t.mem[j]!];
    }
    out.rx.push(rx);
    out.tx.push(tx);
    out.cpu.push(cw ? cs / cw : null);
    out.mem.push(mw ? ms / mw : null);
  }
  return out;
}

const last = (s: Series) => [...s].reverse().find((v) => v != null) ?? null;
const first = (s: Series) => s.find((v) => v != null) ?? null;
// a percent in its heat
const pctOf = (v: number | null) => (v == null ? '–' : `<span class="${heat(v / 100)}">${v.toFixed(1)}%</span>`);
const sizeOf = (v: number | null) => (v == null ? '–' : humanSize(v));

// a line over the hours, gaps left open, scaled to its own top or to max
function spark(s: Series, cls: string, max?: number): string {
  const got = s.filter((v): v is number => v != null);
  if (got.length < 2) return '<span class="st-trend-spark"></span>';
  const w = 96;
  const h = 18;
  const top = max ?? Math.max(...got);
  const runs: string[][] = [[]];
  s.forEach((v, i) => {
    if (v == null) {
      if (runs.at(-1)!.length) runs.push([]);
      return;
    }
    const x = (i / (s.length - 1)) * w;
    const y = h - 1 - (top > 0 ? Math.min(v / top, 1) : 0) * (h - 2);
    runs.at(-1)!.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  return (
    `<svg class="st-trend-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">` +
    runs
      .filter((r) => r.length)
      .map((r) =>
        r.length === 1
          ? `<circle cx="${r[0]!.split(',')[0]}" cy="${r[0]!.split(',')[1]}" r="1" class="${cls}"/>`
          : `<polyline points="${r.join(' ')}" class="${cls}"/>`,
      )
      .join('') +
    '</svg>'
  );
}

// the headline chip: the day's net now, its trend over the hours, the averages under
export function trendStat(t: MeshTrend | null, rx: number, tx: number): string {
  const net = t ? t.rx.map((v, i) => (v == null && t.tx[i] == null ? null : (v ?? 0) + (t.tx[i] ?? 0))) : [];
  return (
    '<div class="st-stat st-day" title="the last 24 hours, rolling: each point the day ending at that hour">' +
    '<span class="st-stat-k">24h</span>' +
    `<span class="st-stat-v"><span class="st-rx">▼</span> ${humanSize(rx)} <span class="st-tx">▲</span> ${humanSize(tx)}</span>` +
    `<span class="st-stat-d">${t ? dotJoin([`cpu avg ${pctOf(last(t.cpu))}`, `mem avg ${pctOf(last(t.mem))}`]) : 'counting'}</span>` +
    spark(net, 'st-trend-net') +
    '</div>'
  );
}

// a row: key, its line, the day now, the day an hour mark ago at the start
const row = (k: string, s: Series, cls: string, fmt: (v: number | null) => string, max?: number) =>
  `<div class="st-trend-row"><span class="st-key">${esc(k)}</span>${spark(s, cls, max)}` +
  `<span class="st-val">${fmt(last(s))}</span><span class="st-dim">${fmt(first(s))}</span></div>`;

export function drawTrend(p: Panel, t: MeshTrend | null) {
  if (!t) {
    panelHead(p, '24h');
    setHtml(p.body, '<div class="st-dim">no day counted yet</div>');
    return;
  }
  const hours = t.rx.length - 1;
  // a window starting before the first bucket only part of a day
  const partial = t.since > t.at - hours * t.step - 24 * 3600 * 1000;
  panelHead(p, '24h', dotJoin(['rolling, hourly', partial && `counted since ${esc(when(t.since))}`]));
  setHtml(
    p.body,
    `<div class="st-trend-row st-dim"><span></span><span></span><span>now</span><span>${hours}h ago</span></div>` +
      row('in', t.rx, 'st-trend-rx', sizeOf) +
      row('out', t.tx, 'st-trend-tx', sizeOf) +
      row('cpu avg', t.cpu, 'st-trend-cpu', pctOf, 100) +
      row('mem avg', t.mem, 'st-trend-mem', pctOf, 100),
  );
}
