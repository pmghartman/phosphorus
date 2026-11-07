// --- the bar's quick buttons: the mesh's graph and pings, and the mesh update, each a popup grown
// out of its own button as they were before settings, borrowing the view settings shows and handing
// it back when it closes

import { drawMesh, meshPanel, pingHosts } from '../features/mesh/mesh.ts';
import { meshAnimFrame, meshUi, saveMeshUi, uiVars } from '../features/mesh/ui.ts';
import { meshLockNow, updateModal, updateOpen, updates, updateWatch } from '../features/update.ts';
import { DK_GLYPHS, dkGlyph, el, stash } from '../lib/dom.ts';
import { st } from '../lib/state.ts';
import { dkAnchor, dkPopReg, dkPopsClose, type Pop } from './taskbar.ts';

type Quick = { wrap: HTMLElement; btn: HTMLButtonElement; pop: Pop; show: (on: boolean) => void };

// a bar button and its popup: one popup open at a time, a press elsewhere or Escape closing it
function quick(o: {
  id: string;
  glyph: string;
  title: string;
  fill: number;
  tall?: number;
  open: (pop: Pop) => void;
  close: (pop: Pop) => void;
}): Quick {
  const wrap = el('div', `dk-tray-wrap dk-quick dk-quick-${o.id}`);
  const btn = Object.assign(el('button', 'dk-tray'), { type: 'button', title: o.title, ariaLabel: o.title });
  btn.setAttribute('aria-expanded', 'false');
  btn.appendChild(dkGlyph(o.glyph));
  const pop = Object.assign(el('div', `dk-pop dk-${o.id}-pop`), { hidden: true }) as Pop;
  wrap.append(btn, pop);
  dkAnchor(pop, btn, { fill: o.fill, tall: o.tall ?? 0 });
  const show = (on: boolean) => {
    if (!on && pop.hidden) return;
    if (on) dkPopsClose(o.id);
    pop.hidden = !on;
    btn.setAttribute('aria-expanded', String(on));
    if (on) o.open(pop);
    else o.close(pop);
  };
  btn.addEventListener('click', () => show(pop.hidden as boolean));
  document.addEventListener(
    'pointerdown',
    (e) => {
      // a press in a page ask (the update's password, say) leaves it open
      const t = e.target as Element;
      if (!pop.hidden && !wrap.contains(t) && !t.closest?.('.page-veil')) show(false);
    },
    true,
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) show(false);
  });
  dkPopReg(o.id, show);
  return { wrap, btn, pop, show };
}

// a view borrowed from settings goes back there while its section is up, else to the stash
function giveBack(view: HTMLElement, home: string, prepend = false) {
  const at = document.querySelector<HTMLElement>(home);
  if (at) at.prepend(view);
  else if (prepend) stash.prepend(view);
  else stash.append(view);
}

// the graph and pings in a column up from the button, its top left corner dragged for a size
export function dkMeshQuick(): HTMLElement {
  const size = meshUi.size || { w: 320, h: 540 };
  const fit = new ResizeObserver(() => {
    if (!meshAnimFrame) drawMesh();
  });
  const grip = Object.assign(el('span', 'dk-mesh-grip'), { title: 'resize' });
  const q: Quick = quick({
    id: 'mesh',
    glyph: DK_GLYPHS.mesh!,
    title: 'mesh',
    fill: size.w,
    tall: size.h,
    open: (pop) => {
      pop.replaceChildren(grip, meshPanel);
      fit.observe(pop);
      uiVars.meshStatsDirty = true;
      drawMesh();
      pingHosts();
    },
    close: () => {
      fit.disconnect();
      giveBack(meshPanel, '.set-mesh', true);
    },
  });
  const pop = q.pop;
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const w0 = pop.offsetWidth;
    const h0 = pop.offsetHeight;
    const move = (ev: PointerEvent) => {
      meshUi.size = {
        w: Math.max(240, Math.round(w0 + x0 - ev.clientX)),
        h: Math.max(260, Math.round(h0 + y0 - ev.clientY)),
      };
      pop.dkAnchor!.fill = meshUi.size.w;
      pop.dkAnchor!.tall = meshUi.size.h;
      pop.style.width = '';
      pop.dkPlace!();
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      saveMeshUi();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up, { once: true });
    grip.addEventListener('pointercancel', up, { once: true });
  });
  return q.wrap;
}

// an admin's: the hosts' versions and the update itself, a dot while a release waits
export function dkUpdateQuick(): HTMLElement | null {
  if (!st.acct?.admin) return null;
  const q: Quick = quick({
    id: 'update',
    glyph: DK_GLYPHS.update!,
    title: 'update',
    fill: 0,
    open: (pop) => {
      updateModal.hidden = false;
      pop.replaceChildren(updateModal);
      updateOpen();
    },
    close: () => giveBack(updateModal, '.set-body[data-at="update"]'),
  });
  const paint = () => {
    const lock = meshLockNow();
    const fresh = !!updates.mesh && !lock;
    q.btn.classList.toggle('has-update', fresh);
    q.btn.classList.toggle('busy', !!lock);
    q.btn.title = lock ? 'update, under way' : fresh ? `update: v${updates.mesh} out` : 'update';
  };
  updateWatch(paint);
  paint();
  return q.wrap;
}
