// the wallpaper: a picture of the user's, kept in their home on the mesh
import { acctCall } from '../../lib/api.ts';
import { dragsFiles } from '../../features/chat/chat.ts';
import { DK_UI, dkGlyph, el } from '../../lib/dom.ts';
import { activeConnections, drawMesh, serviceKey, serviceUrl, startPulseLoop, type Connection } from '../../features/mesh/mesh.ts';
import { filesJoin, filesParent, filesWin, fileLabel, fmSame, fmTransfer, HOME, homeAt, homeOnline, putFile, fmChanged } from '../../features/home/home.ts';
import { dk, st } from '../../lib/state.ts';
import type { Route } from '@phosphorus/wire';
import { dkAppearanceWin } from '../control.ts';
import { dkCode, dkDeskAt, dkFileMenu } from '../deskfiles.ts';
import { dkClock, type Pop } from '../taskbar.ts';
import { dkFocus, dkNav, dkWin, type DkWin, type NavFrame } from '../windows.ts';
import { dkView } from '../desk.ts';
import { dkTerminal } from './apps.ts';
import { DK_GX, DK_GY, DK_PAD, DK_POS_KEY, dkCell, dkGrid, dkIconEls, dkLayout, dkLiveHosts, dkPaintSel, dkSaved } from './icons.ts';

export const DK_WALL_MAX = 2560;

// the wallpaper set or removed, for the appearance window's row
export const WALL_EVENT = 'phosphorus-wallpaper';
export function dkWallPaint(): void {
  const at = st.acct?.wallpaper || 0;
  dkView.classList.toggle('dk-walled', !!at);
  if (at) dkView.style.setProperty('--dk-wall', `url("/api/me/wallpaper?v=${at}")`);
  else dkView.style.removeProperty('--dk-wall');
  dispatchEvent(new CustomEvent(WALL_EVENT, { detail: at }));
}

// shrunk to the screen's size at most, a jpeg; '' once set, else why not
export async function dkWallSet(blob: Blob): Promise<string> {
  let url;
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, DK_WALL_MAX / Math.max(bmp.width, bmp.height));
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    url = c.toDataURL('image/jpeg', 0.85);
  } catch { return 'not an image'; }
  const r = await acctCall('/api/me/wallpaper', { data: url });
  if (!r.ok) return r.error || 'not saved';
  st.acct!.wallpaper = r.wallpaper;
  dkWallPaint();
  return '';
}

export async function dkWallClear(): Promise<void> {
  const r = await acctCall('/api/me/wallpaper', { data: '' });
  if (!r.ok) return;
  st.acct!.wallpaper = 0;
  dkWallPaint();
}

export const dkPick = (accept: string, multiple: boolean, then: (files: File[]) => void) => {
  const input = Object.assign(el('input'), { type: 'file', accept, multiple });
  input.addEventListener('change', () => { if (input.files!.length) then([...input.files!]); });
  input.click();
};
// a picture picked for the wallpaper
export const dkWallPick = (): void => dkPick('image/*', false, ([f]) => dkWallSet(f!).then((why) => why && dkMenuNote(why)));

// files about to land on the desktop held to the cell at x, y (else the
// nearest free ones after it), their icons placed there once they show
export function dkPlaceAt(x: number, y: number, names: string[], dir = dkDeskAt()?.dir) {
  if (!dk.desk || !dir || !names.length) return;
  const box = dk.desk.icons.getBoundingClientRect();
  const { cols, rows } = dkGrid();
  const c0 = Math.max(0, Math.min(cols - 1, Math.floor((x - box.left - DK_PAD) / DK_GX)));
  const r0 = Math.max(0, Math.min(rows - 1, Math.floor((y - box.top - DK_PAD) / DK_GY)));
  const ids = new Set(names.map((n) => `doc\n${filesJoin(dir, n)}`));
  const taken = new Set(dkIconEls().filter((b) => !ids.has(b.dataset.id!)).map((b) => dkCell(b.dataset.c!, b.dataset.r!)));
  const saved = dkSaved();
  let i = c0 * rows + r0;
  for (const id of ids) {
    while (i < cols * rows && taken.has(dkCell(Math.floor(i / rows), i % rows))) i += 1;
    const at: [number, number] = i < cols * rows ? [Math.floor(i / rows), i % rows] : [c0, r0];
    taken.add(dkCell(...at));
    saved[id] = at;
  }
  try { localStorage.setItem(DK_POS_KEY, JSON.stringify(saved)); } catch {}
}

// a new empty file on the desktop at x, y, on this host, opened to edit
export function dkNewFile(x: number, y: number) {
  const d = dkDeskAt();
  if (!d) return;
  const pop = el('form', 'acct-unlock dk-newfile') as HTMLFormElement & Pop;
  const name = Object.assign(el('input'), { value: 'untitled.txt', spellcheck: false, autocomplete: 'off' as const });
  const why = el('span', 'dk-state');
  const go = Object.assign(el('button', 'primary', 'create'), { type: 'submit' });
  pop.append(el('div', 'home-col-head', 'add file'), name, why, go);
  pop.style.left = `${Math.max(4, Math.min(x, innerWidth - 260))}px`;
  pop.style.top = `${Math.max(4, Math.min(y, innerHeight - 140))}px`;
  const close = () => { pop.remove(); pop.dkRelease?.(); document.removeEventListener('pointerdown', away, true); };
  const away = (e: PointerEvent) => { if (!pop.contains(e.target as Node)) close(); };
  document.addEventListener('pointerdown', away, true);
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  pop.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = name.value.trim();
    if (!n || /[\\/]/.test(n)) { why.textContent = 'no slashes'; return; }
    if (dk.deskFiles.some((f) => f.at === d.dir && f.name === n)) { why.textContent = 'exists'; return; }
    const loc = homeAt(st.selfHost);
    const rel = filesJoin(d.dir, n);
    go.disabled = true;
    try { await putFile(loc, rel, new Blob([])); } catch (err) { go.disabled = false; why.textContent = (err as Error).message; return; }
    close();
    dkPlaceAt(x, y, [n], d.dir);
    fmChanged(HOME, d.dir);
    dkCode({ host: loc.host, share: loc.share, path: rel, label: fileLabel(loc.host, 'home', rel) });
  });
  document.body.appendChild(pop);
  name.focus();
  // the name picked, its extension left
  name.setSelectionRange(0, name.value.lastIndexOf('.'));
}

// computer files onto the desktop, else a files window's first folder,
// a files window showing the upload either way
export async function dkAddFiles(list: File[]) {
  const fm = dk.desk && await filesWin(dkDeskAt() || undefined);
  if (fm && list.length) fm.pendingUpload = list;
}

// a right click on the desk or an icon, a drop of the computer's files
export function dkDeskMenu(icons: HTMLElement) {
  icons.addEventListener('contextmenu', (e) => {
    const b = (e.target as Element).closest('.dk-icon') as HTMLElement | null;
    if (e.target !== icons && !b) return;
    e.preventDefault();
    if (b && !dk.sel.has(b.dataset.id!)) { dk.sel = new Set([b.dataset.id!]); dkPaintSel(); }
    const hosts = dkLiveHosts();
    const f = b && dk.deskFiles.find((x) => filesJoin(x.at!, x.name) === b.dataset.file);
    if (f) { dkMenu(e.clientX, e.clientY, dkFileMenu(f)); return; }
    const [kind, name, host] = b ? b.dataset.id!.split('\n') : [];
    const svc = kind === 'service' && dk.services.find((r) => r.host === host && r.name === name);
    const items: MenuItem[] = [
      ...(b ? [['open', () => b.dispatchEvent(new MouseEvent('dblclick')), true] as MenuItem] : []),
      ...(svc && st.acct?.admin ? [[svc.public ? 'make private' : 'make public', () => dkSetPublic(svc, !svc.public), true] as MenuItem] : []),
      ...(b ? [null] : []),
      ['new terminal', hosts.map((h): MenuItem => [h, () => dkTerminal(h), true]), hosts.length > 0],
      null,
      ['add file…', () => dkNewFile(e.clientX, e.clientY), !!dkDeskAt()],
      ['upload files…', () => dkPick('', true, (list) => { dkPlaceAt(e.clientX, e.clientY, list.map((f) => f.name)); dkAddFiles(list); }), homeOnline().length > 0],
      null,
      ['change wallpaper…', dkWallPick, !!st.acct && !st.acct.boot],
      ['appearance…', () => dkAppearanceWin('desktop'), true],
      null,
      ['select all', () => { dk.sel = new Set(dkIconEls().map((x) => x.dataset.id!)); dkPaintSel(); }, true],
      ['arrange icons', dkArrange, true],
    ];
    dkMenu(e.clientX, e.clientY, items);
  });
  icons.addEventListener('dragover', (e) => {
    if (!(dragsFiles(e) || (dk.drag && dkDeskAt()))) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  });
  icons.addEventListener('drop', (e) => {
    const drag = dk.drag;
    const d = dkDeskAt();
    // a files window's picks copied onto the desktop
    if (drag && d) {
      e.preventDefault();
      dk.drag = null;
      const items = drag.items.filter((it) => !(fmSame(drag.loc, d.loc) && filesParent(it.rel) === d.dir));
      dkPlaceAt(e.clientX, e.clientY, items.map((it) => it.name), d.dir);
      if (items.length) fmTransfer(drag.fm, drag.loc, items, d.loc, d.dir, false);
      return;
    }
    if (!dragsFiles(e)) return;
    e.preventDefault();
    const list = [...e.dataTransfer!.files];
    dkPlaceAt(e.clientX, e.clientY, list.map((f) => f.name));
    dkAddFiles(list);
  });
}

// a word in the clock's place a moment
export function dkMenuNote(text: string): void {
  if (!dk.clock) return;
  dk.clock.textContent = text;
  setTimeout(dkClock, 4000);
}

// every icon back in the default order
export function dkArrange(): void {
  try { localStorage.setItem(DK_POS_KEY, '{}'); } catch {}
  dkLayout();
}

// one item of a right click's menu: label, its action (or a submenu's items), whether it's
// enabled, a class; null a separator
export type MenuItem = [string, (() => unknown) | MenuItem[], boolean, string?] | null;

export const dkMenuEl = el('div', 'dk-menu') as HTMLElement & Pop & { owner?: Element | null };
dkMenuEl.hidden = true;
dkMenuEl.setAttribute('role', 'menu');
document.body.appendChild(dkMenuEl);
// a press on its owner left to the owner's own toggle
document.addEventListener('pointerdown', (e) => { if (!dkMenuEl.contains(e.target as Node) && !dkMenuEl.owner?.contains(e.target as Node)) dkMenuEl.hidden = true; }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dkMenuEl.hidden = true; }, true);
addEventListener('blur', () => { dkMenuEl.hidden = true; });

export function dkMenu(x: number, y: number, items: MenuItem[], after?: () => void, title?: string): void {
  dkMenuEl.owner = null;
  dkMenuEl.classList.remove('dk-pop');
  dkMenuEl.dkAnchor = null;
  dkMenuEl.style.bottom = '';
  const item = (it: MenuItem): HTMLElement => {
    if (!it) return el('div', 'dk-menu-sep');
    const [label, act, ok, cls] = it;
    const b = Object.assign(el('button', cls || '', label), { type: 'button', disabled: !ok });
    if (!Array.isArray(act)) {
      b.addEventListener('click', () => { dkMenuEl.hidden = true; after?.(); act(); });
      return b;
    }
    // a list for its act: a submenu out to the side on hover, as Windows' own
    b.classList.add('dk-menu-more');
    const wrap = el('div', 'dk-menu-item');
    const sub = el('div', 'dk-menu dk-submenu');
    sub.append(...act.map(item));
    wrap.append(b, sub);
    const open = () => {
      if (b.disabled) return;
      for (const o of wrap.parentElement!.querySelectorAll(':scope > .dk-menu-item.open')) if (o !== wrap) o.classList.remove('open');
      wrap.classList.add('open');
      const r = b.getBoundingClientRect();
      sub.classList.toggle('left', r.right + sub.offsetWidth > innerWidth - 4);
      sub.style.top = `${Math.min(0, innerHeight - 4 - r.top - sub.offsetHeight)}px`;
    };
    wrap.addEventListener('pointerenter', open);
    wrap.addEventListener('pointerleave', () => wrap.classList.remove('open'));
    b.addEventListener('click', open);
    b.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { open(); (sub.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus(); } });
    sub.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') { wrap.classList.remove('open'); b.focus(); } });
    return wrap;
  };
  dkMenuEl.replaceChildren(...(title ? [el('div', 'dk-menu-title', title)] : []), ...items.map(item));
  dkMenuEl.hidden = false;
  dkMenuEl.style.left = `${Math.min(x, innerWidth - dkMenuEl.offsetWidth - 4)}px`;
  dkMenuEl.style.top = `${Math.min(y, innerHeight - dkMenuEl.offsetHeight - 4)}px`;
}

// a service behind the phosphorus login or open to all, its owning host's services.export rewritten
export async function dkSetPublic(r: Route, on: boolean) {
  const res = await fetch(`/api/services/${encodeURIComponent(r.host)}/${encodeURIComponent(r.name)}/public`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ public: on }),
  }).catch(() => null);
  const out = res ? await res.json().catch(() => ({})) : {};
  dkMenuNote(res?.ok ? `${r.name} ${on ? 'public' : 'private'}` : out.error || 'not changed');
}

export function dkService(r: Route): DkWin | undefined {
  const w = dkWin(`svc:${serviceKey(r)}`, r.name, r.public ? `${r.host}, public` : r.host, 'svc');
  if (!w) return;
  const url = serviceUrl(r);
  const pop = Object.assign(el('button', 'dk-out'), { type: 'button', title: 'open in a browser tab', ariaLabel: 'open in a browser tab' });
  pop.appendChild(dkGlyph(DK_UI.pop!));
  pop.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
  w.head.querySelector('.dk-btns')!.prepend(pop);
  const frame: NavFrame = Object.assign(el('iframe', 'dk-frame'), { src: url, title: r.name, allow: 'clipboard-read; clipboard-write; fullscreen' });
  w.body.appendChild(frame);
  dkNav(w, frame);
  // lit on the mesh graph as an open tab of it would be
  const conn: Connection = { win: { closed: false }, host: r.host, name: r.name };
  activeConnections.set(serviceKey(r), conn);
  startPulseLoop();
  drawMesh();
  w.onFocus = () => frame.contentWindow?.focus();
  w.onClose = () => { conn.win.closed = true; frame.contentWindow?.location.replace('about:blank'); };
  dkFocus(w);
  return w;
}
