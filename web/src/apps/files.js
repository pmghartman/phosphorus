import {
  DK_UI,
  HOME,
  acct,
  copyFile,
  dk,
  dkCode,
  dkFms,
  dkFocus,
  dkGlyph,
  dkMenu,
  dkMenuEl,
  dkRunItems,
  dkWallSet,
  dkWin,
  el,
  fileLabel,
  fileOpen,
  filesApi,
  filesCall,
  filesJoin,
  filesParent,
  filesPath,
  fmChanged,
  fmExt,
  fmIcon,
  fmKind,
  fmMark,
  fmSame,
  fmSay,
  fmSpring,
  fmTransfer,
  fmUnspring,
  fmZones,
  homeAt,
  homeHolders,
  homeOnline,
  homePick,
  homeTarget,
  hostsInfo,
  humanSize,
  icon,
  jsonPost,
  may,
  name,
  putFile,
  runnable,
} from '../app.js';

// --- files: a file manager over the hosts' shares, places, a path bar, list
// or icons, a right click's menu, cut, copy and paste across hosts

const fmKindLabel = (e) => (e.dir ? 'folder' : fmExt(e.name) ? `${fmExt(e.name)} file` : 'file');
const fmDate = (ms) => (ms ? new Date(ms).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

function dkFiles(at) {
  const w = dkWin(null, 'files', '', 'fm');
  if (!w) return;
  const fm = {
    w, loc: null, dir: '', back: [], fwd: [], entries: [], shown: [], sel: new Set(), anchor: null,
    sort: { key: 'name', dir: 1 }, mode: 'list', filter: '', shares: new Map(), busy: '',
  };
  const btn = (cls, glyph, label) => {
    const b = Object.assign(el('button', `fm-btn ${cls}`), { type: 'button', title: label, ariaLabel: label });
    if (glyph) b.append(glyph);
    return b;
  };
  fm.backBtn = btn('', dkGlyph(DK_UI.back), 'back (alt+←)');
  fm.fwdBtn = btn('', dkGlyph(DK_UI.fwd), 'forward (alt+→)');
  fm.upBtn = btn('', dkGlyph(DK_UI.up), 'up (alt+↑)');
  const refresh = btn('', icon('refresh'), 'refresh (f5)');
  fm.crumbs = el('div', 'fm-crumbs');
  fm.find = Object.assign(el('input', 'fm-find'), { placeholder: 'search', spellcheck: false, autocomplete: 'off' });
  const mkdir = btn('', icon('mkdir'), 'new folder (ctrl+shift+n)');
  const upload = btn('', icon('upload'), 'upload here');
  fm.modeBtn = btn('', null, 'list or icons');
  const tools = el('div', 'fm-tools');
  tools.append(fm.backBtn, fm.fwdBtn, fm.upBtn, refresh, fm.crumbs, mkdir, upload, fm.modeBtn, fm.find);
  fm.side = el('nav', 'fm-side');
  fm.main = Object.assign(el('div', 'fm-main'), { tabIndex: 0 });
  fm.status = el('div', 'fm-status');
  fm.count = el('span', 'fm-count');
  fm.note = el('span', 'fm-note');
  fm.status.append(fm.count, fm.note);
  const split = el('div', 'fm-split');
  split.append(fm.side, fm.main);
  fm.input = Object.assign(el('input'), { type: 'file', multiple: true, hidden: true });
  w.body.append(tools, split, fm.status, fm.input);

  fm.backBtn.addEventListener('click', () => fmHistory(fm, -1));
  fm.fwdBtn.addEventListener('click', () => fmHistory(fm, 1));
  fm.upBtn.addEventListener('click', () => fmUp(fm));
  refresh.addEventListener('click', () => fmLoad(fm));
  mkdir.addEventListener('click', () => fmMkdir(fm));
  upload.addEventListener('click', () => fmCan(fm, 'w') && fm.input.click());
  fm.input.addEventListener('change', () => { fmUpload(fm, fm.loc, fm.dir, fm.input.files); fm.input.value = ''; });
  fm.modeBtn.addEventListener('click', () => { fm.mode = fm.mode === 'list' ? 'grid' : 'list'; fmRender(fm); });
  fm.find.addEventListener('input', () => { fm.filter = fm.find.value.trim().toLowerCase(); fmRender(fm); });
  fm.find.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { fm.find.value = ''; fm.filter = ''; fmRender(fm); fm.main.focus(); }
    if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); fm.main.focus(); fmStep(fm, 0); }
  });
  fm.main.addEventListener('keydown', (e) => fmKeys(fm, e));
  fm.main.addEventListener('pointerdown', (e) => {
    if (e.target === fm.main || e.target.classList.contains('fm-items')) { fm.sel.clear(); fmPaintSel(fm); }
  });
  fm.main.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const row = e.target.closest('[data-name]');
    if (row && !fm.sel.has(row.dataset.name)) { fm.sel = new Set([row.dataset.name]); fm.anchor = row.dataset.name; fmPaintSel(fm); }
    if (!row) { fm.sel.clear(); fmPaintSel(fm); }
    fmMenu(fm, e.clientX, e.clientY, !!row);
  });
  fmDropZone(fm, fm.main, () => (fm.loc ? { loc: fm.loc, dir: fm.dir } : null));
  w.onFocus = () => { if (!w.node.contains(document.activeElement)) fm.main.focus({ preventScroll: true }); };
  w.onClose = () => dkFms.delete(fm);
  dkFms.add(fm);
  fmSide(fm);
  if (at) fmGo(fm, at.loc, at.dir); else fmRender(fm);
  dkFocus(w);
  return fm;
}

// each online host's shares, asked once a window; without its login, read only
async function fmSide(fm) {
  const hosts = [...new Set([...dk.creds.keys(), ...homeOnline()])];
  const render = () => {
    const home = el('div', `fm-place fm-share${fmSame(HOME, fm.loc) ? ' here' : ''}`);
    home.append(fmIcon('dir'), el('span', '', 'home'));
    home.title = 'every host\'s home as one';
    home.addEventListener('click', () => fmGo(fm, HOME, ''));
    fmDropZone(fm, home, () => ({ loc: HOME, dir: '' }));
    const out = [home, el('div', 'fm-side-head', 'hosts')];
    for (const h of hosts) {
      const info = fm.shares.get(h);
      const hostRow = el('div', 'fm-place fm-hostrow');
      hostRow.append(fmIcon('host'), el('span', '', h));
      if (!dk.creds.has(h)) {
        hostRow.classList.add('fm-ro');
        hostRow.title = `read only: log in to ${h} to change its files`;
      }
      out.push(hostRow);
      if (!info) { out.push(el('div', 'fm-place-note', '…')); continue; }
      if (info.error) { out.push(Object.assign(el('div', 'fm-place-note bad', info.error), { title: info.error })); continue; }
      for (const loc of info.shares) {
        const row = el('div', `fm-place fm-share${fmSame(loc, fm.loc) ? ' here' : ''}`);
        row.append(fmIcon('dir'), el('span', '', loc.root));
        row.title = `${h}/${loc.root}`;
        row.addEventListener('click', () => fmGo(fm, loc, ''));
        fmDropZone(fm, row, () => ({ loc, dir: '' }));
        out.push(row);
      }
    }
    fm.side.replaceChildren(...out);
  };
  fm.renderSide = render;
  render();
  await Promise.all(hosts.map(async (h) => {
    try {
      // what the host published in sys, else asked
      const info = hostsInfo[h.toLowerCase()]?.files || await filesCall({ host: h }, 'info');
      // the home only as the merged one above
      const perms = (p) => (dk.creds.has(h) ? p : (p || '').replace(/[^r]/g, ''));
      fm.shares.set(h, info.enabled
        ? { shares: info.shares.filter((sh) => sh.id !== 'home' && perms(sh.perms)).map((sh) => ({ host: h, share: sh.id, root: sh.label, perms: perms(sh.perms) })) }
        : { error: 'no files directory' });
    } catch (err) { fm.shares.set(h, { error: err.message }); }
    render();
  }));
  // no place yet: the home, the boot admin's first share
  if (!fm.loc) {
    const first = [...fm.shares.values()].find((i) => i.shares?.length);
    if (acct && !acct.boot) fmGo(fm, HOME, '');
    else if (first) fmGo(fm, first.shares[0], '');
  }
}

function fmGo(fm, loc, dir, how) {
  if (how !== 'history' && fm.loc) { fm.back.push({ loc: fm.loc, dir: fm.dir }); fm.fwd = []; }
  const from = fmSame(fm.loc, loc) ? fm.dir : null;
  fm.loc = loc;
  fm.dir = dir;
  fm.sel.clear();
  fm.find.value = '';
  fm.filter = '';
  // back up a level: the folder left, picked
  if (from != null && filesParent(from) === dir && from !== dir) { fm.sel.add(from.split('/').pop()); fm.anchor = from.split('/').pop(); }
  fm.entries = [];
  fm.renderSide?.();
  fmLoad(fm);
}

function fmHistory(fm, step) {
  const from = step < 0 ? fm.back : fm.fwd;
  const to = step < 0 ? fm.fwd : fm.back;
  const at = from.pop();
  if (!at) return;
  to.push({ loc: fm.loc, dir: fm.dir });
  fmGo(fm, at.loc, at.dir, 'history');
}

const fmUp = (fm) => fm.loc && fm.dir && fmGo(fm, fm.loc, filesParent(fm.dir));

async function fmLoad(fm) {
  if (!fm.loc) return fmRender(fm);
  const want = `${fm.loc.host}\n${fm.loc.share}\n${fm.dir}`;
  fm.loading = want;
  fmRender(fm);
  try {
    const body = await filesCall(fm.loc, 'list', undefined, { path: fm.dir });
    if (fm.loading !== want) return;
    fm.entries = body.entries;
    fm.error = body.truncated ? 'more entries than shown' : '';
  } catch (err) {
    if (fm.loading !== want) return;
    fm.entries = [];
    fm.error = err.message;
  }
  fm.loading = '';
  fmRender(fm);
  // files added from the desktop, into the first folder shown
  const up = fm.pendingUpload;
  if (up) { fm.pendingUpload = null; fmUpload(fm, fm.loc, fm.dir, up); }
}

const fmCan = (fm, perm) => !!fm.loc && may(fm.loc, perm);

function fmSorted(fm) {
  const { key, dir } = fm.sort;
  const val = (e) => (key === 'size' ? e.size ?? -1 : key === 'mtime' ? e.mtime ?? 0 : key === 'kind' ? fmKindLabel(e) : e.name.toLowerCase());
  return fm.entries
    .filter((e) => !fm.filter || e.name.toLowerCase().includes(fm.filter))
    .sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * dir));
}

function fmRender(fm) {
  fm.backBtn.disabled = !fm.back.length;
  fm.fwdBtn.disabled = !fm.fwd.length;
  fm.upBtn.disabled = !fm.dir;
  fm.modeBtn.replaceChildren(dkGlyph(fm.mode === 'list' ? DK_UI.grid : DK_UI.list));
  // the path bar: host, the share, then each folder, any one a jump
  const crumbs = [];
  if (fm.loc) {
    if (fm.loc.host !== '*') crumbs.push(el('span', 'fm-crumb-host', fm.loc.host));
    const parts = fm.dir ? fm.dir.split('/') : [];
    [fm.loc.root, ...parts].forEach((name, i) => {
      const c = Object.assign(el('button', 'fm-crumb', name), { type: 'button' });
      const to = parts.slice(0, i).join('/');
      c.addEventListener('click', () => to !== fm.dir && fmGo(fm, fm.loc, to));
      fmDropZone(fm, c, () => ({ loc: fm.loc, dir: to }));
      crumbs.push(...(crumbs.length ? [el('span', 'fm-crumb-sep', '›')] : []), c);
    });
  }
  fm.crumbs.replaceChildren(...crumbs);
  fm.w.task.textContent = fm.loc ? (fm.dir.split('/').pop() || fm.loc.root) : 'files';
  fm.w.head.querySelector('.tab-label').textContent = fm.w.task.textContent;

  fm.shown = fmSorted(fm);
  const items = el('div', `fm-items fm-${fm.mode}`);
  if (fm.mode === 'list') {
    const head = el('div', 'fm-row fm-cols');
    for (const [key, label] of [['name', 'name'], ['mtime', 'modified'], ['size', 'size'], ['kind', 'kind']]) {
      const c = Object.assign(el('button', `fm-col fm-c-${key}`, label), { type: 'button' });
      if (fm.sort.key === key) c.append(el('span', 'fm-arrow', fm.sort.dir > 0 ? ' ▴' : ' ▾'));
      c.addEventListener('click', () => { fm.sort = { key, dir: fm.sort.key === key ? -fm.sort.dir : 1 }; fmRender(fm); });
      head.appendChild(c);
    }
    items.appendChild(head);
  }
  for (const e of fm.shown) items.appendChild(fmItem(fm, e));
  const note = !fm.loc ? 'pick a place' : fm.loading && !fm.entries.length ? 'loading…'
    : fm.error && !fm.entries.length ? fm.error : !fm.shown.length ? (fm.filter ? 'no match' : 'this folder is empty') : '';
  if (note) items.appendChild(el('div', 'fm-empty', note));
  fm.main.replaceChildren(items);
  fmPaintSel(fm);
}

function fmItem(fm, e) {
  const kind = fmKind(e);
  const row = el('div', fm.mode === 'list' ? 'fm-row fm-item' : 'fm-tile fm-item');
  row.dataset.name = e.name;
  row.draggable = true;
  const name = el('span', 'fm-name');
  name.append(fmIcon(kind), el('span', 'fm-label', e.name));
  // the merged home: where it lives, greyed while only an offline host has it
  if (e.hosts) {
    name.append(el('span', 'fm-where', e.all ? 'all hosts' : e.hosts.join(', ')));
    if (e.stale) { row.classList.add('fm-stale'); row.title = `on ${e.hosts.join(', ')}, offline`; }
  }
  if (fm.mode === 'list') {
    row.append(name, el('span', 'fm-c-mtime', fmDate(e.mtime)), el('span', 'fm-c-size', e.dir ? '' : humanSize(e.size || 0)), el('span', 'fm-c-kind', fmKindLabel(e)));
  } else {
    row.append(name);
    row.title = `${e.name}\n${e.dir ? 'folder' : humanSize(e.size || 0)}\n${fmDate(e.mtime)}`;
  }
  row.addEventListener('click', (ev) => fmClick(fm, e.name, ev));
  row.addEventListener('dblclick', () => fmOpen(fm, e));
  row.addEventListener('dragstart', (ev) => {
    if (!fm.sel.has(e.name)) { fm.sel = new Set([e.name]); fmPaintSel(fm); }
    dk.drag = { fm, loc: fm.loc, items: fmPicked(fm) };
    ev.dataTransfer.effectAllowed = 'copyMove';
    ev.dataTransfer.setData('text/plain', fmPicked(fm).map((p) => p.rel).join('\n'));
  });
  row.addEventListener('dragend', () => { dk.drag = null; });
  if (e.dir) fmDropZone(fm, row, () => ({ loc: fm.loc, dir: filesJoin(fm.dir, e.name) }));
  return row;
}

function fmPaintSel(fm) {
  for (const r of fm.main.querySelectorAll('.fm-item')) r.classList.toggle('sel', fm.sel.has(r.dataset.name));
  const n = fm.shown.length;
  const picked = fm.shown.filter((e) => fm.sel.has(e.name));
  const bytes = picked.reduce((t, e) => t + (e.size || 0), 0);
  fm.count.textContent = `${n} item${n === 1 ? '' : 's'}${picked.length ? `, ${picked.length} selected${bytes ? ` (${humanSize(bytes)})` : ''}` : ''}`;
}

function fmClick(fm, name, e) {
  const names = fm.shown.map((x) => x.name);
  if (e.shiftKey && fm.anchor != null && names.includes(fm.anchor)) {
    const [a, b] = [names.indexOf(fm.anchor), names.indexOf(name)].sort((x, y) => x - y);
    if (!(e.ctrlKey || e.metaKey)) fm.sel.clear();
    for (const n of names.slice(a, b + 1)) fm.sel.add(n);
  } else if (e.ctrlKey || e.metaKey) {
    if (fm.sel.has(name)) fm.sel.delete(name); else fm.sel.add(name);
    fm.anchor = name;
  } else {
    fm.sel = new Set([name]);
    fm.anchor = name;
  }
  fmPaintSel(fm);
}

// the picked entries as {rel, dir, name}
const fmPicked = (fm) => fm.shown.filter((e) => fm.sel.has(e.name)).map((e) => ({ rel: filesJoin(fm.dir, e.name), dir: e.dir, name: e.name }));

function fmOpen(fm, e) {
  const rel = filesJoin(fm.dir, e.name);
  if (e.dir && !runnable(e)) return fmGo(fm, fm.loc, rel);
  fileOpen(fm.loc, rel, e);
}

// keys as a file manager's: arrows, enter, delete, f2, and the clipboard's
function fmKeys(fm, e) {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;
  const one = fm.shown.find((x) => x.name === fm.anchor && fm.sel.has(x.name)) || fm.shown.find((x) => fm.sel.has(x.name));
  if (k === 'ArrowDown' || k === 'ArrowUp' || ((k === 'ArrowLeft' || k === 'ArrowRight') && fm.mode === 'grid' && !e.altKey)) {
    const cols = fm.mode === 'grid' ? Math.max(1, Math.floor(fm.main.clientWidth / (fm.main.querySelector('.fm-tile')?.offsetWidth || 1))) : 1;
    fmStep(fm, { ArrowDown: cols, ArrowUp: -cols, ArrowRight: 1, ArrowLeft: -1 }[k], e.shiftKey);
  } else if (e.altKey && k === 'ArrowLeft') fmHistory(fm, -1);
  else if (e.altKey && k === 'ArrowRight') fmHistory(fm, 1);
  else if ((e.altKey && k === 'ArrowUp') || k === 'Backspace') fmUp(fm);
  else if (k === 'Enter' && one) fmOpen(fm, one);
  else if ((k === 'Delete' || (e.metaKey && k === 'Backspace')) && fm.sel.size) fmDelete(fm);
  else if (k === 'F2' && one) fmRename(fm, one);
  else if (k === 'F5') fmLoad(fm);
  else if (mod && e.shiftKey && k.toLowerCase() === 'n') fmMkdir(fm);
  else if (mod && k.toLowerCase() === 'a') { fm.sel = new Set(fm.shown.map((x) => x.name)); fmPaintSel(fm); }
  else if (mod && k.toLowerCase() === 'c' && fm.sel.size) fmClip(fm, 'copy');
  else if (mod && k.toLowerCase() === 'x' && fm.sel.size) fmClip(fm, 'cut');
  else if (mod && k.toLowerCase() === 'v') fmPaste(fm);
  else if (mod && k.toLowerCase() === 'f') fm.find.focus();
  else if (k === 'Escape') { fm.sel.clear(); fmPaintSel(fm); }
  else if (k.length === 1 && !mod && !e.altKey) {
    // typed letters jump to the next name starting with them
    const names = fm.shown.map((x) => x.name);
    const at = names.indexOf(fm.anchor);
    const hit = [...names.slice(at + 1), ...names.slice(0, at + 1)].find((n) => n.toLowerCase().startsWith(k.toLowerCase()));
    if (hit) { fm.sel = new Set([hit]); fm.anchor = hit; fmPaintSel(fm); fmReveal(fm, hit); }
  } else return;
  e.preventDefault();
  e.stopPropagation();
}

function fmStep(fm, by, extend) {
  const names = fm.shown.map((x) => x.name);
  if (!names.length) return;
  const at = names.indexOf(fm.anchor);
  const to = names[Math.max(0, Math.min(names.length - 1, at < 0 ? 0 : at + by))];
  if (!extend) fm.sel.clear();
  fm.sel.add(to);
  fm.anchor = to;
  fmPaintSel(fm);
  fmReveal(fm, to);
}

const fmReveal = (fm, name) => [...fm.main.querySelectorAll('.fm-item')].find((r) => r.dataset.name === name)?.scrollIntoView({ block: 'nearest' });

async function fmWallpaper(fm, rel) {
  fmSay(fm, 'setting the wallpaper…');
  try {
    const r = await fetch(filesApi(fm.loc, 'download', { path: rel }));
    if (!r.ok) throw new Error(`${r.status}`);
    const why = await dkWallSet(await r.blob());
    fmSay(fm, why || 'wallpaper set', !!why);
  } catch (err) { fmSay(fm, `wallpaper: ${err.message}`, true); }
}

// a right click's menu, on the page so no window's transform shifts it
function fmMenu(fm, x, y, onItem) {
  const picked = fmPicked(fm);
  const one = picked.length === 1 ? fm.shown.find((e) => e.name === picked[0].name) : null;
  const w = fmCan(fm, 'w');
  const items = onItem ? [
    ['open', () => one && fmOpen(fm, one), !!one],
    one && one.dir && runnable(one) && ['browse inside', () => fmGo(fm, fm.loc, picked[0].rel), true],
    one && !one.dir && ['open in editor', () => dkCode({ host: fm.loc.host, share: fm.loc.share, path: picked[0].rel, label: fileLabel(fm.loc.host, fm.loc.root, picked[0].rel) }), true],
    one && !one.dir && ['download', () => fmDownload(fm, picked[0].rel), fmCan(fm, 'r')],
    ...(one && !one.dir && fm.loc.share === 'home' ? dkRunItems(picked[0].rel, fm.loc.host === '*' ? (one.all ? homeOnline() : one.live || []) : [fm.loc.host]) : []),
    one && fmKind(one) === 'image' && ['set as wallpaper', () => fmWallpaper(fm, picked[0].rel), fmCan(fm, 'r')],
    one && !one.dir && one.hosts && ['keep on every host', () => fmMirror(fm, one, !one.all), true, one.all ? 'on' : ''],
    one && !one.dir && one.hosts && !one.all && ['move to host…', () => fmMoveHost(fm, one), homeOnline().length > 1],
    null,
    ['cut', () => fmClip(fm, 'cut'), fmCan(fm, 'd')],
    ['copy', () => fmClip(fm, 'copy'), true],
    ['paste', () => fmPaste(fm, one?.dir ? picked[0].rel : fm.dir), !!dk.clip && w],
    null,
    ['rename', () => fmRename(fm, one), !!one && w],
    ['delete', () => fmDelete(fm), fmCan(fm, 'd'), 'danger'],
  ] : [
    ['new folder', () => fmMkdir(fm), w],
    ['new text file', () => fmTouch(fm), w],
    ['upload here', () => fm.input.click(), w],
    null,
    ['paste', () => fmPaste(fm), !!dk.clip && w],
    ['select all', () => { fm.sel = new Set(fm.shown.map((e) => e.name)); fmPaintSel(fm); }, true],
    ['refresh', () => fmLoad(fm), true],
  ];
  dkMenu(x, y, items.filter((i) => i !== false && i !== undefined), () => fm.main.focus({ preventScroll: true }));
}

// a home file kept on every host, or back to only the one it's read from
async function fmMirror(fm, e, on) {
  const rel = filesJoin(fm.dir, e.name);
  const host = homePick(rel);
  if (!on) {
    const keep = await dkChoose(fm, { title: 'keep it only on', message: e.name, options: homeOnline().map((h) => [h, h]) });
    if (!keep) return;
    try { await filesCall(homeAt(keep), 'mirror', jsonPost({ path: rel, on: false })); } catch (err) { return fmSay(fm, err.message, true); }
    fmSay(fm, `${e.name} kept on ${keep}, the other copies going`);
  } else {
    try { await filesCall(homeAt(host), 'mirror', jsonPost({ path: rel, on: true })); } catch (err) { return fmSay(fm, err.message, true); }
    fmSay(fm, `${e.name} copying to every host`);
  }
  setTimeout(() => fmChanged(HOME, fm.dir), 4000);
  fmChanged(HOME, fm.dir);
}

// the bytes to one host, then off the rest
async function fmMoveHost(fm, e) {
  const rel = filesJoin(fm.dir, e.name);
  const to = await dkChoose(fm, { title: 'move to', message: `${e.name}, now on ${e.hosts.join(', ')}`, options: homeOnline().map((h) => [h, h, e.hosts.includes(h) && e.hosts.length === 1 ? 'already there' : '']) });
  if (!to) return;
  try {
    const from = homePick(rel);
    if (from !== to) await copyFile(homeAt(from), rel, homeAt(to), rel, (f) => fmSay(fm, `moving ${e.name} ${Math.round(f * 100)}%`));
    for (const h of homeHolders(rel)) if (h !== to) await filesCall(homeAt(h), 'delete', jsonPost({ path: rel }));
    fmSay(fm, `${e.name} moved to ${to}`);
  } catch (err) { fmSay(fm, err.message, true); }
  fmChanged(HOME, fm.dir);
}

// a question inside the window: text back, true for a yes, null for no
function dkAsk(fm, { title, message, value, action, danger }) {
  return new Promise((resolve) => {
    const veil = el('div', 'fm-veil');
    const box = el('form', 'fm-ask');
    const input = value != null && Object.assign(el('input'), { value, spellcheck: false, autocomplete: 'off' });
    const no = Object.assign(el('button', '', 'cancel'), { type: 'button' });
    const go = Object.assign(el('button', danger ? 'danger' : 'primary', action), { type: 'submit' });
    const acts = el('div', 'update-actions');
    acts.append(no, go);
    box.append(el('div', 'fm-ask-title', title), el('p', '', message), ...(input ? [input] : []), acts);
    veil.appendChild(box);
    fm.w.body.appendChild(veil);
    const end = (v) => { veil.remove(); fm.main.focus({ preventScroll: true }); resolve(v); };
    no.addEventListener('click', () => end(null));
    box.addEventListener('submit', (e) => { e.preventDefault(); end(input ? input.value.trim() || null : true); });
    box.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') end(null); });
    if (input) {
      input.focus();
      // the name picked, not its extension
      const dot = value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : value.length);
    } else go.focus();
  });
}

// one of a few choices inside the window, its value back, null for none;
// [label, value, why disabled]
function dkChoose(fm, { title, message, options }) {
  return new Promise((resolve) => {
    const veil = el('div', 'fm-veil');
    const box = el('div', 'fm-ask');
    const list = el('div', 'fm-choices');
    const end = (v) => { veil.remove(); fm.main.focus({ preventScroll: true }); resolve(v); };
    for (const [label, value, why] of options) {
      const b = Object.assign(el('button', 'fm-choice', label), { type: 'button', disabled: !!why });
      if (why) b.append(el('span', 'fm-choice-why', why));
      b.addEventListener('click', () => end(value));
      list.appendChild(b);
    }
    const no = Object.assign(el('button', '', 'cancel'), { type: 'button' });
    no.addEventListener('click', () => end(null));
    const acts = el('div', 'update-actions');
    acts.append(no);
    box.append(el('div', 'fm-ask-title', title), el('p', '', message), list, acts);
    box.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') end(null); });
    veil.appendChild(box);
    fm.w.body.appendChild(veil);
    list.querySelector('button:not(:disabled)')?.focus();
  });
}

async function fmMkdir(fm) {
  if (!fmCan(fm, 'w')) return fmSay(fm, 'this share is read-only', true);
  const name = await dkAsk(fm, { title: 'new folder', message: `in ${filesPath(fm.loc.host, fm.loc.root, fm.dir)}`, value: 'new folder', action: 'create' });
  if (!name) return;
  try {
    await filesCall(fm.loc, 'mkdir', jsonPost({ path: filesJoin(fm.dir, name) }));
    fm.sel = new Set([name]);
    fm.anchor = name;
    fmChanged(fm.loc, fm.dir);
  } catch (err) { fmSay(fm, err.message, true); }
}

// an empty file, then the editor on it
async function fmTouch(fm) {
  const name = await dkAsk(fm, { title: 'new text file', message: `in ${filesPath(fm.loc.host, fm.loc.root, fm.dir)}`, value: 'untitled.txt', action: 'create' });
  if (!name) return;
  const rel = filesJoin(fm.dir, name);
  if (fm.entries.some((e) => e.name === name)) return fmSay(fm, `${name} is already here`, true);
  let loc = fm.loc;
  let all = false;
  if (loc.host === '*') {
    const t = await homeTarget(fm, 0, name);
    if (!t) return;
    loc = homeAt(t.host);
    all = t.all;
  }
  try {
    await putFile(loc, rel, new Blob([]));
    if (all) await filesCall(loc, 'mirror', jsonPost({ path: rel, on: true }));
    fmChanged(loc, fm.dir);
    dkCode({ host: loc.host, share: loc.share, path: rel, label: fileLabel(loc.host, loc.root, rel) });
  } catch (err) { fmSay(fm, err.message, true); }
}

async function fmRename(fm, e) {
  const name = await dkAsk(fm, { title: 'rename', message: filesPath(fm.loc.host, fm.loc.root, filesJoin(fm.dir, e.name)), value: e.name, action: 'rename' });
  if (!name || name === e.name) return;
  try {
    await filesCall(fm.loc, 'rename', jsonPost({ from: filesJoin(fm.dir, e.name), to: filesJoin(fm.dir, name) }));
    fm.sel = new Set([name]);
    fm.anchor = name;
    fmChanged(fm.loc, fm.dir);
  } catch (err) { fmSay(fm, err.message, true); }
}

async function fmDelete(fm) {
  const picked = fmPicked(fm);
  if (!picked.length) return;
  const what = picked.length === 1 ? `${picked[0].name}${picked[0].dir ? ' and everything in it' : ''}` : `these ${picked.length} items`;
  const ok = await dkAsk(fm, { title: 'delete', message: `delete ${what}? this cannot be undone.`, action: 'delete', danger: true });
  if (!ok) return;
  const loc = fm.loc;
  const dir = fm.dir;
  for (const p of picked) {
    try { await filesCall(loc, 'delete', jsonPost({ path: p.rel })); } catch (err) { fmSay(fm, `${p.name}: ${err.message}`, true); }
  }
  fm.sel.clear();
  fmChanged(loc, dir);
}

function fmDownload(fm, rel) {
  const a = Object.assign(document.createElement('a'), { href: filesApi(fm.loc, 'download', { path: rel }), download: rel.split('/').pop() });
  a.click();
}

function fmClip(fm, op) {
  dk.clip = { op, loc: fm.loc, items: fmPicked(fm) };
  fmSay(fm, `${dk.clip.items.length} ${op === 'cut' ? 'cut' : 'copied'}, paste with ctrl+v`);
}

async function fmPaste(fm, dir = fm.dir) {
  const clip = dk.clip;
  if (!clip || !fm.loc) return;
  if (clip.op === 'cut') dk.clip = null;
  await fmTransfer(fm, clip.loc, clip.items, fm.loc, dir, clip.op === 'cut');
}

async function fmUpload(fm, loc, dir, fileList) {
  const list = [...fileList];
  if (!list.length || !loc) return;
  if (!may(loc, 'w')) return fmSay(fm, `${loc.root} is read-only`, true);
  let all = false;
  if (loc.host === '*') {
    const bytes = list.reduce((t, f) => Math.max(t, f.size), 0);
    const t = await homeTarget(fm, bytes, list.length === 1 ? list[0].name : `${list.length} files`);
    if (!t) return;
    loc = homeAt(t.host);
    all = t.all;
  }
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    try {
      fm.busy = 'x';
      await putFile(loc, filesJoin(dir, f.name), f, (sent) => fmSay(fm, `uploading ${f.name} ${f.size ? Math.round((sent / f.size) * 100) : 100}% (${i + 1}/${list.length})`));
      if (all) await filesCall(loc, 'mirror', jsonPost({ path: filesJoin(dir, f.name), on: true }));
    } catch (err) { fm.busy = ''; fmSay(fm, `${f.name}: ${err.message}`, true); }
  }
  fm.busy = '';
  fmSay(fm, `uploaded ${list.length} to ${filesPath(loc.host, loc.root, dir)}`);
  fmChanged(loc, dir);
}

// a folder, a place or blank space taking a drag: the computer's own files
// uploaded, a window's moved inside one share or copied (ctrl) across them
function fmDropZone(fm, node, where) {
  fmZones.set(node, { fm, where });
  node.dataset.fmDrop = '';
  node.addEventListener('dragover', (e) => {
    const t = where();
    if (!t || (!dk.drag && !e.dataTransfer.types.includes('Files'))) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = dk.drag && fmSame(dk.drag.loc, t.loc) && !e.ctrlKey && !e.altKey ? 'move' : 'copy';
    fmMark(fm, node);
    fmSpring(fm, node, t);
  });
  node.addEventListener('dragleave', (e) => {
    if (node.contains(e.relatedTarget)) return;
    node.classList.remove('drop');
    fmUnspring(fm, node);
  });
  node.addEventListener('drop', (e) => {
    const t = where();
    fmUnspring(fm);
    node.classList.remove('drop');
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    const drag = dk.drag;
    dk.drag = null;
    if (drag) {
      const items = drag.items.filter((it) => !(fmSame(drag.loc, t.loc) && it.rel === t.dir));
      if (items.length) fmTransfer(fm, drag.loc, items, t.loc, t.dir, fmSame(drag.loc, t.loc) && !e.ctrlKey && !e.altKey);
    } else fmUpload(fm, t.loc, t.dir, e.dataTransfer.files);
  });
}

// anything the browser shows itself: pictures, video, sound, pdfs, else its text
function dkViewer(loc, rel) {
  const w = dkWin(`view:${loc.host}\n${loc.share}\n${rel}`, rel.split('/').pop(), loc.host, 'svc');
  if (!w) return;
  const src = filesApi(loc, 'download', { path: rel, inline: 1 });
  // a picture fit to the window, a click for its own size and back
  if (fmKind({ name: rel }) === 'image') {
    const box = el('div', 'dk-imgview');
    const img = Object.assign(el('img'), { src, alt: rel, draggable: false });
    box.addEventListener('click', () => box.classList.toggle('full'));
    box.appendChild(img);
    w.body.appendChild(box);
    dkFocus(w);
    return;
  }
  const frame = Object.assign(el('iframe', 'dk-frame'), { src, title: rel });
  w.body.appendChild(frame);
  w.onClose = () => { frame.src = 'about:blank'; };
  dkFocus(w);
}


export { dkChoose, dkFiles, dkViewer, fmGo, fmLoad };
