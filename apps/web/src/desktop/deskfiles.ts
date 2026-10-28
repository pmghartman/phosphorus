// --- the desktop's files: the user's own Desktop and shared/Desktop, each
// over the merged home, from every host

import type { FileEntry } from '@phosphorus/wire';
import { app } from '../apps/index.ts';
import {
  fileLabel,
  fileOpen,
  filesApi,
  filesCall,
  filesJoin,
  filesParent,
  filesWin,
  fmChanged,
  fmExt,
  fmIcon,
  fmKind,
  HOME,
  homeAt,
  homeHostList,
  homeList,
  homeOnline,
  homePick,
  type Loc,
  runnable,
} from '../features/home/home.ts';
import { jsonPost } from '../lib/api.ts';
import { DK_GLYPHS, DK_UI, dkGlyph, el } from '../lib/dom.ts';
import { dk, PREF_LS, st } from '../lib/state.ts';
import { shQuote } from '../lib/util.ts';
import { dkIcon, dkIcons, dkLiveHosts, dkMenuNote, dkSulfurOpen, dkTerminal, type MenuItem } from './desk.ts';
import { dkFocus, dkNav, dkSize, dkWin, type NavFrame } from './windows.ts';

export const dkDeskDirs = () => (st.acct && !st.acct.boot ? [`${st.acct.user}/Desktop`, 'shared/Desktop'] : []);
// where a drop lands: the user's own
export const dkDeskAt = () =>
  st.acct && !st.acct.boot && st.selfHost ? { loc: HOME, dir: `${st.acct.user}/Desktop` } : null;

// read again whenever the serving host or the user changes
export function dkDeskWatch(): void {
  const key = dkDeskAt() ? `${st.selfHost}\n${st.acct!.user}` : '';
  if (key === dk.deskKey) return;
  dk.deskKey = key;
  dk.deskFiles = [];
  dk.deskHosts = new Map();
  dk.deskReady = false;
  if (key) dkDeskLoad();
}

// each online host's Desktop stamps, pushed with the state: a change rereads that host's
const dkDeskStamp = (h: string, dir: string) => st.hostsInfo[h.toLowerCase()]?.desk?.[dir] ?? '';
const dkDeskStampNow = () =>
  JSON.stringify(
    homeOnline()
      .sort()
      .map((h) => [h, dkDeskDirs().map((d) => dkDeskStamp(h, d))]),
  );

export function dkDeskStamps(): void {
  if (dk.deskReady && dkDeskStampNow() !== dk.deskStamp) dkDeskLoad();
}

// force: a change made here, every host's listing asked again
export async function dkDeskLoad(force?: boolean): Promise<void> {
  if (!dkDeskAt()) return;
  dk.deskStamp = dkDeskStampNow();
  const key = dk.deskKey;
  const online = homeOnline();
  const cache = dk.deskHosts;
  // a folder no host answered for: its last icons kept, never blinking out
  const lists = await Promise.all(
    dkDeskDirs().map(async (dir) => {
      const got = await Promise.all(
        online.map(async (h) => {
          const stamp = dkDeskStamp(h, dir);
          const hit = cache.get(`${h}\n${dir}`);
          if (!force && hit && !hit.got.stale && hit.stamp === stamp) return hit.got;
          const fresh = await homeHostList(h, dir);
          cache.set(`${h}\n${dir}`, { stamp, got: fresh });
          return fresh;
        }),
      );
      return homeList(dir, got).then(
        (b) => b.entries.map((e) => ({ ...e, at: dir })),
        () => dk.deskFiles.filter((e) => e.at === dir),
      );
    }),
  );
  if (key !== dk.deskKey) return;
  dk.deskFiles = lists.flat();
  dk.deskReady = true;
  dkIcons();
}

// an .app folder's own icon, the first of these it holds
const DK_APP_ICONS = ['icon.svg', 'icon.png', 'favicon.svg', 'favicon.png', 'favicon.ico'];

// a long name cut in its middle, its extension always shown
const DK_NAME_MAX = 24;
function dkShort(n: string): string {
  if (n.length <= DK_NAME_MAX) return n;
  const dot = n.lastIndexOf('.');
  const ext = dot > 0 && n.length - dot <= 8 ? n.slice(dot) : '';
  return `${n.slice(0, DK_NAME_MAX - ext.length - 1)}…${ext}`;
}

export function dkFileIcon(e: FileEntry): HTMLButtonElement {
  const rel = filesJoin(e.at!, e.name);
  const kind = runnable(e) ? 'app' : fmKind(e);
  const pic =
    kind === 'image' && !e.stale
      ? filesApi(HOME, 'download', { path: rel, inline: 1 })
      : kind === 'app' && e.dir && !e.stale
        ? DK_APP_ICONS.map((n) =>
            filesApi(homeAt(e.live?.includes(st.selfHost) ? st.selfHost : e.live?.[0] || st.selfHost), 'download', {
              path: `${rel}/${n}`,
              inline: 1,
            }),
          )
        : '';
  // under it: shared, and the host unless it's everywhere or here alone
  const where = e.all ? '' : e.hosts!.length === 1 && e.hosts![0] === st.selfHost ? '' : e.hosts!.join(', ');
  const sub = [e.at!.startsWith('shared/') ? 'shared' : '', where].filter(Boolean).join(' · ');
  const b = dkIcon('doc', dkShort(e.name.replace(/\.app$/i, '')), sub, () => fileOpen(HOME, rel, e), pic);
  const tile = b.querySelector('.dk-tile')!;
  if (!pic || kind === 'app') tile.replaceChildren(kind === 'app' ? dkGlyph(DK_GLYPHS.app!, 'fm-app') : fmIcon(kind));
  b.classList.add(`dk-doc-${kind}`);
  if (e.stale) b.classList.add('dk-stale');
  b.dataset.file = rel;
  // placed by its path, whatever its label says
  b.dataset.id = `doc\n${rel}`;
  b.title = e.stale ? `${e.name}, on ${e.hosts!.join(', ')}, offline` : e.name;
  return b;
}

// a source file built or run in a terminal on a host the user has a login
// for, its build out of the home in a temp dir; $f the file, $o the program
export const DK_RUNNERS: Record<string, string> = {
  c: 'cc "$f" -o "$o" && "$o"',
  cpp: 'c++ "$f" -o "$o" && "$o"',
  cc: 'c++ "$f" -o "$o" && "$o"',
  cxx: 'c++ "$f" -o "$o" && "$o"',
  rs: 'rustc "$f" -o "$o" && "$o"',
  go: 'go run "$f"',
  zig: 'zig run "$f"',
  java: 'java "$f"',
  swift: 'swift "$f"',
  py: 'python3 "$f"',
  js: 'node "$f"',
  mjs: 'node "$f"',
  ts: 'npx --yes tsx "$f"',
  sh: 'bash "$f"',
  bash: 'bash "$f"',
  rb: 'ruby "$f"',
  pl: 'perl "$f"',
  php: 'php "$f"',
  lua: 'lua "$f"',
  hs: 'runghc "$f"',
  r: 'Rscript "$f"',
};
// the home on a host as its own shell sees it, none on a Windows one
export function dkHomeOn(host: string): string {
  const home = st.hostsInfo[host.toLowerCase()]?.files?.shares?.find((x) => x.home)?.label || '';
  return home.startsWith('/') && !home.startsWith('/run/desktop/') ? home : '';
}
// one "run on" per host holding the file whose login is saved
export function dkRunItems(rel: string, hosts: string[]): MenuItem[] {
  const runner = DK_RUNNERS[fmExt(rel)];
  if (!runner) return [];
  const live = new Set(dkLiveHosts());
  return hosts
    .filter((h) => live.has(h) && dkHomeOn(h))
    .map(
      (h): MenuItem => [
        `run on ${h}`,
        () => {
          const stem =
            rel
              .split('/')
              .pop()!
              .replace(/\.[^.]+$/, '') || 'a.out';
          dkTerminal(
            h,
            `f=${shQuote(`${dkHomeOn(h)}/${rel}`)}; o="$(mktemp -d)"/${shQuote(stem)}; cd "$(dirname "$f")" && ${runner}`,
          );
        },
        true,
      ],
    );
}

export function dkFileMenu(e: FileEntry): MenuItem[] {
  const rel = filesJoin(e.at!, e.name);
  const loc = homeAt(homePick(rel));
  return (
    [
      ['open', () => fileOpen(HOME, rel, e), !e.stale],
      e.dir && ['show in files', () => filesWin({ loc: HOME, dir: rel }), true],
      !e.dir && [
        'open in editor',
        () => dkCode({ host: loc.host, share: loc.share!, path: rel, label: fileLabel(loc.host, 'home', rel) }),
        !e.stale,
      ],
      !e.dir && [
        'download',
        () => {
          location.href = filesApi(loc, 'download', { path: rel });
        },
        !e.stale,
      ],
      ...(e.dir ? [] : dkRunItems(rel, e.all ? homeOnline() : e.live || [])),
      null,
      ['show in files', () => filesWin({ loc: HOME, dir: e.at! }), true],
      [
        'delete',
        async () => {
          try {
            await filesCall(HOME, 'delete', jsonPost({ path: rel }));
          } catch (err) {
            dkMenuNote((err as Error).message);
          }
          fmChanged(HOME, e.at!);
        },
        !e.stale,
        'danger',
      ],
    ] as (MenuItem | false)[]
  ).filter((i): i is MenuItem => i !== false);
}

// --- running: a page, a NAME.app folder's index.html, or a .wasm, sandboxed
// in a window, off this origin, its files through a sealed run link

const RUN_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads';

export async function dkRun(loc: Loc, rel: string): Promise<void> {
  const name = rel.split('/').pop()!;
  let got;
  try {
    got = await filesCall(loc, 'run', jsonPost({ path: rel }));
  } catch (err) {
    dkMenuNote((err as Error).message);
    return;
  }
  const w = dkWin(`run:${loc.host}\n${loc.share}\n${rel}`, name.replace(/\.app$/i, ''), loc.host, 'svc');
  if (!w) return;
  const url = new URL(got.url, location.origin);
  // a .wasm its console page, in this theme's colors
  if (got.kind === 'wasm') {
    const css = getComputedStyle(document.documentElement);
    url.search = String(
      new URLSearchParams({
        console: '',
        bg: css.getPropertyValue('--bg').trim(),
        fg: css.getPropertyValue('--fg').trim(),
      }),
    );
  }
  const frame: NavFrame = Object.assign(el('iframe', 'dk-frame'), {
    title: name,
    allow: 'fullscreen; clipboard-write; autoplay; gamepad',
    src: url.href,
  });
  frame.setAttribute('sandbox', RUN_SANDBOX);
  const pop = Object.assign(el('button', 'dk-out'), {
    type: 'button',
    title: 'open in a browser tab',
    ariaLabel: 'open in a browser tab',
  });
  pop.appendChild(dkGlyph(DK_UI.pop!));
  pop.addEventListener('click', () => window.open(url.href, '_blank', 'noopener'));
  w.head.querySelector('.dk-btns')!.prepend(pop);
  w.body.appendChild(frame);
  dkNav(w, frame);
  w.onClose = () => {
    frame.contentWindow?.location.replace('about:blank');
  };
  dkFocus(w);
}

// --- a file to edit: a plain text window each

// a file as the chat, the agent or a share names it; label and share may be missing
export interface FileRef {
  host: string;
  share?: string;
  path: string;
  label?: string;
}

// whether a file is still where it was: its folder listed, it in it
export async function fileThere(f: FileRef): Promise<boolean> {
  try {
    const body = await filesCall({ host: f.host, share: String(f.share ?? '') }, 'list', undefined, {
      path: filesParent(f.path),
    });
    return body.entries.some((e) => e.name === f.path.split('/').pop() && !e.dir);
  } catch {
    return false;
  }
}

// the editor a file opens in: '' the built-in one, else an installed app's id (sulfur); a
// setting kept with the user's others on every host
export const EDITORS: [string, string][] = [
  ['', 'built-in'],
  ['sulfur', 'sulfur'],
];
export function editorPref(): string {
  let v = '';
  try {
    v = localStorage.getItem(PREF_LS.editor!) || '';
  } catch {}
  return EDITORS.some(([id]) => id === v) ? v : '';
}
export function setEditorPref(id: string): void {
  try {
    if (id) localStorage.setItem(PREF_LS.editor!, id);
    else localStorage.removeItem(PREF_LS.editor!);
  } catch {}
}

// a file to edit, refused with a note when it's gone; in sulfur when it's the editor picked
// and this host serves it, the built-in one otherwise
export async function dkCode(f: FileRef): Promise<void> {
  if (!(await fileThere(f))) {
    dkMenuNote(`${f.path.split('/').pop()} is gone`);
    return;
  }
  if (st.acct?.boot) {
    dkMenuNote('make your own account to edit files');
    return;
  }
  if (editorPref() === 'sulfur') {
    if (dkSulfurOpen(f)) return;
    dkMenuNote('sulfur isn’t on this host yet; the built-in editor for now');
  }
  dkEditor(f);
}

function dkEditor(f: FileRef) {
  if (!dk.desk || !st.acct || st.acct.boot) return;
  const label = f.label || fileLabel(f.host, String(f.share ?? ''), f.path);
  const w = dkWin(
    `view:edit
${f.host}
${f.share ?? ''}
${f.path}`,
    f.path.split('/').pop() || f.path,
    '',
    'edit',
  );
  if (!w) return;
  dkSize(w, 720, 560);
  w.body.append(el('div', 'ed-note', 'loading'));
  let now: { focus: () => void; holdClose: () => boolean } | null = null;
  app('editor').then(
    (m) => {
      if (!w.node.isConnected) return;
      now = m.editorStart(w, { ...f, label });
    },
    (e) => {
      w.body.textContent = `failed: ${e.message}`;
    },
  );
  w.onFocus = () => now?.focus();
  w.holdClose = () => !!now?.holdClose();
  dkFocus(w);
}
