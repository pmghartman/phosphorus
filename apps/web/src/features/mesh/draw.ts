// drawing: a host's node, its model mark

import type { NetInfo, Route, State, TailnetDevice } from '@phosphorus/wire';
import { svgEl } from '../../lib/dom.ts';
import { st } from '../../lib/state.ts';
import { hostSwitch, NODE_HALF } from './hosts.ts';
import { reheat, type SimLink, setGraph, settle, simNodes, tick } from './layout.ts';
import { activeConnections, hostPlatform, serviceKey } from './routes.ts';
import { renderMeshStats } from './stats.ts';
import {
  type Dims,
  meshAnimFrame,
  meshCount,
  meshDimsNow,
  meshPanel,
  meshStats,
  meshSvg,
  meshT,
  uiVars,
} from './ui.ts';

// one square plus its name, the rest in the tooltip, opts: size (half-width), labelDy
// (name's offset, above when negative), sub (a second line: the hub's domain),
// noLabel, host (a host to switch to), desk (a computer to open)

export function drawNode(
  x: number,
  y: number,
  name: string,
  cls: string,
  tooltip: string,
  opts?: {
    size?: number;
    opacity?: number;
    labelDy?: number;
    sub?: string;
    noLabel?: boolean;
    host?: string;
    desk?: string;
  },
) {
  const o = opts || {};
  const size = o.size || NODE_HALF;
  const opacity = o.opacity === undefined ? 1 : o.opacity;
  const dy = o.labelDy ?? 13;
  // a host: square, name and a wider hit area as one target
  const attrs: Record<string, string> = { class: o.host ? 'mesh-host mesh-desk' : 'mesh-desk' };
  if (o.host) attrs['data-host'] = o.host;
  if (o.desk) attrs['data-desk'] = o.desk;
  const parent: SVGElement = o.host || o.desk ? meshSvg.appendChild(svgEl('g', attrs)) : meshSvg;
  if (o.host || o.desk) {
    const w = Math.max(18, name.length * 4.3 + 6);
    const top = Math.min(-8, dy - 8);
    parent.appendChild(
      svgEl('rect', { x: x - w / 2, y: y + top, width: w, height: Math.max(8, dy + 4) - top, class: 'mesh-hit' }),
    );
  }
  const node = svgEl('rect', {
    x: x - size,
    y: y - size,
    width: size * 2,
    height: size * 2,
    class: `mesh-node ${cls}`,
    style: `opacity:${opacity}`,
  });
  const title = svgEl('title', {});
  title.textContent = tooltip;
  node.appendChild(title);
  parent.appendChild(node);

  if (o.noLabel) return;
  const label = svgEl('text', {
    x,
    y: y + dy,
    'text-anchor': 'middle',
    class: 'mesh-label',
    style: `opacity:${opacity}`,
  });
  label.textContent = name;
  parent.appendChild(label);
  if (!o.sub) return;
  const sub = svgEl('text', {
    x,
    y: y + dy + (dy < 0 ? -7.5 : 7),
    'text-anchor': 'middle',
    class: 'mesh-hub-dns',
  });
  sub.textContent = o.sub;
  parent.appendChild(sub);
}

// the gradient sliding by smil, out of the stylesheet's reduced-motion
// rule's reach, so held still here the same way
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
export function drawModelMarker(x: number, y: number, mm: MeshModel) {
  const mark = svgEl('text', {
    x: x - 4.5,
    y: y - 1.2,
    'text-anchor': 'end',
    class: `mesh-model-mark${mm.ready ? '' : ' down'}`,
  });
  mark.textContent = String(mm.agents.length || 'm');
  const title = svgEl('title', {});
  title.textContent = `${mm.agents.length ? mm.agents.join(', ') : 'no agents'} on ${mm.file || 'no model yet'}${mm.ready ? '' : ', not loaded'}`;
  mark.appendChild(title);
  meshSvg.appendChild(mark);
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

export function pulsePoint(key: string, host: string, distFrac: number): DOMPoint | null {
  const ids: [string, boolean][] = [...(pulseRoutes.get(host) ?? []), [`stem-${key}`, false]];
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

// one pulse/sec per connection: hub, self, target host if different, target
// service, its own rAF loop while any connection is open
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
      const point = pulsePoint(key, conn.host, progress);
      if (!point) continue;
      let mark = document.getElementById(`pulse-${key}`);
      if (!mark || !mark.isConnected) {
        mark = svgEl('rect', {
          id: `pulse-${key}`,
          width: 2,
          height: 2,
          class: 'mesh-pulse',
        }) as unknown as HTMLElement;
        meshSvg.appendChild(mark);
      }
      mark.setAttribute('x', String(point.x - 1));
      mark.setAttribute('y', String(point.y - 1));
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

// a host's services on an arc away from the hub, sized to fit them
const SVC_STEP = 8;
function svcRing(n: number): { r: number; step: number } {
  const r = Math.max(12, ((n - 1) * SVC_STEP) / (1.5 * Math.PI));
  return { r, step: SVC_STEP / r };
}
const labelHalf = (name: string) => name.length * 2.15 + 3;

let simSig = '';
let simFrame = 0;
let simAspect = 1;
const aspectNow = () => {
  const d = meshDimsNow().expanded;
  return d.width / Math.max(1, d.height);
};
// cooled a frame at a time while on screen, at once when off it or for reduced motion
function runSim() {
  if (simFrame) return;
  const step = () => {
    simFrame = 0;
    if (!meshPanel.offsetParent || reduceMotion.matches) {
      settle(aspectNow());
      drawMesh();
      return;
    }
    if (!tick(aspectNow())) return;
    drawMesh();
    simFrame = requestAnimationFrame(step);
  };
  simFrame = requestAnimationFrame(step);
}

// the layout's graph from the live links, reheated only when they change
function syncSim(hosts: string[], others: string[], grouped: Map<string, Route[]>, hub: string, edges: Edge[]) {
  const n = hosts.length + others.length;
  const L = Math.max(46, 6.5 * n);
  const nodes = [
    ...hosts.map((h) => {
      const svc = grouped.get(h)?.length ?? 0;
      return { id: h, r: Math.max(labelHalf(h) + 3, 10, svc ? svcRing(svc).r + 4 : 0) };
    }),
    ...others.map((d) => ({ id: d, r: labelHalf(d) + 2 })),
  ];
  const links: SimLink[] = edges.map((e) =>
    e.kind === 'direct'
      ? { a: e.a, b: e.b, len: L * 1.1, k: 0.12 }
      : e.path === 'down'
        ? { a: e.a, b: e.b, len: L * 1.4, k: 0.15 }
        : { a: e.a, b: e.b, len: L, k: 0.5 },
  );
  const sig = JSON.stringify([nodes, links, hub]);
  // a pane of another shape (shown at last, resized, moved to the popup): laid out again for it
  const aspect = aspectNow();
  if (sig === simSig) {
    if (Math.abs(Math.log(aspect / simAspect)) < 0.15) return;
    simAspect = aspect;
    reheat(0.5);
    return runSim();
  }
  simAspect = aspect;
  const first = !simSig;
  simSig = sig;
  setGraph(nodes, links, hub, first ? 1 : 0.6);
  if (first) settle(aspectNow());
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
  // stats table first, room for its height reserved by meshLayoutParams(),
  // rebuilt only on real change, never per layout frame
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

  const dims = meshDimsNow().expanded;
  const { width, height } = dims;
  meshSvg.innerHTML = '';
  meshSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  // every edge in the first layer, so nodes always sit on top of them
  const edgeLayer = svgEl('g', { class: 'mesh-edges' });
  meshSvg.appendChild(edgeLayer);

  if (!hosts.length && !others.length) {
    const text = svgEl('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'mesh-label' });
    text.textContent = 'no nodes live';
    meshSvg.appendChild(text);
    return;
  }

  // the links as they stand: each host and device's spoke to the hub's host, and
  // direct sessions between hosts; with no hub up, only the direct ones
  const edges: Edge[] = [];
  if (hub) {
    for (const h of hosts) if (h !== hub) edges.push({ a: h, b: hub, kind: 'spoke', path: hubPath(h, true) });
    for (const d of others) edges.push({ a: d, b: hub, kind: 'spoke', path: hubPath(d, false) });
  }
  const isHost = new Set(hosts);
  for (const pair of directPairs()) {
    const [a, b] = pair.split(' ') as [string, string];
    if (isHost.has(a) && isHost.has(b)) edges.push({ a, b, kind: 'direct', path: 'udp' });
  }
  syncSim(hosts, others, grouped, hub, edges);

  const cx = width / 2;
  const cy = height / 2;
  const pos = (id: string) => {
    const n = simNodes.get(id);
    return { x: cx + (n?.x ?? 0), y: cy + (n?.y ?? 0) };
  };
  const center = hub ? pos(hub) : { x: cx, y: cy };

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

  // drawn from the sorted first end, so a pulse knows which way it runs
  const direct = edges.filter((e) => e.kind === 'direct').length;
  meshSvg.style.setProperty('--fade', Math.min(1, Math.sqrt(6 / Math.max(1, direct))).toFixed(3));
  for (const e of edges) {
    const [a, b] = [e.a, e.b].sort() as [string, string];
    const p = pos(a);
    const q = pos(b);
    const id = edgeId(e);
    const touched = onRoute.has(id);
    let d = `M ${p.x} ${p.y} L ${q.x} ${q.y}`;
    let cls = `mesh-line-hub ${e.path}`;
    let tip = `${e.a} ${pathWord[e.path]}`;
    if (e.kind === 'direct') {
      // bowed off the straight line, clear of spokes running the same way
      const bow = 0.08;
      const mx = (p.x + q.x) / 2 - (q.y - p.y) * bow;
      const my = (p.y + q.y) / 2 + (q.x - p.x) * bow;
      d = `M ${p.x} ${p.y} Q ${mx} ${my} ${q.x} ${q.y}`;
      cls = 'mesh-line-peer direct';
      tip = `${a} and ${b} direct over udp, past the hub`;
    } else if (e.a === self) cls += ' self';
    const attrs: Record<string, string> = { d, class: touched ? `${cls} touched` : cls };
    if (touched) attrs.id = id;
    const el = svgEl('path', attrs);
    const title = svgEl('title', {});
    title.textContent = tip;
    el.appendChild(title);
    edgeLayer.appendChild(el);
  }

  // a host: its square, its services on an arc pointing out from the hub,
  // its name on the side the arc leaves free
  for (const m of hosts) {
    const p = pos(m);
    const own = grouped.get(m)!;
    const isSelf = m === self;
    const isHub = m === hub;
    let away: number;
    if (isHub || !hub) {
      // the hub's host: toward the widest room its spokes leave
      let sx = 0;
      let sy = 0;
      for (const e of edges)
        if (e.a === m || e.b === m) {
          const o = pos(e.a === m ? e.b : e.a);
          const l = Math.hypot(o.x - p.x, o.y - p.y) || 1;
          sx += (o.x - p.x) / l;
          sy += (o.y - p.y) / l;
        }
      away = Math.hypot(sx, sy) > 0.3 ? Math.atan2(-sy, -sx) : Math.PI / 2;
    } else away = Math.atan2(p.y - center.y, p.x - center.x);
    const below = !own.length || Math.sin(away) < 0.45;

    const ring = svcRing(own.length);
    own.forEach((r, i) => {
      const ang = away + (i - (own.length - 1) / 2) * ring.step;
      const c = { x: p.x + ring.r * Math.cos(ang), y: p.y + ring.r * Math.sin(ang) };
      const key = serviceKey(r);
      const svcTouched = touchedServices.has(key);
      const stem: Record<string, string | number> = {
        x1: p.x,
        y1: p.y,
        x2: c.x,
        y2: c.y,
        class: svcTouched ? 'mesh-line-stem touched' : 'mesh-line-stem',
      };
      if (svcTouched) stem.id = `stem-${key}`;
      edgeLayer.appendChild(svgEl('line', stem));
      drawNode(
        c.x,
        c.y,
        r.name,
        svcTouched ? 'svc touched' : 'svc',
        r.public || r.master !== undefined ? `${r.name} (public, no phosphorus login)` : r.name,
        { size: 1.8, noLabel: true },
      );
    });

    // the new self pulsing until a switch is answered
    const cls = isSelf ? (hostSwitch ? 'self pending' : 'self') : own.length ? 'active' : 'idle';
    const os = hostPlatform.get(m);
    const via = pathWord[hubPath(m, true)];
    const dom = st.meshDomain;
    drawNode(
      p.x,
      p.y,
      m,
      cls,
      `${m}${os ? ` (${os})` : ''}: ${own.length} service${own.length === 1 ? '' : 's'}, ${via}${isHub ? `; every host and device meets here, the relay at ${dom || 'the domain'}` : ''}`,
      {
        host: isSelf ? '' : m,
        desk: m,
        labelDy: below ? 13 : -7,
        sub: isHub && dom ? dom : undefined,
      },
    );
    if (meshModels.has(m)) drawModelMarker(p.x, p.y, meshModels.get(m)!);
  }

  // a device on the WireGuard app: its spoke alone, no services; a guest hollow
  for (const name of others) {
    const { os, guest } = outside.get(name)!;
    const p = pos(name);
    const path = hubPath(name, false);
    const below = Math.sin(Math.atan2(p.y - center.y, p.x - center.x)) > -0.45;
    drawNode(
      p.x,
      p.y,
      name,
      `outside${guest ? ' guest' : ''}${path === 'down' ? ' down' : ''}`,
      `${name}${os ? ` (${os})` : ''}: ${guest ? 'a guest' : 'a device'}, ${pathWord[path]}`,
      { size: 2.4, desk: name, labelDy: below ? 11 : -6 },
    );
  }
  fitMesh(width, height, dims);
}

// viewBox zoomed onto what was drawn, clear of the legend band, at most MESH_ZOOM_MAX
export const MESH_ZOOM_MAX = 1.8;
export function fitMesh(w: number, h: number, dims: Dims) {
  const b = meshSvg.getBBox();
  const u = w / dims.widthPx;
  const pad = 6 * u;
  const top = dims.legendPx * u;
  const z = Math.min(MESH_ZOOM_MAX, w / (b.width + 2 * pad), (h - top) / (b.height + 2 * pad));
  const vw = w / z;
  const vh = h / z;
  const vx = b.x + b.width / 2 - vw / 2;
  const vy = b.y + b.height / 2 - (vh + top / z) / 2;
  meshSvg.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);
}
