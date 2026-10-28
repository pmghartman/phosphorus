// drawing: a host's node, its git and model marks
import { databaseIcon, svgEl } from '../../lib/dom.ts';
import { st } from '../../lib/state.ts';
import type { GitHost, Route, State, TailnetDevice } from '@phosphorus/wire';
import { gitVars } from './git.ts';
import { NODE_HALF, hostSwitch } from './hosts.ts';
import { lerp } from './ping.ts';
import { activeConnections, hostPlatform, serviceKey } from './routes.ts';
import { renderMeshStats } from './stats.ts';
import { LIFT, OTHERS_AXIS, meshAnimFrame, meshCount, meshDimsNow, meshPanel, meshStats, meshSvg, meshT, type Dims, uiVars } from './ui.ts';

// one square plus its name, the rest in the tooltip, opts: size (half-width),
// scale (depth), opacity, noLabel, host (a host to switch to), all optional

export function drawNode(x: number, y: number, name: string, cls: string, tooltip: string, opts?: { size?: number; scale?: number; opacity?: number; noLabel?: boolean; host?: string }) {
  const o = opts || {};
  const scale = o.scale || 1;
  const size = o.size || NODE_HALF * scale;
  const opacity = o.opacity === undefined ? 1 : o.opacity;
  // a host: square, name and a wider hit area as one target
  const parent: SVGElement = o.host
    ? meshSvg.appendChild(svgEl('g', { class: 'mesh-host', 'data-host': o.host }))
    : meshSvg;
  if (o.host) {
    const w = Math.max(18, name.length * 4.3 + 6);
    parent.appendChild(svgEl('rect', { x: x - w / 2, y: y - 8, width: w, height: 24, class: 'mesh-hit' }));
  }
  const node = svgEl('rect', {
    x: x - size, y: y - size, width: size * 2, height: size * 2,
    class: `mesh-node ${cls}`, style: `opacity:${opacity}`,
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
    x: Math.max(half, Math.min(frame.width - half, x)), y: Math.min(frame.height - 1.5, y + 10 * scale + 3), 'text-anchor': 'middle',
    class: 'mesh-label', style: `opacity:${opacity};font-size:${7 * textScale}px`,
  });
  label.textContent = name;
  parent.appendChild(label);
}

// beside a git host: the git service's own glyph for the master, a * for the rest,
// purple master, sand available, dark grey out of date, red unreachable
export function drawGitMarker(x: number, y: number, h: GitHost, scale = 1) {
  const master = h.reachable && h.role === 'master';
  const state = !h.reachable ? 'down' : master ? 'master' : h.eligible ? 'ok' : 'stale';
  const g = svgEl('g', { class: `mesh-git ${state}`, transform: `translate(${x + 4.5 * scale} ${y - 4.5 * scale}) scale(${0.9 * scale})` });
  const title = svgEl('title', {});
  title.textContent = { master: 'git master', ok: 'git servant, in sync', stale: 'git servant, out of date', down: 'git servant, unreachable' }[state];
  g.appendChild(title);
  if (master) {
    // no CSS size for a nested svg, only its own attributes
    const db = databaseIcon();
    db.setAttribute('width', '7');
    db.setAttribute('height', '8');
    g.appendChild(db);
  } else {
    const star = svgEl('text', { x: 3.5, y: 6.5, 'text-anchor': 'middle', class: 'mesh-git-star' });
    star.textContent = '*';
    g.appendChild(star);
  }
  meshSvg.appendChild(g);
}

document.querySelector('.mesh-legend-git')!.prepend(databaseIcon());

// the gradient sliding by smil, out of the stylesheet's reduced-motion
// rule's reach, so held still here the same way
export const svgDefs = document.querySelector('.svg-defs') as SVGSVGElement;
export const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
export const syncMotion = () => (reduceMotion.matches ? svgDefs.pauseAnimations() : svgDefs.unpauseAnimations());
reduceMotion.addEventListener('change', syncMotion);
syncMotion();

// a model host as the graph marks it
export interface MeshModel { file?: string; ready?: boolean; agents: string[] }

// left of a model host, mirroring the git mark: how many agents ask it, in
// the glyph's colours, dimmed while not loaded
export function drawModelMarker(x: number, y: number, mm: MeshModel, scale = 1, opacity = 1) {
  const mark = svgEl('text', {
    x: x - 4.5 * scale, y: y - 1.2 * scale, 'text-anchor': 'end', class: `mesh-model-mark${mm.ready ? '' : ' down'}`,
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

export function renderMesh(routes: Route[], tailnet: TailnetDevice[]): void {
  meshRoutes = routes;
  meshTailnet = tailnet;
  // nothing redrawn for a poll changing nothing drawn (a full rebuild at 10/s grew the tab)
  const sig = JSON.stringify([st.selfHost, routes.map((r) => [r.host, r.name]),
    tailnet.map((d) => [d.name, !!d.phosphorus, d.os || ''])]);
  if (sig === drawVars.meshSig) return;
  drawVars.meshSig = sig;
  uiVars.meshStatsDirty = true;
  if (!meshAnimFrame) drawMesh();
}

// the model hosts from a state push, the graph drawn again for a git or model change
export function meshModelsFrom(state: State, gitChanged: boolean): void {
  const nextModels = new Map<string, MeshModel>((state.model?.models || []).map((x) => [x.host, { file: x.file, ready: x.ready, agents: x.agents || [] }]));
  const modelChanged = JSON.stringify([...nextModels]) !== JSON.stringify([...meshModels]);
  meshModels = nextModels;
  if ((gitChanged || modelChanged) && !meshAnimFrame) drawMesh();
}

// the touched elements drawMesh() drew (tunnel spoke, peer arc, service stem)
// via getPointAtLength(), so the pulse rides the real curve

export function pulsePoint(key: string, host: string, distFrac: number): DOMPoint | null {
  const ids = ['mesh-tunnel-self'];
  if (host !== st.selfHost) ids.push(`peer-${host}`);
  ids.push(`stem-${key}`);
  const segs = ids.map((id) => document.getElementById(id) as unknown as SVGGeometryElement | null).filter((s): s is SVGGeometryElement => !!s);
  if (!segs.length) return null;

  const lens = segs.map((el) => el.getTotalLength());
  const total = lens.reduce((a, b) => a + b, 0);
  let dist = distFrac * total;
  for (let i = 0; i < segs.length; i++) {
    if (dist <= lens[i]! || i === segs.length - 1) return segs[i]!.getPointAtLength(Math.min(dist, lens[i]!));
    dist -= lens[i]!;
  }
  return segs[segs.length - 1]!.getPointAtLength(lens[lens.length - 1]!);
}

// one pulse/sec per connection: hub, self, target host if different, target
// service, its own rAF loop while any connection is open
export function startPulseLoop(): void {
  if (gitVars.pulseAnimFrame) return;
  const tick = (now: number) => {
    if (!activeConnections.size) { gitVars.pulseAnimFrame = null; return; }
    // the graph off screen: nothing to measure, looked at again a few times a second
    if (!meshPanel.offsetParent) { gitVars.pulseAnimFrame = setTimeout(() => requestAnimationFrame(tick), 250); return; }
    const progress = (now / 1000) % 1;
    for (const [key, conn] of activeConnections) {
      const point = pulsePoint(key, conn.host, progress);
      if (!point) continue;
      let mark = document.getElementById(`pulse-${key}`);
      if (!mark || !mark.isConnected) {
        mark = svgEl('rect', { id: `pulse-${key}`, width: 2, height: 2, class: 'mesh-pulse' }) as unknown as HTMLElement;
        meshSvg.appendChild(mark);
      }
      mark.setAttribute('x', String(point.x - 1));
      mark.setAttribute('y', String(point.y - 1));
      mark.setAttribute('style', `opacity:${Math.sin(progress * Math.PI)}`);
    }
    gitVars.pulseAnimFrame = requestAnimationFrame(tick);
  };
  gitVars.pulseAnimFrame = requestAnimationFrame(tick);
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
  // tailnet devices without phosphorus: no routes, known only to the tailnet list
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
    others.length ? `${others.length} in-mesh` : '',
  ].filter(Boolean).join(' · ');
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
  const lanesFor = (span: number, need: number, most: number) => Math.min(most, Math.ceil(need / (span / (hosts.length + 1))));
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
  interface Projected { x: number; y: number; s: number; fog: number }
  const project = (x: number, y: number, depth = 0): Projected => {
    const u = (y - floorY) / floorH;
    const z = -u * tiltSin + depth;
    const s = 1 / (1 + z * PERSP);
    return {
      x: centerX + (x - centerX) * s,
      y: floorY + (u * tiltCos * s / fitY) * floorH,
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
  const laneOff = new Map(hosts.map((n, i) => [n,
    lerp((i % lanesC - (lanesC - 1) / 2) * LANE_C, (i % lanesE) * LANE_E, t)]));
  // collapsed lanes side by side, so depth apart, expanded ones, depth from the tilt
  const laneDepth = new Map(hosts.map((n, i) => [n, (1 - t) * 0.7 * (i % lanesC - (lanesC - 1) / 2)]));

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

  // fainter peer lines the more there are
  const n = hosts.length;
  const o = others.length;
  meshSvg.style.setProperty('--fade', Math.min(1, Math.sqrt(12 / Math.max(1, (n * (n - 1) + o * (o - 1)) / 2 + n * o))).toFixed(3));

  // every device reaching every other, a line per pair, same-group pairs
  // arced outward, the bulge itself rotating with the layout
  const groupMesh = (names: string[], isHost: boolean) => {
    const zoom = width / 232;
    const bulgeStep = zoom * Math.min(7, 60 / Math.max(1, names.length - 2));
    const bulgeAngle = t * (Math.PI / 2);
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const p1 = posOf(names[i]!, isHost);
        const p2 = posOf(names[j]!, isHost);
        const bulge = 12 * zoom + (j - i - 1) * bulgeStep;
        const cx = (p1.x + p2.x) / 2 + bulge * Math.cos(bulgeAngle);
        const cy = (p1.y + p2.y) / 2 + bulge * Math.sin(bulgeAngle);
        const other = names[i] === st.selfHost ? names[j] : names[j] === st.selfHost ? names[i] : null;
        const touched = isHost && other && touchedHosts.has(other);
        // flipped when self is p2, so the pulse runs self->target
        const [start, end] = touched && names[j] === st.selfHost ? [p2, p1] : [p1, p2];
        const attrs: Record<string, string> = {
          d: `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`,
          class: touched ? 'mesh-line-peer touched' : 'mesh-line-peer', style: edgeFog(p1, p2),
        };
        if (touched) attrs.id = `peer-${other}`;
        edges.appendChild(svgEl('path', attrs));
      }
    }
  };
  groupMesh(hosts, true);
  groupMesh(others, false);
  for (const name of others) {
    for (const m of hosts) {
      const p1 = posOf(m, true);
      const p2 = posOf(name, false);
      edges.appendChild(svgEl('line', {
        x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, class: 'mesh-line-peer', style: edgeFog(p1, p2),
      }));
    }
  }

  const hubR = 4 * hub.s;
  meshSvg.appendChild(svgEl('rect', { x: hubX - hubR, y: hubY - hubR, width: hubR * 2, height: hubR * 2, class: 'mesh-hub' }));
  const hubDns = svgEl('text', {
    x: hubX, y: hubY + 12 * hub.s + 4, 'text-anchor': 'middle', class: 'mesh-hub-dns', style: `font-size:${6 * hub.s}px`,
  });
  hubDns.textContent = st.meshDomain || 'tailnet';
  meshSvg.appendChild(hubDns);

  // spokes on the tunnel, only this node's highlighted
  hosts.forEach((m) => {
    const p = posOf(m, true);
    const isSelf = m === st.selfHost;
    const spoke: Record<string, string | number> = {
      x1: hubX, y1: hubY, x2: p.x, y2: p.y, class: isSelf ? 'mesh-line-tunnel self' : 'mesh-line-tunnel', style: edgeFog(hub, p),
    };
    if (isSelf) spoke.id = 'mesh-tunnel-self';
    edges.appendChild(svgEl('line', spoke));
  });

  // far to near, so nearer squares overlap farther ones
  const byDepth = hosts.map((m): [string, Projected] => [m, posOf(m, true)]).sort((a, b) => a[1].s - b[1].s);
  byDepth.forEach(([m, p]) => {
    const own = grouped.get(m)!;
    const isSelf = m === st.selfHost;
    // the new self pulsing until a switch is answered
    const cls = isSelf ? (hostSwitch ? 'self pending' : 'self') : own.length ? 'active' : 'idle';
    const os = hostPlatform.get(m);
    drawNode(p.x, p.y, m, cls,
      `${m}${os ? ` (${os})` : ''}: ${own.length} service${own.length === 1 ? '' : 's'}`,
      { host: isSelf ? '' : m, scale: p.s, opacity: p.fog });
    if (meshModels.has(m)) drawModelMarker(p.x, p.y, meshModels.get(m)!, p.s, p.fog);
    const gitHost = st.gitHostsList.find((h) => h.host === m);
    if (gitHost) drawGitMarker(p.x, p.y, gitHost, p.s);
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
        x1: p.x, y1: p.y, x2: c.x, y2: c.y,
        class: svcTouched ? 'mesh-line-stem touched' : 'mesh-line-stem',
        style: `opacity:${t};${edgeFog(p, c)}`,
      };
      if (svcTouched) stem.id = `stem-${key}`;
      edges.appendChild(svgEl('line', stem));
      drawNode(c.x, c.y, r.name, svcTouched ? 'svc touched' : 'svc', r.public || r.master !== undefined ? `${r.name} (public, no phosphorus login)` : r.name,
        { size: 1.8 * c.s, opacity: t * c.fog, noLabel: true });
    });
  });

  // no spoke, not routable through the tunnel
  others.forEach((name) => {
    const { os } = outside.get(name)!;
    const p = posOf(name, false);
    drawNode(p.x, p.y, name, 'outside',
      `${name}${os ? ` (${os})` : ''}: in-mesh`, { scale: p.s, opacity: p.fog });
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
