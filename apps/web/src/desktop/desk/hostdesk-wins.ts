// the windows a host desktop opens inside itself: its recycle bin, a folder, its
// personalize page; files in the viewer and pages in a phosphorus window

import { acctCall } from '../../lib/api.ts';
import { DK_UI, dkGlyph, el, pageAsk } from '../../lib/dom.ts';
import { humanSize } from '../../lib/util.ts';
import { dkFocus, dkNav, dkWin, type NavFrame } from '../windows.ts';
import { api, type Desk, draw, type HD, type Item, iconBtn, openItem, pic } from './hostdesk.ts';
import { dkSay } from './wallpaper.ts';
import { dkFileApp, dkFileOffer, dkWebApp } from './webapps.ts';

// one window inside the host desktop, moved by its title, the newest on top
function inner(
  hd: HD,
  key: string,
  title: string,
  cls: string,
): { box: HTMLElement; body: HTMLElement; head: HTMLElement } {
  const layer = hd.root.querySelector('.hd-layer') as HTMLElement;
  const had = layer.querySelector(`[data-k="${CSS.escape(key)}"]`) as HTMLElement | null;
  if (had) had.remove();
  const box = el('div', `hd-w ${cls}`);
  box.dataset.k = key;
  const head = el('div', 'hd-w-head');
  const x = Object.assign(el('button', 'hd-w-x'), { type: 'button', title: 'close', ariaLabel: 'close' });
  x.append(dkGlyph(DK_UI.close!));
  x.addEventListener('click', () => box.remove());
  head.append(el('span', 'hd-w-t', title), x);
  const body = el('div', 'hd-w-body');
  box.append(head, body);
  const n = layer.children.length;
  box.style.left = `${8 + ((n * 4) % 30)}%`;
  box.style.top = `${6 + ((n * 4) % 30)}%`;
  head.addEventListener('pointerdown', (e) => {
    if ((e.target as Element).closest('button')) return;
    const r = box.getBoundingClientRect();
    const p = layer.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      box.style.left = `${Math.max(0, Math.min(p.width - 80, ev.clientX - p.left - dx))}px`;
      box.style.top = `${Math.max(0, Math.min(p.height - 40, ev.clientY - p.top - dy))}px`;
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', () => head.removeEventListener('pointermove', move), { once: true });
  });
  box.addEventListener('pointerdown', () => layer.append(box));
  layer.append(box);
  return { box, body, head };
}

const when = (ms: number) => (ms ? new Date(ms).toLocaleString().toLowerCase() : '');

// --- the recycle bin --------------------------------------------------------------------

type BinItem = { id: string; name: string; from: string; deleted: number; size: number; dir: boolean };

// the bin's window; with delete: that path sent to it first, asked about
export async function binWin(hd: HD, o?: { delete: string }) {
  const d = hd.desk!;
  const binName = d.os === 'windows' ? 'recycle bin' : 'trash';
  if (o?.delete) {
    const name = o.delete.split(/[\\/]/).pop();
    const ok = await pageAsk({
      title: `delete ${name}`,
      message: `${o.delete} goes to the ${binName} on ${hd.host}; restore it from there`,
      action: 'delete',
      danger: true,
    });
    if (!ok) return;
    const r = await acctCall(api(hd.host, 'trash'), { op: 'delete', path: o.delete });
    if (!r.ok) return dkSay(r.error || 'not deleted');
    await refresh(hd);
  }
  const { body, head } = inner(hd, 'bin', binName, 'hd-binw');
  const emptyBtn = Object.assign(el('button', 'btn danger', 'empty'), { type: 'button' });
  head.insertBefore(emptyBtn, head.lastChild);
  const list = el('div', 'hd-rows');
  body.append(list);
  const fill = async () => {
    list.replaceChildren(el('p', 'hd-empty', 'reading'));
    const r = await acctCall<{ items: BinItem[] }>(api(hd.host, 'trash'));
    if (!r.ok) return list.replaceChildren(el('p', 'hd-empty bad', r.error || 'no answer'));
    const items = r.items ?? [];
    emptyBtn.disabled = !items.length;
    if (!items.length) return list.replaceChildren(el('p', 'hd-empty', `the ${binName} is empty`));
    list.replaceChildren(
      ...items.map((it) => {
        const row = el('div', 'hd-row');
        const back = Object.assign(el('button', 'btn', 'restore'), { type: 'button' });
        back.addEventListener('click', async () => {
          const ok = await pageAsk({
            title: `restore ${it.name}`,
            message: `${it.name} goes back to ${it.from}`,
            action: 'restore',
          });
          if (!ok) return;
          back.disabled = true;
          const x = await acctCall(api(hd.host, 'trash'), { op: 'restore', id: it.id });
          if (!x.ok) {
            back.disabled = false;
            return dkSay(x.error || 'not restored');
          }
          await fill();
          await refresh(hd);
        });
        row.append(
          el('span', `hd-row-n${it.dir ? ' dir' : ''}`, it.name),
          Object.assign(el('span', 'hd-row-p', it.from), { title: it.from }),
          el('span', 'hd-row-m', `${when(it.deleted)}${it.size ? ` · ${humanSize(it.size)}` : ''}`),
          back,
        );
        return row;
      }),
    );
  };
  emptyBtn.addEventListener('click', async () => {
    const ok = await pageAsk({
      title: `empty the ${binName}`,
      message: `everything in the ${binName} on ${hd.host} is erased for good`,
      action: 'empty',
      danger: true,
    });
    if (!ok) return;
    emptyBtn.disabled = true;
    const x = await acctCall(api(hd.host, 'trash'), { op: 'empty' });
    if (!x.ok) dkSay(x.error || 'not emptied');
    await fill();
    await refresh(hd);
  });
  await fill();
}

// the desktop read again, its bin icon full or empty
async function refresh(hd: HD) {
  const r = await acctCall<{ desk: Desk }>(api(hd.host, 'desktop'));
  if (r.ok && r.desk) draw(hd, r.desk);
}

// --- a folder -----------------------------------------------------------------------------

type Ent = { name: string; path: string; dir: boolean; size: number; mtime: number };

export function folderWin(hd: HD, path: string) {
  const { body, head } = inner(hd, 'folder', path.split(/[\\/]/).filter(Boolean).pop() || path, 'hd-folder');
  const up = Object.assign(el('button', 'hd-w-up'), { type: 'button', title: 'up', ariaLabel: 'up' });
  up.append(dkGlyph(DK_UI.up!));
  head.prepend(up);
  const where = el('div', 'hd-where');
  const grid = el('div', 'hd-files');
  body.append(where, grid);
  const win = hd.desk!.os === 'windows';
  const go = async (p: string) => {
    where.textContent = p;
    where.title = p;
    (head.querySelector('.hd-w-t') as HTMLElement).textContent = p.split(/[\\/]/).filter(Boolean).pop() || p;
    grid.replaceChildren(el('p', 'hd-empty', 'reading'));
    const r = await acctCall<{ entries: Ent[] }>(api(hd.host, 'ls', { path: p }));
    if (!r.ok) return grid.replaceChildren(el('p', 'hd-empty bad', r.error || 'no answer'));
    const ents = r.entries ?? [];
    if (!ents.length) return grid.replaceChildren(el('p', 'hd-empty', 'this folder is empty'));
    grid.replaceChildren(
      ...ents.map((e) => {
        const it: Item = { name: e.name, kind: e.dir ? 'folder' : 'file', path: e.path };
        const b = iconBtn(hd, it, 'hd-file');
        b.replaceChild(el('span', `hd-ficon ${e.dir ? 'dir' : 'doc'}`), b.firstChild!);
        b.addEventListener(
          'dblclick',
          (ev) => {
            ev.stopImmediatePropagation();
            if (e.dir) void go(e.path);
            else void openPath(hd, e.path);
          },
          true,
        );
        return b;
      }),
    );
  };
  up.addEventListener('click', () => {
    const p = where.textContent || path;
    const cut = p.replace(/[\\/]+$/, '');
    const i = Math.max(cut.lastIndexOf('/'), win ? cut.lastIndexOf('\\') : -1);
    if (i < 0 || (win && i < 3 && cut.length <= 3)) return;
    void go(win && i === 2 ? cut.slice(0, 3) : cut.slice(0, i) || '/');
  });
  void go(path);
}

// a file in a folder: what it is asked first, a shortcut or launcher followed
async function openPath(hd: HD, path: string) {
  const r = await acctCall<{ item: Item }>(api(hd.host, 'open'), { path });
  if (!r.ok || !r.item) return dkSay(r.error || 'not opened');
  openItem(hd, r.item);
}

// --- files and pages ---------------------------------------------------------------------

// a file in the app that opens it, over the host desktop's own sftp
export async function openFile(hd: HD, path: string) {
  const name = path.split(/[\\/]/).pop() || path;
  const query = { host: hd.host, share: 'desk', path };
  const id = dkFileApp(name);
  if (id) return dkWebApp(id, query);
  const download = () => {
    const a = Object.assign(el('a'), { href: api(hd.host, 'download', { path }), download: name });
    a.click();
  };
  if (!(await dkFileOffer(name, query, download))) download();
}

// a page in its own phosphorus window
export function webWin(url: string, title: string) {
  const w = dkWin(`web:${url}`, title, new URL(url).host, 'svc');
  if (!w) return;
  const pop = Object.assign(el('button', 'dk-out'), {
    type: 'button',
    title: 'open in a browser tab',
    ariaLabel: 'open in a browser tab',
  });
  pop.appendChild(dkGlyph(DK_UI.pop!));
  pop.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
  w.head.querySelector('.dk-btns')!.prepend(pop);
  const frame: NavFrame = Object.assign(el('iframe', 'dk-frame'), {
    src: url,
    title,
    allow: 'clipboard-read; clipboard-write; fullscreen',
    referrerPolicy: 'no-referrer',
  });
  w.body.appendChild(frame);
  dkNav(w, frame);
  w.onClose = () => frame.contentWindow?.location.replace('about:blank');
  dkFocus(w);
}

// --- personalize: wallpaper, light or dark, accent, pins ---------------------------------

type Ask = { wallpaper?: string; pin?: string; on?: boolean };

const gnomeHex: Record<string, string> = {
  blue: '#3584e4',
  teal: '#2190a4',
  green: '#3a944a',
  yellow: '#c88800',
  orange: '#ed5b00',
  red: '#e62d42',
  pink: '#d56199',
  purple: '#9141ac',
  slate: '#6f8396',
};

// a change written to the host's own settings, asked about first
async function apply(hd: HD, change: Record<string, unknown>, what: string): Promise<boolean> {
  const ok = await pageAsk({
    title: `change ${hd.host}`,
    message: `${what}; this changes ${hd.desk!.user}'s own settings on ${hd.host}`,
    action: 'change',
  });
  if (!ok) return false;
  const r = await acctCall<{ desk: Desk; live: boolean }>(api(hd.host, 'set'), change);
  if (!r.ok || !r.desk) {
    dkSay(r.error || 'not changed');
    return false;
  }
  draw(hd, r.desk);
  if (!r.live) dkSay(`${hd.host} takes it at its next sign in`);
  return true;
}

export async function setWin(hd: HD, o?: Ask) {
  const d = hd.desk!;
  if (o?.wallpaper) return void apply(hd, { wallpaper: o.wallpaper }, `${o.wallpaper} as the desktop background`);
  if (o?.pin) {
    const ids = d.pins.map((p) => p.id).filter((x): x is string => !!x);
    const next = o.on ? [...ids, o.pin] : ids.filter((x) => x !== o.pin);
    return void apply(hd, { pins: next }, o.on ? 'a new pin' : 'one pin fewer');
  }
  const { body } = inner(hd, 'set', 'personalize', 'hd-setw');
  const sec = (t: string) => el('div', 'hd-set-h', t);
  body.append(sec('theme'));
  const mode = el('div', 'hd-set-row');
  for (const dark of [false, true]) {
    const b = Object.assign(el('button', `btn${d.dark === dark ? ' primary' : ''}`, dark ? 'dark' : 'light'), {
      type: 'button',
      disabled: !d.can.dark,
    });
    b.addEventListener('click', () => {
      if (d.dark !== dark) void apply(hd, { dark }, `${dark ? 'dark' : 'light'} mode`).then((x) => x && setWin(hd));
    });
    mode.append(b);
  }
  body.append(mode);
  if (d.can.accent) {
    body.append(sec('accent colour'));
    const row = el('div', 'hd-set-row');
    if (d.accents.length)
      for (const a of d.accents) {
        const b = Object.assign(el('button', `hd-swatch${gnomeHex[a] === d.accent ? ' on' : ''}`), {
          type: 'button',
          title: a,
          ariaLabel: a,
        });
        b.style.background = gnomeHex[a] ?? a;
        b.addEventListener(
          'click',
          () => void apply(hd, { accent: a }, `${a} as the accent`).then((x) => x && setWin(hd)),
        );
        row.append(b);
      }
    else {
      const c = Object.assign(el('input', 'hd-colour'), { type: 'color', value: d.accent || '#0078d4' });
      const b = Object.assign(el('button', 'btn', 'use'), { type: 'button' });
      b.addEventListener(
        'click',
        () => void apply(hd, { accent: c.value }, `${c.value} as the accent`).then((x) => x && setWin(hd)),
      );
      row.append(c, b);
    }
    body.append(row);
  }
  if (d.can.wallpaper) {
    body.append(sec('background'));
    const grid = el('div', 'hd-walls');
    grid.append(el('p', 'hd-empty', 'finding pictures on the host'));
    body.append(grid);
    void acctCall<{ images: string[] }>(api(hd.host, 'images')).then((r) => {
      const list = r.images ?? [];
      if (!r.ok || !list.length)
        return grid.replaceChildren(el('p', 'hd-empty', r.error || 'no pictures found on the host'));
      grid.replaceChildren(
        ...list.map((p) => {
          const b = Object.assign(el('button', `hd-thumb${p === d.wallpaper.path ? ' on' : ''}`), {
            type: 'button',
            title: p,
          });
          b.append(
            Object.assign(el('img'), {
              src: api(hd.host, 'download', { path: p, inline: '1' }),
              loading: 'lazy',
              alt: '',
            }),
          );
          b.addEventListener(
            'click',
            () => void apply(hd, { wallpaper: p }, `${p} as the desktop background`).then((x) => x && setWin(hd)),
          );
          return b;
        }),
      );
    });
  }
  body.append(sec(d.os === 'windows' ? 'taskbar pins' : 'pinned apps'));
  if (!d.can.pins)
    body.append(
      el(
        'p',
        'hd-note',
        d.os === 'windows'
          ? 'windows keeps its taskbar pins to itself; pin and unpin on the host'
          : `${d.shell} pins are changed on the host`,
      ),
    );
  const pins = el('div', 'hd-rows');
  const ids = d.pins.map((p) => p.id).filter((x): x is string => !!x);
  for (const p of d.pins) {
    const row = el('div', 'hd-row');
    row.append(pic(hd, p), el('span', 'hd-row-n', p.name));
    if (d.can.pins && p.id) {
      const i = ids.indexOf(p.id);
      const mv = (to: number) => {
        const next = [...ids];
        next.splice(i, 1);
        next.splice(to, 0, p.id!);
        void apply(hd, { pins: next }, `${p.name} moved`).then((x) => x && setWin(hd));
      };
      const left = Object.assign(el('button', 'btn', 'earlier'), { type: 'button', disabled: i === 0 });
      left.addEventListener('click', () => mv(i - 1));
      const right = Object.assign(el('button', 'btn', 'later'), { type: 'button', disabled: i === ids.length - 1 });
      right.addEventListener('click', () => mv(i + 1));
      const un = Object.assign(el('button', 'btn danger', 'unpin'), { type: 'button' });
      un.addEventListener(
        'click',
        () =>
          void apply(hd, { pins: ids.filter((x) => x !== p.id) }, `${p.name} unpinned`).then((x) => x && setWin(hd)),
      );
      row.append(left, right, un);
    }
    pins.append(row);
  }
  body.append(pins);
  if (d.can.pins) body.append(el('p', 'hd-note', 'pin more from the start menu: right click an app'));
}
