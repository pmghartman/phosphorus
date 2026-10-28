// the list
import { el } from '../../lib/dom.ts';
import type { CodeOptions, CodeSession } from '@phosphorus/wire';
import { drawer, listEl, main } from './frame.ts';
import { paintNew } from './newsession.ts';
import { paintHead, paintOne, say } from './session.ts';
import { PICK_LS, ago, call, cd, lsGet, lsSet, sapi, tilde } from './state.ts';

export async function loadList() {
  try {
    const r = await call('/api/code/sessions');
    cd.list = r.sessions || [];
    cd.err = '';
  } catch (e) { cd.err = (e as Error).message; }
  if (!cd.pick) cd.pick = cd.list.some((s) => s.id === lsGet(PICK_LS, '')) ? lsGet(PICK_LS, '') : cd.list[0]?.id || 'new';
  if (cd.pick !== 'new' && !cd.list.some((s) => s.id === cd.pick) && !cd.err) { go(cd.list[0]?.id || 'new'); return; }
  paintList();
  if (cd.pick === 'new' && !main.querySelector('.cd-newform')) paintNew();
  else if (cd.pick !== 'new') paintHead();
}

export async function loadOpts(fresh?: boolean): Promise<CodeOptions> {
  if (cd.opts && !fresh) return cd.opts;
  try { cd.opts = await call('/api/code/options'); } catch (e) { cd.opts = { hosts: [], models: [], anthropic: false, error: (e as Error).message }; }
  return cd.opts!;
}

export const rec = (id = cd.pick) => cd.list.find((s) => s.id === id) || null;

export function paintList() {
  const sig = JSON.stringify([cd.list, cd.pick, cd.filter, cd.armed, cd.renaming, cd.err, Math.floor(Date.now() / 60000)]);
  if (sig === cd.listSig) return;
  cd.listSig = sig;
  const f = cd.filter;
  const shown = cd.list.filter((s) => !f || [s.title, s.host, s.dir, s.model].some((x) => String(x || '').toLowerCase().includes(f)));
  const rows: HTMLElement[] = [];
  if (cd.err) rows.push(el('div', 'cw-empty cd-bad', `failed: ${cd.err}`));
  else if (!cd.list.length) rows.push(el('div', 'cw-empty', 'no sessions yet'));
  else if (!shown.length) rows.push(el('div', 'cw-empty', 'nothing matches'));
  for (const s of shown) {
    const row = el('div', `cd-item${s.id === cd.pick ? ' on' : ''}`);
    row.dataset.id = s.id;
    if (cd.renaming === s.id) {
      const inp = Object.assign(el('input', 'cd-rename'), { value: s.title || '', maxLength: 120, spellcheck: false });
      const done = (save: boolean) => {
        if (cd.renaming !== s.id) return;
        cd.renaming = '';
        const t = inp.value.trim();
        if (save && t && t !== s.title) {
          s.title = t;
          call(sapi(s.id, 'rename'), 'POST', { title: t }).then(loadList, (e) => say(e.message));
        }
        cd.listSig = '';
        paintList();
        paintHead();
      };
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') done(true);
        if (e.key === 'Escape') done(false);
      });
      inp.addEventListener('blur', () => done(true));
      row.append(inp);
      rows.push(row);
      setTimeout(() => { inp.focus(); inp.select(); });
      continue;
    }
    const b = Object.assign(el('button', 'cd-pick'), { type: 'button', title: `${s.title}\n${s.host}:${s.dir}` });
    const top = el('span', 'cd-item-top');
    top.append(el('span', `cd-dot cd-st-${s.status}`), el('span', 'cw-name', s.title || 'untitled'), el('span', 'cw-sub', ago(s.updated || s.created)));
    const sub = el('span', 'cd-item-sub');
    sub.append(el('span', 'cd-host', s.host), ` ${tilde(s.dir)} · `, el('span', 'cd-model', s.model));
    b.append(top, sub);
    b.addEventListener('click', () => { go(s.id); drawer(false); });
    const acts = el('span', 'cd-item-acts');
    const ren = Object.assign(el('button', 'cd-mini', 'rename'), { type: 'button' });
    ren.addEventListener('click', () => { cd.renaming = s.id; cd.listSig = ''; paintList(); });
    const del = Object.assign(el('button', `cd-mini danger${cd.armed === `del:${s.id}` ? ' armed' : ''}`, cd.armed === `del:${s.id}` ? 'delete?' : 'delete'), { type: 'button' });
    del.title = 'ends it and forgets its transcript; its files stay';
    del.addEventListener('click', () => remove(s));
    acts.append(ren, del);
    row.append(b, acts);
    rows.push(row);
  }
  const focused = (document.activeElement?.closest?.('.cd-item') as HTMLElement | null)?.dataset.id;
  listEl.replaceChildren(...rows);
  if (focused && !cd.renaming) (listEl.querySelector(`.cd-item[data-id="${CSS.escape(focused)}"] .cd-pick`) as HTMLElement | null)?.focus();
}

// twice to confirm, the first press arming it a few seconds
export function arm(what: string): boolean {
  if (cd.armed === what) { cd.armed = ''; return true; }
  cd.armed = what;
  cd.listSig = '';
  paintList();
  setTimeout(() => { if (cd.armed === what) { cd.armed = ''; cd.listSig = ''; paintList(); } }, 4000);
  return false;
}

export function remove(s: CodeSession) {
  if (!arm(`del:${s.id}`)) return;
  call(sapi(s.id), 'DELETE').then(() => {
    const t = cd.logs.get(s.id);
    if (t) { t.closed = true; t.sock?.close(); cd.logs.delete(s.id); }
    cd.list = cd.list.filter((x) => x.id !== s.id);
    if (cd.pick === s.id) { cd.pick = ''; go(cd.list[0]?.id || 'new'); } else loadList();
  }, (e) => say(e.message));
}

export function go(id: string) {
  if (id === cd.pick && main.childElementCount) return;
  const was = cd.logs.get(cd.pick);
  if (was) { was.closed = true; was.sock?.close(); was.sock = null; }
  cd.pick = id;
  if (id !== 'new') lsSet(PICK_LS, id);
  cd.listSig = '';
  paintList();
  if (id === 'new') paintNew(); else paintOne();
}
