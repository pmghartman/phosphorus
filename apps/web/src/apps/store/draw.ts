// the store drawn: the front or the page open, again whenever what it shows changes

import { el } from '../../lib/dom.ts';
import { dk, st } from '../../lib/state.ts';
import { page } from './apps.ts';
import { catalog, catalogError, followJobs, repoBox } from './catalog.ts';
import { front } from './front.ts';
import { sourcesPage } from './sources.ts';
import { apps, logsOpen, nativeLeft, readError, stateVars, view, watching } from './state.ts';
import { stackPage } from './viewer.ts';

export function draw() {
  if (!watching) return;
  followJobs(watching);
  const next = JSON.stringify([
    apps,
    nativeLeft,
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
    st.hostsInfo,
    st.lastState?.stacks,
    dk.services.map((r) => [r.host, r.name]),
    (st.lastState?.tailnet || []).map((d) => [d.name, d.phosphorus, d.os]),
  ]);
  if (next === stateVars.sig) return;
  stateVars.sig = next;
  // a page kept at its scroll across redraws, and the field being typed in at its caret
  const was = view.firstElementChild as HTMLElement | null;
  const scroll = was?.scrollTop || 0;
  const focus = document.activeElement as HTMLInputElement | null;
  const keep = focus && view.contains(focus) ? focus.dataset.keep : undefined;
  const caret = keep && 'selectionStart' in focus! ? [focus!.selectionStart, focus!.selectionEnd] : null;
  const wrap = el('div', 'store');
  const id = stateVars.openId;
  const open = id ? apps?.find((a) => a.id === id) : undefined;
  if (id && !id.startsWith('stack:') && id !== 'sources' && !open && apps) stateVars.openId = '';
  wrap.append(
    id.startsWith('stack:') ? stackPage(id.slice(6)) : id === 'sources' ? sourcesPage() : open ? page(open) : front(),
  );
  if (stateVars.actError) wrap.append(el('div', 'store-err', stateVars.actError));
  view.replaceChildren(wrap);
  wrap.scrollTop = scroll;
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
