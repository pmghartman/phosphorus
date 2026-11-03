import { st } from '../lib/state.ts';
import './status/state.ts';
import './status/glyphs.ts';
import './status/cards.ts';
import './status/model.ts';
import './status/summary.ts';
import './status/context.ts';
import './status/boxes.ts';
import './status/purge.ts';
import { drawHost, hostPage } from './status/boxes.ts';
import {
  ST_STALE_MS,
  stateVars,
  statusDraw,
  statusWatch,
  stHost,
  stHosts,
  stNet,
  stView,
  stWs,
} from './status/state.ts';
import { drawMeshSum, meshPage } from './status/summary.ts';

// the page shown: the mesh summed, or the host picked alone; hosts gone from the mesh dropped
export function statusRender() {
  const live = stNet ? stNet.tailnet.filter((d) => d.phosphorus).map((d) => d.name) : [...stHosts.keys()];
  const names = [...new Set(live)].sort(
    (a, b) => Number(b === st.selfHost) - Number(a === st.selfHost) || a.localeCompare(b),
  );
  for (const [name, h] of stHosts)
    if (!names.includes(name) && name !== stateVars.stPicked) {
      h.page?.node.remove();
      stHosts.delete(name);
    }
  if (names.length) stView.querySelector('.st-wait')?.remove();
  else return;
  const name = stateVars.stPicked;
  const page = name ? (stHost(name).page ||= hostPage(name)) : meshPage;
  if (page.node.parentNode !== stView) stView.replaceChildren(page.node);
  // a sample this page can't draw spoils it alone, the next one tried again
  try {
    if (!name) {
      drawMeshSum(names);
      return;
    }
    const h = stHost(name);
    page.node.classList.toggle('stale', !!h.s?.cpu && Date.now() - h.at > ST_STALE_MS);
    page.node.classList.toggle('waiting', !h.s?.cpu);
    page.node.dataset.note = 'waiting for stats';
    if (h.s?.cpu) drawHost(page, name, h);
  } catch (e) {
    page.node.classList.add('waiting');
    page.node.dataset.note = 'can’t draw its stats';
    console.error(`status: ${name || 'the mesh'}'s stats`, e);
  }
}

// settings' hosts page: one host in full, null for the mesh summed
export function statusOnly(name: string | null) {
  stateVars.stPicked = name;
  statusRender();
}

// a quiet peer's stale mark, with no message to trigger it
setInterval(() => {
  if (stWs) statusDraw();
}, 2000);
window.addEventListener('resize', statusDraw);
// as app.js registered it: the event itself handed to statusWatch, which takes it for a state
// until the next push sets a real one (kept as it was; a candidate fix, not this refactor's)
document.addEventListener('visibilitychange', statusWatch as unknown as EventListener);

export { modelPurged } from './status/purge.ts';
export { statusDraw, statusReconnect, statusState, statusWatch } from './status/state.ts';
