// the graph's force layout in the pane's own pixels: chips held apart as boxes,
// pulled along their links, the hub's host pinned at the middle, kept inside the pane

export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  // half the chip's size plus its margin
  hw: number;
  hh: number;
}
export interface SimLink {
  a: string;
  b: string;
  // rest length as a share of the pane's reach
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
export function setGraph(nodes: { id: string; hw: number; hh: number }[], links: SimLink[], hub: string, heat: number) {
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
      had.hw = n.hw;
      had.hh = n.hh;
      continue;
    }
    // a newcomer beside what it links to, out on its own angle
    const at = simNodes.get(near.get(n.id) ?? '');
    const a = angleOf(n.id);
    const d = n.id === hub ? 0 : 40;
    simNodes.set(n.id, {
      id: n.id,
      x: (at?.x ?? 0) + d * Math.cos(a),
      y: (at?.y ?? 0) + d * Math.sin(a),
      vx: 0,
      vy: 0,
      hw: n.hw,
      hh: n.hh,
    });
  }
  simLinks = links.filter((l) => simNodes.has(l.a) && simNodes.has(l.b));
  pinned = simNodes.has(hub) ? hub : '';
  sim.alpha = Math.max(sim.alpha, heat);
}

// warmed again: the pane changed size
export function reheat(heat: number) {
  sim.alpha = Math.max(sim.alpha, heat);
}

// one step in a w by h pane centred on 0,0; links reach out to its edges on an ellipse
export function tick(w: number, h: number): boolean {
  const a = sim.alpha;
  if (a < ALPHA_MIN) return false;
  const ns = [...simNodes.values()];
  const reach = Math.sqrt(w * h) * 0.5;
  const charge = (reach * 0.55) ** 2;
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
      const f = (charge * a) / d2 / Math.sqrt(d2);
      p.vx -= dx * f;
      p.vy -= dy * f;
      q.vx += dx * f;
      q.vy += dy * f;
      // boxes overlapping: pushed apart along the shallower side
      const ox = p.hw + q.hw - Math.abs(dx);
      const oy = p.hh + q.hh - Math.abs(dy);
      if (ox > 0 && oy > 0) {
        if (ox / (p.hw + q.hw) < oy / (p.hh + q.hh)) {
          const s = Math.sign(dx) * ox * 0.25;
          p.vx -= s;
          q.vx += s;
        } else {
          const s = Math.sign(dy) * oy * 0.25;
          p.vy -= s;
          q.vy += s;
        }
      }
    }
  const ex = Math.sqrt(w / Math.max(1, h));
  for (const l of simLinks) {
    const p = simNodes.get(l.a)!;
    const q = simNodes.get(l.b)!;
    const dx = q.x + q.vx - p.x - p.vx;
    const dy = q.y + q.vy - p.y - p.vy;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const len = (l.len * reach) / Math.hypot(dx / d / ex, (dy / d) * ex);
    const f = ((d - len) / d) * a * l.k;
    p.vx += dx * f * 0.5;
    p.vy += dy * f * 0.5;
    q.vx -= dx * f * 0.5;
    q.vy -= dy * f * 0.5;
  }
  const g = 0.04 * a;
  for (const n of ns) {
    if (n.id === pinned) {
      n.x = n.y = n.vx = n.vy = 0;
      continue;
    }
    n.vx -= (n.x / w) * reach * g;
    n.vy -= (n.y / h) * reach * g;
    n.vx *= 0.6;
    n.vy *= 0.6;
    n.x += n.vx;
    n.y += n.vy;
    // inside the pane, whole
    const mx = Math.max(0, w / 2 - n.hw);
    const my = Math.max(0, h / 2 - n.hh);
    n.x = Math.max(-mx, Math.min(mx, n.x));
    n.y = Math.max(-my, Math.min(my, n.y));
  }
  sim.alpha = a * (1 - DECAY);
  return true;
}

// cooled at once: off screen or reduced motion
export function settle(w: number, h: number) {
  for (let i = 0; i < 400 && tick(w, h); i++);
  sim.alpha = 0;
}
