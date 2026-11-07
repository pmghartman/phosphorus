// the desk's ground with no picture up: ascii glyphs in slow crossing waves, a click rippling out

import { el } from '../../lib/dom.ts';
import { PREF_LS } from '../../lib/state.ts';

// sparse to dense, the about glyph's own characters
const RAMP = ' .:-=+*#%@';
const LV = RAMP.length - 1;
// every frame up to 60 a second, only the cells whose glyph changed repainted
const FPS = 60;
const FONT = 13;
const RIPPLE_S = 3.5;
const still = matchMedia('(prefers-reduced-motion: reduce)');

// on unless turned off in appearance, synced with the user
export const FIELD_EVENT = 'phosphorus-field';
export function fieldOn(): boolean {
  try {
    return localStorage.getItem(PREF_LS.deskfield!) !== 'off';
  } catch {
    return true;
  }
}
export function fieldSet(on: boolean): void {
  try {
    localStorage.setItem(PREF_LS.deskfield!, on ? 'on' : 'off');
  } catch {}
  dispatchEvent(new Event(FIELD_EVENT));
}

export function dkField(): { el: HTMLCanvasElement; poke: (x: number, y: number) => void } {
  const cv = el('canvas', 'dk-field') as HTMLCanvasElement;
  cv.setAttribute('aria-hidden', 'true');
  const g = cv.getContext('2d')!;
  // every level's glyph drawn once per tone (row 0 the text's, row 1 the accent's), stamped per cell
  const atlas = document.createElement('canvas');
  const ag = atlas.getContext('2d')!;
  let look = '';
  let dpr = 1;
  let cw = 8;
  let ch = 16;
  let cols = 0;
  let rows = 0;
  let raf = 0;
  let last = 0;
  let checked = 0;
  const t0 = performance.now();
  // a drop's own shape, picked at random: its wobble's lobes and phases, two wavelengths, its speed
  type Drop = {
    x: number;
    y: number;
    t: number;
    m1: number;
    m2: number;
    p1: number;
    p2: number;
    wob: number;
    k1: number;
    k2: number;
    v: number;
  };
  const ripples: Drop[] = [];
  // each cell's last glyph (level, tone in bit 4), 255 forcing a repaint
  let shown = new Uint8Array(0);
  let colX = new Float32Array(0);
  let colW = new Float32Array(0);
  let rowY = new Float32Array(0);
  let rowW = new Float32Array(0);

  const colorOf = (v: string) => {
    cv.style.color = v;
    const c = getComputedStyle(cv).color;
    cv.style.color = '';
    return c;
  };
  // the theme's text and accent, the atlas redrawn only when they or the scale change
  const restyle = () => {
    const fg = colorOf('var(--fg)');
    const ac = colorOf('var(--accent)');
    const font = `${FONT * dpr}px ${getComputedStyle(cv).fontFamily}`;
    const key = `${fg}|${ac}|${font}`;
    if (key === look) return;
    look = key;
    ag.font = font;
    cw = Math.ceil(ag.measureText('M').width);
    ch = Math.ceil(FONT * 1.3 * dpr);
    atlas.width = cw * (LV + 1);
    atlas.height = ch * 2;
    ag.font = font;
    ag.textBaseline = 'middle';
    ag.textAlign = 'center';
    for (let tone = 0; tone < 2; tone++)
      for (let i = 1; i <= LV; i++) {
        ag.globalAlpha = tone ? 0.1 + (0.25 * i) / LV : 0.03 + (0.11 * i) / LV;
        ag.fillStyle = tone ? ac : fg;
        ag.fillText(RAMP[i]!, i * cw + cw / 2, tone * ch + ch / 2);
      }
    size();
  };
  const size = () => {
    const w = Math.round(cv.clientWidth * dpr);
    const h = Math.round(cv.clientHeight * dpr);
    if (cv.width !== w) cv.width = w;
    if (cv.height !== h) cv.height = h;
    cols = Math.ceil(w / cw);
    rows = Math.ceil(h / ch);
    if (shown.length !== cols * rows) {
      shown = new Uint8Array(cols * rows);
      colX = new Float32Array(cols);
      colW = new Float32Array(cols);
      rowY = new Float32Array(rows);
      rowW = new Float32Array(rows);
    }
    shown.fill(255);
    g.clearRect(0, 0, cv.width, cv.height);
  };

  const draw = (now: number) => {
    const s = (now - t0) / 1000;
    const unit = 70 * dpr;
    const Wu = (cols * cw) / unit;
    const Hu = (rows * ch) / unit;
    // two sources wandering on unrelated periods, two plane waves slowly turning
    const o1x = Wu * (0.5 + 0.4 * Math.sin(s * 0.043));
    const o1y = Hu * (0.5 + 0.4 * Math.cos(s * 0.031));
    const o2x = Wu * (0.5 + 0.45 * Math.cos(s * 0.027 + 1));
    const o2y = Hu * (0.5 + 0.45 * Math.sin(s * 0.037 + 2));
    const a1 = 0.5 + s * 0.011;
    const a2 = 2.2 - s * 0.007;
    const c1 = Math.cos(a1) * 1.05;
    const s1 = Math.sin(a1) * 1.05;
    const c2 = Math.cos(a2) * 0.73;
    const s2 = Math.sin(a2) * 0.73;
    while (ripples.length && s - ripples[0]!.t > RIPPLE_S) ripples.shift();
    // the space warped a column and a row at a time, so no band runs straight or repeats evenly
    for (let c = 0; c < cols; c++) {
      const X = (c * cw + cw / 2) / unit;
      colX[c] = X;
      colW[c] = 0.9 * Math.sin(X * 0.29 - s * 0.05) + 0.4 * Math.sin(X * 0.83 + s * 0.07);
    }
    for (let r = 0; r < rows; r++) {
      const Y = (r * ch + ch / 2) / unit;
      rowY[r] = Y;
      rowW[r] = 0.9 * Math.sin(Y * 0.37 + s * 0.06) + 0.4 * Math.sin(Y * 0.91 - s * 0.04);
    }
    // a drop: a packet of rings spreading out, its height fading as it travels
    const rip = ripples.map((p) => {
      const a = s - p.t;
      const fade = 1 - a / RIPPLE_S;
      return { p, R: a * p.v * dpr, k: (fade * fade * 0.85) / Math.sqrt(1 + a) };
    });
    const packet = 90 * dpr;
    for (let r = 0; r < rows; r++) {
      const py = r * ch + ch / 2;
      const Y = rowY[r]!;
      const rw = rowW[r]!;
      for (let c = 0; c < cols; c++) {
        const px = c * cw + cw / 2;
        const wx = colX[c]! + rw;
        const wy = Y + colW[c]!;
        let f =
          (Math.sin(wx * c1 + wy * s1 + s * 0.45) +
            Math.sin(wx * c2 + wy * s2 - s * 0.31) +
            Math.sin(Math.hypot(wx - o1x, wy - o1y) * 0.9 - s * 0.55) +
            Math.sin(Math.hypot(wx - o2x, wy - o2y) * 0.61 + s * 0.38)) *
          (0.75 + 0.25 * Math.sin(wx * 0.19 - wy * 0.23 + s * 0.03));
        // the drops' rings summed into the waves themselves, so the bands bend where they cross
        let ring = 0;
        for (const { p, R, k } of rip) {
          const dx = px - p.x;
          const dy = py - p.y;
          const d = Math.hypot(dx, dy);
          if (Math.abs(d - R) > 2.5 * packet + R * p.wob * 1.6) continue;
          // the ring's edge wobbling with the angle, never a clean circle
          const th = Math.atan2(dy, dx);
          const x = d - R * (1 + p.wob * Math.sin(p.m1 * th + p.p1) + 0.6 * p.wob * Math.sin(p.m2 * th + p.p2));
          const e = Math.exp(-(x * x) / (packet * packet)) * k * (1 + 0.35 * Math.sin(2 * th + p.p2));
          // two wavelengths, the second stretching ahead of the front as a real drop's do
          f += e * (0.65 * Math.cos(x * p.k1 + p.p1) + 0.35 * Math.cos(x * p.k2 * (1 - (0.3 * x) / packet)));
          ring += e;
        }
        // crests of the summed waves as bands, sparse between them
        let v = 0.5 + 0.5 * Math.sin(f * 2.1);
        v *= v * v;
        const lv = Math.round(v * LV);
        const key = lv | (ring > 0.22 && lv >= 3 ? 16 : 0);
        const i = r * cols + c;
        if (shown[i] === key) continue;
        shown[i] = key;
        g.clearRect(c * cw, r * ch, cw, ch);
        if (lv) g.drawImage(atlas, lv * cw, (key >> 4) * ch, cw, ch, c * cw, r * ch, cw, ch);
      }
    }
  };

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    if (now - last < 1000 / FPS - 2) return;
    last = now;
    // the theme looked at again now and then, not every frame
    if (now - checked > 2000) {
      checked = now;
      cv.hidden = !fieldOn();
      restyle();
    }
    draw(now);
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };
  // run only while it has a size: hidden, walled or off, nothing drawn
  const wake = () => {
    if (!cv.clientWidth || !cv.clientHeight) return stop();
    dpr = Math.min(2, devicePixelRatio || 1);
    restyle();
    size();
    if (still.matches) {
      stop();
      draw(t0 + 4000);
    } else if (!raf) {
      checked = performance.now();
      raf = requestAnimationFrame(frame);
    }
  };
  new ResizeObserver(wake).observe(cv);
  still.addEventListener('change', wake);
  addEventListener(FIELD_EVENT, () => {
    cv.hidden = !fieldOn();
  });
  cv.hidden = !fieldOn();

  const poke = (x: number, y: number) => {
    if (!raf) return;
    const b = cv.getBoundingClientRect();
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const lam = rnd(45, 75) * dpr;
    ripples.push({
      x: (x - b.left) * dpr,
      y: (y - b.top) * dpr,
      t: (performance.now() - t0) / 1000,
      m1: 2 + Math.floor(Math.random() * 2),
      m2: 5 + Math.floor(Math.random() * 3),
      p1: rnd(0, 2 * Math.PI),
      p2: rnd(0, 2 * Math.PI),
      wob: rnd(0.06, 0.15),
      k1: (2 * Math.PI) / lam,
      k2: (2 * Math.PI) / (lam * rnd(1.6, 2.3)),
      v: rnd(210, 300),
    });
    if (ripples.length > 8) ripples.shift();
  };
  return { el: cv, poke };
}
