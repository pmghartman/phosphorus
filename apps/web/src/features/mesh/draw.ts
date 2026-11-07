// drawing: a host's node, its model mark

import type { NetInfo, Route, State, TailnetDevice } from '@phosphorus/wire';
import { svgEl } from '../../lib/dom.ts';
import { st } from '../../lib/state.ts';
import { hostSwitch, NODE_HALF } from './hosts.ts';
import { lerp } from './ping.ts';
import { activeConnections, hostPlatform, serviceKey } from './routes.ts';
import { renderMeshStats } from './stats.ts';
import {
  type Dims,
  LIFT,
  meshAnimFrame,
  meshCount,
  meshDimsNow,
  meshPanel,
  meshStats,
  meshSvg,
  meshT,
  OTHERS_AXIS,
  uiVars,
} from './ui.ts';

// one square plus its name, the rest in the tooltip, opts: size (half-width), scale (depth),
// opacity, noLabel, host (a host to switch to), desk (a computer to open), all optional

export function drawNode(
  x: number,
  y: number,
  name: string,
  cls: string,
  tooltip: string,
  opts?: { size?: number; scale?: number; opacity?: number; noLabel?: boolean; host?: string; desk?: string },
) {
  const o = opts || {};
  const scale = o.scale || 1;
  const size = o.size || NODE_HALF * scale;
  const opacity = o.opacity === undefined ? 1 : o.opacity;
  // a host: square, name and a wider hit area as one target
  const attrs: Record<string, string> = { class: o.host ? 'mesh-host mesh-desk' : 'mesh-desk' };
  if (o.host) attrs['data-host'] = o.host;
  if (o.desk) attrs['data-desk'] = o.desk;
  const parent: SVGElement = o.host || o.desk ? meshSvg.appendChild(svgEl('g', attrs)) : meshSvg;
  if (o.host || o.desk) {
    const w = Math.max(18, name.length * 4.3 + 6);
    parent.appendChild(svgEl('rect', { x: x - w / 2, y: y - 8, width: w, height: 24, class: 'mesh-hit' }));
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
  // kept inside the frame, ~4.3 units a 7px monospace char
  const textScale = Math.sqrt(scale);
  const half = name.length * 2.15 * textScale;
  const frame = meshSvg.viewBox.baseVal;
  const label = svgEl('text', {
    x: Math.max(half, Math.min(frame.width - half, x)),
    y: Math.min(frame.height - 1.5, y + 10 * scale + 3),
    'text-anchor': 'middle',
    class: 'mesh-label',
    style: `opacity:${opacity};font-size:${7 * textScale}px`,
  });
  label.textContent = name;
  parent.appendChild(label);
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
export function drawModelMarker(x: number, y: number, mm: MeshModel, scale = 1, opacity = 1) {
  const mark = svgEl('text', {
    x: x - 4.5 * scale,
    y: y - 1.2 * scale,
    'text-anchor': 'end',
    class: `mesh-model-mark${mm.ready ? '' : ' down'}`,
    style: `font-size:${7 * scale}px;opacity:${opacity}`,
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
  relay: 'on the hub through the relay over https',
  down: 'not on the hub now',
};

export function renderMesh(routes: Route[], tailnet: TailnetDevice[]): void {
  meshRoutes = routes;
  meshTailnet = tailnet;
  // nothing redrawn for a poll changing nothing drawn (a full rebuild at 10/s grew the tab)
  const sig = JSON.stringify([
    st.selfHost,
    routes.map((r) => [r.host, r.name]),
    tailnet.map((d) => [d.name, !!d.phosphorus, d.os || '']),
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

// the touched elements drawMesh() drew (hub spokes, a direct arc, service stem)
// via getPointAtLength(), so the pulse rides the real path: in from the hub to
// this host, then to the target directly or back through the hub

export function pulsePoint(key: string, host: string, distFrac: number): DOMPoint | null {
  const ids: [string, boolean][] = [['mesh-hub-self', false]];
  if (host !== st.selfHost) {
    if (document.getElementById(`peer-${host}`)) ids.push([`peer-${host}`, false]);
    else ids.push(['mesh-hub-self', true], [`spoke-${host}`, false]);
  }
  ids.push([`stem-${key}`, false]);
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

// pure function of last-fetched data + meshT, called per data poll and per
// animation frame, so layout restructures/rescales instead of a CSS transform
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
    if (d.phosphorus) {
      hostPlatform.set(d.name, d.os || '');
      if (!grouped.has(d.name)) grouped.set(d.name, []);
    } else if (!grouped.has(d.name)) {
      outside.set(d.name, d);
    }
  }
  const hosts = [...grouped.keys()].sort();
  const others = [...outside.keys()].sort();

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  meshCount.textContent = [
    hosts.length ? plural(hosts.length, 'host') : '',
    others.length ? plural(others.length, 'device') : '',
  ]
    .filter(Boolean)
    .join(' · ');
  // stats table first, room for its height reserved by meshLayoutParams(),
  // rebuilt only on real change, never per tween frame
  if (uiVars.meshStatsDirty) {
    renderMeshStats(hosts, grouped);
    uiVars.meshStatsDirty = false;
  }

  // tied to meshT, not the .expanded class, max-height reclaiming space at
  // the rate opacity fades, neither in one jump
  if (t > 0) {
    meshStats.style.display = 'flex';
    meshStats.style.opacity = String(t);
    meshStats.style.maxHeight = `${uiVars.lastStatsHeight * t}px`;
  } else if (meshStats.style.display !== 'none') {
    meshStats.style.opacity = '0';
    meshStats.style.maxHeight = '0px';
    meshStats.style.display = 'none';
  }

  const { collapsed, expanded } = meshDimsNow();

  // service squares fanned out in a row below their host once t>0, the frame
  // grown by a fixed drop to clear that row, not per extra service
  const maxSvc = Math.max(0, ...hosts.map((m) => grouped.get(m)!.length));
  const CHILD_BASE = 26;
  // crowded hosts staggered into lanes for clear labels: side by side collapsed,
  // stacked rows expanded, each row with room for its services
  const labelW = Math.max(0, ...hosts.map((m) => m.length)) * 4.3 + 6;
  const lanesFor = (span: number, need: number, most: number) =>
    Math.min(most, Math.ceil(need / (span / (hosts.length + 1))));
  const lanesC = lanesFor(collapsed.height, 22, 3);
  const lanesE = lanesFor(expanded.width, labelW, 5);
  const LANE_C = Math.min(labelW, 34);
  const LANE_E = CHILD_BASE + 10;
  const expandedH = expanded.height + (maxSvc ? CHILD_BASE : 0);

  const width = lerp(collapsed.width, expanded.width, t);
  const height = lerp(collapsed.height, expandedH, t);
  // expanded lanes stacked downward, the frame grown only by what the room
  // below the host row (0.4 to 0.84 of the height) can't take
  const span = (lanesE - 1) * LANE_E;
  const grow = t * Math.max(0, span + CHILD_BASE + 22 - (OTHERS_AXIS + LIFT) * expandedH);

  meshSvg.innerHTML = '';
  meshSvg.setAttribute('viewBox', `0 0 ${width} ${height + grow}`);
  // every edge in the first layer, so nodes always sit on top of them
  const edges = svgEl('g', { class: 'mesh-edges' });
  meshSvg.appendChild(edges);

  if (!hosts.length && !others.length) {
    const text = svgEl('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'mesh-label' });
    text.textContent = 'no nodes live';
    meshSvg.appendChild(text);
    return;
  }

  // collapsed: hub|hosts|others as columns, expanded: rows, a rigid 90deg
  // spin (not a mirror), hub and hosts lifted for service room
  const margin = 0.12;
  const angle = t * (Math.PI / 2);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rotate = (x: number, y: number) => ({ x: x * cos - y * sin, y: x * sin + y * cos });

  const lift = t * LIFT;
  const centerX = width / 2;
  const centerY = height / 2;

  // a floor tilted back from the viewer, lower nearer, side lanes stepping in
  // depth too, s the perspective scale, fog the depth fade
  const TILT = 0.5;
  const tiltSin = Math.sin(TILT);
  const tiltCos = Math.cos(TILT);
  const PERSP = 0.38;
  const floorH = (height + grow) / 2;
  const floorY = centerY + grow / 2;
  const fitY = tiltCos / (1 - tiltSin * PERSP);
  interface Projected {
    x: number;
    y: number;
    s: number;
    fog: number;
  }
  const project = (x: number, y: number, depth = 0): Projected => {
    const u = (y - floorY) / floorH;
    const z = -u * tiltSin + depth;
    const s = 1 / (1 + z * PERSP);
    return {
      x: centerX + (x - centerX) * s,
      y: floorY + ((u * tiltCos * s) / fitY) * floorH,
      s,
      fog: Math.max(0.35, Math.min(1, 1 - 0.55 * z)),
    };
  };

  const hubRel = rotate(margin - 0.5, 0);
  const hub = project(centerX + hubRel.x * width, centerY + (hubRel.y - lift) * height);
  const hubX = hub.x;
  const hubY = hub.y;

  const fracAlong = (i: number, n: number) => (i + 1) / (n + 1);
  const hostSpread = new Map(hosts.map((n, i) => [n, fracAlong(i, hosts.length)]));
  const otherSpread = new Map(others.map((n, i) => [n, fracAlong(i, others.length)]));
  // across the host axis, turning with the layout
  const laneOff = new Map(
    hosts.map((n, i) => [n, lerp(((i % lanesC) - (lanesC - 1) / 2) * LANE_C, (i % lanesE) * LANE_E, t)]),
  );
  // collapsed lanes side by side, so depth apart, expanded ones, depth from the tilt
  const laneDepth = new Map(hosts.map((n, i) => [n, (1 - t) * 0.7 * ((i % lanesC) - (lanesC - 1) / 2)]));

  // flat layout position, before the tilt
  const flatOf = (name: string, isHost: boolean) => {
    const frac = (isHost ? hostSpread : otherSpread).get(name)!;
    const axisFrac = isHost ? 0 : OTHERS_AXIS;
    const rel = rotate(axisFrac, frac - 0.5);
    const off = isHost ? laneOff.get(name)! : grow;
    return {
      x: centerX + rel.x * width + off * cos,
      y: centerY + (rel.y - (isHost ? lift : 0)) * height + off * sin,
      depth: isHost ? laneDepth.get(name)! : 0,
    };
  };
  const posOf = (name: string, isHost: boolean) => {
    const f = flatOf(name, isHost);
    return project(f.x, f.y, f.depth);
  };
  const edgeFog = (a: Projected, b: Projected) => `stroke-opacity:${((a.fog + b.fog) / 2).toFixed(3)}`;

  // a direct session between two hosts, an arc beside their spokes: traffic
  // between them skips the hub; the bulge turning with the layout
  const direct = directPairs();
  meshSvg.style.setProperty('--fade', Math.min(1, Math.sqrt(6 / Math.max(1, direct.size))).toFixed(3));
  const zoom = width / 232;
  const bulgeAngle = t * (Math.PI / 2);
  for (let i = 0; i < hosts.length; i++)
    for (let j = i + 1; j < hosts.length; j++) {
      const a = hosts[i]!;
      const b = hosts[j]!;
      if (!direct.has([a, b].sort().join(' '))) continue;
      const p1 = posOf(a, true);
      const p2 = posOf(b, true);
      const bulge = 12 * zoom + (j - i - 1) * zoom * Math.min(7, 60 / Math.max(1, hosts.length - 2));
      const cx = (p1.x + p2.x) / 2 + bulge * Math.cos(bulgeAngle);
      const cy = (p1.y + p2.y) / 2 + bulge * Math.sin(bulgeAngle);
      const other = a === st.selfHost ? b : b === st.selfHost ? a : null;
      const touched = !!other && touchedHosts.has(other);
      // flipped when self is p2, so the pulse runs self->target
      const [start, end] = touched && b === st.selfHost ? [p2, p1] : [p1, p2];
      const attrs: Record<string, string> = {
        d: `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`,
        class: touched ? 'mesh-line-peer direct touched' : 'mesh-line-peer direct',
        style: edgeFog(p1, p2),
      };
      if (touched) attrs.id = `peer-${other}`;
      const title = svgEl('title', {});
      title.textContent = `${a} and ${b} direct, past the hub`;
      const arc = svgEl('path', attrs);
      arc.appendChild(title);
      edges.appendChild(arc);
    }

  // the hub: the mesh's domain, where every host and device meets, run by one host
  const runBy = hubHost();
  const hubR = 4 * hub.s;
  const hubSq = svgEl('rect', {
    x: hubX - hubR,
    y: hubY - hubR,
    width: hubR * 2,
    height: hubR * 2,
    class: runBy ? 'mesh-hub' : 'mesh-hub down',
  });
  const hubTitle = svgEl('title', {});
  hubTitle.textContent = runBy
    ? `the hub on ${runBy}: every host and device meets here, over udp or the relay at ${st.meshDomain || 'the domain'}`
    : 'no hub answering';
  hubSq.appendChild(hubTitle);
  meshSvg.appendChild(hubSq);
  const hubDns = svgEl('text', {
    x: hubX,
    y: hubY + 12 * hub.s + 4,
    'text-anchor': 'middle',
    class: 'mesh-hub-dns',
    style: `font-size:${6 * hub.s}px`,
  });
  hubDns.textContent = st.meshDomain || 'mesh';
  meshSvg.appendChild(hubDns);

  // a spoke to the hub per host and device, drawn by how it gets there; this
  // host's runs host to hub, the rest hub out, so a pulse rides them in order
  const spoke = (name: string, isHost: boolean, p: Projected) => {
    const path = hubPath(name, isHost);
    const isSelf = isHost && name === st.selfHost;
    const touched = isHost && touchedHosts.has(name) && !isSelf;
    const [a, b] = isSelf ? [p, hub] : [hub, p];
    const line: Record<string, string | number> = {
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      class: `mesh-line-hub ${path}${isSelf ? ' self' : ''}${touched ? ' touched' : ''}`,
      style: edgeFog(hub, p),
    };
    if (isSelf) line.id = 'mesh-hub-self';
    else if (touched) line.id = `spoke-${name}`;
    const el = svgEl('line', line);
    const title = svgEl('title', {});
    title.textContent = `${name} ${pathWord[path]}`;
    el.appendChild(title);
    edges.appendChild(el);
  };
  for (const m of hosts) spoke(m, true, posOf(m, true));
  for (const name of others) spoke(name, false, posOf(name, false));

  // far to near, so nearer squares overlap farther ones
  const byDepth = hosts.map((m): [string, Projected] => [m, posOf(m, true)]).sort((a, b) => a[1].s - b[1].s);
  byDepth.forEach(([m, p]) => {
    const own = grouped.get(m)!;
    const isSelf = m === st.selfHost;
    // the new self pulsing until a switch is answered
    const cls = isSelf ? (hostSwitch ? 'self pending' : 'self') : own.length ? 'active' : 'idle';
    const os = hostPlatform.get(m);
    const via = pathWord[hubPath(m, true)];
    drawNode(
      p.x,
      p.y,
      m,
      cls,
      `${m}${os ? ` (${os})` : ''}: ${own.length} service${own.length === 1 ? '' : 's'}, ${via}`,
      {
        host: isSelf ? '' : m,
        desk: m,
        scale: p.s,
        opacity: p.fog,
      },
    );
    if (meshModels.has(m)) drawModelMarker(p.x, p.y, meshModels.get(m)!, p.s, p.fog);
    const flat = flatOf(m, true);

    // a row below their host as the panel expands, on it (invisible) at t=0,
    // so a pulse always has a target
    const rowZoom = width / 232;
    const gapMax = 20 * rowZoom;
    // no wider than the space to the next host in its lane
    const rowMax = Math.min(45 * rowZoom, 0.7 * lanesE * (width / (hosts.length + 1)));
    const gap = own.length > 1 ? Math.min(gapMax, rowMax / (own.length - 1)) : 0;
    const rowWidth = (own.length - 1) * gap;
    const dropY = flat.y + CHILD_BASE;
    own.forEach((r, i) => {
      const c = project(lerp(flat.x, flat.x - rowWidth / 2 + i * gap, t), lerp(flat.y, dropY, t), flat.depth);
      const key = serviceKey(r);
      const svcTouched = touchedServices.has(key);
      const stem: Record<string, string | number> = {
        x1: p.x,
        y1: p.y,
        x2: c.x,
        y2: c.y,
        class: svcTouched ? 'mesh-line-stem touched' : 'mesh-line-stem',
        style: `opacity:${t};${edgeFog(p, c)}`,
      };
      if (svcTouched) stem.id = `stem-${key}`;
      edges.appendChild(svgEl('line', stem));
      drawNode(
        c.x,
        c.y,
        r.name,
        svcTouched ? 'svc touched' : 'svc',
        r.public || r.master !== undefined ? `${r.name} (public, no phosphorus login)` : r.name,
        { size: 1.8 * c.s, opacity: t * c.fog, noLabel: true },
      );
    });
  });

  // a device on the WireGuard app: its spoke alone, no services
  others.forEach((name) => {
    const { os } = outside.get(name)!;
    const p = posOf(name, false);
    const path = hubPath(name, false);
    drawNode(
      p.x,
      p.y,
      name,
      path === 'down' ? 'outside down' : 'outside',
      `${name}${os ? ` (${os})` : ''}: a device, ${pathWord[path]}`,
      {
        scale: p.s,
        opacity: p.fog,
        desk: name,
      },
    );
  });
  fitMesh(width, height + grow, t ? expanded : collapsed);
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
