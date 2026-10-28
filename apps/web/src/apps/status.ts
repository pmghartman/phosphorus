import { modalOpen } from '../lib/dom.ts';
import { st } from '../lib/state.ts';
import './status/state.ts';
import './status/glyphs.ts';
import './status/cards.ts';
import './status/model.ts';
import './status/summary.ts';
import './status/context.ts';
import './status/boxes.ts';
import { fitTiles, ST_BOXES, stCard } from './status/cards.ts';
import { drawModel, drawSum, headLine, modelOf } from './status/model.ts';
import {
  ST_STALE_MS,
  stateVars,
  statusDraw,
  statusWatch,
  stHost,
  stHosts,
  stHostsEl,
  stNet,
  stOpen,
  stWs,
} from './status/state.ts';
import { drawMeshSum } from './status/summary.ts';

// self first, then by name, hosts gone from the mesh dropped

export function statusRender() {
  const live = stNet ? stNet.tailnet.filter((d) => d.phosphorus).map((d) => d.name) : [...stHosts.keys()];
  const names = [...new Set(live)].sort(
    (a, b) => Number(b === st.selfHost) - Number(a === st.selfHost) || a.localeCompare(b),
  );
  for (const [name, h] of stHosts)
    if (!names.includes(name)) {
      h.card?.card.remove();
      stHosts.delete(name);
    }
  if (!names.includes(stateVars.stOpenHost!)) stateVars.stOpenHost = null;
  if (names.length) stHostsEl.querySelector('.st-wait')?.remove();
  // the mesh's sums left as they were rather than every card after them
  try {
    drawMeshSum(names);
  } catch (e) {
    console.error('status: the mesh summary', e);
  }
  let prev: HTMLElement | null = null;
  for (const name of names) {
    const h = stHost(name);
    h.card ||= stCard(name);
    const { card, parts } = h.card;
    if (card.parentNode !== stHostsEl || card.previousElementSibling !== prev) {
      if (prev) prev.after(card);
      else stHostsEl.prepend(card);
    }
    prev = card;
    const open = name === stateVars.stOpenHost;
    card.classList.toggle('open', open);
    parts.head.innerHTML = headLine(name, h, open);
    const model = modelOf(name);
    card.classList.toggle('has-model', !!model);
    drawModel(parts, model, open);
    card.classList.toggle('stale', !!h.s?.cpu && Date.now() - h.at > ST_STALE_MS);
    card.classList.toggle('waiting', !h.s?.cpu);
    if (!h.s?.cpu) {
      card.dataset.note = 'waiting for stats';
      continue;
    }
    // a sample this page can't draw spoils its own card only, never the hosts after it
    try {
      if (!open) {
        drawSum(parts, h);
        continue;
      }
      // no gpu, no gpu box
      for (const [k, , draw] of ST_BOXES) {
        const box = parts[`${k}Box`] as HTMLElement;
        box.hidden = k === 'gpu' && !h.s.gpus.length;
        if (!box.hidden) draw(parts, h);
      }
    } catch (e) {
      card.classList.add('waiting');
      card.dataset.note = 'can’t draw its stats';
      console.error(`status: ${name}'s stats`, e);
    }
  }
  stHostsEl.classList.toggle('has-open', !!stateVars.stOpenHost);
  fitTiles(names);
}

// one host open at a time, the opened or closed one keeping the arrow keys' pick
export function stToggle(name: string) {
  stateVars.stOpenHost = stateVars.stOpenHost === name ? null : name;
  statusRender();
  const card = stHosts.get(name)?.card?.card;
  card?.focus({ preventScroll: true });
  card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.shiftKey && stateVars.stOpenHost && stOpen() && !modalOpen())
    stToggle(stateVars.stOpenHost);
});

// a quiet peer's stale mark, with no message to trigger it
setInterval(() => {
  if (stWs) statusDraw();
}, 2000);
window.addEventListener('resize', statusDraw);
// as app.js registered it: the event itself handed to statusWatch, which takes it for a state
// until the next push sets a real one (kept as it was; a candidate fix, not this refactor's)
document.addEventListener('visibilitychange', statusWatch as unknown as EventListener);

export { statusDraw, statusReconnect, statusState, statusWatch } from './status/state.ts';
