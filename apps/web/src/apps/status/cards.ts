// the pages' pieces: panels, the headline strip, meter and key rows
import { esc, humanSize } from '../../lib/util.ts';
import { bar, pct } from './glyphs.ts';
import { type Page, type Panel, stNet } from './state.ts';

// a panel: its head a word in its kind's hue, then its body
export function panel(kind: string, title: string): Panel {
  const box = document.createElement('section');
  box.className = `st-panel st-${kind}`;
  box.innerHTML = `<header class="st-panel-head"><span class="st-panel-t">${title}</span></header><div class="st-panel-body"></div>`;
  return { box, head: box.firstElementChild as HTMLElement, body: box.lastElementChild as HTMLElement };
}

// a panel's head: its word, then a dim detail after it
export const panelHead = (p: Panel, title: string, detail = '') =>
  setHtml(p.head, `<span class="st-panel-t">${title}</span>${detail ? `<span class="st-dim">${detail}</span>` : ''}`);

// a page's frame: facts, headline strip, the cpu and net graphs, then the panels named
export function pageFrame(panels: [string, string][]): Page {
  const node = document.createElement('div');
  node.className = 'st-page';
  node.innerHTML =
    '<div class="st-facts"></div><div class="st-stats"></div><div class="st-graphs"></div><div class="st-panels"></div>';
  const [facts, stats, graphs, rest] = node.children as unknown as HTMLElement[];
  const cpu = panel('cpu', 'cpu');
  cpu.body.innerHTML = '<canvas class="st-graph"></canvas><div class="st-line"></div>';
  const [graph, line] = cpu.body.children as unknown as [HTMLCanvasElement, HTMLElement];
  const net = panel('net', 'net');
  net.body.innerHTML =
    '<canvas class="st-graph"></canvas><div class="st-line"></div><canvas class="st-graph"></canvas><div class="st-line"></div>';
  const [rx, rates, tx, day] = net.body.children as unknown as [
    HTMLCanvasElement,
    HTMLElement,
    HTMLCanvasElement,
    HTMLElement,
  ];
  graphs!.append(cpu.box, net.box);
  const box: Record<string, Panel> = {};
  for (const [k, t] of panels) {
    box[k] = panel(k, t);
    rest!.append(box[k].box);
  }
  return {
    node,
    facts: facts!,
    stats: stats!,
    cpu: { ...cpu, graph, line },
    net: { ...net, rx, tx, rates, day },
    panels: rest!,
    box,
  };
}

// a headline: its word, the value, a detail under it, a bar of its share
export const stat = (kind: string, k: string, v: string, d: string, frac?: number) =>
  `<div class="st-stat st-${kind}"><span class="st-stat-k">${k}</span><span class="st-stat-v">${v}</span>` +
  `<span class="st-stat-d">${d}</span>${frac === undefined ? '' : bar(frac)}</div>`;

// key, a bar to the row's width, a value
export const meterRow = (k: string, frac: number, val: string, cls?: string) =>
  `<div class="st-meter"><span class="st-key">${esc(k)}</span>${bar(frac, cls)}<span class="st-val">${val}</span></div>`;
// key, a value
export const kvRow = (k: string, v: string) =>
  `<div class="st-kv"><span class="st-key">${esc(k)}</span><span class="st-val">${v}</span></div>`;

// html set only when changed, no reflow a tick
const drawn = new WeakMap<HTMLElement, string>();
export function setHtml(el: HTMLElement, html: string) {
  if (drawn.get(el) === html) return;
  drawn.set(el, html);
  el.innerHTML = html;
}

export const usedOf = (a: number, b: number) => `${humanSize(a)}<span class="st-dim"> / ${humanSize(b)}</span>`;
export const usedPct = (a: number, b: number) => `${usedOf(a, b)} <span class="st-pct">${pct(a / b)}</span>`;
export const dotJoin = (bits: (string | false | number | undefined | null)[]) =>
  bits.filter(Boolean).join('<span class="st-dim"> · </span>');
export const hostServices = (name: string) => (stNet?.routes || []).filter((r) => r.host === name);
