// the desktop's keys, ctrl+alt the desk's own modifier: windows, the search and apps
// without a pointer, by key code so a mac's alt letters count too
import { isMobile } from '../dom.ts';
import { filesWin } from '../shares.ts';
import { dk, st } from '../state.ts';
import { dkLiveHosts, dkOpenApp, dkTerminal } from './desk.ts';
import { dkOverview, dkOverviewEnd, dkOverviewOn, dkSwitchEnd, dkSwitching, dkSwitchStep } from './switcher.ts';
import { dkClose, dkFocus, dkMax, dkMin, dkSnapTo, dkStack, type DkWin } from './windows.ts';
import { dkSpotlight } from './spotlight.ts';

const focused = (): DkWin | undefined => dkStack().find((w) => w.node.classList.contains('focused')) || dkStack()[0];

// show desktop: every window down, or the last such batch back up
let shown: DkWin[] = [];
export function dkShowDesktop(): void {
  const up = dkStack();
  if (up.length) { shown = up; for (const w of up) dkMin(w); return; }
  const back = shown.filter((w) => dk.wins.has(w.key) && w.node.hidden).reverse();
  shown = [];
  for (const w of back) dkFocus(w);
}

// a terminal on the host serving the page, else the first logged in
function terminal() {
  const hosts = dkLiveHosts();
  const h = hosts.includes(st.selfHost) ? st.selfHost : hosts[0];
  if (h) dkTerminal(h);
}

document.addEventListener('keydown', (e) => {
  if (!dk.desk || isMobile()) return;
  if (e.key === 'Escape' && dkOverviewOn()) { e.preventDefault(); dkOverviewEnd(); return; }
  if (!e.ctrlKey || !e.altKey || e.metaKey) return;
  const w = focused();
  const code = e.code;
  let done = true;
  if (code === 'Tab') dkSwitchStep(e.shiftKey);
  else if (code === 'Space') dkSpotlight();
  else if (code === 'KeyT') terminal();
  else if (code === 'KeyF') filesWin();
  else if (code === 'KeyC') dkOpenApp('chat');
  else if (code === 'KeyS') dkOpenApp('status');
  else if (code === 'KeyE') dkOpenApp('code');
  else if (code === 'KeyD') dkShowDesktop();
  else if (code === 'KeyO') dkOverview();
  else if (code === 'KeyQ' && w) dkClose(w);
  else if (code === 'KeyM' && w) dkMin(w);
  else if (code === 'ArrowUp' && w) dkMax(w);
  else if (code === 'ArrowDown' && w) { if (w.snap) dkSnapTo(w, ''); else dkMin(w); }
  else if (code === 'ArrowLeft' && w) dkSnapTo(w, w.snap === 'r' ? '' : 'l');
  else if (code === 'ArrowRight' && w) dkSnapTo(w, w.snap === 'l' ? '' : 'r');
  else done = false;
  if (done) { e.preventDefault(); e.stopPropagation(); }
}, true);

// the switcher lands once ctrl or alt is let go (or any key comes up without them held),
// cancelled by escape, landed by a press elsewhere
document.addEventListener('keyup', (e) => {
  if (!dkSwitching()) return;
  if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta' || !e.ctrlKey || !e.altKey) dkSwitchEnd();
}, true);
document.addEventListener('keydown', (e) => {
  if (!dkSwitching()) return;
  if (e.key === 'Escape') { e.preventDefault(); dkSwitchEnd(true); } else if (!e.ctrlKey || !e.altKey) dkSwitchEnd();
}, true);
document.addEventListener('pointerdown', (e) => { if (dkSwitching() && !(e.target as Element).closest('.dk-sw')) dkSwitchEnd(); }, true);
addEventListener('blur', () => { dkSwitchEnd(true); dkOverviewEnd(); });
