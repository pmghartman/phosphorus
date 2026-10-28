// the mesh: the tray's icon, its graph and pings in a popup above it
import { DK_GLYPHS, dkGlyph, el } from '../../lib/dom.ts';
import { dk } from '../../lib/state.ts';
import { dkAnchor, dkPopsClose, type Pop } from '../../desktop/taskbar.ts';
import { drawMesh } from './draw.ts';
import { pingHosts } from './ping.ts';
import { meshAnimFrame, meshPanel, meshUi, saveMeshUi, stash, uiVars } from './ui.ts';

export function dkMeshTray(anchor?: HTMLElement): HTMLElement {
  const wrap = el('div', 'dk-tray-wrap');
  const b = Object.assign(el('button', 'dk-tray'), { type: 'button', title: 'mesh', ariaLabel: 'mesh' });
  b.setAttribute('aria-expanded', 'false');
  b.appendChild(dkGlyph(DK_GLYPHS.mesh!));
  const pop = Object.assign(el('div', 'dk-mesh-pop dk-pop'), { hidden: true }) as Pop;
  wrap.append(b, pop);
  // a column up the screen's right edge, the button at its bottom left corner
  const size = meshUi.size || { w: 320, h: 540 };
  dkAnchor(pop, anchor || b, { fill: size.w, tall: size.h });
  // its top left corner dragged for a size, the popup pinned bottom right
  const grip = Object.assign(el('span', 'dk-mesh-grip'), { title: 'resize' });
  pop.append(grip);
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const w0 = pop.offsetWidth;
    const h0 = pop.offsetHeight;
    const move = (ev: PointerEvent) => {
      meshUi.size = { w: Math.max(240, Math.round(w0 + x0 - ev.clientX)), h: Math.max(260, Math.round(h0 + y0 - ev.clientY)) };
      pop.dkAnchor!.fill = meshUi.size.w;
      pop.dkAnchor!.tall = meshUi.size.h;
      pop.style.width = '';
      pop.dkPlace!();
    };
    const up = () => { grip.removeEventListener('pointermove', move); saveMeshUi(); };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up, { once: true });
    grip.addEventListener('pointercancel', up, { once: true });
  });
  const fit = new ResizeObserver(() => { uiVars.meshDims = null; if (!pop.hidden && !meshAnimFrame) drawMesh(); });
  const show = (on: boolean) => {
    if (!on && pop.hidden) return;
    if (on) dkPopsClose('mesh');
    pop.hidden = !on;
    b.setAttribute('aria-expanded', String(on));
    if (on) {
      pop.appendChild(meshPanel);
      fit.observe(pop);
      uiVars.meshDims = null;
      // measured while stashed, 0 tall: measured again now it shows
      uiVars.meshStatsDirty = true;
      drawMesh();
      pingHosts();
    } else {
      fit.disconnect();
      stash.prepend(meshPanel);
    }
  };
  b.addEventListener('click', () => show(pop.hidden as boolean));
  // a press anywhere else closes it
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !wrap.contains(e.target as Node)) show(false); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) show(false); });
  dk.meshTray = { show };
  return wrap;
}
