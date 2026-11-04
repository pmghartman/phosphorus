// the store drawn: the front or the page open, again whenever what it shows changes

import { el } from '../../lib/dom.ts';
import { dk, st } from '../../lib/state.ts';
import { page } from './apps.ts';
import { catalog, catalogError, followJobs, repoBox } from './catalog.ts';
import { framed, front } from './front.ts';
import { sourcesPage } from './sources.ts';
import { apps, logsOpen, readError, stateVars, view, watching } from './state.ts';
import { stackPage } from './viewer.ts';

// the page last drawn, '' for the front, and the front's scroll as a page opened over it
let drawnId = '';
let frontScroll = 0;
// the list the front last showed: another view, category, catalogue or search starts at its top
let drawnList = '';
// what scrolls: the front's main pane beside its rail, a page the whole store
const scroller = (x: HTMLElement | null) => x?.querySelector<HTMLElement>(':scope > .store-shell > .store-main') ?? x;

// each host's facts as the store words them: a copy's sync to the half minute and its progress to
// the percent, so a standby pulling every few seconds never redraws the whole store under the pointer
function calm(info: typeof st.hostsInfo) {
  return Object.fromEntries(
    Object.entries(info).map(([h, i]) => [
      h,
      {
        ...i,
        stacks: Object.fromEntries(
          Object.entries(i.stacks ?? {}).map(([id, x]) => [
            id,
            {
              ...x,
              lastSync: Math.floor((x.lastSync ?? 0) / 30000),
              copying: x.copying ? Math.floor((100 * x.copying.done) / Math.max(1, x.copying.total)) : -1,
            },
          ]),
        ),
      },
    ]),
  );
}

export function draw() {
  if (!watching) return;
  followJobs(watching);
  const next = JSON.stringify([
    apps,
    readError,
    catalog?.apps.length,
    catalog?.sources,
    catalogError,
    repoBox,
    stateVars.actError,
    stateVars.busyId,
    stateVars.openId,
    stateVars.filter,
    stateVars.tab,
    stateVars.source,
    stateVars.category,
    stateVars.all,
    [...logsOpen],
    st.selfHost,
    st.acct?.admin,
    calm(st.hostsInfo),
    st.lastState?.stacks,
    dk.services.map((r) => [r.host, r.name]),
    (st.lastState?.tailnet || []).map((d) => [d.name, d.phosphorus, d.os]),
  ]);
  if (next === stateVars.sig) return;
  stateVars.sig = next;
  // a page kept at its scroll across redraws, and the field being typed in at its caret
  const was = view.firstElementChild as HTMLElement | null;
  const focus = document.activeElement as HTMLInputElement | null;
  const keep = focus && view.contains(focus) ? focus.dataset.keep : undefined;
  const caret = keep && 'selectionStart' in focus! ? [focus!.selectionStart, focus!.selectionEnd] : null;
  const wrap = el('div', 'store');
  let id = stateVars.openId;
  const open = id ? apps?.find((a) => a.id === id) : undefined;
  if (id && !id.startsWith('stack:') && id !== 'sources' && !open && apps) id = stateVars.openId = '';
  // a page opened at its top, the way back landing where the front was left
  if (!drawnId && id) frontScroll = scroller(was)?.scrollTop || 0;
  const list = JSON.stringify([stateVars.tab, stateVars.category, stateVars.source, stateVars.filter.trim()]);
  const moved = list !== drawnList;
  drawnList = list;
  if (moved) frontScroll = 0;
  const scroll = id === drawnId && !moved ? scroller(was)?.scrollTop || 0 : id ? 0 : frontScroll;
  drawnId = id;
  wrap.append(
    id.startsWith('stack:')
      ? framed(stackPage(id.slice(6)))
      : id === 'sources'
        ? framed(sourcesPage())
        : open
          ? framed(page(open))
          : front(),
  );
  if (stateVars.actError) wrap.append(el('div', 'store-err', stateVars.actError));
  view.replaceChildren(wrap);
  scroller(wrap)!.scrollTop = scroll;
  if (keep) {
    const again = wrap.querySelector<HTMLInputElement>(`[data-keep="${CSS.escape(keep)}"]`);
    if (again) {
      again.focus();
      try {
        if (caret) again.setSelectionRange(caret[0], caret[1]);
      } catch {}
    }
  }
}
