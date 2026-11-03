// the wallpaper: a picture of the user's, kept in their home on the mesh

import type { Route } from '@phosphorus/wire';
import { appCall } from '../../apps/index.ts';
import { filesJoin, filesParent, fmSame, fmTransfer } from '../../features/home/home.ts';
import {
  activeConnections,
  type Connection,
  drawMesh,
  serviceKey,
  serviceUrl,
  startPulseLoop,
} from '../../features/mesh/mesh.ts';
import { DK_UI, dkGlyph, el } from '../../lib/dom.ts';
import { dk, st } from '../../lib/state.ts';
import { dkWallPick } from '../../settings/appearance.ts';
import { dkSettings } from '../../settings/settings.ts';
import { dkView } from '../desk.ts';
import { dkDeskAt, dkDeskUpload, dkDeskView } from '../deskfiles.ts';
import { dkClock, type Pop } from '../taskbar.ts';
import { type DkWin, dkFocus, dkNav, dkWin, type NavFrame } from '../windows.ts';
import {
  DK_GX,
  DK_GY,
  DK_PAD,
  DK_POS_KEY,
  dkCell,
  dkGrid,
  dkIconEls,
  dkLayout,
  dkLiveHosts,
  dkPaintSel,
  dkSaved,
} from './icons.ts';
import { dkTerminal } from './terminal.ts';

// the wallpaper set or removed, for settings' appearance row
export const WALL_EVENT = 'phosphorus-wallpaper';
export function dkWallPaint(): void {
  const at = st.acct?.wallpaper || 0;
  dkView.classList.toggle('dk-walled', !!at);
  if (at) dkView.style.setProperty('--dk-wall', `url("/api/me/wallpaper?v=${at}")`);
  else dkView.style.removeProperty('--dk-wall');
  dispatchEvent(new CustomEvent(WALL_EVENT, { detail: at }));
}

export const dkPick = (accept: string, multiple: boolean, then: (files: File[]) => void) => {
  const input = Object.assign(el('input'), { type: 'file', accept, multiple });
  input.addEventListener('change', () => {
    if (input.files!.length) then([...input.files!]);
  });
  input.click();
};

// files about to land on the desktop held to the cell at x, y (else the
// nearest free ones after it), their icons placed there once they show
export function dkPlaceAt(x: number, y: number, names: string[], dir = dkDeskAt()?.dir) {
  if (!dk.desk || !dir || !names.length) return;
  const box = dk.desk.icons.getBoundingClientRect();
  const { cols, rows } = dkGrid();
  const c0 = Math.max(0, Math.min(cols - 1, Math.floor((x - box.left - DK_PAD) / DK_GX)));
  const r0 = Math.max(0, Math.min(rows - 1, Math.floor((y - box.top - DK_PAD) / DK_GY)));
  const ids = new Set(names.map((n) => `doc\n${filesJoin(dir, n)}`));
  const taken = new Set(
    dkIconEls()
      .filter((b) => !ids.has(b.dataset.id!))
      .map((b) => dkCell(b.dataset.c!, b.dataset.r!)),
  );
  const saved = dkSaved();
  let i = c0 * rows + r0;
  for (const id of ids) {
    while (i < cols * rows && taken.has(dkCell(Math.floor(i / rows), i % rows))) i += 1;
    const at: [number, number] = i < cols * rows ? [Math.floor(i / rows), i % rows] : [c0, r0];
    taken.add(dkCell(...at));
    saved[id] = at;
  }
  try {
    localStorage.setItem(DK_POS_KEY, JSON.stringify(saved));
  } catch {}
}

// the computer's own files being dragged in
const dragsFiles = (e: DragEvent) => [...(e.dataTransfer?.types || [])].includes('Files');

// a right click on the desk or an icon, a drop of the computer's files
export function dkDeskMenu(icons: HTMLElement) {
  icons.addEventListener('contextmenu', (e) => {
    const b = (e.target as Element).closest('.dk-icon') as HTMLElement | null;
    if (e.target !== icons && !b) return;
    e.preventDefault();
    if (b && !dk.sel.has(b.dataset.id!)) {
      dk.sel = new Set([b.dataset.id!]);
      dkPaintSel();
    }
    const hosts = dkLiveHosts();
    // a file's: the files app's own menu, the desktop's picks its picks
    if (b?.dataset.file) {
      appCall('files', true, (m) => m.fmMenu(dkDeskView(), e.clientX, e.clientY, true));
      return;
    }
    const [kind, name, host] = b ? b.dataset.id!.split('\n') : [];
    const svc = kind === 'service' && dk.services.find((r) => r.host === host && r.name === name);
    const items: MenuItem[] = [
      ...(b ? [['open', () => b.dispatchEvent(new MouseEvent('dblclick')), true] as MenuItem] : []),
      ...(svc && st.acct?.admin
        ? [[svc.public ? 'make private' : 'make public', () => dkSetPublic(svc, !svc.public), true] as MenuItem]
        : []),
      ...(!b && st.acct?.admin && dkFound().length ? [['publish found page', dkFound(), true] as MenuItem, null] : []),
      ...(b ? [null] : []),
      ['new terminal', hosts.map((h): MenuItem => [h, () => dkTerminal(h), true]), hosts.length > 0],
      null,
      ['new folder', () => appCall('files', true, (m) => m.fmMkdir(dkDeskView())), !!dkDeskAt()],
      [
        'upload files…',
        () =>
          dkPick('', true, (list) => {
            dkPlaceAt(
              e.clientX,
              e.clientY,
              list.map((f) => f.name),
            );
            dkDeskUpload(list);
          }),
        !!dkDeskAt(),
      ],
      ['paste', () => appCall('files', true, (m) => m.fmPaste(dkDeskView())), !!dk.clip && !!dkDeskAt()],
      null,
      ['change wallpaper…', dkWallPick, !!st.acct && !st.acct.boot],
      ['appearance…', () => dkSettings('appearance', 'desktop'), true],
      null,
      [
        'select all',
        () => {
          dk.sel = new Set(dkIconEls().map((x) => x.dataset.id!));
          dkPaintSel();
        },
        true,
      ],
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
      dkPlaceAt(
        e.clientX,
        e.clientY,
        items.map((it) => it.name),
        d.dir,
      );
      if (items.length) fmTransfer(drag.v, drag.loc, items, d.loc, d.dir, false);
      return;
    }
    if (!dragsFiles(e)) return;
    e.preventDefault();
    const list = [...e.dataTransfer!.files];
    dkPlaceAt(
      e.clientX,
      e.clientY,
      list.map((f) => f.name),
    );
    dkDeskUpload(list);
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
  try {
    localStorage.setItem(DK_POS_KEY, '{}');
  } catch {}
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
document.addEventListener(
  'pointerdown',
  (e) => {
    if (!dkMenuEl.contains(e.target as Node) && !dkMenuEl.owner?.contains(e.target as Node)) dkMenuEl.hidden = true;
  },
  true,
);
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape') dkMenuEl.hidden = true;
  },
  true,
);
addEventListener('blur', () => {
  dkMenuEl.hidden = true;
});

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
      b.addEventListener('click', () => {
        dkMenuEl.hidden = true;
        after?.();
        act();
      });
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
      for (const o of wrap.parentElement!.querySelectorAll(':scope > .dk-menu-item.open'))
        if (o !== wrap) o.classList.remove('open');
      wrap.classList.add('open');
      const r = b.getBoundingClientRect();
      sub.classList.toggle('left', r.right + sub.offsetWidth > innerWidth - 4);
      sub.style.top = `${Math.min(0, innerHeight - 4 - r.top - sub.offsetHeight)}px`;
    };
    wrap.addEventListener('pointerenter', open);
    wrap.addEventListener('pointerleave', () => wrap.classList.remove('open'));
    b.addEventListener('click', open);
    b.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') {
        open();
        (sub.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus();
      }
    });
    sub.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') {
        wrap.classList.remove('open');
        b.focus();
      }
    });
    return wrap;
  };
  dkMenuEl.replaceChildren(...(title ? [el('div', 'dk-menu-title', title)] : []), ...items.map(item));
  dkMenuEl.hidden = false;
  dkMenuEl.style.left = `${Math.min(x, innerWidth - dkMenuEl.offsetWidth - 4)}px`;
  dkMenuEl.style.top = `${Math.min(y, innerHeight - dkMenuEl.offsetHeight - 4)}px`;
}

// every host's unpublished pages as menu items, each published as its host's record
function dkFound(): MenuItem[] {
  const out: MenuItem[] = [];
  for (const [host, info] of Object.entries(st.hostsInfo).sort(([a], [b]) => a.localeCompare(b)))
    for (const f of info.found ?? [])
      out.push([`${f.title} (${host}:${f.port})`, () => dkPublish(host, f.name, f.port), true]);
  return out;
}

export async function dkPublish(host: string, name: string, port: number) {
  dkMenuNote(`publishing ${name}…`);
  const res = await fetch(`/api/services/${encodeURIComponent(host)}/${encodeURIComponent(name)}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port }),
  }).catch(() => null);
  const out = res ? await res.json().catch(() => ({})) : {};
  const why = out.outcome && out.outcome.published !== true ? out.outcome.why : '';
  dkMenuNote(res?.ok && !why ? `${name} published` : why || out.error || 'not published');
}

// a service behind the phosphorus login or open to all, its record or want rewritten
export async function dkSetPublic(r: Route, on: boolean) {
  const res = await fetch(`/api/services/${encodeURIComponent(r.host)}/${encodeURIComponent(r.name)}/public`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public: on }),
  }).catch(() => null);
  const out = res ? await res.json().catch(() => ({})) : {};
  dkMenuNote(res?.ok ? `${r.name} ${on ? 'public' : 'private'}` : out.error || 'not changed');
}

export function dkService(r: Route): DkWin | undefined {
  const w = dkWin(`svc:${serviceKey(r)}`, r.name, r.public ? `${r.host}, public` : r.host, 'svc');
  if (!w) return;
  const url = serviceUrl(r);
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
    title: r.name,
    allow: 'clipboard-read; clipboard-write; fullscreen',
  });
  w.body.appendChild(frame);
  dkNav(w, frame);
  // lit on the mesh graph as an open tab of it would be
  const conn: Connection = { win: { closed: false }, host: r.host, name: r.name };
  activeConnections.set(serviceKey(r), conn);
  startPulseLoop();
  drawMesh();
  w.onFocus = () => frame.contentWindow?.focus();
  w.onClose = () => {
    conn.win.closed = true;
    frame.contentWindow?.location.replace('about:blank');
  };
  dkFocus(w);
  return w;
}
