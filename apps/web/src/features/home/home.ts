// the files layer every window shares: the editor's file kinds, the files api and its
// paths, the merged home over every host, transfers through the page, and what the file
// manager windows and the desktop's icons have in common
import { jsonPost } from '../../lib/api.ts';
import { app, appCall } from '../../apps/index.ts';
import { dkGlyph, ICONS } from '../../lib/dom.ts';
import { phosphorusHosts } from '../mesh/mesh.ts';
import { st } from '../../lib/state.ts';
import type { FileEntry, FileListing, FileRead, FileRun, FilesInfo, ShowFile } from '@phosphorus/wire';
import type { DkWin } from '../../desktop/windows.ts';
import { dkCode, dkDeskDirs, dkDeskLoad, dkRun } from '../../desktop/deskfiles.ts';

// --- the editor's file kinds and open tabs, the code itself fetched on first open ---

// by extension: highlight.js's language, the parser checking it, the line comment
const CODE_EXT: Record<string, [string, string, string]> = {
  js: ['javascript', 'javascript', '//'], mjs: ['javascript', 'javascript', '//'], cjs: ['javascript', 'javascript', '//'], jsx: ['javascript', 'javascript:jsx', '//'],
  ts: ['typescript', 'javascript:ts', '//'], mts: ['typescript', 'javascript:ts', '//'], tsx: ['typescript', 'javascript:jsx ts', '//'],
  py: ['python', 'python', '#'], sh: ['bash', '', '#'], bash: ['bash', '', '#'], zsh: ['bash', '', '#'],
  c: ['c', 'cpp', '//'], h: ['c', 'cpp', '//'], cpp: ['cpp', 'cpp', '//'], cc: ['cpp', 'cpp', '//'], cxx: ['cpp', 'cpp', '//'], hpp: ['cpp', 'cpp', '//'],
  go: ['go', 'go', '//'], rs: ['rust', 'rust', '//'], java: ['java', 'java', '//'], rb: ['ruby', '', '#'], lua: ['lua', '', '--'],
  cs: ['csharp', '', '//'], kt: ['kotlin', '', '//'], swift: ['swift', '', '//'], php: ['php', 'php', '//'], r: ['r', '', '#'],
  scala: ['scala', '', '//'], dart: ['dart', '', '//'], ex: ['elixir', '', '#'], exs: ['elixir', '', '#'], hs: ['haskell', '', '--'],
  jl: ['julia', '', '#'], nix: ['nix', '', '#'], ps1: ['powershell', '', '#'], sql: ['sql', '', '--'], proto: ['protobuf', '', '//'],
  css: ['css', 'css', ''], scss: ['scss', '', '//'], html: ['xml', 'html', ''], htm: ['xml', 'html', ''], xml: ['xml', 'xml', ''], svg: ['xml', 'xml', ''],
  json: ['json', 'json', ''], yml: ['yaml', 'yaml', '#'], yaml: ['yaml', 'yaml', '#'], toml: ['ini', '', '#'], ini: ['ini', '', ';'], conf: ['ini', '', '#'],
  cfg: ['ini', '', '#'], env: ['bash', '', '#'], md: ['markdown', '', ''], tex: ['latex', '', '%'], cmake: ['cmake', '', '#'],
  txt: ['plaintext', '', ''], log: ['plaintext', '', ''], csv: ['plaintext', '', ''],
};
const CODE_NAMES: Record<string, [string, string, string]> = { dockerfile: ['dockerfile', '', '#'], makefile: ['makefile', '', '#'], 'cmakelists.txt': ['cmake', '', '#'] };
export function codeLang(p: string | null | undefined): { hl: string; check: string; comment: string } | null {
  const base = String(p || '').split('/').pop()!.toLowerCase();
  const hit = CODE_NAMES[base] || (base.includes('.') && CODE_EXT[base.split('.').pop()!]);
  return hit ? { hl: hit[0], check: hit[1], comment: hit[2] } : null;
}
// any text kind the editor knows, code or prose: what a double click opens in it
export const isCode = (p: string) => !!codeLang(p);

// a file to edit: host, share, path, and its label as the files tab names it
export type EditorFile = ShowFile;

// tab id -> its editor, host\nshare\npath -> its id
export const editors = new Map<string, { file?: EditorFile }>();
export const codeTabs = new Map<string, string>();
export const codeKey = (f: EditorFile) => `${f.host}\n${f.share}\n${f.path}`;
export const codeName = (f: EditorFile) => f.path.split('/').pop() || f.path;

// a file as the files tab names it: host, then the share's root, then the path
export const fileLabel = (host: string, root: string, rel: string) => filesPath(host, root, rel);

// --- files -----------------------------------------------------------------

// hosts at the top, their published directories beneath, every path relative
// to one of those, anything resolving outside it refused by the frontend

// a place: a host's share, or the merged home (host *)
export interface Loc { host: string; share?: string; root?: string; perms?: string }

// loc is any {host, share}: a pane, a share row, or the pair a transfer holds;
// host * the merged home, a path's call sent to a host holding it
export const filesApi = (loc: Loc, op: string, params?: Record<string, string | number>) => {
  const q = new URLSearchParams({ share: loc.share || '0', ...Object.fromEntries(Object.entries(params || {}).map(([k, v]) => [k, String(v)])) });
  const host = loc.host === '*' ? homePick(String(params?.path || '')) : loc.host;
  return `/api/files/${encodeURIComponent(host)}/${op}?${q}`;
};
export const filesJoin = (a: string, b: string) => (a ? `${a}/${b}` : b);
// host then the share path: razer/phosphorus/files/gondor.jpg
export const filesPath = (host: string, root: string, rel: string) =>
  [host === '*' ? '' : host, ...`${root}/${rel || ''}`.split('/')].filter(Boolean).join('/');
export const filesParent = (p: string) => p.split('/').slice(0, -1).join('/');

// JSON from every call, failures included, one place to surface them
export async function filesCall(loc: Loc, op: 'list', init?: RequestInit, params?: Record<string, string | number>): Promise<FileListing>;
export async function filesCall(loc: Loc, op: 'info', init?: RequestInit, params?: Record<string, string | number>): Promise<FilesInfo>;
export async function filesCall(loc: Loc, op: 'read', init?: RequestInit, params?: Record<string, string | number>): Promise<FileRead>;
export async function filesCall(loc: Loc, op: 'run', init?: RequestInit, params?: Record<string, string | number>): Promise<FileRun>;
export async function filesCall(loc: Loc, op: string, init?: RequestInit, params?: Record<string, string | number>): Promise<any>;
export async function filesCall(loc: Loc, op: string, init?: RequestInit, params?: Record<string, string | number>): Promise<any> {
  if (loc.host === '*') return homeCall(op, init, params);
  const res = await fetch(filesApi(loc, op, params), init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `status ${res.status}`);
  return body;
}

// r browse and download, w upload/new folder/rename, d delete
export const may = (loc: Loc, perm: string) => (loc.perms || '').includes(perm);

// ---- the merged home: usr on every host as one, each entry carrying the
// hosts that hold it, an offline host's left out

export const HOME: Loc = { host: '*', share: 'home', root: 'home', perms: 'rwd' };
export const isHome = (loc: Loc | null | undefined) => !!loc && loc.share === 'home';
export const homeAt = (host: string): Loc => ({ host, share: 'home', root: 'home', perms: 'rwd' });
// path -> hosts holding it, from the last listings
const homeWhere = new Map<string, Set<string>>();

export const homeOnline = () => [...new Set([st.selfHost, ...phosphorusHosts()].filter(Boolean))];
// the desktop reaches every host through its own server
export const hostUrl = (host: string, path: string) => path;
export const otherHosts = (): string[] => [];

// the holder to read a path from: this host first, then any online one
export function homePick(rel: string): string {
  const on = homeOnline();
  const has = [...(homeWhere.get(rel) || [])].filter((h) => on.includes(h));
  return has.includes(st.selfHost) ? st.selfHost : has[0] || st.selfHost;
}
export const homeHolders = (rel: string) => {
  const on = homeOnline();
  const has = [...(homeWhere.get(rel) || [])].filter((h) => on.includes(h));
  return has.length ? has : [st.selfHost];
};

// one host's listing of a home folder, stale and empty when it didn't answer
export interface HomeHostList { h: string; entries: FileEntry[]; stale?: boolean }
export async function homeHostList(h: string, dir: string): Promise<HomeHostList> {
  try {
    const body = await filesCall(homeAt(h), 'list', undefined, { path: dir });
    return { h, entries: body.entries };
  } catch { return { h, entries: [], stale: true }; }
}

// the hosts' listings merged; `got` the listings already in hand, else every online host asked
export async function homeList(dir: string, got?: HomeHostList[]): Promise<FileListing> {
  got ||= await Promise.all(homeOnline().map((h) => homeHostList(h, dir)));
  const by = new Map<string, FileEntry & { hosts: string[]; live: string[] }>();
  for (const { h, entries, stale } of got) {
    for (const e of entries) {
      const m = by.get(e.name) || { ...e, hosts: [], live: [] };
      m.hosts.push(h);
      if (!stale) m.live.push(h);
      m.mtime = Math.max(m.mtime || 0, e.mtime || 0);
      m.all ||= !!e.all;
      m.dir ||= e.dir;
      by.set(e.name, m);
    }
  }
  const entries = [...by.values()].map((m) => ({ ...m, stale: !m.live.length }));
  for (const e of entries) homeWhere.set(filesJoin(dir, e.name), new Set(e.live.length ? e.live : e.hosts));
  if (!got.some((g) => !g.stale)) throw new Error('no host answered');
  return { path: dir, entries };
}

// one call over the merged home: listing merged, new folders made everywhere,
// deletes and renames on every holder, the rest on one
async function homeCall(op: string, init?: RequestInit, params?: Record<string, string | number>): Promise<any> {
  if (op === 'list') return homeList(String(params?.path || ''));
  const body = init?.body ? JSON.parse(init.body as string) : {};
  const rel: string = op === 'rename' ? body.from : body.path ?? params?.path ?? '';
  const hosts = op === 'mkdir' ? homeOnline() : ['delete', 'rename', 'mirror'].includes(op) ? homeHolders(rel) : [homePick(rel)];
  const out = await Promise.allSettled(hosts.map((h) => filesCall(homeAt(h), op, init, params)));
  const ok = out.find((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled');
  if (!ok) throw (out[0] as PromiseRejectedResult).reason;
  if (op === 'delete') homeWhere.delete(rel);
  return ok.value;
}

// where new bytes in the home go: one host, or every host (small files only)
export async function homeTarget(fm: Fm, bytes: number, what: string): Promise<{ host: string; all: boolean } | null> {
  const on = homeOnline();
  const opts: Choice[] = [...on.map((h): Choice => [h === st.selfHost ? `${h} (this host)` : h, h]), ['all hosts', '*', bytes > HOME_ALL_MAX ? 'over 32MB' : '']];
  if (on.length < 2) return { host: st.selfHost, all: false };
  const pick = await filesChoose(fm, { title: 'keep it on', message: what, options: opts });
  if (!pick) return null;
  return pick === '*' ? { host: st.selfHost, all: true } : { host: pick, all: false };
}
const HOME_ALL_MAX = 32 * 1024 * 1024;

// ---- transfer -------------------------------------------------------------

// sent in chunks, each its own XHR, so no request nears a proxy's body cap or
// a phone holds one huge one open, a failed chunk retried alone
const CHUNK = 4 * 1024 * 1024;

export async function putFile(loc: Loc, path: string, body: Blob, onSent?: (sent: number) => void): Promise<Record<string, any>> {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join('');
  const total = body.size;
  let offset = 0;
  let last: Record<string, any> = {};
  do {
    const end = Math.min(offset + CHUNK, total);
    const piece = body.slice(offset, end);
    for (let tries = 1; ; tries++) {
      try {
        last = await putChunk(loc, { path, id, offset, total }, piece, (sent) => onSent && onSent(offset + sent));
        break;
      } catch (err) {
        if (tries >= 4 || (err as FatalError).fatal) throw err;
        await new Promise((r) => setTimeout(r, 1000 * tries));
      }
    }
    offset = end;
    if (onSent) onSent(offset);
  } while (offset < total);
  return last;
}

// a refusal the server means, retrying changes nothing
type FatalError = Error & { fatal?: boolean };

function putChunk(loc: Loc, params: Record<string, string | number>, piece: Blob, onSent: (sent: number) => void): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', filesApi(loc, 'upload', params));
    xhr.timeout = 120000;
    xhr.upload.addEventListener('progress', (e) => onSent(e.loaded));
    xhr.addEventListener('load', () => {
      let body: Record<string, any> = {};
      try { body = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200) { resolve(body); return; }
      const err: FatalError = new Error(body.error || `status ${xhr.status}`);
      // a refusal the server means, retrying changes nothing
      err.fatal = xhr.status >= 400 && xhr.status < 500;
      reject(err);
    });
    xhr.addEventListener('error', () => reject(new Error('upload failed')));
    xhr.addEventListener('timeout', () => reject(new Error('upload timed out')));
    xhr.send(piece);
  });
}

// streamed for a bar that moves on the read too, the body still in memory
// before the write, the cost of no host-to-host copy
async function getFile(loc: Loc, path: string, onGot?: (got: number, size: number) => void): Promise<{ blob: Blob; size: number }> {
  const res = await fetch(filesApi(loc, 'download', { path }));
  if (!res.ok) throw new Error(`couldn't read ${path}`);
  const size = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body) return { blob: await res.blob(), size };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onGot && onGot(got, size);
  }
  return { blob: new Blob(chunks as BlobPart[]), size: got };
}

// no server-side copy between hosts: each file pulled from one share by the
// browser and pushed to the other, the read the first half of the bar
export async function copyFile(from: Loc, fromPath: string, to: Loc, toPath: string, tick: (f: number) => void): Promise<void> {
  const { blob } = await getFile(from, fromPath, (got, size) => tick(size ? (got / size) * 0.5 : 0));
  await putFile(to, toPath, blob, (sent) => tick(0.5 + (blob.size ? (sent / blob.size) * 0.5 : 0.5)));
}

async function copyTree(from: Loc, fromPath: string, to: Loc, toPath: string, tick: (f: number, name?: string) => void): Promise<void> {
  const listing = await filesCall(from, 'list', undefined, { path: fromPath });
  // already there: fine, anything else surfacing on the first child write
  await filesCall(to, 'mkdir', jsonPost({ path: toPath })).catch(() => {});
  for (const e of listing.entries) {
    const src = filesJoin(fromPath, e.name);
    const dst = filesJoin(toPath, e.name);
    if (e.dir) await copyTree(from, src, to, dst, tick);
    else await copyFile(from, src, to, dst, (f) => tick(f, e.name));
  }
}

// --- what the file manager windows and the desktop's files share ---------------------

// a file manager window's state (apps/files.ts makes one per window)
export interface ShareInfo { shares?: Loc[]; error?: string }
export interface PickedItem { rel: string; dir: boolean; name: string }
export interface Fm {
  w: DkWin;
  loc: Loc | null;
  dir: string;
  back: { loc: Loc; dir: string }[];
  fwd: { loc: Loc; dir: string }[];
  entries: FileEntry[];
  shown: FileEntry[];
  sel: Set<string>;
  anchor: string | null;
  sort: { key: string; dir: number };
  mode: string;
  filter: string;
  shares: Map<string, ShareInfo | null>;
  busy: string;
  backBtn: HTMLButtonElement;
  fwdBtn: HTMLButtonElement;
  upBtn: HTMLButtonElement;
  modeBtn: HTMLButtonElement;
  crumbs: HTMLElement;
  find: HTMLInputElement;
  side: HTMLElement;
  main: HTMLElement;
  status: HTMLElement;
  count: HTMLElement;
  note: HTMLElement;
  input: HTMLInputElement;
  cols: [string, string, string | null][];
  renderSide?: () => void;
  sideSig?: string;
  loading?: string;
  error?: string;
  pendingUpload?: File[] | FileList | null;
  noteTimer?: ReturnType<typeof setTimeout>;
  spring?: { node: Element; timer: ReturnType<typeof setTimeout> } | null;
}
// a drop zone's target: a place and a folder in it
export interface DropTarget { loc: Loc; dir: string }
// a choice in a box: label, value, why disabled
export type Choice = [string, string, string?];

export const fmExt = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');

export function fmKind(e: { name: string; dir?: boolean }): string {
  if (e.dir) return 'dir';
  const x = fmExt(e.name);
  for (const k in FM_KINDS) if (FM_KINDS[k]!.includes(x)) return k;
  return isCode(e.name) ? 'code' : 'file';
}

export const fmIcon = (kind: string) => dkGlyph(FM_GLYPHS[kind]!, `fm-${kind}`);

export const fmSame = (a: Loc | null | undefined, b: Loc | null | undefined) => !!a && !!b && a.host === b.host && a.share === b.share;

// every window showing that folder, read again
export function fmChanged(loc: Loc, ...dirs: string[]): void {
  const same = (a: Loc | null) => fmSame(a, loc) || (isHome(a) && isHome(loc));
  for (const fm of dkFms) if (same(fm.loc) && dirs.includes(fm.dir)) appCall('files', false, (m) => m.fmLoad(fm));
  if (isHome(loc) && dkDeskDirs().some((d) => dirs.includes(d))) dkDeskLoad(true);
}

// pages, wasm and NAME.app folders run, text edits, the rest shown
export const runnable = (e: { name: string; dir?: boolean }) => (e.dir ? /\.app$/i.test(e.name) : ['html', 'htm', 'wasm'].includes(fmExt(e.name)));

export function fileOpen(loc: Loc, rel: string, e: FileEntry): unknown {
  if (loc.host === '*' && !(e.dir && !runnable(e))) loc = homeAt(homePick(rel));
  if (runnable(e)) return dkRun(loc, rel);
  if (e.dir) return filesWin({ loc, dir: rel });
  if (isCode(e.name)) return dkCode({ host: loc.host, share: loc.share!, path: rel, label: fileLabel(loc.host, loc.root!, rel) });
  app('files').then((m) => m.dkViewer(loc, rel));
}

// inside one share a move is a rename, anything else bytes through the page,
// a move's source deleted once its copy is whole
export async function fmTransfer(fm: Fm, from: Loc, items: PickedItem[], to: Loc, dir: string, move: boolean): Promise<void> {
  if (!may(to, 'w')) return fmSay(fm, 'read-only', true);
  // into the home, other than a move inside it: where the copies go; every
  // host's a folder copied to each, a file kept in step
  let all = false;
  let alsoTo: Loc[] = [];
  if (to.host === '*' && !(move && fmSame(from, to))) {
    const t = await homeTarget(fm, items.some((it) => it.dir) ? 0 : 1, items.length === 1 ? items[0]!.name : `${items.length} items`);
    if (!t) return;
    all = t.all;
    if (all) alsoTo = homeOnline().filter((h) => h !== t.host).map(homeAt);
    to = homeAt(t.host);
  }
  const label = move ? 'moving' : 'copying';
  let failed = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const dst = filesJoin(dir, it.name);
    if (fmSame(from, to) && (dst === it.rel || `${dir}/`.startsWith(`${it.rel}/`))) {
      if (move || it.dir) { failed += 1; fmSay(fm, 'into itself', true); continue; }
    }
    const tick = (f: number, child?: string) => { fm.busy = 'x'; fmSay(fm, `${label} ${Math.round(f * 100)}%`); };
    try {
      if (move && fmSame(from, to)) {
        await filesCall(to, 'rename', jsonPost({ from: it.rel, to: dst }));
      } else {
        // a copy into its own folder, as a file manager's: "name copy.ext"
        let target = dst;
        if (fmSame(from, to) && filesParent(it.rel) === dir) {
          const x = it.dir ? '' : fmExt(it.name);
          target = filesJoin(dir, x ? `${it.name.slice(0, -x.length - 1)} copy.${x}` : `${it.name} copy`);
        }
        if (it.dir) {
          await copyTree(from, it.rel, to, target, tick);
          for (const other of alsoTo) await copyTree(from, it.rel, other, target, tick);
        } else {
          await copyFile(from, it.rel, to, target, tick);
          if (all) await filesCall(to, 'mirror', jsonPost({ path: target, on: true }));
        }
        if (move) await filesCall(from, 'delete', jsonPost({ path: it.rel }));
      }
    } catch (err) { failed += 1; fm.busy = ''; fmSay(fm, `${it.name}: ${(err as Error).message}`, true); }
  }
  fm.busy = '';
  if (!failed) fmSay(fm, move ? 'moved' : 'copied');
  fmChanged(to, dir);
  if (move) fmChanged(from, ...new Set(items.map((it) => filesParent(it.rel))));
}

export function fmSpring(fm: Fm, node: Element, t: DropTarget): void {
  if (fm.spring?.node === node) return;
  clearTimeout(fm.spring?.timer);
  fm.spring = null;
  if (fmSame(t.loc, fm.loc) && t.dir === fm.dir) return;
  fm.spring = { node, timer: setTimeout(() => { fm.spring = null; node.classList.remove('drop'); app('files').then((m) => m.fmGo(fm, t.loc, t.dir)); }, FM_SPRING_MS) };
}

export function fmUnspring(fm: Fm, node?: Element): void {
  if (node && fm.spring?.node !== node) return;
  clearTimeout(fm.spring?.timer);
  fm.spring = null;
}

// every drop zone's window and target, for the desktop's own icon drags
export const fmZones = new WeakMap<Element, { fm: Fm; where: () => DropTarget | null }>();

export function fmMark(fm: Fm, node: Element | null): void {
  for (const root of [fm.main, fm.side]) root?.querySelectorAll('.drop').forEach((x) => x !== node && x.classList.remove('drop'));
  node?.classList.add('drop');
}

const FM_KINDS: Record<string, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'],
  video: ['mp4', 'webm', 'mkv', 'mov', 'avi'],
  audio: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'opus'],
  archive: ['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'xz', 'bz2', 'zst'],
  pdf: ['pdf'],
};

const FM_GLYPHS: Record<string, string> = {
  dir: 'M1.5 3.5h4l1.2 1.5h7.8v8h-13z',
  file: 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3',
  code: 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3M6.5 8l-1.5 1.5 1.5 1.5M9.5 8l1.5 1.5-1.5 1.5',
  image: 'M2 3h12v10H2zM2 11l3.5-3.5 3 3 2-2 3.5 3.5M10.5 5.5h.01',
  video: 'M2 3.5h12v9H2zM6.5 6v4l3.5-2z',
  audio: 'M6 12.5a1.5 1.5 0 1 1-1.5-1.5H6V3l7-1.5v9a1.5 1.5 0 1 1-1.5-1.5H13',
  archive: 'M3.5 1.5h9v13h-9zM8 1.5v2M8 4.5v1M8 6.5v1M7 8.5h2v2H7z',
  pdf: 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3M5.5 9.5h5M5.5 12h3.5',
  host: ICONS.host!,
};

// every file manager open, for a change one makes shown in the rest
export const dkFms = new Set<Fm>();

// a folder or place held under a drag this long: opened, the drag going on
const FM_SPRING_MS = 700;

export const fmSay = (fm: Fm, text: string, bad?: boolean) => {
  fm.note.textContent = text || '';
  fm.note.classList.toggle('bad', !!bad);
  clearTimeout(fm.noteTimer);
  if (text && !fm.busy) fm.noteTimer = setTimeout(() => { if (fm.note.textContent === text) fm.note.textContent = ''; }, 6000);
};

// the file manager's window and its choices, fetched on first open
export const filesWin = (at?: DropTarget) => app('files').then((m) => m.dkFiles(at));
export const filesChoose = (fm: Fm, ask: { title: string; message: string; options: Choice[] }) => app('files').then((m) => m.dkChoose(fm, ask));
