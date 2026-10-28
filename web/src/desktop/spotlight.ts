// the search: a box in the middle of the desk (ctrl+alt+space, or the bar's glass), plain
// words finding apps, settings, menu actions, open windows, hosts and files
import { acctLogout, dkProfileWin, dkUsersWin } from '../account.ts';
import { DK_GLYPHS, dkGlyph, el, isMobile } from '../dom.ts';
import { MODES, modePick, setTheme } from '../scheme.ts';
import { filesApi, filesJoin, filesWin, fileOpen, HOME, homeOnline } from '../shares.ts';
import { dk, st } from '../state.ts';
import { PALETTES, paletteNow, setPalette } from '../theme.ts';
import type { FileEntry } from '../types.ts';
import { openUpdateModal } from '../update.ts';
import { dkAppearanceWin } from './control.ts';
import { dkLiveHosts, dkOpenApp, dkService, dkTerminal, dkWallClear, dkWallPick, dkArrange, dkWebApp, dkWebApps } from './desk.ts';
import { dkShowDesktop } from './keys.ts';
import { dkOverview } from './switcher.ts';
import { dkClose, dkFocus, dkMax, dkMin, dkSnapTo, dkStack } from './windows.ts';

interface Hit { glyph: string; label: string; sub: string; kind: string; keys: string; act: () => void }

// words that say nothing about what is wanted
const FILLER = new Set(['open', 'show', 'the', 'a', 'an', 'me', 'my', 'go', 'to', 'please', 'run', 'start', 'launch', 'find', 'search', 'for', 'on', 'in', 'at', 'with']);
const words = (q: string) => q.toLowerCase().split(/\s+/).filter((w) => w && !FILLER.has(w));

// everything the search can reach, before any file
function hits(): Hit[] {
  const out: Hit[] = [];
  const add = (glyph: string, label: string, sub: string, kind: string, keys: string, act: () => void) => out.push({ glyph, label, sub, kind, keys, act });
  const G = DK_GLYPHS;
  for (const h of dkLiveHosts()) add(G.terminal!, 'terminal', h, 'terminal', `shell console ssh ${h}`, () => dkTerminal(h));
  add(G.files!, 'files', '', 'files', 'folders browse home share', () => filesWin());
  add(G.chat!, 'chat', '', 'app', 'messages talk mesh', () => dkOpenApp('chat'));
  add(G.status!, 'status', '', 'app', 'stats cpu memory disk hosts health', () => dkOpenApp('status'));
  if (st.gitRoute) add(G.git!, 'git', '', 'app', 'forgejo repos', () => dkOpenApp('git'));
  add(G.code!, 'code', '', 'app', 'claude opencode agent sessions', () => dkOpenApp('code'));
  add(G.agents!, 'agents', '', 'app', 'models assign', () => dkOpenApp('agents'));
  add(G.games!, 'game servers', '', 'app', 'games play', () => dkOpenApp('games'));
  add(G.apps!, 'apps', '', 'app', 'install store extras sulfur editor', () => dkOpenApp('apps'));
  add(G.about!, 'about', '', 'app', 'version license', () => dkOpenApp('about'));
  for (const a of dkWebApps()) add(G.app!, a.id, `v${a.want.version}`, 'app', 'editor code app', () => dkWebApp(a.id));
  for (const r of dk.services) add(G.service!, r.name, r.host, 'service', `service site ${r.public ? 'public' : ''}`, () => dkService(r));
  // settings
  if (st.acct && !st.acct.boot) {
    add(G.user!, 'profile', 'hosts, page logins, password', 'setting', 'account settings password logins vault prefs', dkProfileWin);
    add(G.palette!, 'appearance', 'theme, desk, bar, windows', 'setting', 'theme editor accent font corners layout bar customize look wallpaper', () => dkAppearanceWin());
    if (st.acct.admin) {
      add(G.users!, 'users', '', 'setting', 'accounts admin', dkUsersWin);
      add(G.update!, 'mesh update', '', 'setting', 'upgrade version release', openUpdateModal);
    }
    add(G.doc!, 'change wallpaper', '', 'setting', 'background picture desk', dkWallPick);
    if (st.acct.wallpaper) add(G.doc!, 'remove wallpaper', '', 'setting', 'background picture', dkWallClear);
  }
  for (const m of MODES) add(G.palette!, `${m} mode`, modePick() === m ? 'on' : '', 'setting', 'theme light dark oled appearance', () => setTheme(m));
  for (const p of PALETTES) if (!p.custom) add(G.palette!, `theme ${p.label}`, paletteNow() === p.id ? 'on' : p.about || '', 'setting', 'look palette style appearance', () => setPalette(p.id));
  add(G.mesh!, 'mesh', '', 'menu', 'graph hosts peers tailnet', () => dk.meshTray?.show(true));
  add(G.bell!, 'notifications', '', 'menu', 'bell alerts', () => dk.bell?.show(true));
  add(G.app!, 'arrange icons', '', 'menu', 'desktop tidy sort', dkArrange);
  add(G.power!, 'log out', '', 'menu', 'sign out quit exit', acctLogout);
  // windows
  const up = dkStack();
  const top = up.find((w) => w.node.classList.contains('focused')) || up[0];
  if (up.length) add(G.app!, 'show desktop', '', 'window', 'minimize all hide windows', dkShowDesktop);
  if (dk.wins.size) add(G.app!, 'overview', '', 'window', 'all windows expose', dkOverview);
  if (top) {
    const t = top.task.querySelector('.dk-task-t')?.textContent || '';
    add(top.glyph, `close ${t}`, '', 'window', 'quit window', () => dkClose(top));
    add(top.glyph, `minimize ${t}`, '', 'window', 'hide window', () => dkMin(top));
    add(top.glyph, top.snap === 'max' ? `restore ${t}` : `maximize ${t}`, '', 'window', 'full window', () => dkMax(top));
    add(top.glyph, `snap ${t} left`, '', 'window', 'tile half window', () => dkSnapTo(top, 'l'));
    add(top.glyph, `snap ${t} right`, '', 'window', 'tile half window', () => dkSnapTo(top, 'r'));
  }
  for (const w of dk.wins.values()) if (w !== top) add(w.glyph, `switch to ${w.task.querySelector('.dk-task-t')?.textContent || ''}`, w.node.hidden ? 'minimized' : '', 'window', 'window focus raise', () => dkFocus(w));
  // the desktop's files
  for (const f of dk.deskFiles) if (!f.stale) add(G.doc!, f.name, f.at!.startsWith('shared/') ? 'shared desktop' : 'desktop', 'file', f.dir ? 'folder' : 'file document', () => fileOpen(HOME, filesJoin(f.at!, f.name), f));
  return out;
}

// 0 for no match, else higher the earlier the words land in the label
function score(h: Hit, ws: string[]): number {
  const label = h.label.toLowerCase();
  const hay = `${label} ${h.sub} ${h.kind} ${h.keys}`.toLowerCase();
  let s = 0;
  for (const w of ws) {
    const i = hay.indexOf(w);
    if (i < 0) return 0;
    s += label.startsWith(w) ? 3 : label.includes(w) ? 2 : 1;
  }
  return s;
}

let box: HTMLElement | null = null;

// the home searched by name, a few hits, each a file the files app opens
async function fileHits(q: string): Promise<Hit[]> {
  const host = homeOnline().includes(st.selfHost) ? st.selfHost : homeOnline()[0];
  if (!host || !st.acct || st.acct.boot) return [];
  const r = await fetch(filesApi({ host, share: 'home' }, 'search', { path: '', query: q, skip: 'node_modules,.git,.cache' })).catch(() => null);
  const body = r?.ok ? await r.json().catch(() => null) : null;
  const list: { path: string; size?: number }[] = Array.isArray(body?.results) ? body.results : [];
  return list.slice(0, 12).map((e) => {
    const dir = e.path.endsWith('/');
    const rel = dir ? e.path.slice(0, -1) : e.path;
    const name = rel.split('/').pop()!;
    const entry = { name, dir, size: e.size ?? 0 } as unknown as FileEntry;
    return { glyph: dir ? DK_GLYPHS.files! : DK_GLYPHS.doc!, label: name, sub: rel.slice(0, -name.length).replace(/\/$/, '') || 'home', kind: 'file', keys: '', act: () => fileOpen(HOME, rel, entry) };
  });
}

export function dkSpotlightEnd(): void {
  box?.parentElement?.remove();
  box = null;
}

export function dkSpotlight(): void {
  if (!dk.desk || isMobile()) return;
  if (box) { dkSpotlightEnd(); return; }
  const veil = el('div', 'dk-spot-veil');
  box = el('div', 'dk-spot');
  const find = Object.assign(el('input', 'dk-spot-find'), { placeholder: 'apps, settings, windows, files', spellcheck: false, autocomplete: 'off' as const });
  const list = el('div', 'dk-spot-list');
  list.setAttribute('role', 'listbox');
  box.append(dkGlyph(DK_GLYPHS.search!, 'dk-spot-ic'), find, list);
  veil.appendChild(box);
  dk.desk.el.appendChild(veil);
  let at = 0;
  let shown: Hit[] = [];
  let files: Hit[] = [];
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pick = (h: Hit) => { dkSpotlightEnd(); h.act(); };
  const mark = () => { [...list.children].forEach((r, i) => r.classList.toggle('cur', i === at)); list.children[at]?.scrollIntoView({ block: 'nearest' }); };
  const paint = () => {
    const ws = words(find.value);
    const all = hits();
    shown = ws.length ? all.map((h) => [score(h, ws), h] as const).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).map(([, h]) => h) : all.filter((h) => h.kind !== 'window');
    if (ws.length) shown = [...shown, ...files];
    shown = shown.slice(0, 40);
    at = Math.min(at, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.map((h, i) => {
      const row = Object.assign(el('button', `dk-spot-row dk-${h.kind}${i === at ? ' cur' : ''}`), { type: 'button' });
      row.setAttribute('role', 'option');
      row.append(dkGlyph(h.glyph, 'dk-spot-row-ic'), el('span', 'dk-spot-t', h.label));
      if (h.sub) row.append(el('span', 'dk-spot-s', h.sub));
      row.append(el('span', 'dk-spot-k', h.kind));
      row.addEventListener('click', () => pick(h));
      row.addEventListener('pointerenter', () => { at = i; mark(); });
      return row;
    }));
    if (!shown.length) list.append(el('div', 'dk-spot-none', 'nothing matches'));
  };
  // the home searched a moment after typing stops, an old answer never shown over a new one
  const lookup = () => {
    const q = find.value.trim();
    clearTimeout(timer!);
    if (q.length < 2) { files = []; return; }
    timer = setTimeout(async () => {
      const n = ++seq;
      const got = await fileHits(q);
      if (n !== seq || !box) return;
      const seen = new Set(shown.map((h) => `${h.kind}\n${h.label}\n${h.sub}`));
      files = got.filter((h) => !seen.has(`${h.kind}\n${h.label}\n${h.sub}`));
      paint();
    }, 250);
  };
  find.addEventListener('input', () => { at = 0; paint(); lookup(); });
  find.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (shown.length) { at = (at + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length; mark(); } }
    else if (e.key === 'Enter') { e.preventDefault(); const h = shown[at]; if (h) pick(h); }
    else if (e.key === 'Escape') { e.preventDefault(); dkSpotlightEnd(); }
    e.stopPropagation();
  });
  veil.addEventListener('pointerdown', (e) => { if (e.target === veil) dkSpotlightEnd(); });
  paint();
  find.focus();
}

// the bar's glass
export function dkSpotlightTray(): HTMLElement {
  const wrap = el('div', 'dk-tray-wrap dk-spot-tray');
  const b = Object.assign(el('button', 'dk-tray dk-spot-btn'), { type: 'button', title: 'search (ctrl+alt+space)', ariaLabel: 'search' });
  b.appendChild(dkGlyph(DK_GLYPHS.search!));
  b.addEventListener('click', () => dkSpotlight());
  wrap.appendChild(b);
  return wrap;
}

addEventListener('blur', dkSpotlightEnd);
