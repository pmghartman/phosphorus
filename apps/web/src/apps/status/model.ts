// model

import type { ModelHost, StatsSample } from '@phosphorus/wire';
import { pingClass, steadyRtt } from '../../features/mesh/mesh.ts';
import { st } from '../../lib/state.ts';
import { esc, plural } from '../../lib/util.ts';
import { dotJoin, hostServices, usedOf } from './cards.ts';
import { ctxCells, kTok } from './context.ts';
import { cpuTop, dotGraph, meter, meterCells, netScale, pct, rate, uptime } from './glyphs.ts';
import { type Parts, type StHost, stNet } from './state.ts';

// the mesh's models as the status tab shows them: nothing at all until some
// host has [model] host = true, and then only on the hosts that do

export const stModel = () => stNet?.model || null;
export const stModels = () => stModel()?.models || [];
export const modelOf = (host: string) => stModels().find((x) => x.host === host) || null;

// loaded, loading, downloading with its share done, else not loaded
export function modelPhase(m: ModelHost): [string, string] {
  if (m.ready) return ['st-lo', 'loaded'];
  if (m.download && m.download.total) return ['st-mid', `downloading ${pct(m.download.done / m.download.total)}`];
  if (m.loading) return ['st-mid', 'loading'];
  return ['st-hi', 'not loaded'];
}

// open: every detail, a tile: name, platform, uptime and ping only
export function headLine(name: string, h: StHost, open: boolean): string {
  const s: Partial<StatsSample> = h.s || {};
  const dev = (stNet?.tailnet || []).find((d) => d.name === name) || ({} as { os?: string; version?: string });
  const git = (stNet?.gitHosts || []).find((g) => g.host === name);
  const svc = hostServices(name);
  const rtt = steadyRtt(name);
  return dotJoin([
    `<span class="st-name${name === st.selfHost ? ' self' : ''}">${esc(name)}</span>`,
    esc(s.platform || dev.os || '?'),
    open && (s.version || dev.version) && `v${esc(s.version || dev.version)}`,
    open && s.uptime && `up ${uptime(s.uptime)}`,
    typeof rtt === 'number' && `<span class="mesh-stat-ping ${pingClass(rtt)}">${rtt}ms</span>`,
    open && git?.role && `<span class="st-git">git ${esc(git.role)}</span>`,
    modelOf(name) && '<span class="st-model-mark">model</span>',
    open && svc.length && plural(svc.length, 'service'),
    // a tile's whole head the click, only an open card showing its fold
    open && '<span class="st-dim">▴</span>',
  ]);
}

// key, then a value wrapped under itself rather than cut
const wrapRow = (k: string, v: string) => `<div class="st-row st-wrap"><span class="st-key">${k}</span>${v}</div>`;

// key, bar to the row's width, a right hand value
export const SUM_VAL = 18;
export const sumRow = (k: string, frac: number, cells: number, val: string, cls?: string) =>
  `<div class="st-row"><span class="st-key">${esc(k)}</span>` + `${meter(frac, cells, cls)} ${val}</div>`;

export function drawSum(p: Parts, h: StHost) {
  const { cpu, mem, disk, gpus } = h.s!;
  const rx = h.hist.rx!.at(-1) || 0;
  const tx = h.hist.tx!.at(-1) || 0;
  dotGraph(p.sumCpu, h.hist.cpu!, cpuTop(h.hist.cpu!), () => '--sage');
  const max = netScale(h);
  dotGraph(p.sumRx, h.hist.rx!, max, () => '--accent');
  dotGraph(p.sumTx, h.hist.tx!, max, () => '--teal', true);
  const cells = meterCells(p.sum, 8 + SUM_VAL);
  const load = gpus.filter((g) => g.util !== null);
  const gpuLoad = load.reduce((a, g) => a + g.util!, 0) / Math.max(1, load.length) / 100;
  p.sum.innerHTML = [
    sumRow(
      'cpu',
      cpu.total / 100,
      cells,
      `${pct(cpu.total / 100).padStart(4)}${cpu.load[0] == null ? '' : ` <span class="st-dim">load ${cpu.load[0].toFixed(2)}</span>`}`,
    ),
    sumRow('mem', mem.used / mem.total, cells, usedOf(mem.used, mem.total)),
    sumRow('disk', disk.used / disk.total, cells, usedOf(disk.used, disk.total)),
    load.length &&
      sumRow(
        'gpu',
        gpuLoad,
        cells,
        `${pct(gpuLoad).padStart(4)} <span class="st-dim">${plural(gpus.length, 'gpu')}</span>`,
      ),
  ]
    .filter(Boolean)
    .join('');
  p.sumNet.innerHTML = `<span class="st-rx">▼ ${rate(rx).padEnd(9)}</span> <span class="st-tx">▲ ${rate(tx).padEnd(9)}</span>`;
}

// a model host's model box: phase and speed, its file, the context window as
// its last ask left it, the agents asking it

export function modelHtml(m: ModelHost): string {
  const [cls, phase] = modelPhase(m);
  const head = dotJoin([
    `<span class="${cls}">${esc(phase)}</span>`,
    m.ready && m.use?.tps && `<b>${m.use.tps}</b> <span class="st-dim">tok/s</span>`,
  ]);
  const agents = m.agents?.length
    ? m.agents.map((a) => `<span class="st-model-a">${esc(a)}</span>`).join('')
    : '<span class="st-dim">no agents</span>';
  let ctx = '';
  if (m.ready && m.ctx) {
    const { cells, parts, used } = ctxCells(m);
    // counts by colour alone, the names on hover
    const legend = [
      `<span>${kTok(used)}/${kTok(m.ctx)} <span class="st-dim">${pct(used / m.ctx)}</span></span>`,
      ...parts.map(([k, label, n]) => `<span title="${label}"><i class="ctx-${k} full"></i>${kTok(n)}</span>`),
      `<span title="free"><i></i>${kTok(m.ctx - used)}</span>`,
    ].join(' ');
    ctx = `<div class="st-ctx"><div class="st-ctx-grid">${cells}</div><div class="st-model-key">${legend}</div></div>`;
  }
  const file = m.file
    ? `<div class="st-model-file st-dim" title="${esc(m.file)}">${esc(String(m.file).replace(/\\/g, '/').split('/').pop())}</div>`
    : '';
  const clear = m.ready
    ? `<button type="button" class="st-clear" data-host="${esc(m.host)}" title="erase ${esc(m.host)}'s context windows">clear context</button>`
    : '';
  return `<div class="st-model-head">${head}</div>${file}${ctx}<div class="st-model-foot"><div class="st-model-agents">${agents}</div>${clear}</div>`;
}

// the box drawn only when its html changed, no reflow a tick; it sits beside
// the tile's graphs, or in the open grid after cpu
export function drawModel(p: Parts, m: ModelHost | null, open: boolean) {
  p.modelBox.hidden = !m;
  const html = m ? modelHtml(m) : '';
  if (html !== p.modelHtml) {
    p.modelHtml = html;
    p.model.innerHTML = html;
  }
  if (open) {
    if (p.modelBox.previousElementSibling !== p.cpuBox) (p.cpuBox as HTMLElement).after(p.modelBox);
  } else if (p.modelBox.parentElement !== p.tile) p.tile.append(p.modelBox);
}

// tile widths in rem: the narrowest still legible, the widest before another column
export const ST_TILE_MIN = 15;
export const ST_TILE_MAX = 21;
// px, the tiles' cpu graph, shrunk toward the min only to spare a scroll, never grown past the max
export const ST_GRAPH_MIN = 12;
export const ST_GRAPH_MAX = 160;

// the module's variables other modules set
export const modelVars = {
  // columns enough that every tile fits the view unscrolled, spare height left empty
  stFit: '',
};
