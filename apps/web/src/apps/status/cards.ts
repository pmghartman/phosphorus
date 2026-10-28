// cards
import { humanSize } from '../../lib/util.ts';
import { stToggle } from '../status.ts';
import { drawCpu, drawCtr, drawDisk, drawGpu, drawMem, drawNet, drawProc } from './boxes.ts';
import { pct } from './glyphs.ts';
import { ST_GRAPH_MAX, ST_GRAPH_MIN, ST_TILE_MAX, ST_TILE_MIN, modelVars } from './model.ts';
import { stHostsEl, stNet, stateVars, statusDraw, type Parts, type StHost } from './state.ts';
import { stMeshEl, stTopEl } from './summary.ts';

// box, title, its drawing
export const ST_BOXES: [string, string, (p: Parts, h: StHost) => void][] = [['cpu', 'cpu', drawCpu], ['mem', 'mem', drawMem], ['disk', 'disk', drawDisk], ['net', 'net', drawNet],
  ['gpu', 'gpu', drawGpu], ['ctr', 'phosphorus', drawCtr], ['proc', 'processes', drawProc]];

// a tile of the headline numbers, clicked open to the full btop grid; a model
// host's model box beside the tile's graphs, and among the open grid's boxes
export function stCard(name: string): { card: HTMLElement; parts: Parts } {
  const card = document.createElement('section');
  card.className = 'st-card';
  card.dataset.host = name;
  card.innerHTML = '<div class="st-card-head"></div><div class="st-tile"><div class="st-sum"><canvas class="st-graph st-sum-cpu"></canvas>'
    + '<div class="st-sum-rows"></div><div class="st-row st-sum-netrow"><span class="st-key">net</span><span></span>'
    + '<div class="st-sum-net"><canvas class="st-graph"></canvas><canvas class="st-graph"></canvas></div></div></div>'
    + '<div class="st-box st-model" hidden><div class="st-head">model</div><div class="st-body"></div></div></div><div class="st-grid"></div>';
  const grid = card.querySelector('.st-grid')!;
  const tile = card.querySelector('.st-tile') as HTMLElement;
  const modelBox = tile.lastElementChild as HTMLElement;
  const parts = { head: card.querySelector('.st-card-head') as HTMLElement, tile, modelBox, model: modelBox.lastElementChild as HTMLElement, modelHtml: '' } as Parts;
  const [cpuGraph, rows, netRow] = tile.firstElementChild!.children as unknown as [HTMLCanvasElement, HTMLElement, HTMLElement];
  parts.sum = rows;
  parts.sumCpu = cpuGraph;
  parts.sumNet = netRow.children[1] as HTMLElement;
  [parts.sumRx, parts.sumTx] = netRow.lastElementChild!.children as unknown as [HTMLCanvasElement, HTMLCanvasElement];
  card.tabIndex = 0;
  card.addEventListener('click', () => stToggle(name));
  for (const [k, t] of ST_BOXES) {
    const b = document.createElement('div');
    b.className = `st-box st-${k}`;
    b.innerHTML = `<div class="st-head">${t}</div><div class="st-body"></div>`;
    grid.appendChild(b);
    parts[k] = b.querySelector('.st-body');
    parts[`${k}Head`] = b.querySelector('.st-head');
    parts[`${k}Box`] = b;
  }
  return { card, parts };
}

export const usedOf = (a: number, b: number) => `${pct(a / b).padStart(4)} <span class="st-dim">${humanSize(a)}/${humanSize(b)}</span>`;
export const dotJoin = (bits: (string | false | number | undefined | null)[]) => bits.filter(Boolean).join('<span class="st-dim"> · </span>');
export const hostServices = (name: string) => (stNet?.routes || []).filter((r) => r.host === name && r.type !== 'game');

export function fitTiles(names: string[]) {
  const view = stHostsEl.parentElement!;
  const tile = (stHostsEl.querySelector('.st-card:not(.open):not(.waiting):not(.has-model)') || stHostsEl.querySelector('.st-card:not(.open):not(.waiting)')) as HTMLElement | null;
  if (!tile) return;
  // a host open: the page scrolling anyway, the rest kept compact
  if (stateVars.stOpenHost) {
    modelVars.stFit = '';
    stHostsEl.style.setProperty('--st-sum-graph', `${ST_GRAPH_MAX}px`);
    return;
  }
  const css = getComputedStyle(stHostsEl);
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const colGap = parseFloat(css.columnGap) || 0;
  const rowGap = parseFloat(css.rowGap) || 0;
  const vs = getComputedStyle(view);
  const avail = view.clientHeight - parseFloat(vs.paddingTop) - parseFloat(vs.paddingBottom)
    - (stMeshEl.hidden ? 0 : stTopEl.offsetHeight + parseFloat(getComputedStyle(stTopEl).marginBottom));
  const width = stHostsEl.clientWidth;
  const graph = tile.querySelector('.st-sum-cpu') as HTMLElement;
  const base = tile.offsetHeight - graph.offsetHeight;
  const fits = (w: number) => Math.max(1, Math.floor((width + colGap) / (w * rem + colGap)));
  const rowsFit = Math.max(1, Math.floor((avail + rowGap) / (base + ST_GRAPH_MIN + rowGap)));
  const most = Math.min(names.length, fits(ST_TILE_MIN), Math.max(fits(ST_TILE_MAX), Math.ceil(names.length / rowsFit)));
  const rows = Math.ceil(names.length / most);
  // rows evened out: 4 hosts as 2 by 2, never 3 and a lone 1
  const cols = Math.ceil(names.length / rows);
  // the rows not fitting even at their smallest (a phone): scrolling anyway, so no shrinking
  const h = rows * (base + ST_GRAPH_MIN + rowGap) - rowGap > avail ? ST_GRAPH_MAX / 2
    : Math.round(Math.max(ST_GRAPH_MIN, Math.min(ST_GRAPH_MAX, (avail - rowGap * (rows - 1)) / rows - base)));
  const fit = `${cols}/${h}`;
  if (fit === modelVars.stFit) return;
  modelVars.stFit = fit;
  stHostsEl.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  // a model host's tile twice as wide where three columns or more fit, its model box beside its graphs
  stHostsEl.classList.toggle('st-wide', cols >= 3);
  stHostsEl.style.setProperty('--st-sum-graph', `${h}px`);
  statusDraw();
}
