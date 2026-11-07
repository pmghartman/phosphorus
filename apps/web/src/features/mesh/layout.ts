// the graph's force layout: nodes held apart, pulled along their links,
// the hub's host pinned at the middle, settled by cooling

export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  // collision radius: label and service ring
  r: number;
}
export interface SimLink {
  a: string;
  b: string;
  len: number;
  k: number;
}

export const simNodes = new Map<string, SimNode>();
let simLinks: SimLink[] = [];
let pinned = '';
export const sim = { alpha: 0 };
const ALPHA_MIN = 0.004;
const DECAY = 0.035;

// a start angle per name, so a reload lays out the same way
function angleOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) / 2 ** 32) * Math.PI * 2;
}

// the graph swapped in, positions kept for nodes still in it; heat by how much moved
export function setGraph(nodes: { id: string; r: number }[], links: SimLink[], hub: string, heat: number) {
  const keep = new Set(nodes.map((n) => n.id));
  for (const id of simNodes.keys()) if (!keep.has(id)) simNodes.delete(id);
  const near = new Map<string, string>();
  for (const l of links) {
    if (!near.has(l.a)) near.set(l.a, l.b);
    if (!near.has(l.b)) near.set(l.b, l.a);
  }
  for (const n of nodes) {
    const had = simNodes.get(n.id);
    if (had) {
      had.r = n.r;
      continue;
    }
    // a newcomer beside what it links to, out on its own angle
    const at = simNodes.get(near.get(n.id) ?? '');
    const a = angleOf(n.id);
    const d = n.id === hub ? 0 : 30;
    simNodes.set(n.id, {
      id: n.id,
      x: (at?.x ?? 0) + d * Math.cos(a),
      y: (at?.y ?? 0) + d * Math.sin(a),
      vx: 0,
      vy: 0,
      r: n.r,
    });
  }
  simLinks = links.filter((l) => simNodes.has(l.a) && simNodes.has(l.b));
  pinned = simNodes.has(hub) ? hub : '';
  sim.alpha = Math.max(sim.alpha, heat);
}

// warmed again: the frame changed shape
export function reheat(heat: number) {
  sim.alpha = Math.max(sim.alpha, heat);
}

// one step; aspect stretches the pull to the middle to the frame's shape
export function tick(aspect: number): boolean {
  const a = sim.alpha;
  if (a < ALPHA_MIN) return false;
  const ns = [...simNodes.values()];
  for (let i = 0; i < ns.length; i++)
    for (let j = i + 1; j < ns.length; j++) {
      const p = ns[i]!;
      const q = ns[j]!;
      let dx = q.x - p.x;
      let dy = q.y - p.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) {
        dx = Math.cos(angleOf(p.id + q.id));
        dy = Math.sin(angleOf(p.id + q.id));
        d2 = 1;
      }
      const d = Math.sqrt(d2);
      // charge, then overlap pushed out
      let f = (900 * a) / d2;
      const gap = p.r + q.r - d;
      if (gap > 0) f += (gap * 0.5) / d;
      p.vx -= dx * f;
      p.vy -= dy * f;
      q.vx += dx * f;
      q.vy += dy * f;
    }
  // rest lengths on an ellipse the frame's shape, so a star fills a wide or tall pane
  const ex = Math.sqrt(aspect);
  for (const l of simLinks) {
    const p = simNodes.get(l.a)!;
    const q = simNodes.get(l.b)!;
    const dx = q.x + q.vx - p.x - p.vx;
    const dy = q.y + q.vy - p.y - p.vy;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const len = l.len / Math.hypot(dx / d / ex, (dy / d) * ex);
    const f = ((d - len) / d) * a * l.k;
    p.vx += dx * f * 0.5;
    p.vy += dy * f * 0.5;
    q.vx -= dx * f * 0.5;
    q.vy -= dy * f * 0.5;
  }
  // a tall frame pulls harder across than down
  const gx = 0.06 * a * Math.max(1, 1 / aspect);
  const gy = 0.06 * a * Math.max(1, aspect);
  for (const n of ns) {
    if (n.id === pinned) {
      n.x = n.y = n.vx = n.vy = 0;
      continue;
    }
    n.vx -= n.x * gx;
    n.vy -= n.y * gy;
    n.vx *= 0.6;
    n.vy *= 0.6;
    n.x += n.vx;
    n.y += n.vy;
  }
  sim.alpha = a * (1 - DECAY);
  return true;
}

// cooled at once: off screen or reduced motion
export function settle(aspect: number) {
  for (let i = 0; i < 400 && tick(aspect); i++);
  sim.alpha = 0;
}
