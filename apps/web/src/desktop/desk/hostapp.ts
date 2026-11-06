// a host's Electron app served to the browser: its own renderer in a frame, its own main
// process on the host the backend. Each of its windows a desk window: moved, snapped,
// minimized as any other, the app's own title bar standing in for ours when it draws one.
// An app with no web inside comes back as native and is streamed instead

import {
  AppViewer,
  type Bounds,
  type MenuEntry,
  type Overlay,
  type Shell,
  type ShellWin,
  type WinState,
} from '@phosphorus/appweb/web';
import { deskAbs, deskLoc, deskRel, fileOpen, filesWin } from '../../features/home/home.ts';
import { el } from '../../lib/dom.ts';
import { currentTheme } from '../../lib/scheme.ts';
import { dk } from '../../lib/state.ts';
import {
  type DkWin,
  dkClose,
  dkFocus,
  dkMax,
  dkMin,
  dkPlace,
  dkSize,
  dkSnap,
  dkStack,
  dkTaskIcon,
  dkWin,
} from '../windows.ts';
import { api, hostInfo, type Item, iconSrc } from './hosts.ts';
import { streamWin } from './hoststream.ts';
import { dkMenu, dkMenuEl, dkSay, type MenuItem } from './wallpaper.ts';

type App = {
  host: string;
  name: string;
  icon: string;
  key: string;
  done: boolean;
  wins: Set<DkWin>;
  // each window's parent, by the app's own ids
  parent: Map<DkWin, number>;
  byId: Map<number, DkWin>;
  viewer?: AppViewer;
  started: () => void;
};

// the apps open in this page, by host and the path or id they opened by
const apps = new Map<string, App>();
const dkOf = new WeakMap<ShellWin, DkWin>();
// where the pointer last pressed in any app's window, on the page
let lastAt = { x: innerWidth / 2, y: innerHeight / 3 };

const deskRect = () => dk.desk!.wins.getBoundingClientRect();

// a host's window app: served as itself when it's a web app inside, streamed when it isn't
export function hostApp(host: string, it: Item | { id: string; name: string }) {
  if (!dk.desk) return;
  const byId = 'id' in it && !('kind' in it) ? it.id : '';
  const path = 'path' in it ? (it.path ?? '') : '';
  const key = `${host}\0${byId || path}`;
  const live = apps.get(key);
  if (live) {
    const top = [...live.wins].find((w) => !w.task.hidden);
    if (top) dkFocus(top);
    return;
  }
  const r = deskRect();
  const q = new URLSearchParams(byId ? { id: byId } : { path });
  q.set('w', String(Math.round(r.width)));
  q.set('h', String(Math.round(r.height)));
  q.set('dpr', String(devicePixelRatio || 1));
  q.set('dark', currentTheme() === 'light' ? '0' : '1');
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/appweb/${encodeURIComponent(host)}/socket?${q}`;
  const app: App = {
    host,
    name: it.name,
    icon: 'kind' in it ? iconSrc(host, it) : '',
    key,
    done: false,
    wins: new Set(),
    parent: new Map(),
    byId: new Map(),
    started: () => {},
  };
  apps.set(key, app);
  // the pointer busy until its first window, a note only for a slow start
  const waits = dk.desk.el;
  waits.classList.add('aw-wait');
  let slowT = window.setTimeout(() => dkSay(`starting ${app.name} on ${host}`), 2500);
  app.started = () => {
    clearTimeout(slowT);
    slowT = 0;
    if (![...apps.values()].some((a) => !a.done && a !== app && !a.wins.size)) waits.classList.remove('aw-wait');
  };
  const end = () => {
    app.started();
    app.done = true;
    if (apps.get(app.key) === app) apps.delete(app.key);
  };
  const shell = shellOf(app, (s) => {
    switch (s.t) {
      case 'ready': {
        // keyed by its id too, so the apps menu's running entry finds it
        const k = `${host}\0${s.id}`;
        if (k !== app.key) {
          apps.delete(app.key);
          app.key = k;
          apps.set(k, app);
        }
        return;
      }
      case 'error': {
        end();
        const why = String(s.s ?? '');
        // no web inside or its inspector sealed: streamed instead, as one that never got a
        // window up is, unless a stream would hit the same wall
        const shut = s.code === 'native' || s.code === 'sealed';
        const wall = /already open|apps are open|save a login/i.test(why);
        if ('kind' in it && (shut || (!app.wins.size && !wall))) return streamWin(host, it);
        return dkSay(`${app.name}: ${why}`);
      }
      case 'taken':
        end();
        return dkSay(`${app.name} was opened in another tab`);
      case 'ended':
        end();
        return;
      case 'lost':
        if (!app.done) dkSay(`lost the link to ${app.name} on ${host}; it's still open there`);
        end();
        return;
    }
  });
  app.viewer = new AppViewer(url, shell);
}

// --- the desktop's side of the app ----------------------------------------------------------

function shellOf(app: App, status: (s: { t: string; [k: string]: unknown }) => void): Shell {
  return {
    window: (s, ev) => winOf(app, s, ev),
    menu: (sw, items, at) => menu(sw, items, at),
    message: (sw, o) => message(sw, o),
    openDialog: (sw, o) => pickFile(app.host, sw, o, false) as Promise<{ canceled: boolean; filePaths: string[] }>,
    saveDialog: (sw, o) => pickFile(app.host, sw, o, true) as Promise<{ canceled: boolean; filePath: string }>,
    tell: (kind, data) => tell(app, kind, data),
    status,
  };
}

function tell(app: App, kind: string, data: any) {
  switch (kind) {
    case 'open':
      return void window.open(String(data), '_blank', 'noopener');
    case 'path': {
      const p = String(data);
      return void fileOpen(deskLoc(app.host), deskRel(p), {});
    }
    case 'reveal': {
      const rel = deskRel(String(data));
      return void filesWin({ loc: deskLoc(app.host), dir: rel.replace(/\/[^/]*$/, '') });
    }
    case 'clip':
      return void navigator.clipboard?.writeText(String(data)).catch(() => {});
    case 'notify':
      return dkSay(`${app.name}: ${[data?.title, data?.body].filter(Boolean).join(': ')}`);
    case 'error':
    case 'dialog':
      return void message(null, {
        title: data?.title,
        message: data?.message ?? data?.title ?? '',
        detail: data?.detail ?? data?.content ?? '',
        buttons: data?.buttons,
      });
    default:
      return dkSay(`${app.name}: ${typeof data === 'string' ? data : kind}`);
  }
}

function winOf(app: App, s: WinState, ev: Parameters<Shell['window']>[1]): ShellWin {
  const w = dkWin(null, s.title || app.name, app.host, 'aw')!;
  // shown when the app shows it, never before
  w.node.hidden = true;
  w.task.hidden = true;
  app.wins.add(w);
  app.byId.set(s.id, w);
  if (s.parent) app.parent.set(w, s.parent);
  dkTaskIcon(w.task, app.icon);
  let bare = false;
  let shown = false;
  let closing = false;
  let asked = 0;
  const headH = () => (bare ? 0 : w.head.offsetHeight || 32);

  // its first size: a dialog's own, centered on its parent; a main window as the desk fits it
  const small = !!s.parent || s.modal || !s.resizable;
  if (small) {
    const d = deskRect();
    w.w = Math.min(d.width - 24, s.bounds.width);
    w.h = Math.min(d.height - 24, s.bounds.height + headH());
    const parent = [...app.wins].find((o) => o !== w && !o.task.hidden);
    const pr = parent?.node.getBoundingClientRect();
    const cx = pr ? pr.left - d.left + pr.width / 2 : d.width / 2;
    const cy = pr ? pr.top - d.top + pr.height / 3 : d.height / 3;
    w.x = Math.max(0, Math.round(cx - w.w / 2));
    w.y = Math.max(0, Math.round(cy - w.h / 3));
    dkPlace(w);
  } else dkSize(w, s.bounds.width, s.bounds.height);
  // a fixed size: no maximize, no edges to pull
  if (!s.resizable) w.node.classList.add('aw-fixed');
  if (s.min) {
    w.node.style.minWidth = `${s.min.w}px`;
    w.node.style.minHeight = `${s.min.h}px`;
  }

  const label = w.head.querySelector('.tab-label')!;
  const taskT = w.task.querySelector('.dk-task-t');
  const title = (t: string) => {
    const v = t || app.name;
    label.textContent = v;
    if (taskT) taskT.textContent = v;
    w.task.title = `${v} ${app.host}`;
  };

  // what the app is told: the content's place on the desk, and its state as the desk changed it
  let sent = '';
  let st = { minimized: false, maximized: false, fullscreen: false, focused: false };
  let syncT = 0;
  const sync = () => {
    syncT = 0;
    if (closing || !w.node.isConnected) return;
    if (!w.node.hidden) {
      const d = deskRect();
      const b = w.body.getBoundingClientRect();
      if (b.width > 0) {
        const nb: Bounds = {
          x: Math.round(b.left - d.left),
          y: Math.round(b.top - d.top),
          width: Math.round(b.width),
          height: Math.round(b.height),
        };
        const k = JSON.stringify(nb);
        if (k !== sent) {
          sent = k;
          ev.bounds(nb);
        }
      }
    }
    const now = {
      minimized: shown && w.node.hidden === true,
      maximized: w.snap === 'max',
      fullscreen: document.fullscreenElement === w.node,
      focused: w.node.classList.contains('focused'),
    };
    if (now.focused !== st.focused) ev.focus(now.focused);
    const diff: Record<string, boolean> = {};
    for (const k of ['minimized', 'maximized', 'fullscreen'] as const) if (now[k] !== st[k]) diff[k] = now[k];
    if (Object.keys(diff).length) ev.state(diff);
    st = now;
  };
  const later = () => {
    if (!syncT) syncT = window.setTimeout(sync, 60);
  };
  const ro = new ResizeObserver(later);
  ro.observe(w.body);
  const mo = new MutationObserver(later);
  mo.observe(w.node, { attributes: true, attributeFilter: ['style', 'hidden', 'class', 'data-snap'] });
  const onFull = () => later();
  document.addEventListener('fullscreenchange', onFull);

  // the close button asks the app, which may ask to save first; a second press after it
  // has had its time closes the window regardless
  w.holdClose = () => {
    if (closing || app.done) return false;
    if (asked && Date.now() - asked > 4000) return false;
    if (!asked) {
      asked = Date.now();
      ev.close();
    }
    return true;
  };
  w.onClose = () => {
    closing = true;
    ro.disconnect();
    mo.disconnect();
    document.removeEventListener('fullscreenchange', onFull);
    clearTimeout(syncT);
    app.wins.delete(w);
    app.byId.delete(s.id);
    app.parent.delete(w);
  };
  // the keyboard handed to the app's page whenever its window is raised
  w.onFocus = () => {
    asked = 0;
    // its own windows kept above it, as the OS keeps a dialog over its owner
    for (const [c, pid] of app.parent) if (pid === s.id && !c.node.hidden) c.node.style.zIndex = String(++dk.z);
    w.task.classList.remove('aw-flash');
    setTimeout(() => w.body.querySelector('iframe')?.focus(), 0);
  };

  // a drag from the app's own title bar
  let drag: { x: number; y: number } | null = null;
  let dragF = 0;

  const sw: ShellWin = {
    body: w.body,
    title,
    bounds(b) {
      if (b.width) w.w = b.width;
      if (b.height) w.h = b.height + headH();
      if (b.x !== undefined) w.x = Math.max(0, b.x);
      if (b.y !== undefined) w.y = Math.max(0, b.y - headH());
      if (w.snap && (b.x !== undefined || b.width)) dkSnap(w, '');
      dkPlace(w);
    },
    show(focus) {
      shown = true;
      app.started();
      w.task.hidden = false;
      if (focus) return dkFocus(w);
      w.node.hidden = false;
      w.node.style.zIndex = String(++dk.z);
    },
    hide() {
      shown = false;
      const was = w.node.classList.contains('focused');
      w.node.hidden = true;
      w.task.hidden = true;
      w.node.classList.remove('focused');
      w.task.classList.remove('active');
      if (was) {
        const top = dkStack()[0];
        if (top) dkFocus(top);
      }
    },
    focus: () => dkFocus(w),
    minimize: () => {
      if (!w.node.hidden) dkMin(w);
    },
    maximize(on) {
      if ((w.snap === 'max') !== on) dkMax(w);
    },
    restore() {
      if (w.node.hidden) return dkFocus(w);
      if (w.snap === 'max') dkMax(w);
    },
    fullscreen(on) {
      if (on && document.fullscreenElement !== w.node) void w.node.requestFullscreen?.().catch(() => {});
      else if (!on && document.fullscreenElement === w.node) void document.exitFullscreen().catch(() => {});
    },
    frameless(on, ov: Overlay | null) {
      bare = on;
      w.node.classList.toggle('aw-bare', on);
      // the app leaves room for the window's buttons: ours drawn there, in its colours
      w.node.classList.toggle('aw-overlay', on && !!ov);
      const n = w.node.style;
      if (on && ov) {
        n.setProperty('--aw-ov-h', `${ov.height || 30}px`);
        if (ov.color) n.setProperty('--aw-ov-bg', ov.color);
        if (ov.symbolColor) n.setProperty('--aw-ov-fg', ov.symbolColor);
      }
    },
    background(c) {
      w.body.style.background = c;
    },
    flash() {
      if (!w.node.classList.contains('focused')) w.task.classList.add('aw-flash');
    },
    close() {
      closing = true;
      if (dk.wins.get(w.key) === w) dkClose(w);
      else w.onClose?.();
    },
    drag(dx, dy, at) {
      if (!drag) {
        if (w.snap) {
          // let go of its snap under the pointer, where it was held
          const d = deskRect();
          const b = w.body.getBoundingClientRect();
          w.x = Math.round(b.left - d.left + at.x - (at.x / Math.max(1, b.width)) * w.w);
          w.y = Math.max(0, Math.round(b.top - d.top));
          dkSnap(w, '');
          dkPlace(w);
        }
        drag = { x: w.x, y: w.y };
      }
      w.x = drag.x + dx;
      w.y = Math.max(0, drag.y + dy);
      if (!dragF)
        dragF = requestAnimationFrame(() => {
          dragF = 0;
          dkPlace(w);
        });
    },
    dragEnd() {
      if (!drag) return;
      drag = null;
      cancelAnimationFrame(dragF);
      dragF = 0;
      // never lost under the task bar or off either side
      const d = deskRect();
      w.x = Math.max(48 - w.w, Math.min(d.width - 48, w.x));
      w.y = Math.max(0, Math.min(d.height - 28, w.y));
      dkPlace(w);
    },
    toggleMax: () => dkMax(w),
    framed(f) {
      // a press inside raises the window (windows.ts), a drag over it never lost to it
      f.classList.add('dk-frame');
    },
    pointer(x, y) {
      const b = w.body.getBoundingClientRect();
      lastAt = { x: b.left + x, y: b.top + y };
    },
  };
  dkOf.set(sw, w);
  title(s.title);
  return sw;
}

// --- menus ------------------------------------------------------------------------------------

// Electron's mnemonics dropped, its && a plain &
const plain = (s: string) => s.replace(/&&|&/g, (m) => (m === '&&' ? '&' : ''));

function menu(sw: ShellWin | null, items: MenuEntry[], at: { x?: number; y?: number }): Promise<string | null> {
  return new Promise((res) => {
    let done = false;
    const pick = (id: string) => {
      done = true;
      res(id);
    };
    const conv = (es: MenuEntry[]): MenuItem[] => {
      const out: MenuItem[] = [];
      for (const e of es) {
        if (!e.visible) continue;
        if (e.type === 'separator') {
          if (out.length && out.at(-1)) out.push(null);
          continue;
        }
        const mark = e.type === 'checkbox' || e.type === 'radio' ? (e.checked ? '✓ ' : ' ') : '';
        const text = `${mark}${plain(e.label || e.role || '')}`;
        if (e.items?.length) out.push([text, conv(e.items), e.enabled]);
        else out.push([text, () => pick(e.id), e.enabled]);
      }
      while (out.length && !out.at(-1)) out.pop();
      return out;
    };
    const list = conv(items);
    if (!list.length) return res(null);
    let x = lastAt.x;
    let y = lastAt.y;
    const w = sw && dkOf.get(sw);
    if (w && at.x !== undefined && at.y !== undefined) {
      const b = w.body.getBoundingClientRect();
      x = b.left + at.x;
      y = b.top + at.y;
    }
    dkMenu(x, y, list);
    // gone without a pick: the app told so
    const mo = new MutationObserver(() => {
      if (!dkMenuEl.hidden) return;
      mo.disconnect();
      if (!done) res(null);
    });
    mo.observe(dkMenuEl, { attributes: true, attributeFilter: ['hidden'] });
  });
}

// --- sheets: a message or a file picker over its window, else over the desk -----------------

function sheet(sw: ShellWin | null, build: (card: HTMLElement, close: () => void) => void): void {
  const w = sw && dkOf.get(sw);
  const back = el('div', w ? 'aw-sheet' : 'aw-sheet aw-sheet-desk');
  const card = el('div', 'aw-card');
  card.tabIndex = -1;
  back.append(card);
  (w ? w.node : dk.desk!.wins).append(back);
  if (!w) back.style.zIndex = String(++dk.z);
  build(card, () => back.remove());
  if (w) dkFocus(w);
  setTimeout(() => (card.querySelector<HTMLElement>('[autofocus]') ?? card).focus(), 0);
}

type MsgOpts = {
  title?: string;
  message?: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
  checkboxLabel?: string;
  checkboxChecked?: boolean;
};

function message(sw: ShellWin | null, o: MsgOpts): Promise<{ response: number; checkboxChecked: boolean }> {
  return new Promise((res) => {
    sheet(sw, (card, close) => {
      const buttons = o.buttons?.length ? o.buttons.map(plain) : ['OK'];
      const cancelIdx =
        o.cancelId ??
        Math.max(
          0,
          buttons.findIndex((b) => /^(cancel|no)$/i.test(b)),
        );
      let box: HTMLInputElement | undefined;
      const done = (i: number) => {
        close();
        res({ response: i, checkboxChecked: !!box?.checked });
      };
      if (o.title) card.append(el('div', 'aw-card-title', o.title));
      card.append(el('p', 'aw-msg', o.message ?? ''));
      if (o.detail) card.append(el('p', 'aw-detail', o.detail));
      if (o.checkboxLabel) {
        const l = el('label', 'aw-check');
        box = Object.assign(el('input'), { type: 'checkbox', checked: !!o.checkboxChecked });
        l.append(box, document.createTextNode(` ${o.checkboxLabel}`));
        card.append(l);
      }
      const row = el('div', 'aw-btns');
      const def = o.defaultId ?? 0;
      buttons.forEach((t, i) => {
        const b = Object.assign(el('button', i === def ? 'btn primary' : 'btn', t), { type: 'button' });
        if (i === def) b.autofocus = true;
        b.addEventListener('click', () => done(i));
        row.append(b);
      });
      card.append(row);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          done(cancelIdx);
        }
      });
    });
  });
}

type FileOpts = {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: { name: string; extensions: string[] }[];
  properties?: string[];
};
type Entry = { name: string; dir: boolean; size: number | null; mtime: number | null };

const join = (rel: string, name: string) => (rel ? `${rel.replace(/\/$/, '')}/${name}` : name);
const parent = (rel: string) => (/^[A-Za-z]:$/.test(rel) ? '' : rel.includes('/') ? rel.replace(/\/[^/]*$/, '') : '');

// a folder of the host's disk at a time, over the same login the app runs as
function pickFile(host: string, sw: ShellWin | null, o: FileOpts, save: boolean) {
  const props = new Set(o.properties ?? []);
  const dirs = props.has('openDirectory') && !save;
  const files = props.has('openFile') || (!dirs && !save);
  const multi = props.has('multiSelections') && !save;
  const hidden = props.has('showHiddenFiles');
  const exts = (o.filters ?? []).flatMap((f) => f.extensions.map((e) => e.toLowerCase()));
  const anyExt = !exts.length || exts.includes('*');
  const canceled = () => (save ? { canceled: true, filePath: '' } : { canceled: true, filePaths: [] as string[] });

  const start = o.defaultPath ? deskRel(o.defaultPath) : deskRel(hostInfo(host).desk?.home ?? '');
  // a save's default a file to name, an open's a folder or the file to select
  let dir = save ? parent(start) : start;
  const startName = save ? (start.split('/').pop() ?? '') : '';

  return new Promise<unknown>((res) => {
    sheet(sw, (card, close) => {
      const done = (v: unknown) => {
        close();
        res(v);
      };
      card.classList.add('aw-picker');
      card.append(el('div', 'aw-card-title', o.title || (save ? 'save as' : dirs ? 'open folder' : 'open')));
      const where = Object.assign(el('input', 'aw-where'), { spellcheck: false, ariaLabel: 'folder' });
      const up = Object.assign(el('button', 'btn aw-up', '↑'), { type: 'button', title: 'up', ariaLabel: 'up' });
      const bar = el('div', 'aw-bar');
      bar.append(up, where);
      const list = el('div', 'aw-list');
      list.tabIndex = 0;
      const name = Object.assign(el('input', 'aw-name'), { value: startName, spellcheck: false, ariaLabel: 'name' });
      const say = el('div', 'aw-say');
      const row = el('div', 'aw-btns');
      const cancel = Object.assign(el('button', 'btn', 'cancel'), { type: 'button' });
      const ok = Object.assign(el('button', 'btn primary', plain(o.buttonLabel || (save ? 'save' : 'open'))), {
        type: 'button',
      });
      row.append(cancel, ok);
      card.append(bar, list, ...(save ? [name] : []), say, row);
      if (save) name.autofocus = true;
      else list.autofocus = true;

      const picked = new Set<string>();
      let entries: Entry[] = [];
      const paint = () => {
        list.replaceChildren(
          ...entries.map((e) => {
            const r = el('button', `aw-row${e.dir ? ' dir' : ''}${picked.has(e.name) ? ' on' : ''}`, e.name);
            r.type = 'button';
            r.addEventListener('click', (ev) => {
              if (!multi || !(ev.ctrlKey || ev.metaKey)) picked.clear();
              if (picked.has(e.name)) picked.delete(e.name);
              else picked.add(e.name);
              if (save && !e.dir) name.value = e.name;
              paint();
            });
            r.addEventListener('dblclick', () => (e.dir ? go(join(dir, e.name)) : accept()));
            return r;
          }),
        );
        ok.disabled = !save && !dirs && !picked.size;
      };
      const go = async (rel: string) => {
        say.textContent = '';
        const r = await fetch(api(host, 'fs-list', { path: rel }), { cache: 'no-store' })
          .then((x) => x.json())
          .catch((e) => ({ error: String(e) }));
        if (r.error || !Array.isArray(r.entries)) {
          say.textContent = r.error || `can't read ${rel || 'the top'}`;
          return;
        }
        dir = rel;
        where.value = rel ? deskAbs(rel) : '';
        picked.clear();
        entries = (r.entries as Entry[])
          .filter((e) => hidden || !e.name.startsWith('.'))
          .filter((e) => e.dir || (files && (anyExt || exts.includes(e.name.split('.').pop()!.toLowerCase()))))
          .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
        paint();
      };
      const accept = () => {
        if (save) {
          const n = name.value.trim();
          if (!n) return name.focus();
          return done({ canceled: false, filePath: deskAbs(join(dir, n)) });
        }
        const chosen = [...picked].map((n) => entries.find((e) => e.name === n)!).filter(Boolean);
        // a folder opened into unless folders are what's asked for
        if (!dirs && chosen.length === 1 && chosen[0]!.dir) return void go(join(dir, chosen[0]!.name));
        const paths = chosen.filter((e) => (dirs ? e.dir : !e.dir) || (dirs && files)).map((e) => join(dir, e.name));
        if (!paths.length && dirs && dir) paths.push(dir);
        if (!paths.length) return;
        done({ canceled: false, filePaths: paths.map(deskAbs) });
      };
      up.addEventListener('click', () => void go(parent(dir)));
      where.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void go(deskRel(where.value.trim()));
        }
      });
      cancel.addEventListener('click', () => done(canceled()));
      ok.addEventListener('click', accept);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          done(canceled());
        } else if (e.key === 'Enter' && e.target !== where) {
          e.preventDefault();
          accept();
        }
      });
      // an open's default a file: its folder shown, the file picked
      void go(dir).then(() => {
        if (!save && entries.length === 0 && dir) {
          const n = dir.split('/').pop() ?? '';
          void go(parent(dir)).then(() => {
            if (entries.some((e) => e.name === n && !e.dir)) {
              picked.add(n);
              paint();
            }
          });
        }
      });
    });
  });
}
