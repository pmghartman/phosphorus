// drawing: each computer a chip in the pane's own pixels, its links beneath

import type { NetInfo, Route, State, TailnetDevice } from '@phosphorus/wire';
import { svgEl } from '../../lib/dom.ts';
import { st } from '../../lib/state.ts';
import { hostSwitch } from './hosts.ts';
import { reheat, type SimLink, setGraph, settle, simNodes, tick } from './layout.ts';
import { activeConnections, hostPlatform, serviceKey } from './routes.ts';
import { renderMeshStats } from './stats.ts';
import { meshAnimFrame, meshCount, meshGraphWrap, meshPanel, meshStats, meshSvg, meshT, uiVars } from './ui.ts';

// --- chips -------------------------------------------------------------------------

// text widths from the page's own font, cached until the root's type changes
const ctx = document.createElement('canvas').getContext('2d')!;
const widths = new Map<string, number>();
const fonts = new Map<string, string>();
let typeKey = '';
function checkType() {
  const cs = getComputedStyle(document.documentElement);
  const k = `${cs.fontSize}|${cs.fontFamily}|${cs.getPropertyValue('--fs-xs')}`;
  if (k === typeKey) return;
  typeKey = k;
  widths.clear();
  fonts.clear();
}
function textW(text: string, cls: string): number {
  const key = `${cls}|${text}`;
  let w = widths.get(key);
  if (w !== undefined) return w;
  let font = fonts.get(cls);
  if (!font) {
    const probe = meshSvg.appendChild(svgEl('text', { class: cls }));
    const cs = getComputedStyle(probe);
    font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    probe.remove();
    fonts.set(cls, font);
  }
  ctx.font = font;
  w = ctx.measureText(text).width;
  widths.set(key, w);
  return w;
}

const PAD = 6;
const DOT = 5;
const PIP = 4;
const TAG = 'model';

// a chip's parts and its size, worked out before the layout so it can hold them apart
export interface Chip {
  name: string;
  kind: 'host' | 'device';
  sub?: string;
  pips: number;
  model?: MeshModel;
  w: number;
  h: number;
}
export function chipOf(name: string, kind: 'host' | 'device', pips: number, sub?: string, model?: MeshModel): Chip {
  const label = kind === 'host' ? 'mesh-label' : 'mesh-label dev';
  let line = DOT + 5 + textW(name, label);
  if (model) line += 6 + textW(TAG, 'mesh-model-mark') + 6;
  if (pips) line += 6 + pips * (PIP + 2) - 2;
  const w = Math.ceil(2 * PAD + Math.max(line, sub ? textW(sub, 'mesh-hub-dns') : 0));
  const h = kind === 'host' ? (sub ? 30 : 19) : 16;
  return { name, kind, sub, pips, model, w, h };
}

// one chip at x,y: a hairline box, a status square, the name, the model tag and
// one pip a service; a host to switch to, a computer to open
export function drawChip(
  x: number,
  y: number,
  c: Chip,
  cls: string,
  dot: string,
  tooltip: string,
  o: { host?: string; desk?: string; services?: { name: string; tip: string; touched: boolean }[] },
) {
  const attrs: Record<string, string> = { class: `mesh-chip-g${o.host ? ' mesh-host' : ''} mesh-desk` };
  if (o.host) attrs['data-host'] = o.host;
  if (o.desk) attrs['data-desk'] = o.desk;
  const g = meshSvg.appendChild(svgEl('g', attrs));
  const left = Math.round(x - c.w / 2) + 0.5;
  const top = Math.round(y - c.h / 2) + 0.5;
  const box = g.appendChild(
    svgEl('rect', { x: left, y: top, width: c.w, height: c.h, rx: 3, class: `mesh-chip ${cls}` }),
  );
  const title = svgEl('title', {});
  title.textContent = tooltip;
  box.appendChild(title);
  const mid = top + (c.sub ? 10 : c.h / 2);
  let cx = left + PAD;
  g.appendChild(svgEl('rect', { x: cx, y: mid - DOT / 2, width: DOT, height: DOT, class: `mesh-node ${dot}` }));
  cx += DOT + 5;
  const label = g.appendChild(
    svgEl('text', { x: cx, y: mid, class: c.kind === 'host' ? 'mesh-label' : 'mesh-label dev' }),
  );
  label.textContent = c.name;
  cx += textW(c.name, c.kind === 'host' ? 'mesh-label' : 'mesh-label dev');
  if (c.model) {
    cx += 6;
    const mm = c.model;
    const tag = g.appendChild(svgEl('text', { x: cx, y: mid, class: `mesh-model-mark${mm.ready ? '' : ' down'}` }));
    tag.textContent = TAG;
    const t = svgEl('title', {});
    t.textContent = `${mm.file || 'no model yet'}${mm.ready ? '' : ', not loaded'}; ${mm.agents.length ? `asked by ${mm.agents.join(', ')}` : 'no agents ask it'}`;
    tag.appendChild(t);
    cx += textW(TAG, 'mesh-model-mark');
  }
  if (o.services?.length) {
    cx += 6;
    for (const s of o.services) {
      const pip = g.appendChild(
        svgEl('rect', {
          x: cx,
          y: mid - PIP / 2,
          width: PIP,
          height: PIP,
          class: s.touched ? 'mesh-pip touched' : 'mesh-pip',
        }),
      );
      const t = svgEl('title', {});
      t.textContent = s.tip;
      pip.appendChild(t);
      cx += PIP + 2;
    }
  }
  if (c.sub) {
    const sub = g.appendChild(svgEl('text', { x: left + PAD, y: top + 22, class: 'mesh-hub-dns' }));
    sub.textContent = c.sub;
  }
}

// where a link from a chip's middle toward a point leaves its box
function rim(p: { x: number; y: number }, c: Chip, to: { x: number; y: number }) {
  const dx = to.x - p.x;
  const dy = to.y - p.y;
  const t = Math.min(dx ? c.w / 2 / Math.abs(dx) : Infinity, dy ? c.h / 2 / Math.abs(dy) : Infinity, 1);
  return { x: p.x + dx * t, y: p.y + dy * t };
}

export const svgDefs = document.querySelector('.svg-defs') as SVGSVGElement;
export const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
export const syncMotion = () => (reduceMotion.matches ? svgDefs.pauseAnimations() : svgDefs.unpauseAnimations());
reduceMotion.addEventListener('change', syncMotion);
syncMotion();

// a model host as the graph marks it
export interface MeshModel {
  file?: string;
  ready?: boolean;
  agents: string[];
}

// left of a model host: how many agents ask it, in
// the glyph's colours, dimmed while not loaded
// a model host as the graph marks it
export interface MeshModel {
  file?: string;
  ready?: boolean;
  agents: string[];
}

export let meshRoutes: Route[] = [];
export let meshTailnet: TailnetDevice[] = [];
// the model hosts, marked in the glyph's colours
export let meshModels = new Map<string, MeshModel>();

// the module's variables other modules set
export const drawVars = {
  meshSig: '',
};

// --- the network as the tunnels report it -------------------------------------------

// each host's tunnel from its info.json
const netOf = (h: string): NetInfo | undefined => st.hostsInfo[h]?.net;

// the host running the hub, blank before any tunnel says
export function hubHost(): string {
  for (const [h, i] of Object.entries(st.hostsInfo)) if (i.net?.hub && i.net.up) return h;
  return '';
}

// how a host or device reaches the hub: home on the hub's own host, udp, the
// relay over https, or down
export type HubPath = 'home' | 'udp' | 'relay' | 'down';
export function hubPath(name: string, isHost: boolean): HubPath {
  const hub = hubHost();
  if (isHost && name === hub) return 'home';
  const carried = !!hub && !!netOf(hub)?.spokes.includes(name);
  if (!isHost) return carried ? 'udp' : 'down';
  const n = netOf(name);
  if (!n?.up || !carried) return 'down';
  return n.relay ? 'relay' : 'udp';
}

// host pairs with a direct session up, either side's word enough, as "a b" sorted
export function directPairs(): Set<string> {
  const out = new Set<string>();
  for (const [h, i] of Object.entries(st.hostsInfo))
    for (const o of i.net?.direct ?? []) out.add([h, o].sort().join(' '));
  return out;
}

const pathWord: Record<HubPath, string> = {
  home: 'runs the hub',
  udp: 'on the hub over udp',
  relay: 'on the hub through the relay over wss',
  down: 'not on the hub now',
};

export function renderMesh(routes: Route[], tailnet: TailnetDevice[]): void {
  meshRoutes = routes;
  meshTailnet = tailnet;
  // nothing redrawn for a poll changing nothing drawn (a full rebuild at 10/s grew the tab)
  const sig = JSON.stringify([
    st.selfHost,
    st.meshDomain,
    routes.map((r) => [r.host, r.name]),
    tailnet.map((d) => [d.name, !!d.phosphorus, !!d.phosphorusSeen, !!d.guest, d.os || '']),
    Object.entries(st.hostsInfo).map(([h, i]) => [h, i.net ?? null]),
  ]);
  if (sig === drawVars.meshSig) return;
  drawVars.meshSig = sig;
  uiVars.meshStatsDirty = true;
  if (!meshAnimFrame) drawMesh();
}

// the model hosts from a state push, the graph drawn again for a model change
export function meshModelsFrom(state: State): void {
  const nextModels = new Map<string, MeshModel>(
    (state.model?.models || []).map((x) => [x.host, { file: x.file, ready: x.ready, agents: x.agents || [] }]),
  );
  const modelChanged = JSON.stringify([...nextModels]) !== JSON.stringify([...meshModels]);
  meshModels = nextModels;
  if (modelChanged && !meshAnimFrame) drawMesh();
}

// --- the pulse along a touched path -------------------------------------------------

// per touched host, the drawn edges a request rides as [id, reversed]: in from
// the hub's host to this one, then on directly or back through the hub
const pulseRoutes = new Map<string, [string, boolean][]>();

export function pulsePoint(host: string, distFrac: number): DOMPoint | null {
  const ids = pulseRoutes.get(host) ?? [];
  const segs = ids
    .map(([id, rev]) => ({ el: document.getElementById(id) as unknown as SVGGeometryElement | null, rev }))
    .filter((s): s is { el: SVGGeometryElement; rev: boolean } => !!s.el);
  if (!segs.length) return null;

  const lens = segs.map((s) => s.el.getTotalLength());
  const total = lens.reduce((a, b) => a + b, 0);
  let dist = distFrac * total;
  for (let i = 0; i < segs.length; i++) {
    if (dist <= lens[i]! || i === segs.length - 1) {
      const d = Math.min(dist, lens[i]!);
      return segs[i]!.el.getPointAtLength(segs[i]!.rev ? lens[i]! - d : d);
    }
    dist -= lens[i]!;
  }
  return null;
}

// one pulse/sec per connection: hub, self, then the target host, its own rAF loop while any connection is open
let pulseAnimFrame: number | ReturnType<typeof setTimeout> | null = null;
export function startPulseLoop(): void {
  if (pulseAnimFrame) return;
  const tick = (now: number) => {
    if (!activeConnections.size) {
      pulseAnimFrame = null;
      return;
    }
    // the graph off screen: nothing to measure, looked at again a few times a second
    if (!meshPanel.offsetParent) {
      pulseAnimFrame = setTimeout(() => requestAnimationFrame(tick), 250);
      return;
    }
    const progress = (now / 1000) % 1;
    for (const [key, conn] of activeConnections) {
      const point = pulsePoint(conn.host, progress);
      if (!point) continue;
      let mark = document.getElementById(`pulse-${key}`);
      if (!mark || !mark.isConnected) {
        mark = svgEl('rect', {
          id: `pulse-${key}`,
          width: 3,
          height: 3,
          class: 'mesh-pulse',
        }) as unknown as HTMLElement;
        meshSvg.appendChild(mark);
      }
      mark.setAttribute('x', String(point.x - 1.5));
      mark.setAttribute('y', String(point.y - 1.5));
      mark.setAttribute('style', `opacity:${Math.sin(progress * Math.PI)}`);
    }
    pulseAnimFrame = requestAnimationFrame(tick);
  };
  pulseAnimFrame = requestAnimationFrame(tick);
}

// --- the layout, live -----------------------------------------------------------------

// an edge as the tunnels have it: a spoke to the hub's host, or a direct session
interface Edge {
  a: string;
  b: string;
  kind: 'spoke' | 'direct';
  path: HubPath;
}
const edgeId = (e: { a: string; b: string; kind: string }) => `me-${e.kind}-${[e.a, e.b].sort().join('~')}`;

let simSig = '';
let simFrame = 0;
let simSize = { w: 1, h: 1 };
// the graph's room: the pane less the legend's corner when it's up
function room() {
  const w = meshGraphWrap.clientWidth || 300;
  const h = meshGraphWrap.clientHeight || 200;
  const legend = meshGraphWrap.querySelector('.mesh-legend') as HTMLElement;
  const top = meshPanel.classList.contains('legend-on') ? legend.offsetTop + legend.offsetHeight + 4 : 0;
  return { w, h, top, iw: Math.max(40, w - 16), ih: Math.max(40, h - top - 16) };
}
// cooled a frame at a time while on screen, at once when off it or for reduced motion
function runSim() {
  if (simFrame) return;
  const step = () => {
    simFrame = 0;
    if (!meshPanel.offsetParent || reduceMotion.matches) {
      settle(simSize.w, simSize.h);
      drawMesh();
      return;
    }
    if (!tick(simSize.w, simSize.h)) return;
    drawMesh();
    simFrame = requestAnimationFrame(step);
  };
  simFrame = requestAnimationFrame(step);
}

// the layout's graph from the live links, reheated only when they or the pane change
function syncSim(chips: Map<string, Chip>, hub: string, edges: Edge[], iw: number, ih: number) {
  const nodes = [...chips.values()].map((c) => ({ id: c.name, hw: c.w / 2 + 7, hh: c.h / 2 + 6 }));
  const links: SimLink[] = edges.map((e) =>
    e.kind === 'direct'
      ? { a: e.a, b: e.b, len: 1, k: 0.08 }
      : e.path === 'down'
        ? { a: e.a, b: e.b, len: 1.15, k: 0.3 }
        : { a: e.a, b: e.b, len: 0.9, k: 0.5 },
  );
  const sig = JSON.stringify([nodes, links, hub]);
  const resized = Math.abs(Math.log(iw / simSize.w)) > 0.06 || Math.abs(Math.log(ih / simSize.h)) > 0.06;
  simSize = { w: iw, h: ih };
  if (sig === simSig) {
    if (!resized) return;
    reheat(0.4);
    return runSim();
  }
  const first = !simSig;
  simSig = sig;
  setGraph(nodes, links, hub, first ? 1 : 0.6);
  if (first) settle(iw, ih);
  else runSim();
}

// pure function of last-fetched data and the layout's positions, called per
// data change and per layout frame
export function drawMesh(): void {
  const t = meshT;

  // hosts a live connection targets, and the specific services it's touching
  const touchedHosts = new Set<string>();
  const touchedServices = new Set<string>();
  for (const conn of activeConnections.values()) {
    touchedHosts.add(conn.host);
    touchedServices.add(serviceKey(conn));
  }

  const routes = meshRoutes;
  const tailnet = meshTailnet;
  const grouped = new Map<string, Route[]>();
  for (const r of routes) {
    if (!grouped.has(r.host)) grouped.set(r.host, []);
    grouped.get(r.host)!.push(r);
  }
  // devices without phosphorus (phones, laptops on the WireGuard app): no routes
  const outside = new Map<string, TailnetDevice>();
  for (const d of tailnet) {
    if (d.phosphorus || d.phosphorusSeen) {
      hostPlatform.set(d.name, d.os || '');
      if (!grouped.has(d.name)) grouped.set(d.name, []);
    } else if (!grouped.has(d.name)) {
      outside.set(d.name, d);
    }
  }
  const hosts = [...grouped.keys()].sort();
  const others = [...outside.keys()].sort();
  const hub = hosts.includes(hubHost()) ? hubHost() : '';

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  meshCount.textContent = [
    hosts.length ? plural(hosts.length, 'host') : '',
    others.length ? plural(others.length, 'device') : '',
    hosts.length && !hub ? 'no hub' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  // stats table first, so the graph takes the height it leaves
  if (uiVars.meshStatsDirty) {
    renderMeshStats(hosts, grouped);
    uiVars.meshStatsDirty = false;
  }
  if (t > 0) {
    meshStats.style.display = 'flex';
    meshStats.style.opacity = String(t);
    meshStats.style.maxHeight = `${uiVars.lastStatsHeight * t}px`;
  } else if (meshStats.style.display !== 'none') {
    meshStats.style.opacity = '0';
    meshStats.style.maxHeight = '0px';
    meshStats.style.display = 'none';
  }

  // one unit a pixel, 0,0 the middle of the room the legend leaves
  checkType();
  const { w, h, top, iw, ih } = room();
  meshSvg.innerHTML = '';
  meshSvg.setAttribute('viewBox', `${-w / 2} ${-(h + top) / 2} ${w} ${h}`);
  // every edge in the first layer, so chips always sit on top of them
  const edgeLayer = svgEl('g', { class: 'mesh-edges' });
  meshSvg.appendChild(edgeLayer);

  if (!hosts.length && !others.length) {
    const text = svgEl('text', { x: 0, y: 0, 'text-anchor': 'middle', class: 'mesh-label' });
    text.textContent = 'no nodes live';
    meshSvg.appendChild(text);
    return;
  }

  // the links as they stand: each host and device's spoke to the hub's host, and
  // direct sessions between hosts; with no hub up, only the direct ones
  const edges: Edge[] = [];
  if (hub) {
    for (const hh of hosts) if (hh !== hub) edges.push({ a: hh, b: hub, kind: 'spoke', path: hubPath(hh, true) });
    for (const d of others) edges.push({ a: d, b: hub, kind: 'spoke', path: hubPath(d, false) });
  }
  const isHost = new Set(hosts);
  for (const pair of directPairs()) {
    const [a, b] = pair.split(' ') as [string, string];
    if (isHost.has(a) && isHost.has(b)) edges.push({ a, b, kind: 'direct', path: 'udp' });
  }

  const dom = st.meshDomain;
  const chips = new Map<string, Chip>();
  for (const m of hosts)
    chips.set(m, chipOf(m, 'host', grouped.get(m)!.length, m === hub && dom ? dom : undefined, meshModels.get(m)));
  for (const d of others) chips.set(d, chipOf(d, 'device', 0));
  syncSim(chips, hub, edges, iw, ih);

  const pos = (id: string) => {
    const n = simNodes.get(id);
    return { x: n?.x ?? 0, y: n?.y ?? 0 };
  };

  // a request's way: in at the hub's host (the domain's edge), to this host,
  // then direct to the target or through the hub
  const has = new Set(edges.map(edgeId));
  const hop = (from: string, to: string): [string, boolean][] => {
    for (const kind of ['direct', 'spoke']) {
      const id = edgeId({ a: from, b: to, kind });
      if (has.has(id)) return [[id, [from, to].sort()[0] !== from]];
    }
    return [];
  };
  const self = st.selfHost;
  const onRoute = new Set<string>();
  pulseRoutes.clear();
  for (const target of touchedHosts) {
    const route: [string, boolean][] = [];
    if (hub && self !== hub) route.push(...hop(hub, self));
    if (target !== self) {
      const straight = hop(self, target);
      if (straight.length) route.push(...straight);
      else if (hub) route.push(...hop(self, hub), ...hop(hub, target));
    }
    pulseRoutes.set(target, route);
    for (const [id] of route) onRoute.add(id);
  }

  // drawn from the sorted first end, so a pulse knows which way it runs; cut at the chips' rims
  for (const e of edges) {
    const [a, b] = [e.a, e.b].sort() as [string, string];
    const p = pos(a);
    const q = pos(b);
    const id = edgeId(e);
    const touched = onRoute.has(id);
    let d: string;
    let cls = `mesh-line-hub ${e.path}`;
    let tip = `${e.a} ${pathWord[e.path]}`;
    if (e.kind === 'direct') {
      // bowed off the straight line, clear of spokes running the same way
      const bow = 0.2;
      const m = { x: (p.x + q.x) / 2 - (q.y - p.y) * bow, y: (p.y + q.y) / 2 + (q.x - p.x) * bow };
      const s = rim(p, chips.get(a)!, m);
      const f = rim(q, chips.get(b)!, m);
      d = `M ${s.x} ${s.y} Q ${m.x} ${m.y} ${f.x} ${f.y}`;
      cls = 'mesh-line-peer direct';
      tip = `${a} and ${b} direct over udp, past the hub`;
    } else {
      const s = rim(p, chips.get(a)!, q);
      const f = rim(q, chips.get(b)!, p);
      d = `M ${s.x} ${s.y} L ${f.x} ${f.y}`;
      if (e.a === self) cls += ' self';
    }
    const attrs: Record<string, string> = { d, class: touched ? `${cls} touched` : cls };
    if (touched) attrs.id = id;
    const el = svgEl('path', attrs);
    const title = svgEl('title', {});
    title.textContent = tip;
    el.appendChild(title);
    edgeLayer.appendChild(el);
  }

  // a host: its chip, lit for this host, the hub's carrying its domain
  for (const m of hosts) {
    const p = pos(m);
    const own = grouped.get(m)!;
    const isSelf = m === self;
    const isHub = m === hub;
    // the new self pulsing until a switch is answered
    const dot = isSelf ? (hostSwitch ? 'self pending' : 'self') : own.length ? 'active' : 'idle';
    const os = hostPlatform.get(m);
    const path = hubPath(m, true);
    drawChip(
      p.x,
      p.y,
      chips.get(m)!,
      `host${isSelf ? ' self' : ''}${isHub ? ' hub' : ''}${path === 'down' && hub ? ' down' : ''}${touchedHosts.has(m) ? ' touched' : ''}`,
      dot,
      `${m}${os ? ` (${os})` : ''}: ${own.length} service${own.length === 1 ? '' : 's'}, ${pathWord[path]}${isHub ? `; every host and device meets here, the relay at ${dom || 'the domain'}` : ''}`,
      {
        host: isSelf ? '' : m,
        desk: m,
        services: own.map((r) => ({
          name: r.name,
          tip: r.public || r.master !== undefined ? `${r.name} (public, no phosphorus login)` : r.name,
          touched: touchedServices.has(serviceKey(r)),
        })),
      },
    );
  }

  // a device on the WireGuard app: a smaller chip, a guest's dashed
  for (const name of others) {
    const { os, guest } = outside.get(name)!;
    const p = pos(name);
    const path = hubPath(name, false);
    drawChip(
      p.x,
      p.y,
      chips.get(name)!,
      `device${guest ? ' guest' : ''}${path === 'down' ? ' down' : ''}`,
      `outside${path === 'down' ? ' down' : ''}`,
      `${name}${os ? ` (${os})` : ''}: ${guest ? 'a guest' : 'a device'}, ${pathWord[path]}`,
      { desk: name },
    );
  }
}
