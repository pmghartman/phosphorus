import {
  DK_RUNNERS,
  HOME,
  acct,
  codeKey,
  codeLang,
  codeTabs,
  copyFile,
  copyText,
  dk,
  dkGlyph,
  dkHomeOn,
  dkLiveHosts,
  editors,
  el,
  filesApi,
  hostUrl,
  otherHosts,
  filesCall,
  filesJoin,
  filesParent,
  filesWin,
  homeAt,
  homeOnline,
  homePick,
  hostsInfo,
  humanSize,
  isMobile,
  jsonPost,
  name,
  newSid,
  putFile,
  selfHost,
  shQuote,
  shareMenu,
  standalone,
} from '../app.js';
import { codeEditor } from './editor.js';
import { createLanguageWorkbench } from '../sulfur/language-workbench.js';
import { startTerminal, taskTerminal, termsRetheme } from './terminal.js';
import { renderMd } from '../md.js';
import { symbolsFor, identifierAt, enclosingSymbol } from '../symbols.js';
import { singleFileCommand, configsFor } from '../sulfur/build-commands.js';
import { cmakeTargets, cmakeConfiguration, targetForFile, executableCommand, absolutePath, joinPath } from '../sulfur/project-targets.js';
import { PALETTES, PALETTE_EVENT, paletteNow, setPalette } from '../theme.js';
import guideText from '../../../docs/sulfur-extensions.md';

// --- sulfur, the code editor ----------------------------------------------------------
// a workbench in one desktop window, laid out and keyed as VS Code is: a folder
// of the user's own home (theirs or shared, nobody else's) its workspace, every
// file in it one of the editor's live sessions on the host holding it, its
// terminals on the hosts this desktop is logged into, its chat the mesh's models
// asked straight through their gateway, its extensions each in a sandboxed frame of its own,
// reaching the workbench only through the messages it answers

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform || '');
const STATE_KEY = () => `phosphorus-sulfur:${acct?.user || ''}`;
// what the same browser kept before the name was Sulfur
const OLD_STATE_KEY = () => `phosphorus-ide:${acct?.user || ''}`;
// where the user's ide keeps what follows them across browsers
const CONF_DIR = () => `${acct.user}/.sulfur`;
const OLD_CONF_DIR = () => `${acct.user}/.ide`;
const EXT_DIR = () => `${CONF_DIR()}/extensions`;
const SETTINGS_PATH = () => `${CONF_DIR()}/settings.json`;
const KEYS_PATH = () => `${CONF_DIR()}/keybindings.json`;
const INDEX_TTL = 30000;
const OUTPUT_MAX = 5000;
const CHAT_KEEP = 200;
// opened as a picture, or refused as bytes the text editor can't hold
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
const BINARY_EXT = new Set(['pdf', 'zip', 'gz', 'tgz', 'xz', 'bz2', 'zst', '7z', 'rar', 'tar', 'jar', 'exe', 'dll', 'so', 'dylib', 'o', 'a',
  'obj', 'lib', 'bin', 'img', 'iso', 'wasm', 'class', 'pyc', 'mp3', 'mp4', 'm4a', 'wav', 'flac', 'ogg', 'mkv', 'mov', 'avi', 'webm',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'psd', 'sqlite', 'db', 'deb', 'rpm', 'dmg', 'msi', 'apk']);

// the workbench's own glyphs, 16 by 16, stroked as the desktop's are
const IC = {
  files: 'M5.5 1.5h5l3 3v8h-8zM10.5 1.5v3h3M3.5 4.5v10h7',
  search: 'M6.75 2a4.75 4.75 0 1 0 0 9.5 4.75 4.75 0 0 0 0-9.5zM10.2 10.2L14 14',
  run: 'M4.5 2.5v11l9-5.5z',
  runSide: 'M3 2.5v10l6.5-5zM12 8.5c1.1 0 2 .9 2 2.2v1.6c0 1.2-.9 2.2-2 2.2s-2-1-2-2.2v-1.6c0-1.3.9-2.2 2-2.2zM10 11.5H8.5M15.5 11.5H14M12 8.5V7',
  ext: 'M1.5 5h4.5v4.5H1.5zM6 9.5h4.5V14H6zM1.5 9.5H6V14H1.5zM9.5 1.5H14V6H9.5z',
  chat: 'M1.5 2.5h9v6.5H5l-2.5 2V9h-1zM10.5 5.5h4v6.5h-1v2l-2.5-2H7V9',
  tools: 'M10.8 1.6a3.4 3.4 0 0 0-3.3 4.5L2 11.6a1.5 1.5 0 0 0 2.1 2.1l5.5-5.5a3.4 3.4 0 0 0 4.5-3.3l-2 2-1.9-.5-.5-1.9z',
  gear: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  user: 'M8 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM2.5 14.5c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5',
  right: 'M6 3.5L10.5 8 6 12.5',
  down: 'M3.5 6L8 10.5 12.5 6',
  up: 'M3.5 10L8 5.5l4.5 4.5',
  left: 'M10 3.5L5.5 8l4.5 4.5',
  close: 'M4 4l8 8M12 4l-8 8',
  newFile: 'M3.5 1.5h5l3 3v4M8.5 1.5v3h3M3.5 1.5v13h5M12 10v5M9.5 12.5h5',
  newFolder: 'M1.5 3h4l1.2 1.5h7.8V8M1.5 3v10h6.5M12 9.5v5M9.5 12h5',
  refresh: 'M13.5 8a5.5 5.5 0 1 1-1.8-4.1M13.5 1.5v3.5h-3.5',
  collapse: 'M4.5 4.5h9v9h-9zM2.5 11.5v-9h9M6.5 9h5',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  plus: 'M8 3v10M3 8h10',
  trash: 'M2.5 4h11M6 4V2.2h4V4M4 4l.7 10h6.6L12 4M6.4 6.5v5M9.6 6.5v5',
  maximize: 'M3.5 10L8 5.5l4.5 4.5',
  restore: 'M3.5 6L8 10.5 12.5 6',
  bell: 'M8 2.2a3.1 3.1 0 0 0-3.1 3.1v2.2L3.4 10.2h9.2L11.1 7.5V5.3A3.1 3.1 0 0 0 8 2.2zM6.6 12.6a1.4 1.4 0 0 0 2.8 0',
  error: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5',
  warning: 'M8 1.8L14.8 13.7H1.2zM8 6v3.6M8 11.6h.01',
  info: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM8 7v4.5M8 4.75h.01',
  check: 'M3 8.5l3 3 7-7',
  remote: 'M1.5 5.5L5 9 1.5 12.5M14.5 3.5L11 7l3.5 3.5',
  terminal: 'M2 3h12v10H2zM4.5 6.5l2 1.5-2 1.5M8 10h3.5',
  folder: 'M1.5 3.5h4l1.2 1.5h7.8v8h-13z',
  folderOpen: 'M1.5 3.5h4l1.2 1.5h6.8v2M1.5 3.5v9h11l2-5.5h-10.5L1.5 12.5',
  file: 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3',
  image: 'M2 2.5h12v11H2zM2 11l3.5-3.5 3 3 2-2 3.5 3.5M10.5 5.5h.01',
  split: 'M1.5 2.5h13v11h-13zM8 2.5v11',
  send: 'M2 8l12-5.5-4 11-2.5-4.5zM7.5 9L14 2.5',
  stop: 'M4 4h8v8H4z',
  spark: 'M8 1.5l1.4 5.1 5.1 1.4-5.1 1.4L8 14.5l-1.4-5.1L1.5 8l5.1-1.4z',
  copy: 'M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3',
  insert: 'M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11',
  lock: 'M4 7.5h8v6H4zM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5',
  host: 'M1.5 2.5h13v4.5h-13zM1.5 9h13v4.5h-13zM4 4.75h1.5M4 11.25h1.5',
  output: 'M2 2.5h12v11H2zM4.5 6h7M4.5 8.5h7M4.5 11h4',
  people: 'M6 2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM1.5 13.5c.4-2.6 2.2-4 4.5-4s4.1 1.4 4.5 4M11 3a2 2 0 0 1 0 4M12.5 9.8c1.2.5 1.9 1.7 2 3.7',
  book: 'M2 2.5h4.5A1.5 1.5 0 0 1 8 4v10a1.5 1.5 0 0 0-1.5-1.5H2zM14 2.5H9.5A1.5 1.5 0 0 0 8 4v10a1.5 1.5 0 0 1 1.5-1.5H14z',
  keyboard: 'M1.5 4h13v8h-13zM4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M4.5 9.5h7',
  preview: 'M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  replaceAll: 'M2 3.5h7M2 6.5h5M9.5 8.5l2.5 2.5 2.5-2.5M12 3v8M2 10.5h5M2 13.5h7',
  replaceOne: 'M2 4.5h7M2 8h5M9.5 9.5l2.5 2.5 2.5-2.5M12 4v8',
  word: 'M2 12.5h12M3.5 5l1.5 5.5L6.5 7l1.5 3.5L9.5 5M11 5.5h2M11 8h2',
  scm: 'M4.5 1.75a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5zM4.5 10.75a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5zM11.5 1.75a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5zM4.5 5.25v5.5M11.5 5.25c0 3.25-7 2-7 5.5',
  branch: 'M5 2.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5zM5 11a1.25 1.25 0 1 0 0 2.5A1.25 1.25 0 0 0 5 11zM11 2.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5zM5 5v6M11 5c0 3-6 1.75-6 6',
  minus: 'M3 8h10',
  home: 'M2 7.5L8 2.5l6 5M3.5 6.5v7h3.5v-4h2v4h3.5v-7',
  drive: 'M1.5 9.5l2-6h9l2 6v3.5h-13zM1.5 9.5h13M11.5 11.25h1',
  undo: 'M3 6.5h7a3 3 0 0 1 0 6H6M5.5 4L3 6.5 5.5 9',
  symbolType: 'M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7zM2.5 4.5L8 8l5.5-3.5M8 8v6.5',
  symbolMethod: 'M2 5l6-3.5L14 5l-6 3.5zM2 8l6 3.5L14 8M2 11l6 3.5L14 11',
  symbolField: 'M8 2l6 6-6 6-6-6zM5 8h6',
};
const icon = (k, cls = '') => dkGlyph(IC[k], `ide-ic ${cls}`);

// a file kind's glyph and hue, by extension, the explorer's and the tabs'
const FILE_HUES = {
  js: 'y', mjs: 'y', cjs: 'y', jsx: 'b', ts: 'b', tsx: 'b', json: 'y', py: 'b', go: 'c', rs: 'o', c: 'b', h: 'p', cpp: 'b',
  cc: 'b', hpp: 'p', java: 'r', rb: 'r', php: 'p', sh: 'g', bash: 'g', zsh: 'g', md: 'b', html: 'o', htm: 'o', css: 'b',
  scss: 'p', yml: 'p', yaml: 'p', toml: 'o', xml: 'o', svg: 'y', lua: 'b', sql: 'p', txt: '', log: '', lock: '', swift: 'o',
  kt: 'p', cs: 'p', zig: 'y', ex: 'p', exs: 'p', hs: 'p', ps1: 'b', dockerfile: 'b', makefile: 'o', r: 'b', dart: 'c',
};
const extOf = (p) => { const b = String(p).split('/').pop().toLowerCase(); return b.includes('.') ? b.split('.').pop() : b; };
function fileIcon(p, dir = false, open = false) {
  if (dir) return icon(open ? 'folderOpen' : 'folder', 'ide-fi ide-fi-dir');
  const x = extOf(p);
  return icon(IMAGE_EXT.has(x) ? 'image' : 'file', `ide-fi ide-hue-${FILE_HUES[x] ?? 'n'}`);
}

// the editor's language names as VS Code says them in its status bar
const LANG_NAMES = {
  javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python', bash: 'Shell Script', c: 'C', cpp: 'C++', go: 'Go',
  rust: 'Rust', java: 'Java', ruby: 'Ruby', lua: 'Lua', csharp: 'C#', kotlin: 'Kotlin', swift: 'Swift', php: 'PHP', r: 'R',
  scala: 'Scala', dart: 'Dart', elixir: 'Elixir', haskell: 'Haskell', julia: 'Julia', nix: 'Nix', powershell: 'PowerShell',
  sql: 'SQL', protobuf: 'Protocol Buffers', css: 'CSS', scss: 'SCSS', xml: 'HTML', json: 'JSON', yaml: 'YAML', ini: 'Ini',
  markdown: 'Markdown', latex: 'LaTeX', cmake: 'CMake', dockerfile: 'Dockerfile', makefile: 'Makefile', plaintext: 'Plain Text',
};

// --- small helpers ------------------------------------------------------------------

const debounce = (fn, ms) => { let t = 0; const f = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; f.cancel = () => clearTimeout(t); return f; };
const baseName = (p) => String(p).split('/').pop() || String(p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function btn(cls, ic, title, onClick) {
  const b = Object.assign(el('button', `ide-btn ${cls}`), { type: 'button', title, ariaLabel: title });
  if (ic) b.append(icon(ic));
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
// a path made safe: no empties, dots or climbs, null for one that climbs
function cleanPath(p) {
  const out = [];
  for (const seg of String(p || '').replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return null;
    out.push(seg);
  }
  return out.join('/');
}
// --- where a workspace lives: the merged home, every host's at once, or a
// folder of one host's own disk published as a share (D:\Projects, /srv/code)
const HOME_LOC = { host: '*', share: 'home' };
// offline in Sulfur's desktop app: this computer's files; a mesh remembered, maybe logged into
const localDesktop = () => standalone?.mode === 'local';
// a mesh API call's path: offline, the remembered mesh's, through the app's own server
const meshApi = (path) => (standalone?.meshUrl ? standalone.meshUrl(path) : path);
// offline with a mesh logged into: its models, agents and Forgejo here too
const meshLinked = () => localDesktop() && !!standalone.meshUser;
// a place on the computer Sulfur's running on, not a mesh machine: offline all of them,
// on a mesh this computer's own folders beside the mesh's
const thisComputer = (l) => !!standalone?.localHost && (isHomeLoc(l) ? localDesktop() : l.host === standalone.localHost);
const meshName = (s = standalone?.server) => String(s || '').replace(/^https?:\/\//, '');
// offline in Sulfur's desktop app: this computer's own file dialogs, as any editor's
// a folder or file picked in the system's dialog, as Sulfur's place and path; null if cancelled
async function nativeOpen(directory, title) {
  const t = I.active;
  const start = !localDesktop() ? '' : t?.rel ? hostPath(selfHost, isHomeLoc(t.loc) ? 'home' : t.loc.share, filesParent(t.rel)) : hostPath(selfHost, isHomeLoc() ? 'home' : locOf().share, I.st.root);
  let abs = null;
  try { abs = await standalone.nativePick({ directory, title, defaultPath: start }); } catch (err) { notify('error', `The ${directory ? 'folder' : 'file'} dialog failed: ${err.message || err}`); return null; }
  if (!abs || !I) return null;
  const at = standalone.locate(abs);
  if (!at) { notify('warning', `${abs} isn't on a drive Sulfur can reach.`); return null; }
  if (!at.rel) { notify('info', `Pick a folder on ${abs}, not the whole drive.`); return null; }
  return { ...at, abs };
}

// where a host's login is given: Sulfur's own Machines when it runs alone, else the desktop's task bar
const loginWhere = () => (standalone ? 'from Run and Build › Machines' : 'from its lock in the desktop’s task bar');
const locOf = () => I?.st.loc || HOME_LOC;
const isHomeLoc = (l = locOf()) => !l || l.host === '*';
const sameLoc = (a, b) => (isHomeLoc(a) && isHomeLoc(b)) || (!!a && !!b && a.host === b.host && String(a.share) === String(b.share));
const locKey = (l = locOf()) => (isHomeLoc(l) ? '*' : `${l.host}:${l.share}`);
// a share as its host publishes it: its folder there and its perms
function shareOf(host, id) {
  return (hostsInfo[String(host || '').toLowerCase()]?.files?.shares || []).find((x) => String(x.id) === String(id)) || null;
}
const isWinPath = (p) => /^[A-Za-z]:[\\/]/.test(p || '');
// the files api's place for a location: the merged home, or one host's share
function apiLoc(l = locOf()) {
  if (isHomeLoc(l)) return HOME;
  const sh = shareOf(l.host, l.share);
  return { host: l.host, share: String(l.share), root: sh?.label || '', perms: sh?.perms || 'rwd' };
}
// a path as the host's own shell names it: its share's folder, then rel
function hostPath(host, shareId, rel) {
  const label = shareOf(host, shareId)?.label || '';
  if (!label) return '';
  const sep = isWinPath(label) ? '\\' : '/';
  const r = String(rel || '').split('/').filter(Boolean).join(sep);
  const base = label.length > 3 ? label.replace(/[\\/]+$/, '') : label;
  return r ? `${base}${base.endsWith(sep) ? '' : sep}${r}` : base;
}
const hostIsWindows = (host) => isWinPath(shareOf(host, 'home')?.label) || /win/i.test(hostsInfo[String(host).toLowerCase()]?.platform || '');
// where a workspace file's session lives: the share's host, or the home's holder
function fileLoc(rel, host, l = locOf()) {
  return isHomeLoc(l) ? { host: host || homePick(rel), share: 'home' } : { host: l.host, share: String(l.share) };
}
// a location's name for people: the home, or host and folder
function locLabel(l = locOf()) {
  if (isHomeLoc(l)) return localDesktop() ? `your home folder on ${selfHost}` : 'home, synced across the mesh';
  return `${l.host} · ${shareOf(l.host, l.share)?.label || `share ${l.share}`}`;
}
// the user's own space and the shared one in the home; in a host's share, anything in it
function inScope(rel, l = locOf()) {
  const c = cleanPath(rel);
  if (c === null || !acct) return false;
  if (!isHomeLoc(l)) return c !== '';
  const top = c.split('/')[0];
  return top === acct.user || top === 'shared';
}
const under = (p, dir) => p === dir || p.startsWith(`${dir}/`);
// the workspace's own name for a path in it
const wsRel = (p) => (under(p, I.st.root) ? p.slice(I.st.root.length + 1) : p);
// the workspace, place and folder, as one key
const wsKey = () => `${locKey()}\n${I.st.root}`;
// VS Code's JSON with comments and trailing commas, as its settings files are
function parseJsonc(text) {
  let out = '';
  let str = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (str) {
      out += c;
      if (c === '\\') { out += text[i + 1] ?? ''; i += 1; } else if (c === '"') str = false;
    } else if (c === '"') { str = true; out += c; }
    else if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; out += '\n'; }
    else if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 1; }
    else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// --- key chords as VS Code writes them ----------------------------------------------

// an event as "ctrl+shift+p", ctrl meaning cmd on a mac
function keyOf(e) {
  let k = e.key;
  if (!k || ['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return '';
  const code = e.code || '';
  if (code.startsWith('Key')) k = code.slice(3).toLowerCase();
  else if (code.startsWith('Digit')) k = code.slice(5);
  else if (code === 'Backquote') k = '`';
  else if (code === 'Slash') k = '/';
  else if (code === 'BracketLeft') k = '[';
  else if (code === 'BracketRight') k = ']';
  else if (code === 'Equal') k = '=';
  else if (code === 'Minus') k = '-';
  else if (code === 'Comma') k = ',';
  else if (code === 'Period') k = '.';
  else if (k === ' ') k = 'space';
  else k = k.toLowerCase().replace(/^arrow/, '');
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  return [mod && 'ctrl', e.shiftKey && 'shift', e.altKey && 'alt', IS_MAC && e.ctrlKey && 'meta', k].filter(Boolean).join('+');
}
const normKey = (k) => String(k).toLowerCase().split(' ').map((part) => {
  const bits = part.split('+').map((b) => (b === 'cmd' ? 'ctrl' : b));
  const key = bits.pop();
  return ['ctrl', 'shift', 'alt', 'meta'].filter((m) => bits.includes(m)).concat(key).join('+');
}).join(' ');
const KEY_SHOW = { ctrl: IS_MAC ? '⌘' : 'Ctrl', shift: IS_MAC ? '⇧' : 'Shift', alt: IS_MAC ? '⌥' : 'Alt', meta: '⌃' };
function keyLabel(k) {
  if (!k) return '';
  return k.split(' ').map((part) => part.split('+').map((b) => KEY_SHOW[b]
    || ({ pagedown: 'PageDown', pageup: 'PageUp', enter: 'Enter', escape: 'Escape', space: 'Space', up: '↑', down: '↓', left: '←', right: '→', delete: 'Delete', backspace: 'Backspace', tab: 'Tab' })[b]
    || (b.length === 1 ? b.toUpperCase() : b.replace(/^f(\d+)$/, 'F$1'))).join(IS_MAC ? '' : '+')).join(' ');
}

// --- the live ide: one at a time, the window's ---------------------------------------

let I = null;

const languages = createLanguageWorkbench({
  el, join: filesJoin, log, pick, input: inputBox,
  error: (e) => notify('error', e.message), notice: (text) => notify('info', text),
  alive: (t) => !!I?.tabs.includes(t),
  hosts: () => dkLiveHosts(),
  url: (host) => new URL(hostUrl(host, `/api/sulfur/languages?host=${encodeURIComponent(host)}`), location.href).href,
  problems: () => I && paintProblemsSoon(),
  async context(t) {
    if (!I || I.active !== t || !sameLoc(t.loc, locOf()) || !under(t.rel, I.st.root)) return null;
    const current = I;
    const workspace = wsKey();
    const project = await detectProject();
    if (I !== current || I.active !== t || wsKey() !== workspace || !project) return null;
    const cfg = buildCfg();
    const share = t.share ?? 'home';
    const rootRel = project.dir;
    const root = hostPath(t.host, share, rootRel);
    const path = hostPath(t.host, share, t.rel);
    if (!root || !path) return null;
    const buildRoot = cfg?.host === t.host && cfg.toolchain ? tasksFor(cfg, project).buildRoot : '';
    const buildDirectory = buildRoot ? absolutePath(buildRoot) ? buildRoot : hostPath(t.host, share, joinPath(rootRel, buildRoot)) : '';
    return { host: t.host, root, rootRel, path, documentRel: t.rel.slice(rootRel.length + 1), loc: t.loc, workspace, configuration: cfg?.configuration || '', buildDirectory, settings: setting('sulfur.languageServerSettings') || {} };
  },
  open(path, context, range) {
    if (!I || context.workspace !== wsKey()) return null;
    return openFile(path, { host: context.host, loc: context.loc, preview: false, line: range.start.line + 1, col: range.start.character + 1 });
  },
  async prepare(path, context) {
    if (!I || context.workspace !== wsKey()) throw new Error('Project changed during rename');
    const tab = openFile(path, { host: context.host, loc: context.loc, preview: false, focus: false });
    if (!tab) throw new Error(`Cannot open ${path}`);
    for (let n = 0; !tab.ed?.ready() && n < 80 && I?.tabs.includes(tab); n++) await sleep(100);
    if (!I?.tabs.includes(tab) || context.workspace !== wsKey() || !tab.ed?.ready() || tab.info?.readOnly) throw new Error(`${path} is not ready or writable`);
    return tab;
  },
});

const DEFAULTS = () => ({
  root: acct.user, tabs: [], active: '', recent: [], recentFolders: [],
  side: { view: 'explorer', w: 260, hidden: false },
  panel: { h: 260, hidden: true, view: 'terminal', max: false },
  aux: { w: 360, hidden: true, agent: '', harness: 'chat', model: 'chimp', perm: 'acceptEdits' },
  expanded: {}, runHost: '', sections: { open: true, tree: true },
  ext: { enabled: {} }, loc: HOME_LOC, build: {},
});

const SETTINGS = {
  'sulfur.languageServerSettings': { def: {}, type: 'object', title: 'Languages: Server Settings', about: 'Language-server settings, keyed by extension id (typescript, python, javascript, java, csharp, php, shell, cpp, hcl, go). Runtime prerequisites and installation are in Extensions.' },
  'editor.fontSize': { def: 13, type: 'number', min: 8, max: 40, title: 'Editor: Font Size', about: 'Controls the font size in pixels.' },
  'editor.enablePreview': { def: true, type: 'boolean', title: 'Workbench › Editor: Enable Preview', about: 'Controls whether a file opened from the explorer is shown as a preview, its tab reused until you edit it or double click.' },
  'explorer.confirmDelete': { def: true, type: 'boolean', title: 'Explorer: Confirm Delete', about: 'Controls whether the explorer asks before deleting a file or folder. A delete here is for good: there is no trash.' },
  'explorer.autoReveal': { def: true, type: 'boolean', title: 'Explorer: Auto Reveal', about: 'Controls whether the explorer reveals and selects the active file.' },
  'search.exclude': { def: 'build, out, bin, obj, target, .vs, .vscode, cmake-build-*, dist, .cache, .gradle, __pycache__, node_modules, .git', type: 'string', title: 'Search: Exclude', about: 'Comma separated folder names or simple globs left out of quick open (Ctrl+P) and Find in Files, as a big project’s build outputs and caches are; the explorer still shows them.' },
  'files.exclude': { def: '.git, node_modules, __pycache__, .DS_Store', type: 'string', title: 'Files: Exclude', about: 'Comma separated names or simple globs (*.o) hidden from the explorer, quick open and search.' },
  'terminal.integrated.fontSize': { def: 13, type: 'number', min: 8, max: 40, title: 'Terminal › Integrated: Font Size', about: 'Controls the font size in pixels of the terminal. New terminals take it.' },
  'window.appearance': { def: 'system', type: 'enum', options: [['system', 'Follow the System'], ['light', 'Light'], ['dark', 'Dark']], title: 'Window: Appearance', about: 'Light or dark, whatever the system is set to, when Sulfur runs on its own. Inside the Phosphorus desktop, the desktop\'s own theme decides.' },
  'workbench.restoreEditors': { def: true, type: 'boolean', title: 'Workbench: Restore Editors', about: 'Controls whether the open editors come back when Sulfur opens again.' },
  'sulfur.runners': { def: {}, type: 'object', title: 'Run: Runners', about: 'Commands that run a file, by extension, over the built-in ones, as {"py": "python3 -u \\"$f\\""}: $f is the file, $o a fresh output path beside it.' },
  'chat.includeActiveFile': { def: true, type: 'boolean', title: 'Chat: Include Active File', about: 'Controls whether the mesh agents see the file you have open, and know "this file" means it.' },
};
const setting = (k) => (I?.settings && k in I.settings ? I.settings[k] : SETTINGS[k]?.def);

// this browser's keeping from before the name was Sulfur, copied once
function migrateLocal() {
  try {
    const old = OLD_STATE_KEY();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || (k !== old && !k.startsWith(`${old}:`))) continue;
      const to = STATE_KEY() + k.slice(old.length);
      if (localStorage.getItem(to) === null) localStorage.setItem(to, localStorage.getItem(k));
      localStorage.removeItem(k);
    }
  } catch {}
}

function loadState() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(STATE_KEY())); } catch {}
  const d = DEFAULTS();
  if (!v || typeof v !== 'object') return d;
  const st = { ...d, ...v, side: { ...d.side, ...v.side }, panel: { ...d.panel, ...v.panel }, aux: { ...d.aux, ...v.aux }, ext: { ...d.ext, ...v.ext }, sections: { ...d.sections, ...v.sections } };
  if (!st.loc || typeof st.loc !== 'object' || (!isHomeLoc(st.loc) && !st.loc.host)) st.loc = HOME_LOC;
  if (!st.build || typeof st.build !== 'object') st.build = {};
  return st;
}
// a tab as it's kept: its path, and where it lives unless the home
const tabKept = (t) => (isHomeLoc(t.loc) ? t.rel : { rel: t.rel, host: t.loc.host, share: t.loc.share });
const keptLoc = (x) => (typeof x === 'string' ? { rel: x, loc: HOME_LOC } : { rel: x?.rel, loc: x?.host ? { host: x.host, share: String(x.share) } : HOME_LOC });
const saveState = debounce(() => {
  if (!I) return;
  const st = I.st;
  st.tabs = I.tabs.filter((t) => t.kind === 'code' || t.kind === 'image').map(tabKept);
  st.active = I.active?.rel ? tabKept(I.active) : '';
  try { localStorage.setItem(STATE_KEY(), JSON.stringify(st)); } catch {}
}, 300);

// --- start and stop -----------------------------------------------------------------

// the window's body made the workbench; open: {dir} a folder, {path} a file
export function ideStart(w, open) {
  if (I) teardown();
  migrateLocal();
  if (standalone) {
    standalone.onHosts = () => { fdHostsSoon(); paintRunView(); paintStatus(); };
    standalone.onMesh = () => { if (I) { refreshRoles(); paintWelcomeSoon(); paintRunView(); paintChat(true); } };
  }
  const st = loadState();
  if (!isHomeLoc(st.loc) && !shareOf(st.loc.host, st.loc.share)) st.loc = HOME_LOC;
  if (!inScope(st.root, st.loc)) { st.loc = HOME_LOC; st.root = acct.user; }
  let cached = {};
  try { cached = JSON.parse(localStorage.getItem(`${STATE_KEY()}:settings`)) || {}; } catch {}
  I = {
    w, st, settings: cached, userKeys: [], tabs: [], active: null, mru: [], closed: [], tree: new Map(), loading: new Map(),
    sel: '', terms: [], term: null, termSeq: 0, output: new Map(), outCh: 'Sulfur', commands: new Map(), keys: new Map(),
    exts: new Map(), runners: new Map(), providers: new Map(), statusItems: new Map(), notes: [], chord: '', chats: new Map(),
    index: null, offs: [], seq: 0,
  };
  build();
  registerCommands();
  applySettings();
  if (standalone) {
    const follow = () => { if (setting('window.appearance') === 'system') applyAppearance(); };
    systemLight.addEventListener('change', follow);
    I.offs.push(() => systemLight.removeEventListener('change', follow));
  }
  if (standalone?.app) setTimeout(() => I && checkUpdate(false), 5000);
  // the color theme phosphorus wide, picked here, in the desktop's account menu or another tab
  const repaint = () => I && applySettings();
  addEventListener(PALETTE_EVENT, repaint);
  I.offs.push(() => removeEventListener(PALETTE_EVENT, repaint));
  for (const [ext, cmd] of Object.entries(DK_RUNNERS)) I.runners.set(ext, { cmd, by: '' });
  log(`started as ${acct.user} on ${selfHost}, workspace ${st.root} in ${locLabel(st.loc)}`);
  setRoot(st.root, true, st.loc);
  if (setting('workbench.restoreEditors')) {
    for (const x of st.tabs.map(keptLoc)) if (x.rel && inScope(x.rel, x.loc)) openFile(x.rel, { preview: false, focus: false, quiet: true, loc: x.loc });
    const a = st.active ? keptLoc(st.active) : null;
    const back = a && I.tabs.find((t) => t.rel === a.rel && sameLoc(t.loc, a.loc));
    if (back) activate(back, false);
  }
  // Sulfur on its own opens ready to work: the welcome when nothing's open
  if (standalone && !I.tabs.length && !open) openWelcome();
  if (standalone?.signedOut) notify('warning', `Your session on ${meshName(standalone.signedOut)} ended. This computer (${selfHost}) is still available.`, { actions: [{ label: 'Log In…', run: () => run('sulfur.mesh.connect') }] });
  paintEditors();
  showSide(st.side.view, !st.side.hidden);
  showPanel(st.panel.view, !st.panel.hidden);
  showAux(!st.aux.hidden);
  loadUserFiles().then(() => I && loadExtensions());
  // the mesh's models looked at now and then, while the chat's in view
  refreshRoles();
  const roles = setInterval(() => { if (I && !I.st.aux.hidden) refreshRoles(); }, 30000);
  I.offs.push(() => clearInterval(roles));
  addEventListener('message', onWebviewMessage);
  I.offs.push(() => removeEventListener('message', onWebviewMessage));
  if (open) openRequest(open);
  // the window up front: the focus in it, so its keys answer at once
  requestAnimationFrame(() => { if (I && w.node.classList.contains('focused') && !I.root.contains(document.activeElement)) focusActive(); });
  return {
    focus: () => focusActive(),
    open: (o) => openRequest(o),
    holdClose: (done) => holdClose(done),
    close: () => teardown(),
  };
}

// o: {dir} or {path}, in the home unless o.loc names a host's share
function openRequest(o) {
  if (!I || !o) return;
  if (o.welcome) { openWelcome(); return; }
  const l = o.loc || HOME_LOC;
  if (o.dir !== undefined) {
    const d = cleanPath(o.dir);
    if (d && inScope(d, l)) setRoot(d, false, l); else notify('warning', `${o.dir} is outside your space`);
  } else if (o.path) {
    const p = cleanPath(o.path);
    if (p && inScope(p, l)) openFile(p, { preview: false, loc: l, host: o.host }); else notify('warning', `${o.path} is outside your space`);
  }
}

// unsaved files asked about once, the window closed by done when settled
function holdClose(done) {
  const dirty = I?.tabs.filter((t) => t.ed?.dirty()) || [];
  if (!dirty.length) return false;
  ask({
    title: dirty.length === 1 ? `Do you want to save the changes you made to ${dirty[0].title}?` : `Do you want to save the changes to ${dirty.length} files?`,
    detail: 'Your changes will be lost if they don’t reach the disk.',
    buttons: [{ label: 'Save All', primary: true, value: 'save' }, { label: 'Don’t Save', value: 'drop' }, { label: 'Cancel', value: '' }],
  }).then(async (v) => {
    if (v === 'save') { await saveAll(); done(); } else if (v === 'drop') done();
  });
  return true;
}

function teardown() {
  if (!I) return;
  languages.reset();
  const was = I;
  I = null;
  for (const off of was.offs) { try { off(); } catch {} }
  for (const t of was.tabs) t.dispose?.();
  for (const t of was.terms) t.h.close();
  for (const x of was.exts.values()) x.frame?.remove();
  was.titleBar.remove();
  was.w.node.classList.remove('ide-win', 'ide-narrow');
  was.root.remove();
  for (const c of was.chats.values()) c.ctrl?.abort();
  for (const S of was.agents?.values() || []) { S.closed = true; try { S.sock?.close(); } catch {} }
}

// --- the layout -----------------------------------------------------------------------
// title bar, activity bar, side bar, editors over the panel, the chat beside, the
// status bar under all; overlays in a layer of their own

function build() {
  const root = Object.assign(el('div', 'ide'), { tabIndex: -1 });
  const layer = el('div', 'ide-layer');
  // the window's own title bar: its menus and the command center, the window's buttons and drag kept
  const title = el('div', 'ide-titlebar');
  const menubar = el('div', 'ide-menubar');
  menubar.setAttribute('role', 'menubar');
  const cc = Object.assign(el('button', 'ide-cc'), { type: 'button' });
  const ccText = el('span', 'ide-cc-text');
  cc.append(icon('search'), ccText);
  cc.addEventListener('click', () => quickOpen(''));
  title.append(menubar, cc);

  const main = el('div', 'ide-main');
  // the activity bar: a view per icon, the manage menus at its foot
  const activity = el('div', 'ide-activity');
  activity.setAttribute('role', 'tablist');
  activity.setAttribute('aria-orientation', 'vertical');
  const actTop = el('div', 'ide-act-top');
  const actFoot = el('div', 'ide-act-foot');
  activity.append(actTop, actFoot);

  const side = el('div', 'ide-side');
  const sideHead = el('div', 'ide-side-head');
  const sideTitle = el('span', 'ide-side-title');
  const sideActs = el('span', 'ide-actions');
  sideHead.append(sideTitle, sideActs);
  const sideBody = el('div', 'ide-side-body');
  side.append(sideHead, sideBody);

  const center = el('div', 'ide-center');
  const editorsPart = el('div', 'ide-editors');
  const tabsRow = el('div', 'ide-tabs-row');
  const tabs = el('div', 'ide-tabs');
  tabs.setAttribute('role', 'tablist');
  const tabActs = el('div', 'ide-actions ide-tab-acts');
  tabsRow.append(tabs, tabActs);
  const crumbs = el('div', 'ide-crumbs');
  const views = el('div', 'ide-views');
  const watermark = el('div', 'ide-watermark');
  editorsPart.append(tabsRow, crumbs, views, watermark);

  const panel = el('div', 'ide-panel');
  const panelHead = el('div', 'ide-panel-head');
  const panelTabs = el('div', 'ide-panel-tabs');
  panelTabs.setAttribute('role', 'tablist');
  const panelActs = el('div', 'ide-actions');
  panelHead.append(panelTabs, panelActs);
  const panelBody = el('div', 'ide-panel-body');
  panel.append(panelHead, panelBody);
  const sashH = el('div', 'ide-sash ide-sash-h');
  center.append(editorsPart, sashH, panel);

  const aux = el('div', 'ide-aux');
  const sashSide = el('div', 'ide-sash ide-sash-v ide-sash-side');
  const sashAux = el('div', 'ide-sash ide-sash-v ide-sash-aux');
  main.append(activity, side, sashSide, center, sashAux, aux);

  const status = el('div', 'ide-status');
  const statusL = el('div', 'ide-status-l');
  const statusR = el('div', 'ide-status-r');
  status.append(statusL, statusR);
  root.append(main, status, layer);
  I.w.body.replaceChildren(root);
  I.w.head.insertBefore(title, I.w.head.querySelector('.dk-btns'));
  I.w.node.classList.add('ide-win');
  Object.assign(I, {
    root, layer, titleBar: title, menubar, cc, ccText, activity, actTop, actFoot, side, sideTitle, sideActs, sideBody, center, editorsPart,
    tabsEl: tabs, tabActs, crumbs, views, watermark, panel, panelTabs, panelActs, panelBody, sashH, aux, sashSide, sashAux,
    statusL, statusR, sideViews: new Map(), panelViews: new Map(), actBtns: new Map(),
  });

  buildMenubar();
  buildActivity();
  buildPanel();
  buildAux();
  buildStatus();
  sash(sashSide, 'x', () => I.st.side.w, (v) => { I.st.side.w = Math.max(170, Math.min(v, root.clientWidth * 0.6)); paintLayout(); });
  sash(sashAux, 'x', () => I.st.aux.w, (v) => { I.st.aux.w = Math.max(240, Math.min(v, root.clientWidth * 0.6)); paintLayout(); }, true);
  sash(sashH, 'y', () => I.st.panel.h, (v) => { I.st.panel.h = Math.max(90, Math.min(v, center.clientHeight - 80)); paintLayout(); }, true);
  // narrow: the side bars over the editors, never squeezing them to nothing
  const ro = new ResizeObserver(() => {
    if (!I) return;
    const was = narrow();
    I.w.node.classList.toggle('ide-narrow', root.clientWidth < 760 || isMobile());
    // gone narrow over an open editor: the drawers start put away
    if (narrow() && !was && I.active) drawersAway();
    else if (narrow() && !was && !I.st.side.hidden && !I.st.aux.hidden) { I.st.aux.hidden = true; paintLayout(); }
  });
  ro.observe(root);
  I.offs.push(() => ro.disconnect());
  // narrow: a tap on the editors or the panel puts the side bars away, as a phone's drawer goes
  center.addEventListener('pointerdown', () => drawersAway());
  root.addEventListener('keydown', onKey, true);
  root.addEventListener('contextmenu', (e) => { if (!e.target.closest('input, textarea, .xterm, .md')) e.preventDefault(); });
  // a tab's unsaved edits held against the page's own close
  const unload = (e) => { if (I?.tabs.some((t) => t.ed?.dirty())) e.preventDefault(); };
  addEventListener('beforeunload', unload);
  I.offs.push(() => removeEventListener('beforeunload', unload));
  // the files looked at again when the window's come back to after a while
  root.addEventListener('pointerdown', () => {
    if (!I) return;
    if (Date.now() - (I.seenAt || Date.now()) > 15000) { refreshTree(); I.index = null; }
    I.seenAt = Date.now();
  }, true);
  paintLayout();
}

const narrow = () => !!I?.w.node.classList.contains('ide-narrow');
// narrow: the drawers put away once the work moves to an editor or the panel
function drawersAway() {
  if (!narrow()) return;
  if (!I.st.side.hidden) showSide(I.st.side.view, false);
  if (!I.st.aux.hidden) showAux(false);
}

function paintLayout() {
  const { st, root } = I;
  root.style.setProperty('--side-w', `${st.side.w}px`);
  root.style.setProperty('--aux-w', `${st.aux.w}px`);
  root.style.setProperty('--panel-h', `${st.panel.h}px`);
  root.classList.toggle('ide-side-off', st.side.hidden);
  root.classList.toggle('ide-panel-off', st.panel.hidden);
  root.classList.toggle('ide-aux-off', st.aux.hidden);
  root.classList.toggle('ide-panel-max', !st.panel.hidden && st.panel.max);
  I.actChat?.classList.toggle('on', !st.aux.hidden);
  saveState();
}

// a drag on a sash: the size it governs, from the far side when from is set
function sash(node, axis, get, set, from = false) {
  node.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    node.setPointerCapture(e.pointerId);
    const start = axis === 'x' ? e.clientX : e.clientY;
    const was = get();
    node.classList.add('on');
    I.root.classList.add('ide-dragging', axis === 'x' ? 'ide-drag-x' : 'ide-drag-y');
    const move = (ev) => {
      const d = (axis === 'x' ? ev.clientX : ev.clientY) - start;
      set(was + (from ? -d : d));
    };
    const up = () => {
      node.removeEventListener('pointermove', move);
      node.classList.remove('on');
      I?.root.classList.remove('ide-dragging', 'ide-drag-x', 'ide-drag-y');
    };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up, { once: true });
    node.addEventListener('pointercancel', up, { once: true });
  });
}

// --- the activity bar and the side bar -------------------------------------------------

const SIDE_VIEWS = [
  { id: 'explorer', title: 'Explorer', ic: 'files', cmd: 'workbench.view.explorer' },
  { id: 'search', title: 'Search', ic: 'search', cmd: 'workbench.action.findInFiles' },
  { id: 'scm', title: 'Source Control', ic: 'scm', cmd: 'workbench.view.scm' },
  { id: 'run', title: 'Run and Build', ic: 'runSide', cmd: 'workbench.view.run' },
  { id: 'extensions', title: 'Extensions', ic: 'ext', cmd: 'workbench.view.extensions' },
];

function buildActivity() {
  for (const v of SIDE_VIEWS) {
    const b = Object.assign(el('button', 'ide-act'), { type: 'button', ariaLabel: v.title });
    b.setAttribute('role', 'tab');
    b.dataset.cmd = v.cmd;
    b.dataset.label = v.title;
    b.append(icon(v.ic));
    b.addEventListener('click', () => {
      if (I.st.side.view === v.id && !I.st.side.hidden) showSide(v.id, false);
      else showSide(v.id, true, true);
    });
    I.actTop.append(b);
    I.actBtns.set(v.id, b);
    const body = el('div', `ide-view ide-view-${v.id}`);
    body.hidden = true;
    I.sideBody.append(body);
    I.sideViews.set(v.id, { ...v, body, acts: [] });
  }
  const chat = Object.assign(el('button', 'ide-act ide-act-chat'), { type: 'button', ariaLabel: 'Chat' });
  chat.dataset.cmd = 'workbench.action.chat.open';
  chat.dataset.label = 'Chat';
  chat.append(icon('chat'));
  chat.addEventListener('click', () => run('workbench.action.toggleAuxiliaryBar'));
  I.actTop.append(chat);
  I.actChat = chat;
  // the gear names who's signed in; Sulfur alone signs in to a mesh from the status bar's remote item
  const manage = Object.assign(el('button', 'ide-act'), { type: 'button', ariaLabel: 'Manage', title: 'Manage' });
  manage.append(icon('gear'));
  manage.addEventListener('click', () => menu(manage, [
    { label: localDesktop() ? `${standalone.meshUser ? `${standalone.meshUser}, ` : ''}on ${selfHost}` : `${acct.user}${acct.admin ? ' (admin)' : ''} on ${selfHost}`, disabled: true },
    '-',
    cmdItem('workbench.action.openSettings', 'Settings'),
    cmdItem('workbench.action.openGlobalKeybindings', 'Keyboard Shortcuts'),
    cmdItem('workbench.action.selectTheme', 'Color Theme'),
  ], { side: 'right', up: true }));
  I.actFoot.append(manage);
  buildExplorer();
  buildSearch();
  buildScm();
  buildRunView();
  buildExtView();
}

// the activity bar's titles, once the keys are known
function paintActivityTitles() {
  for (const b of [...I.actBtns.values(), I.actChat]) {
    const k = keyLabel(keyFor(b.dataset.cmd));
    b.title = k ? `${b.dataset.label} (${k})` : b.dataset.label;
  }
  I.cc.title = `Search files by name (${keyLabel(keyFor('workbench.action.quickOpen'))})`;
}

// a view shown in the side bar, or the side bar hidden; focus moves into it when asked
function showSide(id, on = true, focus = false) {
  if (!I.sideViews.has(id)) id = 'explorer';
  const wasIn = I.side.contains(document.activeElement);
  I.st.side.view = id;
  I.st.side.hidden = !on;
  for (const [k, v] of I.sideViews) {
    v.body.hidden = k !== id;
    I.actBtns.get(k).classList.toggle('on', k === id && on);
    I.actBtns.get(k).setAttribute('aria-selected', String(k === id && on));
  }
  const v = I.sideViews.get(id);
  if (on && narrow()) I.st.aux.hidden = true;
  I.sideTitle.textContent = v.title.toUpperCase();
  I.sideActs.replaceChildren(...v.acts);
  paintLayout();
  if (on) v.onShow?.();
  if (on && focus) (v.focus || (() => v.body.querySelector('input, [tabindex="0"]')?.focus()))();
  if (!on && wasIn) focusActive();
}

// --- the title bar's menus ---------------------------------------------------------------

const MENUS = [
  ['File', () => [
    cmdItem('sulfur.project.new', 'New Project…'), cmdItem('explorer.newFile', 'New File…'), cmdItem('explorer.newFolder', 'New Folder…'), '-',
    cmdItem('workbench.action.files.openFile', 'Open File…'),
    cmdItem('workbench.action.files.openFolder', 'Open Folder…'),
    { label: 'Open Recent', sub: () => recentItems() },
    cmdItem('sulfur.project.transfer', 'Copy or Move Project to…'), cmdItem('sulfur.git.clone', 'Clone Repository…'), '-',
    cmdItem('workbench.action.files.save', 'Save'), cmdItem('workbench.action.files.saveAll', 'Save All'), '-',
    cmdItem('workbench.action.revertFile', 'Revert File'),
    cmdItem('workbench.action.closeActiveEditor', 'Close Editor'), cmdItem('workbench.action.closeAllEditors', 'Close All Editors'), '-',
    ...(standalone?.app ? [cmdItem('sulfur.mesh.connect', standalone.server ? `Connect to ${meshName()}…` : 'Connect to a Phosphorus Mesh…'), '-'] : []),
    cmdItem('sulfur.closeWindow', standalone?.app ? 'Exit' : 'Close Window'),
  ]],
  ['Edit', () => [
    cmdItem('undo', 'Undo'), cmdItem('redo', 'Redo'), '-',
    cmdItem('actions.find', 'Find'), cmdItem('editor.action.startFindReplaceAction', 'Replace'),
    cmdItem('workbench.action.findInFiles', 'Find in Files'), '-',
    cmdItem('editor.action.selectAll', 'Select All'), cmdItem('expandLineSelection', 'Expand Line Selection'),
    cmdItem('editor.action.duplicateSelection', 'Duplicate Selection'),
    { label: 'Line', sub: () => [
      cmdItem('editor.action.commentLine', 'Toggle Line Comment'), '-',
      cmdItem('editor.action.copyLinesUpAction', 'Copy Line Up'), cmdItem('editor.action.copyLinesDownAction', 'Copy Line Down'),
      cmdItem('editor.action.moveLinesUpAction', 'Move Line Up'), cmdItem('editor.action.moveLinesDownAction', 'Move Line Down'),
    ] },
  ]],
  ['View', () => [
    cmdItem('workbench.action.showCommands', 'Command Palette…'), '-',
    cmdItem('workbench.actions.view.problems', 'Problems'), cmdItem('workbench.action.output.toggleOutput', 'Output'), cmdItem('workbench.action.terminal.toggleTerminal', 'Terminal'), '-',
    { label: 'Go', sub: () => [
      cmdItem('workbench.action.gotoLine', 'Go to Line/Column…'), '-',
      cmdItem('workbench.action.nextEditor', 'Next Editor'), cmdItem('workbench.action.previousEditor', 'Previous Editor'), '-',
      cmdItem('editor.action.marker.next', 'Next Problem'), cmdItem('editor.action.marker.prev', 'Previous Problem'),
    ] },
    { label: 'Appearance', sub: () => [
      cmdItem('workbench.action.toggleSidebarVisibility', 'Primary Side Bar', !I.st.side.hidden),
      cmdItem('workbench.action.toggleAuxiliaryBar', 'Chat', !I.st.aux.hidden),
      cmdItem('workbench.action.togglePanel', 'Panel', !I.st.panel.hidden),
      cmdItem('workbench.action.toggleMaximizedPanel', 'Maximized Panel', I.st.panel.max), '-',
      cmdItem('editor.action.fontZoomIn', 'Zoom In'), cmdItem('editor.action.fontZoomOut', 'Zoom Out'), cmdItem('editor.action.fontZoomReset', 'Reset Zoom'),
    ] },
    cmdItem('markdown.showPreview', 'Toggle Markdown Preview'),
  ]],
  ['Go', () => [
    cmdItem('workbench.action.quickOpen', 'Go to File…'), cmdItem('workbench.action.gotoLine', 'Go to Line/Column…'), '-',
    cmdItem('editor.action.revealDefinition', 'Go to Definition'), cmdItem('editor.action.referenceSearch.trigger', 'Find All References'), '-',
    cmdItem('workbench.action.nextEditor', 'Next Editor'), cmdItem('workbench.action.previousEditor', 'Previous Editor'), '-',
    cmdItem('editor.action.marker.next', 'Next Problem'), cmdItem('editor.action.marker.prev', 'Previous Problem'),
  ]],
  ['Run', () => [
    cmdItem('sulfur.build', 'Build'), cmdItem('sulfur.task.run', 'Run Task…'), cmdItem('sulfur.build.select', 'Select Toolchain…'),
    cmdItem('sulfur.build.configuration', 'Select Configuration…'), '-',
    cmdItem('sulfur.run.context', 'Run Active Target'), cmdItem('sulfur.run.start', 'Start Without Debugging'), cmdItem('sulfur.run.startup', 'Select Startup Item…'), '-',
    cmdItem('sulfur.run.file', 'Run Active File'), cmdItem('sulfur.run.fileOn', 'Run Active File On…'),
    cmdItem('workbench.action.terminal.runSelectedText', 'Run Selected Text in Terminal'), '-',
    cmdItem('workbench.action.terminal.new', 'New Terminal'), cmdItem('workbench.action.terminal.newOn', 'New Terminal On…'),
    { label: 'Terminal', sub: () => [
      cmdItem('workbench.action.terminal.clear', 'Clear Terminal'), cmdItem('workbench.action.terminal.rename', 'Rename Terminal…'),
      cmdItem('workbench.action.terminal.kill', 'Kill Terminal'),
    ] }, '-',
    cmdItem('sulfur.selectHost', 'Select Host…'),
  ]],
  ['Help', () => [
    cmdItem('workbench.action.openWalkthrough', 'Welcome'), '-',
    cmdItem('sulfur.extensions.guide', 'Extension Guide'), cmdItem('sulfur.extensions.create', 'Create an Extension…'), '-',
    cmdItem('workbench.action.showOutput', 'Show Log'),
    ...(standalone?.app ? [cmdItem('sulfur.update', 'Check for Updates…')] : []), cmdItem('sulfur.about', 'About'),
  ]],
];

function buildMenubar() {
  const tops = MENUS.map(([label, items]) => {
    const b = Object.assign(el('button', 'ide-menu-top', label), { type: 'button' });
    b.setAttribute('role', 'menuitem');
    b.setAttribute('aria-haspopup', 'true');
    const openIt = (focusFirst = false) => {
      for (const o of tops) o.classList.toggle('on', o === b);
      menu(b, items(), { onClose: () => b.classList.remove('on'), bar: tops, focusFirst });
    };
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (I.menuOpen?.anchor === b) closeMenu(); else openIt();
    });
    b.addEventListener('keydown', (e) => { if (['Enter', ' ', 'ArrowDown'].includes(e.key)) { e.preventDefault(); openIt(true); } });
    // a menu already open: hovering another opens that one instead
    b.addEventListener('pointerenter', () => { if (I.menuOpen?.bar && I.menuOpen.anchor !== b) openIt(); });
    b.openIt = openIt;
    return b;
  });
  // narrow: the menus behind one button, as VS Code's are in a small window
  const burger = Object.assign(el('button', 'ide-menu-top ide-burger'), { type: 'button', title: 'Application Menu', ariaLabel: 'Application Menu' });
  burger.append(dkGlyph('M2.5 4h11M2.5 8h11M2.5 12h11', 'ide-ic'));
  burger.addEventListener('click', () => menu(burger, MENUS.map(([label, items]) => ({ label, sub: items }))));
  I.menubar.replaceChildren(burger, ...tops);
  I.menuTops = tops;
}

// --- the explorer ----------------------------------------------------------------------
// the workspace's folder over the merged home: each listing every online host's
// at once, a file on any of them shown once, its holders on hover

function sectionHead(key, label, acts) {
  const node = Object.assign(el('div', 'ide-sec-head'), { tabIndex: 0 });
  node.setAttribute('role', 'button');
  const chev = el('span', 'ide-chev');
  const title = el('span', 'ide-sec-title', label);
  const actions = el('span', 'ide-actions ide-sec-acts');
  actions.append(...acts);
  node.append(chev, title, actions);
  const paint = () => {
    const open = I.st.sections[key] !== false;
    chev.replaceChildren(icon(open ? 'down' : 'right'));
    node.setAttribute('aria-expanded', String(open));
    node.classList.toggle('closed', !open);
    node.dispatchEvent(new Event('ide-section'));
  };
  const toggle = () => { I.st.sections[key] = I.st.sections[key] === false; paint(); saveState(); };
  node.addEventListener('click', (e) => { if (!e.target.closest('.ide-sec-acts')) toggle(); });
  node.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === node) { e.preventDefault(); toggle(); } });
  return { node, title, paint, open: () => I.st.sections[key] !== false };
}

function buildExplorer() {
  const v = I.sideViews.get('explorer');
  const open = sectionHead('open', 'Open Editors', [
    btn('', 'check', 'Save All', () => run('workbench.action.files.saveAll')),
    btn('', 'close', 'Close All Editors', () => run('workbench.action.closeAllEditors')),
  ]);
  const openList = el('div', 'ide-open-list');
  openList.setAttribute('role', 'listbox');
  const treeHead = sectionHead('tree', '', [
    btn('', 'newFile', 'New File…', () => run('explorer.newFile')),
    btn('', 'newFolder', 'New Folder…', () => run('explorer.newFolder')),
    btn('', 'refresh', 'Refresh Explorer', () => run('workbench.files.action.refreshFilesExplorer')),
    btn('', 'collapse', 'Collapse Folders in Explorer', () => run('workbench.files.action.collapseExplorerFolders')),
  ]);
  const tree = Object.assign(el('div', 'ide-tree'), { tabIndex: 0 });
  tree.setAttribute('role', 'tree');
  tree.setAttribute('aria-label', 'Files Explorer');
  const note = el('div', 'ide-tree-note');
  v.body.append(open.node, openList, treeHead.node, tree, note);
  open.node.addEventListener('ide-section', () => { openList.hidden = !open.open(); });
  treeHead.node.addEventListener('ide-section', () => { tree.hidden = !treeHead.open(); });
  open.paint();
  treeHead.paint();
  I.ex = { open, openList, treeHead, tree, note, edit: null, rows: [] };
  v.focus = () => { tree.focus(); if (!I.sel) selectRow(I.st.root, false); };
  v.acts = [];
  tree.addEventListener('click', (e) => {
    const row = e.target.closest('.ide-row');
    if (!row || row.classList.contains('ide-row-edit')) return;
    const p = row.dataset.path;
    selectRow(p, false);
    if (row.dataset.dir === '1') toggleDir(p);
    else openFile(p, { preview: setting('editor.enablePreview'), host: row.dataset.host || undefined });
  });
  tree.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.ide-row');
    if (row && row.dataset.dir !== '1' && !row.classList.contains('ide-row-edit')) openFile(row.dataset.path, { preview: false });
  });
  tree.addEventListener('keydown', treeKey);
  tree.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const row = e.target.closest('.ide-row');
    if (row?.classList.contains('ide-row-edit')) return;
    const p = row ? row.dataset.path : I.st.root;
    if (row) selectRow(p, false);
    menu({ x: e.clientX, y: e.clientY }, explorerItems(p, row ? row.dataset.dir === '1' : true));
  });
  // a row dragged onto a folder moves there; the computer's files dropped in upload
  tree.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.ide-row');
    if (!row || row.dataset.path === I.st.root) { e.preventDefault(); return; }
    e.dataTransfer.setData('application/x-ide-path', row.dataset.path);
    e.dataTransfer.setData('text/plain', row.dataset.path);
    e.dataTransfer.effectAllowed = 'move';
  });
  const dropDir = (e) => {
    const row = e.target.closest('.ide-row');
    if (!row) return I.st.root;
    return row.dataset.dir === '1' ? row.dataset.path : filesParent(row.dataset.path);
  };
  tree.addEventListener('dragover', (e) => {
    const types = [...e.dataTransfer.types];
    if (!types.includes('application/x-ide-path') && !types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = types.includes('Files') ? 'copy' : 'move';
    const d = dropDir(e);
    for (const r of tree.querySelectorAll('.drop')) r.classList.remove('drop');
    (tree.querySelector(`.ide-row[data-path="${CSS.escape(d)}"]`) || tree).classList.add('drop');
  });
  tree.addEventListener('dragleave', (e) => { if (!tree.contains(e.relatedTarget)) for (const r of [tree, ...tree.querySelectorAll('.drop')]) r.classList.remove('drop'); });
  tree.addEventListener('drop', (e) => {
    e.preventDefault();
    for (const r of [tree, ...tree.querySelectorAll('.drop')]) r.classList.remove('drop');
    const d = dropDir(e);
    const from = e.dataTransfer.getData('application/x-ide-path');
    if (from) moveEntry(from, d);
    else if (e.dataTransfer.files.length) uploadInto(d, [...e.dataTransfer.files]);
  });
}

// the folder the workspace is, its tree read afresh
// l: the place it's in, the workspace's own when left out
function setRoot(dir, first = false, l = locOf()) {
  const d = cleanPath(dir);
  if (!d || !inScope(d, l)) return;
  const st = I.st;
  if (!first && d === st.root && sameLoc(l, st.loc)) { refreshTree(); return; }
  languages.reset();
  st.root = d;
  st.loc = isHomeLoc(l) ? HOME_LOC : { host: l.host, share: String(l.share) };
  const rk = (x) => `${locKey(x.loc || HOME_LOC)}\n${x.root ?? x}`;
  const here = { loc: st.loc, root: d };
  st.recentFolders = [here, ...(st.recentFolders || []).filter((x) => rk(x) !== rk(here))].slice(0, 12);
  I.tree.clear();
  I.expanded = new Set((st.expanded[wsKey()] || st.expanded[d] || []).filter((p) => under(p, d)));
  I.expanded.add(d);
  I.sel = '';
  I.index = null;
  I.ex.treeHead.title.textContent = baseName(d).toUpperCase();
  I.ex.treeHead.title.title = isHomeLoc() ? d : `${st.loc.host}: ${hostPath(st.loc.host, st.loc.share, d)}`;
  I.ccText.textContent = isHomeLoc() ? baseName(d) : `${baseName(d)} · ${st.loc.host}`;
  I.w.head.querySelector('.tab-label').textContent = `${baseName(d)} — Sulfur`;
  loadBuildConfig();
  I.scm = null;
  scmRefreshSoon();
  I.projHas = undefined;
  refreshProjectSoon();
  for (const p of I.expanded) loadDir(p);
  paintTree();
  saveState();
}

const sortEntries = (list) => [...list].sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

const fdHostsSoon = debounce(() => { if (I) { I.fdPaint?.(); paintStatus(); } }, 200);
const scmRefreshSoon = debounce(() => { if (I) scmRefresh(); }, 600);

// the folders quick open and Find in Files never go into: search.exclude and files.exclude together
const searchSkip = () => [setting('search.exclude'), setting('files.exclude')].filter(Boolean).join(',');

// the exclude setting as tests on a name
function excluded() {
  const raw = String(setting('files.exclude') || '');
  if (I.exclude?.raw === raw) return I.exclude.test;
  const res = raw.split(',').map((s) => s.trim()).filter(Boolean)
    .map((g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`));
  const test = (n) => res.some((r) => r.test(n));
  I.exclude = { raw, test };
  return test;
}

function loadDir(dir, force = false) {
  if (!force && I.tree.has(dir)) return Promise.resolve(I.tree.get(dir));
  if (I.loading.has(dir)) return I.loading.get(dir);
  const root = I.st.root;
  const key = wsKey();
  const pr = filesCall(apiLoc(), 'list', undefined, { path: dir }).then((b) => {
    const list = sortEntries(b.entries || []);
    if (I && wsKey() === key) I.tree.set(dir, list);
    if (dir === root && I) I.ex.error = '';
    return list;
  }).catch((err) => {
    if (I && wsKey() === key) {
      if (dir === root) I.ex.error = err.message;
      else if (!I.tree.has(dir)) I.tree.set(dir, []);
    }
    return [];
  }).finally(() => { I?.loading.delete(dir); paintTreeSoon(); });
  I.loading.set(dir, pr);
  paintTreeSoon();
  return pr;
}

// every folder shown read again, an open one gone dropped from the open set
async function refreshTree() {
  if (!I) return;
  const dirs = [...I.expanded].filter((p) => p === I.st.root || I.tree.has(p));
  await Promise.all(dirs.map((d) => loadDir(d, true)));
  if (!I) return;
  for (const p of [...I.expanded]) {
    if (p === I.st.root) continue;
    const parent = I.tree.get(filesParent(p));
    if (parent && !parent.some((e) => e.dir && e.name === baseName(p))) I.expanded.delete(p);
  }
  paintTree();
}

let treeFrame = 0;
function paintTreeSoon() { if (!treeFrame) treeFrame = requestAnimationFrame(() => { treeFrame = 0; if (I) paintTree(); }); }

function paintTree() {
  const { tree, note } = I.ex;
  const skip = excluded();
  const rows = [];
  const edit = I.ex.edit;
  const editRow = (depth) => rows.push(edit.node || editNode(depth));
  const walk = (dir, depth) => {
    if (edit && edit.kind !== 'rename' && edit.dir === dir) editRow(depth);
    const list = I.tree.get(dir);
    if (!list) {
      if (I.loading.has(dir)) rows.push(Object.assign(el('div', 'ide-row ide-row-wait'), { style: `--depth:${depth}` }));
      return;
    }
    for (const e of list) {
      if (skip(e.name)) continue;
      const p = filesJoin(dir, e.name);
      if (edit?.kind === 'rename' && edit.path === p) { editRow(depth); continue; }
      rows.push(treeRow(e, p, depth));
      if (e.dir && I.expanded.has(p)) walk(p, depth + 1);
    }
  };
  walk(I.st.root, 0);
  const root = I.st.root;
  note.replaceChildren();
  if (I.ex.error) {
    note.append(el('p', '', `Can't read ${root}: ${I.ex.error}`));
    const b = Object.assign(el('button', 'ide-button', 'Open Folder'), { type: 'button' });
    b.addEventListener('click', () => run('workbench.action.files.openFolder'));
    note.append(b);
  } else if (I.tree.has(root) && !rows.length) {
    note.append(el('p', '', 'This folder is empty.'));
    const b = Object.assign(el('button', 'ide-button', 'New File'), { type: 'button' });
    b.addEventListener('click', () => run('explorer.newFile'));
    note.append(b);
  }
  tree.replaceChildren(...rows);
  I.ex.rows = rows.filter((r) => r.dataset.path);
  tree.setAttribute('aria-activedescendant', '');
  const sel = I.sel && tree.querySelector(`.ide-row[data-path="${CSS.escape(I.sel)}"]`);
  if (sel) { sel.classList.add('sel'); tree.setAttribute('aria-activedescendant', sel.id); }
  if (edit?.input && document.activeElement !== edit.input && edit.focus) { edit.focus = false; edit.input.focus(); }
  saveExpanded();
}

function saveExpanded() {
  I.st.expanded[wsKey()] = [...I.expanded].filter((p) => p !== I.st.root);
  saveState();
}

function treeRow(e, p, depth) {
  const row = el('div', `ide-row${e.dir ? ' ide-dir' : ''}${e.stale ? ' stale' : ''}`);
  row.id = `ide-r-${(I.seq += 1)}`;
  row.dataset.path = p;
  row.dataset.dir = e.dir ? '1' : '0';
  if (!e.dir && e.live?.length === 1) row.dataset.host = e.live[0];
  else if (!e.dir && !isHomeLoc()) row.dataset.host = locOf().host;
  row.draggable = true;
  row.style.setProperty('--depth', depth);
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-level', String(depth + 1));
  if (e.dir) row.setAttribute('aria-expanded', String(I.expanded.has(p)));
  const holders = isHomeLoc() ? (e.live?.length ? e.live : e.hosts || []) : [locOf().host];
  row.title = `${p}\n${e.all ? 'on every host' : `on ${holders.join(', ')}`}${e.stale ? ' (offline now)' : ''}${e.dir ? '' : ` · ${humanSize(e.size)}`}`;
  for (let i = 0; i < depth; i++) row.append(el('span', 'ide-guide'));
  const open = e.dir && I.expanded.has(p);
  const twist = el('span', 'ide-twist');
  if (e.dir) twist.append(icon(open ? 'down' : 'right'));
  row.append(twist);
  row.append(fileIcon(p, e.dir, open), el('span', 'ide-row-name', e.name));
  const t = !e.dir && I.tabs.find((x) => x.rel === p);
  if (e.all) row.append(el('span', 'ide-deco', 'A'));
  else if (e.stale) row.append(el('span', 'ide-deco ide-deco-off', 'offline'));
  if (t?.info?.errors?.length) { row.classList.add('has-err'); row.append(el('span', 'ide-deco ide-deco-err', String(t.info.errors.length))); }
  if (I.active?.rel === p) row.classList.add('active-file');
  return row;
}

function selectRow(p, reveal = true) {
  I.sel = p;
  const { tree } = I.ex;
  for (const r of tree.querySelectorAll('.ide-row.sel')) r.classList.remove('sel');
  const row = tree.querySelector(`.ide-row[data-path="${CSS.escape(p)}"]`);
  if (row) {
    row.classList.add('sel');
    tree.setAttribute('aria-activedescendant', row.id);
    if (reveal) row.scrollIntoView({ block: 'nearest' });
  }
}

async function toggleDir(p, on) {
  const open = on ?? !I.expanded.has(p);
  if (open) { I.expanded.add(p); paintTree(); await loadDir(p); }
  else { for (const x of [...I.expanded]) if (under(x, p) && x !== I.st.root) I.expanded.delete(x); paintTree(); }
}

// a file's folders opened down to it, it selected
async function revealPath(p) {
  if (!under(p, I.st.root)) return;
  const parts = p.slice(I.st.root.length + 1).split('/');
  let at = I.st.root;
  for (const seg of parts.slice(0, -1)) {
    at = filesJoin(at, seg);
    I.expanded.add(at);
    await loadDir(at);
  }
  if (!I) return;
  paintTree();
  selectRow(p);
}

function treeKey(e) {
  if (e.target !== I.ex.tree) return;
  const rows = I.ex.rows;
  const i = rows.findIndex((r) => r.dataset.path === I.sel);
  const row = rows[i];
  const go = (j) => { const r = rows[Math.max(0, Math.min(rows.length - 1, j))]; if (r) selectRow(r.dataset.path); };
  const k = e.key;
  if (k === 'ArrowDown') { e.preventDefault(); go(i + 1); }
  else if (k === 'ArrowUp') { e.preventDefault(); go(i < 0 ? rows.length - 1 : i - 1); }
  else if (k === 'Home') { e.preventDefault(); go(0); }
  else if (k === 'End') { e.preventDefault(); go(rows.length - 1); }
  else if (k === 'ArrowRight' && row) {
    e.preventDefault();
    if (row.dataset.dir === '1') { if (!I.expanded.has(row.dataset.path)) toggleDir(row.dataset.path, true); else go(i + 1); }
  } else if (k === 'ArrowLeft' && row) {
    e.preventDefault();
    if (row.dataset.dir === '1' && I.expanded.has(row.dataset.path)) toggleDir(row.dataset.path, false);
    else { const up = filesParent(row.dataset.path); if (up && under(up, I.st.root) && up !== I.st.root) selectRow(up); }
  } else if ((k === 'Enter' || k === ' ') && row) {
    e.preventDefault();
    if (row.dataset.dir === '1') toggleDir(row.dataset.path);
    else openFile(row.dataset.path, { preview: k === ' ', focus: k === 'Enter' });
  } else if (k === 'F2' && row) { e.preventDefault(); startEdit('rename', row.dataset.path); }
  else if ((k === 'Delete' || (IS_MAC && k === 'Backspace' && e.metaKey)) && row) { e.preventDefault(); deleteEntry(row.dataset.path); }
}

function explorerItems(p, dir) {
  const isRoot = p === I.st.root;
  const file = !dir;
  const runnable = file && runnerFor(p);
  return [
    file && { label: 'Open', run: () => openFile(p, { preview: false }) },
    dir && { label: 'New File…', run: () => startEdit('file', p) },
    dir && { label: 'New Folder…', run: () => startEdit('folder', p) },
    dir && { label: 'Open in Integrated Terminal', run: () => newTerminal({ cwd: p }) },
    dir && !isRoot && { label: 'Open as Workspace Folder', run: () => setRoot(p) },
    isRoot && { label: 'Build', key: keyFor('sulfur.build'), run: () => run('sulfur.build') },
    isRoot && { label: 'Copy or Move Project to…', run: () => run('sulfur.project.transfer') },
    runnable && { label: `Run on ${runHost() || 'a host'}`, run: () => runFile(p) },
    runnable && { label: 'Run On…', run: () => runFileOn(p) },
    filesWin && { label: localDesktop() ? (standalone.mac ? 'Reveal in Finder' : /Win/.test(navigator.platform) ? 'Reveal in File Explorer' : 'Open Containing Folder') : 'Reveal in Files', run: () => filesWin({ loc: apiLoc(), dir: dir ? p : filesParent(p) }) },
    file && { label: 'Ask the Agent About This File', run: () => { openFile(p, { preview: false }); showAux(true, true); } },
    '-',
    { label: 'Copy Path', key: IS_MAC ? 'alt+ctrl+c' : 'shift+alt+c', run: () => copyPath(p, true) },
    { label: 'Copy Relative Path', run: () => copyPath(p, false) },
    '-',
    !isRoot && { label: 'Rename…', key: 'f2', run: () => startEdit('rename', p) },
    !isRoot && { label: 'Delete Permanently', key: 'delete', run: () => deleteEntry(p) },
  ].filter((x) => x !== false && x !== undefined && x !== '').reduce((out, x) => (x === '-' && (!out.length || out.at(-1) === '-') ? out : [...out, x]), []);
}

// the path as its host's shell sees it, or as the workspace names it
function copyPath(p, abs) {
  const at = fileLoc(p);
  const full = hostPath(at.host, at.share, p);
  const text = abs ? (full || p) : (under(p, I.st.root) ? p.slice(I.st.root.length + 1) || '.' : p);
  copyText(text).then(() => setStatusFlash(`copied ${text}`), () => notify('error', 'The clipboard refused the copy.'));
}

// --- making, renaming, deleting, moving: inline, as VS Code does ---

// the folder a new entry lands in: the selection's, else the workspace's
function targetDir() {
  const row = I.sel && I.ex.tree.querySelector(`.ide-row[data-path="${CSS.escape(I.sel)}"]`);
  if (!row) return I.st.root;
  return row.dataset.dir === '1' ? row.dataset.path : filesParent(row.dataset.path);
}

async function startEdit(kind, at) {
  showSide('explorer', true);
  if (!I.ex.treeHead.open()) I.ex.treeHead.node.click();
  const dir = kind === 'rename' ? filesParent(at) : (at ?? targetDir());
  if (kind !== 'rename' && dir !== I.st.root) { I.expanded.add(dir); await loadDir(dir); }
  if (!I) return;
  I.ex.edit = { kind, dir, path: kind === 'rename' ? at : '', focus: true, node: null, input: null };
  paintTree();
}

function editNode(depth) {
  const edit = I.ex.edit;
  const row = el('div', 'ide-row ide-row-edit');
  row.style.setProperty('--depth', depth);
  for (let i = 0; i < depth; i++) row.append(el('span', 'ide-guide'));
  const old = edit.kind === 'rename' ? baseName(edit.path) : '';
  const isDir = edit.kind === 'folder' || (edit.kind === 'rename' && I.tree.get(edit.dir)?.find((e) => e.name === old)?.dir);
  row.append(el('span', 'ide-twist'), fileIcon(old || (edit.kind === 'file' ? 'x' : ''), isDir));
  const input = Object.assign(el('input', 'ide-input ide-row-input'), { value: old, spellcheck: false, autocomplete: 'off' });
  input.setAttribute('aria-label', edit.kind === 'rename' ? `rename ${old}` : `name of the new ${edit.kind}`);
  const msg = el('div', 'ide-input-msg');
  msg.hidden = true;
  const box = el('span', 'ide-row-box');
  box.append(input, msg);
  row.append(box);
  edit.node = row;
  edit.input = input;
  const check = () => {
    const v = input.value;
    const hit = (I.tree.get(edit.dir) || []).find((e) => e.name === v.split('/')[0]);
    let why = '';
    let warn = false;
    if (!v.trim()) why = 'A file or folder name must be provided.';
    else if (edit.kind === 'rename' && /[\\/]/.test(v)) why = `The name ${v} is not valid as a file or folder name. Please choose a different name.`;
    else if (v.split('/').some((s) => s === '..' || s === '.') || v.includes('\\')) why = `The name ${v} is not valid as a file or folder name. Please choose a different name.`;
    else if (v !== old && hit && !(v.includes('/') && hit.dir)) why = `A file or folder ${v} already exists at this location. Please choose a different name.`;
    else if (v !== v.trim()) { why = 'Leading or trailing whitespace detected in file or folder name.'; warn = true; }
    msg.textContent = why;
    msg.hidden = !why;
    msg.classList.toggle('warn', warn);
    input.classList.toggle('bad', !!why && !warn);
    return !why || warn;
  };
  let done = false;
  const finish = async (keep) => {
    if (done) return;
    if (keep && input.value !== old && !check()) { input.focus(); return; }
    done = true;
    const v = input.value;
    I.ex.edit = null;
    if (!keep || !v.trim() || v === old) { paintTree(); I.ex.tree.focus(); return; }
    paintTree();
    I.ex.tree.focus();
    if (edit.kind === 'rename') await renameEntry(edit.path, filesJoin(edit.dir, v));
    else await createEntry(edit.kind, edit.dir, v);
  };
  input.addEventListener('input', check);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => setTimeout(() => finish(true), 0));
  // the stem picked, its extension left
  queueMicrotask(() => {
    if (old && !isDir && old.lastIndexOf('.') > 0) input.setSelectionRange(0, old.lastIndexOf('.'));
    else input.select();
  });
  return row;
}

// a/b/c.txt made with its folders, as VS Code's explorer does
async function createEntry(kind, dir, typed) {
  const parts = typed.split('/').filter(Boolean);
  const leaf = parts.pop();
  let at = dir;
  try {
    for (const seg of parts) {
      at = filesJoin(at, seg);
      await filesCall(apiLoc(), 'mkdir', jsonPost({ path: at })).catch(() => {});
      I.expanded.add(at);
    }
    const rel = filesJoin(at, leaf);
    if (kind === 'folder') {
      await filesCall(apiLoc(), 'mkdir', jsonPost({ path: rel }));
      I.expanded.add(rel);
    } else {
      await putFile(isHomeLoc() ? homeAt(homePick(at)) : apiLoc(), rel, new Blob([]));
    }
    if (!I) return;
    await Promise.all([dir, ...parts.map((_, i) => filesJoin(dir, parts.slice(0, i + 1).join('/')))].map((d) => loadDir(d, true)));
    if (!I) return;
    I.index = null;
    selectRow(rel);
    if (kind === 'file') openFile(rel, { preview: false });
  } catch (err) {
    notify('error', `Unable to create ${kind === 'folder' ? 'folder' : 'file'} '${typed}': ${err.message}`);
  }
}

// the tabs under a path saved first, then moved with it
async function renameEntry(from, to) {
  if (from === to) return;
  const moving = I.tabs.filter((t) => t.rel && sameLoc(t.loc, locOf()) && under(t.rel, from));
  await Promise.all(moving.filter((t) => t.ed?.dirty()).map((t) => saveTab(t)));
  try {
    await filesCall(apiLoc(), 'rename', jsonPost({ from, to }));
  } catch (err) {
    notify('error', `Unable to rename '${baseName(from)}': ${err.message}`);
    return;
  }
  if (!I) return;
  for (const p of [...I.expanded]) if (under(p, from)) { I.expanded.delete(p); I.expanded.add(to + p.slice(from.length)); }
  const wasActive = I.active;
  for (const t of moving) {
    const next = to + t.rel.slice(from.length);
    const sel = t.ed?.selection();
    const i = I.tabs.indexOf(t);
    closeTab(t, true);
    const n = openFile(next, { preview: false, focus: false, index: i });
    if (n && sel) n.pendingSel = sel;
    if (t === wasActive && n) activate(n, false);
  }
  await Promise.all([loadDir(filesParent(from), true), loadDir(filesParent(to), true)]);
  I.index = null;
  selectRow(to);
}

async function deleteEntry(p) {
  if (p === I.st.root) return;
  const e = I.tree.get(filesParent(p))?.find((x) => x.name === baseName(p));
  if (setting('explorer.confirmDelete')) {
    const ok = await ask({
      title: `Are you sure you want to permanently delete '${baseName(p)}'${e?.dir ? ' and its contents' : ''}?`,
      detail: isHomeLoc()
        ? `It goes from every host holding it${e?.hosts?.length ? ` (${e.hosts.join(', ')})` : ''}. This action is irreversible: phosphorus keeps no trash.`
        : `It goes from ${locOf().host}'s disk. This action is irreversible: phosphorus keeps no trash.`,
      buttons: [{ label: 'Delete', primary: true, danger: true, value: 'y' }, { label: 'Cancel', value: '' }],
      check: { label: 'Do not ask me again', key: 'explorer.confirmDelete' },
    });
    if (ok !== 'y') return;
  }
  try {
    await filesCall(apiLoc(), 'delete', jsonPost({ path: p }));
  } catch (err) {
    notify('error', `Unable to delete '${baseName(p)}': ${err.message}`);
    return;
  }
  if (!I) return;
  for (const t of I.tabs.filter((x) => x.rel && sameLoc(x.loc, locOf()) && under(x.rel, p))) closeTab(t, true);
  for (const x of [...I.expanded]) if (under(x, p)) I.expanded.delete(x);
  const rows = I.ex.rows;
  const i = rows.findIndex((r) => r.dataset.path === p);
  const next = rows[i + 1] && !under(rows[i + 1].dataset.path, p) ? rows[i + 1] : rows[i - 1];
  await loadDir(filesParent(p), true);
  I.index = null;
  if (next) selectRow(next.dataset.path);
}

async function moveEntry(from, dir) {
  const to = filesJoin(dir, baseName(from));
  if (from === to || under(dir, from) || filesParent(from) === dir) return;
  if ((I.tree.get(dir) || []).some((e) => e.name === baseName(from))) {
    notify('warning', `A file or folder '${baseName(from)}' already exists in '${baseName(dir)}'.`);
    return;
  }
  const ok = await ask({
    title: `Are you sure you want to move '${baseName(from)}' into '${baseName(dir)}'?`,
    buttons: [{ label: 'Move', primary: true, value: 'y' }, { label: 'Cancel', value: '' }],
  });
  if (ok === 'y') await renameEntry(from, to);
}

async function uploadInto(dir, list) {
  const host = isHomeLoc() ? homePick(dir) : locOf().host;
  const to = isHomeLoc() ? homeAt(host) : apiLoc();
  const note = notify('info', `Uploading ${list.length === 1 ? list[0].name : `${list.length} files`} to ${host}…`, { progress: true, sticky: true });
  let n = 0;
  for (const f of list) {
    try {
      await putFile(to, filesJoin(dir, f.name), f, (sent) => note.progress?.((n + (f.size ? sent / f.size : 1)) / list.length));
    } catch (err) { notify('error', `${f.name}: ${err.message}`); }
    n += 1;
  }
  note.close();
  if (!I) return;
  await loadDir(dir, true);
  I.index = null;
}

// --- open editors, in the explorer's first section ---

function paintOpenEditors() {
  const list = I.ex.openList;
  list.replaceChildren(...I.tabs.map((t) => {
    const row = Object.assign(el('div', `ide-open${t === I.active ? ' on' : ''}${t.info?.dirty ? ' dirty' : ''}${t.preview ? ' preview' : ''}`), { title: t.rel || t.title });
    row.setAttribute('role', 'option');
    const x = btn('ide-open-x', 'close', 'Close', (e) => { e.stopPropagation(); closeTab(t); });
    row.append(x, t.rel ? fileIcon(t.rel) : icon(t.ic || 'file', 'ide-fi'), el('span', 'ide-open-name', t.title));
    if (t.rel) row.append(el('span', 'ide-open-dir', filesParent(t.rel).slice(I.st.root.length + 1) || (under(t.rel, I.st.root) ? '' : filesParent(t.rel))));
    row.addEventListener('click', () => activate(t));
    row.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(t); });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); menu({ x: e.clientX, y: e.clientY }, tabItems(t)); });
    return row;
  }));
  I.ex.open.title.textContent = 'Open Editors';
  const dirty = I.tabs.filter((t) => t.info?.dirty).length;
  I.ex.open.node.querySelector('.ide-sec-count')?.remove();
  if (dirty) I.ex.open.title.after(el('span', 'ide-sec-count', `${dirty} unsaved`));
}

// --- editors: one group of tabs, a file's tab its live session ---------------------------

let edSeq = 0;
// line and column (1-based) as an offset into text
function offsetOf(text, line, col = 1) {
  let at = 0;
  for (let n = 1; n < line; n++) {
    const i = text.indexOf('\n', at);
    if (i < 0) return text.length;
    at = i + 1;
  }
  const end = text.indexOf('\n', at);
  return Math.min(at + Math.max(0, col - 1), end < 0 ? text.length : end);
}

// o: preview, focus, host, line, col, select [from, to], index, quiet, loc (the
// workspace's place when left out)
function openFile(rel, o = {}) {
  const p = cleanPath(rel);
  const l = o.loc || locOf();
  if (!p || !inScope(p, l)) { if (!o.quiet) notify('warning', `${rel} is outside your space`); return null; }
  let t = I.tabs.find((x) => x.rel === p && sameLoc(x.loc, l));
  if (t) {
    if (o.preview === false) pin(t);
    activate(t, o.focus !== false);
    placeCaret(t, o);
    return t;
  }
  const preview = o.preview ?? false;
  let index = o.index ?? (I.active ? I.tabs.indexOf(I.active) + 1 : I.tabs.length);
  if (preview) {
    const old = I.tabs.find((x) => x.preview);
    if (old && !old.info?.dirty) { index = I.tabs.indexOf(old); closeTab(old, true, false); }
  }
  const x = extOf(p);
  const kind = IMAGE_EXT.has(x) ? 'image' : BINARY_EXT.has(x) && !o.anyway ? 'binary' : 'code';
  const known = !isHomeLoc(l) ? l.host : o.host && homeOnline().includes(o.host) ? o.host : '';
  const fl = fileLoc(p, known, l);
  t = addTab({ kind, rel: p, host: known || fl.host, share: fl.share, loc: isHomeLoc(l) ? HOME_LOC : { host: l.host, share: String(l.share) }, title: baseName(p), preview }, index);
  // the session opened on a host holding the file: one named, else the folder
  // listed first, so a file only elsewhere never opens empty here
  if (known) mountKind(t);
  else {
    t.view.append(el('div', 'ide-loading', 'opening…'));
    holdersOf(p, l).then((hs) => {
      if (!I || !I.tabs.includes(t)) return;
      t.host = hs.includes(selfHost) ? selfHost : hs[0] || homePick(p);
      t.view.replaceChildren();
      mountKind(t);
      paintEditors();
      if (t === I.active) {
        t.ed?.show();
        if (t.wantFocus && (document.activeElement === I.root || !I.root.contains(document.activeElement))) focusTab(t);
      }
    });
  }
  t.wantFocus = o.focus !== false;
  placeCaret(t, o);
  emit('open', { path: p });
  const kept = isHomeLoc(l) ? p : { rel: p, host: l.host, share: String(l.share) };
  const same = (x) => { const y = keptLoc(x); return y.rel === p && sameLoc(y.loc, l); };
  I.st.recent = [kept, ...I.st.recent.filter((r) => !same(r))].slice(0, 30);
  I.closed = I.closed.filter((r) => !same(r));
  if (o.focus !== false || !I.active) activate(t, o.focus !== false);
  else paintEditors();
  saveState();
  return t;
}

// a page of the workbench's own (settings, welcome, a guide) in a tab, one per key
function openPage(key, title, ic, mount) {
  let t = I.tabs.find((x) => x.page === key);
  if (!t) {
    t = addTab({ kind: 'page', page: key, title, ic }, I.active ? I.tabs.indexOf(I.active) + 1 : I.tabs.length);
    t.view.classList.add('ide-page');
    t.view.tabIndex = -1;
    mount(t);
  }
  activate(t);
  return t;
}

function addTab(t, index) {
  t.id = `ide-tab-${(edSeq += 1)}`;
  t.view = el('div', 'ide-view-ed');
  t.view.hidden = true;
  t.view.id = `${t.id}-view`;
  t.view.setAttribute('role', 'tabpanel');
  const tab = Object.assign(el('div', 'ide-tab'), { draggable: true, id: t.id, tabIndex: -1 });
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-controls', t.view.id);
  const label = el('span', 'ide-tab-label', t.title);
  const desc = el('span', 'ide-tab-desc');
  const x = btn('ide-tab-x', 'close', `Close (${keyLabel(keyFor('workbench.action.closeActiveEditor'))})`, (e) => { e.stopPropagation(); closeTab(t); });
  tab.append(t.rel ? fileIcon(t.rel) : icon(t.ic || 'file', 'ide-fi'), label, desc, x);
  tab.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  tab.addEventListener('click', () => activate(t));
  tab.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(t); });
  tab.addEventListener('dblclick', () => pin(t));
  tab.addEventListener('contextmenu', (e) => { e.preventDefault(); menu({ x: e.clientX, y: e.clientY }, tabItems(t)); });
  tab.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-ide-tab', t.id); e.dataTransfer.effectAllowed = 'move'; });
  tab.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('application/x-ide-tab')) return;
    e.preventDefault();
    const r = tab.getBoundingClientRect();
    tab.classList.toggle('drop-l', e.clientX < r.left + r.width / 2);
    tab.classList.toggle('drop-r', e.clientX >= r.left + r.width / 2);
  });
  tab.addEventListener('dragleave', () => tab.classList.remove('drop-l', 'drop-r'));
  tab.addEventListener('drop', (e) => {
    e.preventDefault();
    const after = tab.classList.contains('drop-r');
    tab.classList.remove('drop-l', 'drop-r');
    const moving = I.tabs.find((y) => y.id === e.dataTransfer.getData('application/x-ide-tab'));
    if (!moving || moving === t) return;
    I.tabs.splice(I.tabs.indexOf(moving), 1);
    I.tabs.splice(I.tabs.indexOf(t) + (after ? 1 : 0), 0, moving);
    paintEditors();
    saveState();
  });
  Object.assign(t, { tabEl: tab, labelEl: label, descEl: desc, info: null });
  I.tabs.splice(Math.max(0, Math.min(index, I.tabs.length)), 0, t);
  I.views.append(t.view);
  return t;
}

function mountKind(t) {
  if (t.kind === 'code') mountCode(t);
  else if (t.kind === 'image') mountImage(t);
  else mountBinary(t);
}

function mountCode(t) {
  const share = t.share ?? 'home';
  const file = { host: t.host, share, path: t.rel, label: `${t.host}/${share === 'home' ? 'home' : shareOf(t.host, share)?.label || share}/${t.rel}` };
  t.edId = `ide-code-${(edSeq += 1)}`;
  t.ed = codeEditor(t.view, file, null, t.edId, { bare: true, onState: (info) => tabState(t, info) });
  editors.set(t.edId, t.ed);
  codeTabs.set(codeKey(file), t.edId);
  t.dispose = () => t.ed.close();
  languages.attach(t);
  mountSymbolNavigation(t);
  t.view.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.code-ta')) return;
    e.preventDefault();
    activate(t, false);
    menu({ x: e.clientX, y: e.clientY }, [
      cmdItem('editor.action.revealDefinition', 'Go to Definition'),
      cmdItem('editor.action.referenceSearch.trigger', 'Find All References'),
      cmdItem('editor.action.rename', 'Rename…'), '-',
      { label: 'Cut', key: 'ctrl+x', disabled: t.info?.readOnly || !t.info?.sel, run: () => editorClipboard(t, 'cut') },
      { label: 'Copy', key: 'ctrl+c', disabled: !t.info?.sel, run: () => editorClipboard(t, 'copy') },
      { label: 'Paste', key: 'ctrl+v', disabled: t.info?.readOnly, run: () => editorClipboard(t, 'paste') }, '-',
      cmdItem('editor.action.selectAll', 'Select All'),
      cmdItem('editor.action.commentLine', 'Toggle Line Comment'),
    ]);
  });
  t.view.addEventListener('click', (e) => {
    if (!(IS_MAC ? e.metaKey : e.ctrlKey) || !e.target.closest('.code-ta')) return;
    e.preventDefault();
    activate(t, false);
    goToDefinition(t).catch((err) => notify('error', err.message));
  });
}

function mountSymbolNavigation(t) {
  const nav = el('div', 'ide-symbol-nav');
  nav.setAttribute('aria-label', 'Code navigation');
  const control = (label, glyph) => {
    const b = Object.assign(el('button', 'ide-symbol-picker'), { type: 'button', ariaLabel: label });
    b.setAttribute('aria-haspopup', 'menu');
    b.append(icon(glyph, 'ide-symbol-icon'), el('span', 'ide-symbol-label', label), icon('down', 'ide-symbol-chevron'));
    return b;
  };
  const types = control('Types', 'symbolType');
  const members = control('Methods and fields', 'symbolMethod');
  nav.append(types, members);
  t.view.prepend(nav);
  t.symbolNav = { nav, types, members };
  for (const b of [types, members]) b.addEventListener('click', () => {
    const items = b.symbolItems || [];
    menu(b, items.length ? items.map((s) => ({ label: s.name, detail: `${s.kind} · line ${t.ed.text().slice(0, s.from).split('\n').length}`, ic: s.kind === 'type' ? 'symbolType' : s.kind === 'field' ? 'symbolField' : 'symbolMethod', checked: s === b.currentSymbol, run: () => t.ed.select(s.from, s.to) })) : [{ label: 'No symbols in this scope', disabled: true }], { search: items.length > 12 });
  });
}

async function tabSymbols(t) {
  const text = t.ed.text();
  if (t.symbolText === text && t.symbolPromise) return t.symbolPromise;
  t.symbolText = text;
  const lang = codeLang(t.rel);
  t.symbolPromise = text.length > 2 * 1024 * 1024 ? Promise.resolve({ symbols: [], tokens: [] }) : symbolsFor(text, lang?.check, lang?.hl);
  const data = await t.symbolPromise;
  if (t.ed.text() === text) t.symbols = data;
  return data;
}

const paintSymbolNavSoon = debounce(() => { if (I?.active?.ed) paintSymbolNav(I.active); }, 180);
async function paintSymbolNav(t) {
  if (!t.info?.ready || !t.symbolNav) return;
  const data = await tabSymbols(t);
  if (!I || I.active !== t || t.symbolText !== t.ed.text()) return;
  const pos = t.ed.selection()[1];
  const type = enclosingSymbol(data.symbols, pos, 'type');
  const member = enclosingSymbol(data.symbols, pos);
  const fill = (select, items, prompt, selected) => {
    select.symbolItems = items;
    select.currentSymbol = items.includes(selected) ? selected : null;
    select.querySelector('.ide-symbol-label').textContent = select.currentSymbol?.name || prompt;
    select.title = select.currentSymbol ? `${select.currentSymbol.kind}: ${select.currentSymbol.name}` : prompt;
  };
  fill(t.symbolNav.types, data.symbols.filter((s) => s.kind === 'type'), '(Global scope)', type);
  const members = data.symbols.filter((s) => s.kind !== 'type' && (!s.owner || s.owner.kind === 'type') && (!type || s.owner === type));
  fill(t.symbolNav.members, members, 'Methods and fields', member);
  t.symbolNav.nav.title = t.ed.text().length > 2 * 1024 * 1024 ? 'Symbol navigation is limited to files up to 2 MB' : 'Types, methods and fields in this file';
}

async function editorClipboard(t, action) {
  const [from, to] = t.ed.selection();
  try {
    if (action === 'paste') t.ed.edit(from, to, await navigator.clipboard.readText());
    else { await copyText(t.ed.text().slice(from, to)); if (action === 'cut') t.ed.edit(from, to, ''); }
  } catch (err) { notify('error', `Clipboard: ${err.message}`); }
}

async function symbolDocuments(t, word, root = I.st.root) {
  const state = I;
  const key = wsKey();
  const loc = locOf();
  // Fetch matching files only, using the existing server search. Parse their
  // complete text so comments, strings and partial names are excluded.
  const places = isHomeLoc(loc) ? homeOnline().map((h) => [h, homeAt(h)]) : [[loc.host, apiLoc(loc)]];
  const found = await Promise.all(places.map(async ([host, at]) => ({ host, body: await filesCall(at, 'search', undefined, { path: root, query: word, content: 'true', skip: searchSkip() }) })));
  if (I !== state || wsKey() !== key) return null;
  const candidates = new Map();
  for (const { host, body } of found) for (const r of body.results || []) candidates.set(r.path, host);
  for (const tab of I.tabs) if (tab.ed && sameLoc(tab.loc, loc) && under(tab.rel, root)) candidates.set(tab.rel, tab.host);
  const docs = [];
  for (const [path, host] of candidates) {
    if (I !== state || wsKey() !== key) return null;
    const tab = I.tabs.find((x) => x.rel === path && sameLoc(x.loc, loc) && x.ed);
    const text = tab ? tab.ed.text() : await filesCall(isHomeLoc(loc) ? homeAt(host) : apiLoc(loc), 'read', undefined, { path }).then((b) => typeof b.text === 'string' ? b.text : null, () => null);
    if (text === null || text.length > 2 * 1024 * 1024) continue;
    const lang = codeLang(path);
    const data = tab ? await tabSymbols(tab) : await symbolsFor(text, lang?.check, lang?.hl);
    docs.push({ path, host, loc, text, tab, ...data });
  }
  if (I !== state || wsKey() !== key) return null;
  return { docs, truncated: found.some((x) => x.body.truncated) };
}

async function goToDefinition(t = I.active) {
  if (t?.ed && await languages.navigate(t)) return;
  const state = I;
  const workspace = wsKey();
  const current = () => I === state && I.active === t && wsKey() === workspace;
  const word = t?.ed && identifierAt(t.ed.text(), t.ed.selection()[0]);
  if (!word) return;
  const local = await tabSymbols(t);
  if (!current()) return;
  const defs = local.symbols.filter((s) => s.name === word.name && !s.declarationOnly);
  const pos = word.from;
  const scoped = defs.filter((s) => !s.owner || (s.owner.start <= pos && pos <= s.owner.end));
  const closest = scoped.length === 1 ? scoped[0] : scoped.find((s) => s.owner && s.owner === enclosingSymbol(local.symbols, pos));
  if (closest) { t.ed.select(closest.from, closest.to); return; }
  const project = await detectProject();
  if (!current()) return;
  const result = await symbolDocuments(t, word.name, project?.kinds.length ? project.dir : I.st.root);
  if (!result || !current()) return;
  const candidates = result.docs.flatMap((d) => d.symbols.filter((s) => s.name === word.name && (d.tab === t || s.owner?.kind !== 'method')).map((s) => ({ ...s, doc: d })));
  const definitions = candidates.filter((s) => !s.declarationOnly);
  const hits = definitions.length ? definitions : candidates;
  if (!hits.length) { notify('info', `No declaration found for ${word.name}${result.truncated ? ' in the searched files (search was truncated)' : ''}.`); return; }
  const hit = hits.length === 1 ? hits[0] : await pick(hits.map((s) => ({ label: `${s.name} · ${s.kind}`, description: s.doc.path, value: s })), { title: `Definitions of ${word.name}` });
  if (hit && current()) openFile(hit.doc.path, { host: hit.doc.host, loc: hit.doc.loc, select: [hit.from, hit.to], preview: false });
}

async function findReferences(t = I.active) {
  if (t?.ed && await languages.navigate(t, true)) return;
  const word = t?.ed && identifierAt(t.ed.text(), t.ed.selection()[0]);
  if (!word) return;
  const result = await symbolDocuments(t, word.name);
  if (!result || !I) return;
  const hits = result.docs.flatMap((d) => d.tokens.filter((s) => s.name === word.name).map((s) => ({ ...s, doc: d })));
  const hit = await pick(hits.map((s) => ({ label: `${baseName(s.doc.path)}:${s.doc.text.slice(0, s.from).split('\n').length}`, description: s.doc.path, value: s })),
    { title: `${word.name}: ${hits.length} identifier matches${result.truncated ? ' (search truncated)' : ''}`, placeholder: 'Syntax matches across the workspace; names can refer to different symbols', matchDescription: true });
  if (hit && I) openFile(hit.doc.path, { host: hit.doc.host, loc: hit.doc.loc, select: [hit.from, hit.to], preview: false });
}

async function renameSymbol(t = I.active) {
  if (t?.ed && await languages.rename(t)) return;
  const word = t?.ed && identifierAt(t.ed.text(), t.ed.selection()[0]);
  if (!word || t.info?.readOnly) return;
  const value = await inputBox({ title: `Rename ${word.name}`, value: word.name, prompt: 'Preview matching identifiers across the workspace.', validate: (s) => /^[$\p{L}_][$\p{L}\p{N}_]*$/u.test(s) ? '' : 'Enter an identifier' });
  if (!I || !value || value === word.name) return;
  const result = await symbolDocuments(t, word.name);
  if (!result || !I) return;
  if (result.truncated) { notify('warning', 'The workspace search was truncated. Narrow the open folder before renaming.'); return; }
  const docs = result.docs.map((d) => ({ ...d, hits: d.tokens.filter((s) => s.name === word.name) })).filter((d) => d.hits.length);
  if (!docs.length) { notify('info', 'No matching identifiers found.'); return; }
  openPage(`rename-preview:${newSid()}`, `Rename ${word.name}`, 'replaceAll', (page) => {
    const head = el('div', 'ide-page-head');
    const apply = Object.assign(el('button', 'ide-button', 'Apply Rename'), { type: 'button' });
    const note = el('p', 'ide-run-note', 'Syntax matches may include unrelated symbols with the same name. Select the occurrences to change. Comments and strings are excluded. Changes stay in editor tabs for review and undo.');
    const rows = el('div', 'ide-rename-files');
    const selected = new Map(docs.map((d) => [d, new Set(d.hits)]));
    for (const d of docs) {
      rows.append(el('strong', 'ide-rename-file', `${d.path} (${d.hits.length})`));
      for (const h of d.hits) {
        const row = el('label', 'ide-rename-file');
        const check = Object.assign(el('input'), { type: 'checkbox', checked: true });
        check.addEventListener('change', () => check.checked ? selected.get(d).add(h) : selected.get(d).delete(h));
        const line = d.text.slice(0, h.from).split('\n').length;
        const start = d.text.lastIndexOf('\n', h.from - 1) + 1;
        const end = d.text.indexOf('\n', h.to);
        row.append(check, el('code', '', `${line}: ${d.text.slice(start, end < 0 ? d.text.length : end).trim()}`));
        rows.append(row);
      }
    }
    apply.addEventListener('click', async () => {
      apply.disabled = true;
      try {
        const chosen = [...selected].filter(([, hits]) => hits.size);
        if (!chosen.length) { apply.disabled = false; return; }
        for (const [d] of chosen) {
          const tab = I.tabs.find((x) => x.rel === d.path && sameLoc(x.loc, d.loc) && x.ed);
          const current = tab ? tab.ed.text() : await readAt(d.path, d.loc);
          if (current !== d.text) throw new Error(`${d.path} changed since the preview. Run Rename again.`);
        }
        const prepared = [];
        for (const [d, hits] of chosen) {
          const tab = openFile(d.path, { host: d.host, loc: d.loc, preview: false });
          if (!tab) throw new Error(`Couldn't open ${d.path}`);
          for (let n = 0; !tab.ed?.ready() && n < 80; n++) await sleep(100);
          if (!I || !tab.ed) throw new Error(`Couldn't open ${d.path}`);
          if (!tab.ed.ready() || tab.ed.text() !== d.text || tab.info?.readOnly) throw new Error(`${d.path} changed or isn't writable. Run Rename again.`);
          prepared.push({ d, hits, tab });
        }
        for (const { d, hits, tab } of prepared) {
          if (tab.ed.text() !== d.text) throw new Error(`${d.path} changed during rename. Review the open tabs and run Rename again.`);
          let text = d.text;
          for (const h of [...hits].sort((a, b) => b.from - a.from)) text = text.slice(0, h.from) + value + text.slice(h.to);
          if (!tab.ed.edit(0, d.text.length, text)) throw new Error(`Couldn't edit ${d.path}`);
        }
        notify('info', `Renamed ${word.name} to ${value} in ${chosen.length} files. Review the open tabs.`);
      } catch (err) { notify('error', err.message); apply.disabled = false; }
    });
    head.append(el('span', '', `${word.name} → ${value}`), apply);
    page.view.append(head, note, rows);
  });
}

function mountImage(t) {
  const box = el('div', 'ide-image');
  const img = Object.assign(el('img'), { alt: t.title, src: filesApi({ host: t.host, share: t.share ?? 'home' }, 'download', { path: t.rel, inline: '' }) });
  const meta = el('div', 'ide-image-meta');
  img.addEventListener('load', () => { meta.textContent = `${img.naturalWidth} × ${img.naturalHeight} · on ${t.host}`; });
  img.addEventListener('error', () => { box.replaceChildren(el('p', 'ide-empty', `${t.title} couldn't be read from ${t.host}.`)); });
  // a click between fit and actual size, as VS Code's image preview does
  img.addEventListener('click', () => box.classList.toggle('actual'));
  box.append(img, meta);
  t.view.append(box);
  t.view.tabIndex = -1;
}

function mountBinary(t) {
  const box = el('div', 'ide-binary');
  box.append(el('p', '', 'The file is not displayed in the text editor because it is either binary or uses an unsupported text encoding.'));
  const any = Object.assign(el('button', 'ide-link', 'Open Anyway'), { type: 'button' });
  any.addEventListener('click', () => {
    const i = I.tabs.indexOf(t);
    closeTab(t, true, false);
    openFile(t.rel, { preview: false, index: i, anyway: true, host: t.host, loc: t.loc });
  });
  const dl = Object.assign(el('a', 'ide-link', 'Download'), { href: filesApi({ host: t.host, share: t.share ?? 'home' }, 'download', { path: t.rel }) });
  box.append(any, dl);
  t.view.append(box);
  t.view.tabIndex = -1;
}

// a jump asked for before the text's in: held until it is
function placeCaret(t, o) {
  if (!o.select && !o.line) return;
  t.pendingSel = o.select || { line: o.line, col: o.col || 1 };
  if (t.info?.ready) applyPending(t);
}
function applyPending(t) {
  const want = t.pendingSel;
  if (!want || !t.ed) return;
  t.pendingSel = null;
  if (want.then) want.then();
  else if (Array.isArray(want)) t.ed.select(want[0], want[1], { focus: t === I.active });
  else { const at = offsetOf(t.ed.text(), want.line, want.col); t.ed.select(at, at, { focus: t === I.active }); }
}

// a code tab's news: its dot, the status bar, the problems, a held jump
function tabState(t, info) {
  if (!I) return;
  const was = t.info;
  t.info = info;
  languages.changed(t);
  if (info.ready && !was?.ready && t === I.active) languages.get(t).catch((e) => log(e.message, 'Languages'));
  if (info.ready && !was?.ready) applyPending(t);
  if (info.dirty && t.preview) pin(t);
  if (!was || was.dirty !== info.dirty) { t.tabEl.classList.toggle('dirty', info.dirty); paintOpenEditorsSoon(); }
  if (!was || was.errors.length !== info.errors.length) { paintProblemsSoon(); paintTreeSoon(); }
  if (t === I.active) paintStatus();
  if (t === I.active) paintSymbolNavSoon();
  if (I.find?.open && t === I.active && was && was.length !== info.length) findSoon();
  // the user's settings and keys read again once their file's saved
  if (was?.dirty && !info.dirty) {
    languages.saved(t);
    emit('save', { path: t.rel });
    if (t.rel === SETTINGS_PATH() || t.rel === KEYS_PATH()) loadUserFiles();
    scmRefreshSoon();
    // the project's build settings, as edited by hand
    if (t.rel.endsWith(`/${BUILD_FILE}`) && under(t.rel, I.st.root) && sameLoc(t.loc, locOf())) loadBuildConfig(filesParent(filesParent(t.rel)));
  }
}
const paintOpenEditorsSoon = debounce(() => I && paintOpenEditors(), 50);

function pin(t) {
  if (!t.preview) return;
  t.preview = false;
  t.tabEl.classList.remove('preview');
  paintOpenEditorsSoon();
}

function activate(t, focus = true) {
  if (!t || !I.tabs.includes(t)) return;
  const was = I.active;
  I.active = t;
  if (t !== was) {
    I.projHas = undefined;
    I.runContext = { tabId: t.id, workspace: wsKey(), pending: true };
  }
  I.mru = [t, ...I.mru.filter((x) => x !== t)];
  for (const x of I.tabs) {
    x.view.hidden = x !== t;
    x.tabEl.classList.toggle('on', x === t);
    x.tabEl.setAttribute('aria-selected', String(x === t));
  }
  // painted first: an editor in a hidden view takes no focus
  paintEditors();
  t.ed?.show();
  if (t.ed) paintSymbolNavSoon();
  if (t.ed?.ready()) languages.get(t).catch((e) => log(e.message, 'Languages'));
  if (t !== was) paintRunView();
  if (focus) { drawersAway(); focusTab(t); }
  if (t !== was) {
    if (I.find?.open) { if (t.ed) findSoon(); else closeFind(false); }
    if (was?.ed) was.ed.setFinds([]);
    if (t.rel && setting('explorer.autoReveal') && under(t.rel, I.st.root)) revealPath(t.rel);
  }
  t.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  saveState();
  emit('activeEditor');
  refreshProjectSoon();
}

// a code tab still finding its host: the workbench holds the focus, its keys
// live, the editor taking it once it's there
function focusTab(t) {
  if (t.ed) t.ed.focus();
  else if (t.kind === 'code') { t.wantFocus = true; I.root.focus({ preventScroll: true }); }
  else t.view.focus({ preventScroll: true });
}

function focusActive() {
  if (!I) return;
  if (I.active) focusTab(I.active); else I.root.focus({ preventScroll: true });
}

async function saveTab(t) {
  if (!t.ed) return true;
  t.ed.save();
  for (let i = 0; i < 50 && t.ed.dirty(); i++) await sleep(100);
  if (t.ed.dirty()) { notify('error', `Failed to save '${t.title}': ${t.info?.state || 'no answer from its host'}.`); return false; }
  return true;
}
const saveAll = () => Promise.all(I.tabs.filter((t) => t.ed?.dirty()).map(saveTab));

// force: no question about unsaved edits; next: another tab taken up after
async function closeTab(t, force = false, next = true) {
  if (!I || !I.tabs.includes(t)) return false;
  if (!force && t.ed?.dirty()) {
    activate(t);
    const v = await ask({
      title: `Do you want to save the changes you made to ${t.title}?`,
      detail: 'Your changes will be lost if they don’t reach the disk.',
      buttons: [{ label: 'Save', primary: true, value: 'save' }, { label: 'Don’t Save', value: 'drop' }, { label: 'Cancel', value: '' }],
    });
    if (!v || !I) return false;
    if (v === 'save' && !(await saveTab(t))) return false;
  }
  // the next tab takes the focus only if this one had it
  const hadFocus = t.view.contains(document.activeElement) || t.tabEl.contains(document.activeElement);
  t.dispose?.();
  t.tabEl.remove();
  t.view.remove();
  I.tabs.splice(I.tabs.indexOf(t), 1);
  I.mru = I.mru.filter((x) => x !== t);
  if (t.rel) I.closed = [t.rel, ...I.closed.filter((r) => r !== t.rel)].slice(0, 20);
  if (I.active === t) {
    I.active = null;
    if (I.find?.open) closeFind(false);
    if (next && I.mru[0]) activate(I.mru[0], hadFocus || !I.root.contains(document.activeElement));
    else { emit('activeEditor'); if (hadFocus) I.root.focus({ preventScroll: true }); }
  }
  paintEditors();
  paintProblemsSoon();
  saveState();
  return true;
}

async function closeMany(list) {
  const dirty = list.filter((t) => t.ed?.dirty());
  if (dirty.length > 1) {
    const v = await ask({
      title: `Do you want to save the changes to ${dirty.length} files?`,
      detail: dirty.map((t) => t.title).join('\n'),
      buttons: [{ label: 'Save All', primary: true, value: 'save' }, { label: 'Don’t Save', value: 'drop' }, { label: 'Cancel', value: '' }],
    });
    if (!v) return;
    if (v === 'save') await Promise.all(dirty.map(saveTab));
    for (const t of list) await closeTab(t, true);
    return;
  }
  for (const t of list) if (!(await closeTab(t))) return;
}

// the file invited to someone over the chat, as /share does: a dialog on their end,
// the same live text once they accept
function shareTab(t, anchor = t.tabEl || I.tabsEl) {
  const f = t?.ed?.file;
  if (!f) return;
  shareMenu(anchor, f, (said) => setStatusFlash(said));
}

function tabItems(t) {
  const i = I.tabs.indexOf(t);
  return [
    { label: 'Close', key: keyFor('workbench.action.closeActiveEditor'), run: () => closeTab(t) },
    { label: 'Close Others', disabled: I.tabs.length < 2, run: () => closeMany(I.tabs.filter((x) => x !== t)) },
    { label: 'Close to the Right', disabled: i === I.tabs.length - 1, run: () => closeMany(I.tabs.slice(i + 1)) },
    { label: 'Close Saved', run: () => closeMany(I.tabs.filter((x) => !x.ed?.dirty())) },
    { label: 'Close All', key: keyFor('workbench.action.closeAllEditors'), run: () => closeMany([...I.tabs]) },
    '-',
    t.rel && { label: 'Copy Path', run: () => copyPath(t.rel, true) },
    t.rel && { label: 'Copy Relative Path', run: () => copyPath(t.rel, false) },
    t.ed && !standalone && { label: 'Share With…', run: () => shareTab(t) },
    t.rel && '-',
    t.rel && { label: 'Reveal in Explorer View', run: () => { showSide('explorer', true); revealPath(t.rel); } },
    t.preview && { label: 'Keep Open', run: () => pin(t) },
  ].filter(Boolean);
}

// the tabs, the breadcrumbs, the watermark, the title: all from the tabs as they stand
function paintEditors() {
  if (!I) return;
  const counts = new Map();
  for (const t of I.tabs) counts.set(t.title, (counts.get(t.title) || 0) + 1);
  for (const t of I.tabs) {
    t.labelEl.textContent = t.title;
    t.descEl.textContent = t.rel && counts.get(t.title) > 1 ? baseName(filesParent(t.rel)) : '';
    t.tabEl.classList.toggle('preview', !!t.preview);
    t.tabEl.title = t.rel ? `${t.rel}\non ${t.host}` : t.title;
  }
  const order = I.tabs.map((t) => t.tabEl);
  if (order.some((n, i) => I.tabsEl.children[i] !== n) || I.tabsEl.children.length !== order.length) I.tabsEl.replaceChildren(...order);
  const has = I.tabs.length > 0;
  I.editorsPart.classList.toggle('empty', !has);
  if (!has) paintWatermark();
  paintCrumbs();
  paintTabActions();
  paintOpenEditors();
  paintStatus();
  if (I.chat) paintChatCtx();
  const t = I.active;
  const head = I.w.head.querySelector('.tab-label');
  if (head) head.textContent = `${t ? `${t.title} — ` : ''}${baseName(I.st.root)} — Sulfur`;
}

function paintCrumbs() {
  const t = I.active;
  const c = I.crumbs;
  c.replaceChildren();
  c.hidden = !t?.rel;
  if (!t?.rel) return;
  const inRoot = under(t.rel, I.st.root);
  const segs = (inRoot ? t.rel.slice(I.st.root.length + 1) : t.rel).split('/');
  if (inRoot) segs.unshift(baseName(I.st.root));
  let at = inRoot ? filesParent(I.st.root) : '';
  segs.forEach((s, i) => {
    at = filesJoin(at, s);
    const last = i === segs.length - 1;
    const here = at;
    const b = Object.assign(el('button', 'ide-crumb'), { type: 'button', title: here });
    if (last) b.append(fileIcon(here));
    b.append(el('span', '', s));
    b.addEventListener('click', () => crumbMenu(b, filesParent(here), here));
    c.append(b);
    if (!last) c.append(icon('right', 'ide-crumb-sep'));
  });
}

// a breadcrumb's siblings, to step across as VS Code's do
async function crumbMenu(anchor, dir, here) {
  const list = await loadDir(dir);
  if (!I) return;
  const skip = excluded();
  menu(anchor, list.filter((e) => !skip(e.name)).slice(0, 200).map((e) => {
    const p = filesJoin(dir, e.name);
    return { label: e.name, checked: p === here, ic: e.dir ? 'folder' : 'file', run: () => {
      if (!e.dir) { openFile(p, { preview: false }); return; }
      showSide('explorer', true);
      revealPath(p).then(() => I && toggleDir(p, true));
    } };
  }), { search: true });
}

function paintTabActions() {
  const t = I.active;
  const acts = [];
  const context = activeRunContext();
  if (context?.project || context?.pending || (t?.ed && runnerFor(t.rel))) {
    const title = context?.pending ? 'Finding the active project target…' : context?.project ? `Run ${context.item?.label || baseName(projDir())} (${context.cfg?.configuration || 'select configuration'}) on ${context.cfg?.host || runHost()}` : `Run ${t.title} on ${runHost() || 'a host'}`;
    const go = btn('ide-run-btn', 'run', `${title} (F5)`, () => run('sulfur.run.context'));
    go.disabled = !!context?.pending;
    acts.push(go);
  }
  if (t?.ed?.preview) acts.push(btn(t.ed.previewing() ? 'on' : '', 'preview', `${t.ed.previewing() ? 'Show Source' : 'Open Preview'} (${keyLabel(keyFor('markdown.showPreview'))})`, () => run('markdown.showPreview')));
  if (t) acts.push(btn('', 'more', 'More Actions…', (e) => menu(e.currentTarget, [
    cmdItem('workbench.action.closeAllEditors', 'Close All'),
    { label: 'Close Saved', run: () => closeMany(I.tabs.filter((x) => !x.ed?.dirty())) },
    cmdItem('workbench.action.reopenClosedEditor', 'Reopen Closed Editor'),
  ])));
  I.tabActs.replaceChildren(...acts);
}

function paintWatermark() {
  const wm = I.watermark;
  if (wm.childElementCount) return;
  const art = el('div', 'ide-wm-art');
  art.append(icon('spark'));
  const list = el('dl', 'ide-wm-keys');
  for (const [label, cmd] of [['Show All Commands', 'workbench.action.showCommands'], ['Go to File', 'workbench.action.quickOpen'],
    ['Find in Files', 'workbench.action.findInFiles'], ['Toggle Terminal', 'workbench.action.terminal.toggleTerminal'],
    ['Run Active Target', 'sulfur.run.context'], ['Open Chat', 'workbench.action.chat.open'], ['Open Folder', 'workbench.action.files.openFolder']]) {
    const k = keyFor(cmd);
    list.append(el('dt', '', label), el('dd'));
    list.lastChild.append(...(k ? k.split(' ').map((part) => el('kbd', '', keyLabel(part))) : []));
  }
  wm.append(art, list);
}

// --- find and replace in the active editor -------------------------------------------

function buildFind() {
  const box = el('div', 'ide-find');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Find / Replace');
  const toggle = btn('ide-find-toggle', 'right', 'Toggle Replace', () => setReplace(!I.find.replace));
  const rows = el('div', 'ide-find-rows');
  const r1 = el('div', 'ide-find-row');
  const field = el('div', 'ide-find-field');
  const q = Object.assign(el('input', 'ide-input'), { placeholder: 'Find', spellcheck: false, autocomplete: 'off' });
  q.setAttribute('aria-label', 'Find');
  const opt = (label, title, key) => {
    const b = Object.assign(el('button', 'ide-opt', label), { type: 'button', title });
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => { I.find[key] = !I.find[key]; b.classList.toggle('on', I.find[key]); b.setAttribute('aria-pressed', String(I.find[key])); findNow(); q.focus(); });
    return b;
  };
  const caseB = opt('Aa', `Match Case (${keyLabel('alt+c')})`, 'caseS');
  const wordB = opt('ab', `Match Whole Word (${keyLabel('alt+w')})`, 'word');
  wordB.classList.add('ide-opt-word');
  const reB = opt('.*', `Use Regular Expression (${keyLabel('alt+r')})`, 're');
  field.append(q, caseB, wordB, reB);
  const count = el('span', 'ide-find-count', 'No results');
  const prev = btn('', 'up', `Previous Match (${keyLabel('shift+enter')})`, () => findStep(-1));
  const next = btn('', 'down', `Next Match (${keyLabel('enter')})`, () => findStep(1));
  const close = btn('', 'close', `Close (${keyLabel('escape')})`, () => closeFind(true));
  r1.append(field, count, prev, next, close);
  const r2 = el('div', 'ide-find-row ide-find-rep');
  const rq = Object.assign(el('input', 'ide-input'), { placeholder: 'Replace', spellcheck: false, autocomplete: 'off' });
  rq.setAttribute('aria-label', 'Replace');
  const one = btn('', 'replaceOne', `Replace (${keyLabel('ctrl+shift+1')})`, () => replaceOne());
  const all = btn('', 'replaceAll', `Replace All (${keyLabel('ctrl+alt+enter')})`, () => replaceAll());
  r2.append(rq, one, all);
  rows.append(r1, r2);
  box.append(toggle, rows);
  I.views.append(box);
  const keys = (e) => {
    const k = keyOf(e);
    if (k === 'enter') { e.preventDefault(); if (e.target === rq) replaceOne(); else findStep(1); }
    else if (k === 'shift+enter') { e.preventDefault(); findStep(-1); }
    else if (k === 'escape') { e.preventDefault(); e.stopPropagation(); closeFind(true); }
    else if (k === 'alt+c') { e.preventDefault(); caseB.click(); }
    else if (k === 'alt+w') { e.preventDefault(); wordB.click(); }
    else if (k === 'alt+r') { e.preventDefault(); reB.click(); }
    else if (k === 'ctrl+alt+enter') { e.preventDefault(); replaceAll(); }
    else if (k === 'ctrl+shift+1') { e.preventDefault(); replaceOne(); }
    else if (k === 'tab' && e.target === q && I.find.replace) { e.preventDefault(); rq.focus(); }
    else if (k === 'shift+tab' && e.target === rq) { e.preventDefault(); q.focus(); }
  };
  q.addEventListener('keydown', keys);
  rq.addEventListener('keydown', keys);
  q.addEventListener('input', () => findNow(true));
  I.find = { box, q, rq, count, toggle, field, open: false, replace: false, caseS: false, word: false, re: false, ranges: [], at: -1 };
}

function openFind(replace = false) {
  const t = I.active;
  if (!t?.ed) return;
  if (!I.find) buildFind();
  const f = I.find;
  f.open = true;
  f.box.classList.add('open');
  setReplace(replace || (f.replace && f.open));
  const [s, e] = t.ed.selection();
  const sel = t.ed.text().slice(s, e);
  if (sel && !sel.includes('\n')) f.q.value = sel;
  // the replace box first once there's something to find; select() focuses, so only the one
  const box = replace && f.q.value ? f.rq : f.q;
  box.focus();
  box.select();
  findNow(true);
}

function setReplace(on) {
  const f = I.find;
  f.replace = on;
  f.box.classList.toggle('replace', on);
  f.toggle.replaceChildren(icon(on ? 'down' : 'right'));
  f.toggle.setAttribute('aria-expanded', String(on));
}

function closeFind(focus) {
  const f = I.find;
  if (!f?.open) return;
  f.open = false;
  f.box.classList.remove('open');
  const t = I.active;
  if (t?.ed) {
    t.ed.setFinds([]);
    if (focus) {
      const r = f.ranges[f.at];
      if (r) t.ed.select(r[0], r[1]); else t.ed.focus();
    }
  }
}

function findRegex() {
  const f = I.find;
  const v = f.q.value;
  if (!v) return null;
  let src = f.re ? v : v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (f.word) src = `\\b${src}\\b`;
  try { return new RegExp(src, f.caseS ? 'gm' : 'gim'); } catch { return undefined; }
}

const findSoon = debounce(() => I?.find?.open && findNow(), 120);
// fromTyping: the current match the first at or after the caret
function findNow(fromTyping = false) {
  const f = I.find;
  const t = I.active;
  if (!f?.open || !t?.ed) return;
  const text = t.ed.text();
  const re = findRegex();
  const was = f.ranges[f.at];
  f.ranges = [];
  f.field.classList.toggle('bad', re === undefined);
  if (re) {
    for (let m = re.exec(text); m && f.ranges.length < 20000; m = re.exec(text)) {
      if (m[0] === '') { re.lastIndex += 1; continue; }
      f.ranges.push([m.index, m.index + m[0].length]);
    }
  }
  const from = fromTyping || !was ? t.ed.selection()[0] : was[0];
  f.at = f.ranges.length ? Math.max(0, f.ranges.findIndex((r) => r[0] >= from)) : -1;
  if (f.ranges.length && f.ranges.findIndex((r) => r[0] >= from) < 0) f.at = 0;
  paintFind(fromTyping);
}

function paintFind(reveal) {
  const f = I.find;
  const t = I.active;
  const n = f.ranges.length;
  f.count.textContent = !f.q.value ? 'No results' : n ? `${f.at + 1} of ${n >= 20000 ? '20000+' : n}` : 'No results';
  f.field.classList.toggle('none', !!f.q.value && !n);
  t.ed.setFinds(f.ranges, f.at);
  const r = f.ranges[f.at];
  if (r && reveal) t.ed.select(r[0], r[1], { focus: false });
}

function findStep(d) {
  const f = I.find;
  if (!f?.open) { openFind(); return; }
  if (!f.ranges.length) return;
  f.at = (f.at + d + f.ranges.length) % f.ranges.length;
  paintFind(true);
}

// $1 and the rest for a regular expression's groups, as VS Code's replace takes them
function replacement(match) {
  const f = I.find;
  if (!f.re) return f.rq.value;
  const re = findRegex();
  return match.replace(new RegExp(re.source, re.flags.replace('g', '')), f.rq.value);
}

function replaceOne() {
  const f = I.find;
  const t = I.active;
  const r = f.ranges[f.at];
  if (!r || !t?.ed) return;
  const text = t.ed.text();
  const put = replacement(text.slice(r[0], r[1]));
  if (!t.ed.edit(r[0], r[1], put)) { notify('warning', 'The file is read-only here.'); return; }
  f.rq.focus();
  findNow();
}

function replaceAll() {
  const f = I.find;
  const t = I.active;
  const re = findRegex();
  if (!re || !f.ranges.length || !t?.ed) return;
  const text = t.ed.text();
  const n = f.ranges.length;
  const next = text.replace(re, f.re ? f.rq.value : () => f.rq.value);
  if (!t.ed.edit(0, text.length, next)) { notify('warning', 'The file is read-only here.'); return; }
  setStatusFlash(`Replaced ${n} occurrence${n === 1 ? '' : 's'}`);
  f.rq.focus();
  findNow();
}

// --- line commands, VS Code's, as edits the browser's undo knows ---

function lineSpan(text, s, e) {
  const a = text.lastIndexOf('\n', s - 1) + 1;
  const end = e > s && text[e - 1] === '\n' ? e - 1 : e;
  const ni = text.indexOf('\n', end);
  return [a, ni < 0 ? text.length : ni];
}

function lineCmd(fn) {
  const t = I.active;
  if (!t?.ed || !t.info?.ready) return;
  if (t.info.readOnly) { setStatusFlash('read-only'); return; }
  const text = t.ed.text();
  const [s, e] = t.ed.selection();
  fn(t.ed, text, s, e);
}

const LINE_CMDS = {
  moveUp: (ed, text, s, e) => {
    const [a, b] = lineSpan(text, s, e);
    if (a === 0) return;
    const pa = text.lastIndexOf('\n', a - 2) + 1;
    const block = text.slice(a, b);
    const prev = text.slice(pa, a - 1);
    ed.edit(pa, b, `${block}\n${prev}`, s - (a - pa), e - (a - pa));
  },
  moveDown: (ed, text, s, e) => {
    const [a, b] = lineSpan(text, s, e);
    if (b >= text.length) return;
    const ne = text.indexOf('\n', b + 1);
    const nb = ne < 0 ? text.length : ne;
    const next = text.slice(b + 1, nb);
    ed.edit(a, nb, `${next}\n${text.slice(a, b)}`, s + next.length + 1, e + next.length + 1);
  },
  copyUp: (ed, text, s, e) => { const [a, b] = lineSpan(text, s, e); ed.edit(a, a, `${text.slice(a, b)}\n`, s, e); },
  copyDown: (ed, text, s, e) => { const [a, b] = lineSpan(text, s, e); const block = text.slice(a, b); ed.edit(b, b, `\n${block}`, s + block.length + 1, e + block.length + 1); },
  deleteLines: (ed, text, s, e) => {
    const [a, b] = lineSpan(text, s, e);
    const from = b < text.length ? a : Math.max(0, a - 1);
    const to = b < text.length ? b + 1 : b;
    ed.edit(from, to, '', from, from);
  },
  insertBelow: (ed, text, s) => {
    const [a, b] = lineSpan(text, s, s);
    const ind = text.slice(a, b).match(/^[ \t]*/)[0];
    ed.edit(b, b, `\n${ind}`, b + 1 + ind.length);
  },
  insertAbove: (ed, text, s) => {
    const [a, b] = lineSpan(text, s, s);
    const ind = text.slice(a, b).match(/^[ \t]*/)[0];
    ed.edit(a, a, `${ind}\n`, a + ind.length);
  },
  selectLine: (ed, text, s, e) => {
    const [a] = lineSpan(text, s, s);
    const from = s !== e && text[s - 1] === '\n' ? s : a;
    const ni = text.indexOf('\n', e > s ? e : s);
    ed.select(Math.min(from, a), ni < 0 ? text.length : ni + 1);
  },
  duplicate: (ed, text, s, e) => {
    if (s === e) { LINE_CMDS.copyDown(ed, text, s, e); return; }
    ed.edit(e, e, text.slice(s, e), e, e + (e - s));
  },
  indent: (ed, text, s, e) => {
    const unit = I.active.info.indent === 'tab' ? '\t' : ' '.repeat(I.active.info.indent);
    const [a, b] = lineSpan(text, s, e);
    const lines = text.slice(a, b).split('\n');
    const next = lines.map((l) => (l ? unit + l : l)).join('\n');
    ed.edit(a, b, next, s + unit.length, e + (next.length - (b - a)));
  },
  outdent: (ed, text, s, e) => {
    const n = I.active.info.indent === 'tab' ? 4 : I.active.info.indent;
    const [a, b] = lineSpan(text, s, e);
    const lines = text.slice(a, b).split('\n');
    const next = lines.map((l) => (l.startsWith('\t') ? l.slice(1) : l.replace(new RegExp(`^ {1,${n}}`), ''))).join('\n');
    const cut = (lines[0].length - next.split('\n')[0].length);
    ed.edit(a, b, next, Math.max(a, s - cut), Math.max(a, e - ((b - a) - next.length)));
  },
  trimTrailing: (ed, text) => {
    const next = text.replace(/[ \t]+$/gm, '');
    if (next !== text) ed.edit(0, text.length, next, 0, 0);
  },
  sortAsc: (ed, text, s, e) => sortLines(ed, text, s, e, 1),
  sortDesc: (ed, text, s, e) => sortLines(ed, text, s, e, -1),
  upper: (ed, text, s, e) => { if (s !== e) ed.edit(s, e, text.slice(s, e).toUpperCase(), s, e); },
  lower: (ed, text, s, e) => { if (s !== e) ed.edit(s, e, text.slice(s, e).toLowerCase(), s, e); },
  title: (ed, text, s, e) => { if (s !== e) ed.edit(s, e, text.slice(s, e).toLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (m, p1, c) => p1 + c.toUpperCase()), s, e); },
  joinLines: (ed, text, s, e) => {
    const [a, b0] = lineSpan(text, s, e);
    let b = b0;
    if (s === e) { const ni = text.indexOf('\n', b + 1); b = ni < 0 ? text.length : ni; }
    const next = text.slice(a, b).replace(/[ \t]*\n[ \t]*/g, ' ');
    ed.edit(a, b, next, a + next.length);
  },
};
function sortLines(ed, text, s, e, dir) {
  let [a, b] = lineSpan(text, s, e);
  if (s === e) { a = 0; b = text.length; }
  const lines = text.slice(a, b).split('\n');
  const next = [...lines].sort((x, y) => x.localeCompare(y) * dir).join('\n');
  if (next !== text.slice(a, b)) ed.edit(a, b, next, a, a + next.length);
}

function nextProblem(d) {
  const t = I.active;
  const errs = t?.info?.errors || [];
  if (!errs.length) { setStatusFlash('No problems in this file'); return; }
  const at = t.ed.selection()[0];
  const order = d > 0 ? errs : [...errs].reverse();
  const hit = order.find((x) => (d > 0 ? x.from > at : x.from < at)) || order[0];
  t.ed.select(hit.from, Math.max(hit.to, hit.from + 1));
  setStatusFlash(`Ln ${hit.line}, Col ${hit.col}: ${hit.what}`);
}

async function revertFile(t) {
  if (!t?.ed) return;
  try {
    const b = await filesCall({ host: t.host, share: t.share ?? 'home' }, 'read', undefined, { path: t.rel });
    if (typeof b.text !== 'string') throw new Error(b.tooBig ? 'too big to read back' : 'not text');
    const now = t.ed.text();
    if (now !== b.text) t.ed.edit(0, now.length, b.text, 0, 0);
    setStatusFlash(`Reverted ${t.title}`);
  } catch (err) { notify('error', `Unable to revert '${t.title}': ${err.message}`); }
}

// --- commands and their keys --------------------------------------------------------------
// every action one command, named as VS Code names it where VS Code has it, so its
// keys, menus, palette and the extensions all reach the same thing

// o: category, key (a chord as "ctrl+k ctrl+o"), when, shell (taken even from a
// focused terminal), hidden (left out of the palette)
function command(id, title, fn, o = {}) {
  I.commands.set(id, { id, title, run: fn, category: o.category || '', key: o.key ? normKey(o.key) : '', alt: (o.alt || []).map(normKey), when: o.when, shell: !!o.shell, hidden: !!o.hidden, ext: o.ext || '' });
}

// the key a command answers to: the user's keybindings.json first
function keyFor(id) {
  const user = I.userKeys.filter((k) => k.command === id);
  if (user.length) return user[0].key;
  if (I.userKeys.some((k) => k.command === `-${id}`)) return '';
  return I.commands.get(id)?.key || '';
}

function buildKeys() {
  const keys = new Map();
  const add = (k, id) => { if (k) keys.set(k, [...(keys.get(k) || []), id]); };
  const dropped = new Set(I.userKeys.filter((k) => k.command.startsWith('-')).map((k) => `${k.key}\n${k.command.slice(1)}`));
  for (const c of I.commands.values()) for (const k of [c.key, ...c.alt]) if (k && !dropped.has(`${k}\n${c.id}`) && !dropped.has(`\n${c.id}`)) add(k, c.id);
  // the user's own first, over any default on the same keys
  for (const u of I.userKeys) if (!u.command.startsWith('-') && u.key) keys.set(u.key, [u.command, ...(keys.get(u.key) || []).filter((x) => x !== u.command)]);
  I.keys = keys;
  I.chords = new Set([...keys.keys()].filter((k) => k.includes(' ')).map((k) => k.split(' ')[0]));
  if (I.actBtns.size) paintActivityTitles();
}

function run(id, ...args) {
  const c = I?.commands.get(id);
  if (!c) { notify('warning', `command '${id}' not found`); return undefined; }
  if (c.when && !c.when()) return undefined;
  if (!c.hidden && id !== 'workbench.action.showCommands') I.st.recentCmds = [id, ...(I.st.recentCmds || []).filter((x) => x !== id)].slice(0, 12);
  try { return c.run(...args); } catch (err) { notify('error', `${c.title}: ${err.message}`); console.error(err); return undefined; }
}

const edFocused = () => !!I.active?.ed && document.activeElement?.classList.contains('code-ta') && I.active.view.contains(document.activeElement);
const hasEd = () => !!I.active?.ed;
const termFocused = () => !!document.activeElement?.closest?.('.ide-term-view');

// one handler, capturing, for the whole workbench: chords, then a key's commands
// in order, the first that applies taking it; a focused terminal keeps its keys
// but those meant for the workbench
function onKey(e) {
  if (!I || e.isComposing || I.dialog) return;
  const k = keyOf(e);
  if (!k) return;
  const inTerm = !!e.target.closest?.('.xterm');
  if (I.chord) {
    const full = `${I.chord} ${k}`;
    I.chord = '';
    setChord('');
    e.preventDefault();
    e.stopPropagation();
    const ids = I.keys.get(full);
    const c = ids?.map((id) => I.commands.get(id)).find((x) => x && (!x.when || x.when()));
    if (c) run(c.id); else setStatusFlash(`The key combination (${keyLabel(full)}) is not a command.`);
    return;
  }
  if (I.chords.has(k) && !inTerm) {
    I.chord = k;
    e.preventDefault();
    e.stopPropagation();
    setChord(`(${keyLabel(k)}) was pressed. Waiting for second key of chord…`);
    return;
  }
  const ids = I.keys.get(k);
  if (!ids) return;
  const c = ids.map((id) => I.commands.get(id)).find((x) => x && (!x.when || x.when()));
  if (!c || (inTerm && !c.shell)) return;
  e.preventDefault();
  e.stopPropagation();
  run(c.id);
}

function registerCommands() {
  const C = command;
  // the palette and its kin
  C('workbench.action.showCommands', 'Show All Commands', () => quickOpen('>'), { key: 'ctrl+shift+p', alt: ['f1'], shell: true });
  C('workbench.action.quickOpen', 'Go to File…', () => quickOpen(''), { key: 'ctrl+p', shell: true });
  C('workbench.action.gotoLine', 'Go to Line/Column…', () => quickOpen(':'), { key: 'ctrl+g', when: hasEd, category: 'Go' });
  C('workbench.action.quickOpenHelp', 'Quick Open Help', () => quickOpen('?'), { hidden: true });
  // files
  C('explorer.newFile', 'New File…', () => startEdit('file'), { key: 'ctrl+alt+n', category: 'File' });
  C('explorer.newFolder', 'New Folder…', () => startEdit('folder'), { category: 'File' });
  C('workbench.action.files.openFolder', 'Open Folder…', () => pickFolder(), { key: 'ctrl+k ctrl+o', category: 'File' });
  C('workbench.action.files.openFile', 'Open File…', async () => {
    const at = await fileDialog({ files: true });
    if (at && I) openFile(at.rel, { preview: false, loc: at.loc });
  }, { key: 'ctrl+o', category: 'File' });
  C('workbench.action.openRecent', 'Open Recent…', () => pick(recentItems().map((x) => ({ ...x, value: x })), { placeholder: 'Select to open' }).then((x) => x?.run()), { key: 'ctrl+r', category: 'File' });
  C('workbench.action.files.save', 'Save', () => I.active?.ed && saveTab(I.active), { key: 'ctrl+s', when: hasEd, category: 'File', shell: true });
  C('workbench.action.files.saveAll', 'Save All', () => saveAll(), { key: 'ctrl+k s', category: 'File' });
  C('workbench.action.revertFile', 'Revert File', () => revertFile(I.active), { when: hasEd, category: 'File' });
  C('workbench.action.closeActiveEditor', 'Close Editor', () => I.active && closeTab(I.active), { key: 'ctrl+w', alt: ['ctrl+f4'], category: 'View' });
  C('workbench.action.closeAllEditors', 'Close All Editors', () => closeMany([...I.tabs]), { key: 'ctrl+k ctrl+w', category: 'View' });
  C('workbench.action.reopenClosedEditor', 'Reopen Closed Editor', () => { const p = I.closed[0]; if (p) openFile(p, { preview: false }); }, { category: 'View' });
  C('workbench.action.nextEditor', 'Open Next Editor', () => stepTab(1), { key: 'ctrl+pagedown', alt: ['alt+pagedown'], category: 'View' });
  C('workbench.action.previousEditor', 'Open Previous Editor', () => stepTab(-1), { key: 'ctrl+pageup', alt: ['alt+pageup'], category: 'View' });
  C('workbench.action.keepEditor', 'Keep Editor', () => I.active && pin(I.active), { key: 'ctrl+k enter', category: 'View' });
  C('workbench.files.action.refreshFilesExplorer', 'Refresh Explorer', () => { I.index = null; refreshTree(); }, { category: 'File' });
  C('workbench.files.action.collapseExplorerFolders', 'Collapse Folders in Explorer', () => { I.expanded = new Set([I.st.root]); paintTree(); }, { category: 'File' });
  C('workbench.files.action.showActiveFileInExplorer', 'Reveal Active File in Explorer View', () => { if (I.active?.rel) { showSide('explorer', true); revealPath(I.active.rel); } }, { category: 'File' });
  C('sulfur.share', 'Share Active File With…', () => shareTab(I.active), { when: () => !standalone && !!I.active?.ed, category: 'File' });
  C('copyFilePath', 'Copy Path of Active File', () => I.active?.rel && copyPath(I.active.rel, true), { key: 'shift+alt+c', category: 'File' });
  C('copyRelativeFilePath', 'Copy Relative Path of Active File', () => I.active?.rel && copyPath(I.active.rel, false), { key: 'ctrl+k ctrl+shift+alt+c', category: 'File' });
  C('sulfur.closeWindow', 'Close Window', () => I.w.node.querySelector('.dk-close')?.click(), { category: 'View' });
  // views and layout
  C('workbench.view.explorer', 'Show Explorer', () => showSide('explorer', true, true), { key: 'ctrl+shift+e', category: 'View', shell: true });
  C('workbench.view.search', 'Show Search', () => showSide('search', true, true), { category: 'View' });
  C('workbench.view.scm', 'Show Source Control', () => showSide('scm', true, true), { key: 'ctrl+shift+g', category: 'View', shell: true });
  C('sulfur.git.clone', 'Git: Clone…', () => gitClone(), { category: 'Git' });
  C('sulfur.git.branch', 'Git: Checkout to…', () => scmBranchPick(), { category: 'Git' });
  C('sulfur.git.commit', 'Git: Commit', () => scmCommit(), { category: 'Git' });
  C('sulfur.git.pull', 'Git: Pull', () => scmOp(['pull'], 'Pulling'), { category: 'Git' });
  C('sulfur.git.push', 'Git: Push', () => scmPush(), { category: 'Git' });
  C('sulfur.git.sync', 'Git: Sync', () => scmSync(), { category: 'Git' });
  C('sulfur.git.history', 'Git: View History…', () => scmHistory(), { category: 'Git' });
  C('sulfur.forgejo.open', 'Forgejo: Open on Forgejo', () => forgejoOpen(I.active?.rel), { category: 'Forgejo' });
  C('sulfur.forgejo.pr', 'Forgejo: Create Pull Request…', () => forgejoPR(), { category: 'Forgejo' });
  C('sulfur.forgejo.prs', 'Forgejo: Pull Requests…', () => forgejoPRs(), { category: 'Forgejo' });
  C('sulfur.forgejo.publish', 'Forgejo: Publish Repository…', () => forgejoPublish(), { category: 'Forgejo' });
  C('workbench.action.findInFiles', 'Search: Find in Files', () => findInFiles(), { key: 'ctrl+shift+f', category: 'Search', shell: true });
  C('workbench.view.run', 'Show Run and Build', () => showSide('run', true, true), { key: 'ctrl+shift+d', category: 'View', shell: true });
  C('workbench.view.extensions', 'Show Extensions', () => showSide('extensions', true, true), { key: 'ctrl+shift+x', category: 'View', shell: true });
  C('workbench.action.toggleSidebarVisibility', 'Toggle Primary Side Bar Visibility', () => showSide(I.st.side.view, I.st.side.hidden), { key: 'ctrl+k b', category: 'View' });
  C('workbench.action.toggleAuxiliaryBar', 'Toggle Secondary Side Bar Visibility', () => showAux(I.st.aux.hidden, I.st.aux.hidden), { key: 'ctrl+alt+b', category: 'View', shell: true });
  C('workbench.action.chat.open', 'Open Chat', () => showAux(true, true), { key: 'ctrl+alt+i', category: 'Chat', shell: true });
  C('workbench.action.chat.newChat', 'New Chat', () => newChat(), { category: 'Chat' });
  C('inlineChat.start', 'Ask the Agent About the Selection', () => askSelection(), { key: 'ctrl+i', when: hasEd, category: 'Chat' });
  C('workbench.action.togglePanel', 'Toggle Panel Visibility', () => showPanel(I.st.panel.view, I.st.panel.hidden), { key: 'ctrl+j', category: 'View', shell: true });
  C('workbench.action.toggleMaximizedPanel', 'Toggle Maximized Panel', () => { I.st.panel.max = !I.st.panel.max; showPanel(I.st.panel.view, true); }, { category: 'View' });
  C('workbench.actions.view.problems', 'Focus on Problems View', () => showPanel('problems', true, true), { key: 'ctrl+shift+m', category: 'View', shell: true });
  C('workbench.action.output.toggleOutput', 'Toggle Output', () => (I.st.panel.view === 'output' && !I.st.panel.hidden ? showPanel('output', false) : showPanel('output', true, true)), { key: 'ctrl+shift+u', category: 'View', shell: true });
  C('workbench.action.showOutput', 'Show Output', () => showPanel('output', true, true), { category: 'Output', hidden: true });
  // the editor
  C('actions.find', 'Find', () => openFind(false), { key: 'ctrl+f', when: hasEd, category: 'Editor' });
  C('editor.action.startFindReplaceAction', 'Replace', () => openFind(true), { key: 'ctrl+h', when: hasEd, category: 'Editor' });
  C('editor.action.revealDefinition', 'Go to Definition', () => goToDefinition().catch((err) => notify('error', err.message)), { key: 'f12', when: hasEd, category: 'Go' });
  C('editor.action.referenceSearch.trigger', 'Find All References', () => findReferences().catch((err) => notify('error', err.message)), { key: 'shift+f12', when: hasEd, category: 'Go' });
  C('editor.action.rename', 'Rename Symbol…', () => renameSymbol().catch((err) => notify('error', err.message)), { key: 'ctrl+r ctrl+r', when: hasEd, category: 'Editor' });
  C('editor.action.nextMatchFindAction', 'Find Next', () => findStep(1), { key: 'f3', when: hasEd, category: 'Editor' });
  C('editor.action.previousMatchFindAction', 'Find Previous', () => findStep(-1), { key: 'shift+f3', when: hasEd, category: 'Editor' });
  C('closeFindWidget', 'Close Find Widget', () => closeFind(true), { key: 'escape', when: () => !!I.find?.open && I.active?.view.contains(document.activeElement), hidden: true });
  C('undo', 'Undo', () => { I.active?.ed?.focus(); I.active?.ed?.undo(); }, { when: hasEd, category: 'Edit', hidden: true });
  C('redo', 'Redo', () => { I.active?.ed?.focus(); I.active?.ed?.redo(); }, { when: hasEd, category: 'Edit', hidden: true });
  C('editor.action.selectAll', 'Select All', () => { const ed = I.active?.ed; if (ed) ed.select(0, ed.text().length); }, { when: hasEd, category: 'Selection', hidden: true });
  C('editor.action.commentLine', 'Toggle Line Comment', () => {
    const ta = I.active?.view.querySelector('.code-ta');
    if (!ta) return;
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'Slash', ctrlKey: !IS_MAC, metaKey: IS_MAC, bubbles: true, cancelable: true }));
  }, { when: hasEd, category: 'Editor' });
  const L = (id, title, fn, key, alt) => C(id, title, () => lineCmd(LINE_CMDS[fn]), { key, alt, when: edFocused, category: 'Editor' });
  L('editor.action.moveLinesUpAction', 'Move Line Up', 'moveUp', 'alt+up');
  L('editor.action.moveLinesDownAction', 'Move Line Down', 'moveDown', 'alt+down');
  L('editor.action.copyLinesUpAction', 'Copy Line Up', 'copyUp', 'shift+alt+up');
  L('editor.action.copyLinesDownAction', 'Copy Line Down', 'copyDown', 'shift+alt+down');
  L('editor.action.deleteLines', 'Delete Line', 'deleteLines', 'ctrl+shift+k');
  L('editor.action.insertLineAfter', 'Insert Line Below', 'insertBelow', 'ctrl+enter');
  L('editor.action.insertLineBefore', 'Insert Line Above', 'insertAbove', 'ctrl+shift+enter');
  L('expandLineSelection', 'Expand Line Selection', 'selectLine', 'ctrl+l');
  L('editor.action.duplicateSelection', 'Duplicate Selection', 'duplicate', '');
  L('editor.action.indentLines', 'Indent Line', 'indent', 'ctrl+]');
  L('editor.action.outdentLines', 'Outdent Line', 'outdent', 'ctrl+[');
  L('editor.action.trimTrailingWhitespace', 'Trim Trailing Whitespace', 'trimTrailing', 'ctrl+k ctrl+x');
  L('editor.action.sortLinesAscending', 'Sort Lines Ascending', 'sortAsc', '');
  L('editor.action.sortLinesDescending', 'Sort Lines Descending', 'sortDesc', '');
  L('editor.action.transformToUppercase', 'Transform to Uppercase', 'upper', '');
  L('editor.action.transformToLowercase', 'Transform to Lowercase', 'lower', '');
  L('editor.action.transformToTitlecase', 'Transform to Title Case', 'title', '');
  L('editor.action.joinLines', 'Join Lines', 'joinLines', '');
  for (const id of ['editor.action.duplicateSelection', 'editor.action.sortLinesAscending', 'editor.action.sortLinesDescending', 'editor.action.transformToUppercase',
    'editor.action.transformToLowercase', 'editor.action.transformToTitlecase', 'editor.action.joinLines', 'editor.action.trimTrailingWhitespace']) I.commands.get(id).when = hasEd;
  C('editor.action.marker.next', 'Go to Next Problem (Error, Warning, Info)', () => nextProblem(1), { key: 'f8', when: hasEd, category: 'Go' });
  C('editor.action.marker.prev', 'Go to Previous Problem (Error, Warning, Info)', () => nextProblem(-1), { key: 'shift+f8', when: hasEd, category: 'Go' });
  C('markdown.showPreview', 'Markdown: Toggle Preview', () => { I.active?.ed?.preview?.(); paintTabActions(); }, { key: 'ctrl+shift+v', when: () => !!I.active?.ed?.preview, category: 'Markdown' });
  const zoom = (d) => { setSetting('editor.fontSize', d ? Math.max(8, Math.min(40, setting('editor.fontSize') + d)) : SETTINGS['editor.fontSize'].def); };
  C('editor.action.fontZoomIn', 'Editor Font Zoom In', () => zoom(1), { key: 'ctrl+=', category: 'View' });
  C('editor.action.fontZoomOut', 'Editor Font Zoom Out', () => zoom(-1), { key: 'ctrl+-', category: 'View' });
  C('editor.action.fontZoomReset', 'Editor Font Zoom Reset', () => zoom(0), { key: 'ctrl+0', category: 'View' });
  // terminals and runs
  C('workbench.action.terminal.toggleTerminal', 'Toggle Terminal', () => toggleTerminal(), { key: 'ctrl+`', category: 'Terminal', shell: true });
  C('workbench.action.terminal.new', 'Create New Terminal', () => newTerminal(), { key: 'ctrl+shift+`', category: 'Terminal', shell: true });
  C('workbench.action.terminal.newOn', 'Create New Terminal On…', () => pickHost('Open a terminal on…').then((h) => h && newTerminal({ host: h })), { category: 'Terminal' });
  C('workbench.action.terminal.kill', 'Kill the Active Terminal Instance', () => I.term && killTerm(I.term), { category: 'Terminal' });
  C('workbench.action.terminal.clear', 'Clear', () => I.term?.h.clear(), { category: 'Terminal' });
  C('workbench.action.terminal.rename', 'Rename…', () => I.term && renameTerm(I.term), { category: 'Terminal' });
  C('workbench.action.terminal.focusNext', 'Focus Next Terminal', () => stepTerm(1), { category: 'Terminal', shell: true });
  C('workbench.action.terminal.focusPrevious', 'Focus Previous Terminal', () => stepTerm(-1), { category: 'Terminal', shell: true });
  C('workbench.action.terminal.runSelectedText', 'Run Selected Text In Active Terminal', () => runSelection(), { when: hasEd, category: 'Terminal' });
  C('sulfur.run.context', 'Run Active Target', () => runActiveContext().catch((err) => notify('error', err.message)), { key: 'f5', category: 'Run', shell: true });
  C('sulfur.run.file', 'Run Active File', () => (I.active?.rel ? runFile(I.active.rel) : notify('info', 'Open a file to run it.')), { category: 'Run', shell: true });
  // Visual Studio's Ctrl+F5: the project built and its startup item run
  C('sulfur.run.start', 'Start Without Debugging', () => startProject().catch((err) => notify('error', err.message)), { key: 'ctrl+f5', category: 'Run', shell: true });
  C('sulfur.run.startup', 'Select Startup Item…', () => startProject(true).catch((err) => notify('error', err.message)), { category: 'Run' });
  C('sulfur.run.fileOn', 'Run Active File On…', () => I.active?.rel && runFileOn(I.active.rel), { when: hasEd, category: 'Run' });
  // building, as VS Code's tasks are but asked for in a list, never a JSON file first
  C('sulfur.build', 'Build', () => buildProject(), { key: 'ctrl+b', alt: ['ctrl+shift+b'], category: 'Build', shell: true });
  C('sulfur.build.select', 'Select Toolchain…', () => pickToolchain(null, true), { category: 'Build' });
  C('sulfur.task.run', 'Run Task…', () => chooseTask(), { category: 'Build' });
  C('sulfur.task.add', 'Add Task…', () => addTask(), { category: 'Build' });
  C('sulfur.build.configuration', 'Select Configuration…', () => toggleConfiguration(), { category: 'Build' });
  C('sulfur.build.editJson', 'Open Build Settings (JSON)', () => openBuildJson(), { category: 'Build' });
  C('sulfur.toolchains.refresh', 'Look at Every Machine’s Toolchains Again', () => { I.tc = new Map(); paintRunView(true); }, { category: 'Build' });
  // projects: anywhere on the mesh, carried between machines
  C('sulfur.project.new', 'New Project…', () => newProject(), { key: 'ctrl+alt+shift+n', category: 'File' });
  C('sulfur.project.transfer', 'Copy or Move Project to Another Machine…', () => transferProject(), { category: 'File' });
  C('sulfur.folder.add', 'Add a Folder of a Machine for Projects…', () => addFolderDialog(), { when: () => !!acct.admin && !localDesktop(), category: 'File' });
  // the desktop app's start pane again: offline, or another mesh
  C('sulfur.mesh.connect', 'Connect to a Phosphorus Mesh…', () => meshConnect(), { when: () => !!standalone?.app, category: 'Mesh' });
  C('sulfur.mesh.other', 'Connect to Another Phosphorus Mesh…', () => meshConnect(true), { when: () => !!standalone?.app, category: 'Mesh' });
  C('sulfur.mesh.open', 'Open the Mesh’s Machines', () => meshOpen(), { when: () => !!standalone?.app && localDesktop() && !!standalone.meshUser, category: 'Mesh' });
  C('sulfur.mesh.signOut', 'Sign Out of the Mesh', () => meshSignOut(), { when: () => !!standalone?.app && !!standalone.meshUser, category: 'Mesh' });
  C('workbench.action.selectTheme', 'Color Theme', () => pickTheme(), { key: 'ctrl+k ctrl+t', category: 'Preferences' });
  C('workbench.action.toggleLightDarkThemes', 'Toggle between Light and Dark', () => setSetting('window.appearance', document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'), { when: () => !!standalone, category: 'Preferences' });
  C('sulfur.selectHost', 'Select Host for Terminals and Runs…', () => pickHost('Select the host terminals and runs use').then((h) => h && setRunHost(h)), { category: 'Phosphorus' });
  // preferences and help
  C('workbench.action.openSettings', 'Open Settings (UI)', () => openSettings(), { key: 'ctrl+,', category: 'Preferences', shell: true });
  C('workbench.action.openSettingsJson', 'Open User Settings (JSON)', () => openUserFile(SETTINGS_PATH(), '{\n  // your Sulfur settings, VS Code’s names: see Preferences: Open Settings (UI)\n}\n'), { category: 'Preferences' });
  C('workbench.action.openGlobalKeybindings', 'Open Keyboard Shortcuts', () => openKeysPage(), { key: 'ctrl+k ctrl+s', category: 'Preferences' });
  C('workbench.action.openGlobalKeybindingsFile', 'Open Keyboard Shortcuts (JSON)', () => openUserFile(KEYS_PATH(), '// your keys, each {"key": "ctrl+alt+r", "command": "ide.run.file"}; a "-command" removes a default\n[\n]\n'), { category: 'Preferences' });
  C('workbench.action.openWalkthrough', 'Welcome', () => openWelcome(), { category: 'Help' });
  C('sulfur.update', 'Check for Updates…', () => checkUpdate(true), { when: () => !!standalone?.app, category: 'Sulfur' });
  C('sulfur.about', 'About', () => ask({ title: 'Sulfur', detail: localDesktop()
    ? `Sulfur ${standalone.info?.version || ''} on ${selfHost}.\nUser: ${acct.user}\nHome: ${hostPath(selfHost, 'home', acct.user)}`
    : `A VS Code-shaped workbench over your phosphorus home.\nUser: ${acct.user}\nServed by: ${selfHost}\nHosts online: ${homeOnline().join(', ')}\nTerminals on: ${dkLiveHosts().join(', ') || 'none logged into'}`, buttons: [{ label: 'OK', primary: true, value: 'ok' }] }), { category: 'Help' });
  // extensions
  C('sulfur.extensions.guide', 'Open the Extension Guide', () => openGuide(), { category: 'Extensions' });
  C('sulfur.extensions.create', 'Create New Extension…', () => createExtension(), { category: 'Extensions' });
  C('workbench.extensions.action.refreshExtension', 'Reload Extensions', () => loadExtensions(true), { category: 'Developer' });
  C('workbench.action.reloadWindow', 'Reload Window', () => { const w = I.w; const open = { dir: I.st.root }; teardown(); ideStart(w, open); }, { category: 'Developer' });
  buildKeys();
}

function stepTab(d) {
  if (I.tabs.length < 2 || !I.active) return;
  const i = I.tabs.indexOf(I.active);
  activate(I.tabs[(i + d + I.tabs.length) % I.tabs.length]);
}

// --- the quick input: files, commands, a line, a choice -----------------------------------

// subsequence match, word starts and runs scored up, the base name before the path
function fuzzy(q, s) {
  if (!q) return { score: 0, hl: [] };
  const ql = q.toLowerCase();
  const sl = s.toLowerCase();
  let qi = 0;
  let score = 0;
  let run = 0;
  const hl = [];
  for (let i = 0; i < s.length && qi < ql.length; i++) {
    if (sl[i] !== ql[qi]) { run = 0; continue; }
    const start = i === 0 || /[\s/_.\-]/.test(s[i - 1]) || (s[i] !== sl[i] && s[i - 1] === sl[i - 1]);
    score += 1 + (start ? 8 : 0) + run * 5;
    run += 1;
    if (hl.length && hl.at(-1)[1] === i) hl.at(-1)[1] = i + 1; else hl.push([i, i + 1]);
    qi += 1;
  }
  return qi === ql.length ? { score: score - s.length * 0.01, hl } : null;
}
function hlText(text, hl = []) {
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const [a, b] of hl) {
    if (a > at) frag.append(text.slice(at, a));
    frag.append(el('b', 'ide-hl', text.slice(a, b)));
    at = b;
  }
  frag.append(text.slice(at));
  return frag;
}

// the workspace's files on every online host, for quick open: read once, kept a while
async function fileIndex() {
  const root = wsKey();
  if (I.index && I.index.root === root && Date.now() - I.index.at < INDEX_TTL) return I.index;
  if (I.indexing?.root === root) return I.indexing.pr;
  const places = isHomeLoc() ? homeOnline().map((h) => [h, homeAt(h)]) : [[locOf().host, apiLoc()]];
  const pr = Promise.all(places.map(([h, at]) => filesCall(at, 'tree', undefined, { path: I.st.root, depth: 8, skip: searchSkip() }).then((b) => ({ h, b }), () => null))).then((got) => {
    const files = new Map();
    let truncated = false;
    const skip = excluded();
    for (const g of got) {
      if (!g) continue;
      truncated ||= !!g.b.truncated;
      for (const e of g.b.entries || []) {
        if (e.path.endsWith('/')) continue;
        if (e.path.split('/').some(skip)) continue;
        const x = files.get(e.path) || { path: e.path, hosts: [] };
        x.hosts.push(g.h);
        files.set(e.path, x);
      }
    }
    const idx = { root, at: Date.now(), files: [...files.values()], truncated };
    if (I) { I.index = idx; I.indexing = null; }
    return idx;
  });
  I.indexing = { root, pr };
  return pr;
}

// value's first character picks the mode: > commands, : a line, ? help, else files
function quickOpen(value = '') {
  fileIndex().catch(() => {});
  quick({
    value,
    placeholder: 'Search files by name (append : to go to a line)',
    provide: (v) => {
      if (v.startsWith('>')) return commandItems(v.slice(1).trim());
      if (v.startsWith(':')) return gotoItems(v.slice(1).trim());
      if (v.startsWith('?')) return helpItems();
      return fileItems(v.trim());
    },
  });
}

function commandItems(q) {
  const cmds = [...I.commands.values()].filter((c) => !c.hidden && (!c.when || c.when()));
  const label = (c) => (c.category ? `${c.category}: ${c.title}` : c.title);
  const recent = (I.st.recentCmds || []).map((id) => I.commands.get(id)).filter((c) => c && cmds.includes(c));
  const item = (c, m, sep) => ({ label: label(c), hl: m?.hl, key: keyFor(c.id), sep, detail: c.ext ? `from ${c.ext}` : '', accept: () => run(c.id) });
  if (!q) {
    const rest = cmds.filter((c) => !recent.includes(c)).sort((a, b) => label(a).localeCompare(label(b)));
    return { items: [...recent.map((c, i) => item(c, null, i === 0 ? 'recently used' : '')), ...rest.map((c, i) => item(c, null, i === 0 && recent.length ? 'other commands' : ''))], placeholder: 'Type the name of a command to run.' };
  }
  const hits = cmds.map((c) => ({ c, m: fuzzy(q, label(c)) || (c.id.includes(q) ? { score: -1, hl: [] } : null) })).filter((x) => x.m);
  hits.sort((a, b) => (recent.includes(b.c) - recent.includes(a.c)) || b.m.score - a.m.score);
  return { items: hits.map((x) => item(x.c, x.m)), empty: 'No matching commands' };
}

function gotoItems(q) {
  const t = I.active;
  if (!t?.ed) return { items: [], empty: 'Open a text editor first to go to a line.' };
  const text = t.ed.text();
  const lines = text.split('\n').length;
  const m = q.match(/^(\d+)?(?:[:,](\d+))?$/);
  if (!q || !m || !m[1]) return { items: [], message: `Current Line: ${t.info?.line || 1}, Character: ${t.info?.col || 1}. Type a line number between 1 and ${lines} to navigate to.` };
  const line = Math.min(Number(m[1]), lines);
  const col = Number(m[2] || 1);
  return { items: [{ label: m[2] ? `Go to line ${line}, character ${col}.` : `Go to line ${line}.`, accept: () => { const at = offsetOf(text, line, col); t.ed.select(at, at); } }] };
}

function helpItems() {
  return { items: [
    { label: '…', description: 'Go to File', accept: () => quickOpen('') , keep: true },
    { label: '>', description: 'Show and Run Commands', accept: () => quickOpen('>'), keep: true },
    { label: ':', description: 'Go to Line/Column', accept: () => quickOpen(':'), keep: true },
  ] };
}

function fileItems(q) {
  const [name, line] = q.split(':');
  const go = (p, hosts) => () => openFile(p, { preview: false, host: hosts?.includes(selfHost) ? selfHost : hosts?.[0], line: Number(line) || undefined });
  const rel = (p) => (under(p, I.st.root) ? p.slice(I.st.root.length + 1) : p);
  if (!name) {
    const here = I.st.recent.map(keptLoc).filter((x) => x.rel && sameLoc(x.loc, locOf()) && inScope(x.rel));
    const items = here.slice(0, 30).map((x, i) => ({ label: baseName(x.rel), description: filesParent(rel(x.rel)), ic: x.rel, sep: i === 0 ? 'recently opened' : '', accept: go(x.rel) }));
    return { items, empty: 'Type to search the workspace’s files' };
  }
  if (!I.index || I.index.root !== wsKey()) {
    return { items: [], message: 'Searching the workspace on every host…', wait: fileIndex().then(() => fileItems(q)) };
  }
  const hits = [];
  for (const f of I.index.files) {
    const r = rel(f.path);
    const b = baseName(r);
    const mb = fuzzy(name, b);
    const m = mb ? { score: mb.score + 100, hl: mb.hl } : fuzzy(name.replace(/\\/g, '/'), r);
    if (m) hits.push({ f, r, b, m, inBase: !!mb });
  }
  hits.sort((a, b) => b.m.score - a.m.score || a.r.length - b.r.length);
  const items = hits.slice(0, 200).map((x) => ({
    label: x.b, hl: x.inBase ? x.m.hl : [], description: filesParent(x.r), ic: x.f.path,
    detail: x.f.hosts.length > 1 ? '' : `on ${x.f.hosts[0]}`, accept: go(x.f.path, x.f.hosts),
  }));
  return { items, empty: `No matching results${I.index.truncated ? ' (the workspace is too big to list whole)' : ''}`, message: I.index.truncated ? 'Only the first 2000 entries per host are searched.' : '' };
}

// a generic choice, as an extension's showQuickPick asks; resolves the item or undefined
function pick(items, o = {}) {
  return new Promise((resolve) => {
    quick({
      placeholder: o.placeholder || '', title: o.title, value: o.value || '',
      provide: (v) => {
        const q = v.trim();
        const list = items.map((x) => (typeof x === 'string' ? { label: x, value: x } : x));
        const hits = q ? list.map((x) => ({ x, m: fuzzy(q, x.label) || (o.matchDescription && x.description && fuzzy(q, x.description) ? { score: -1, hl: [] } : null) })).filter((y) => y.m).sort((a, b) => b.m.score - a.m.score) : list.map((x) => ({ x, m: null }));
        // a row of what was typed itself, as a path: the picker's own say
        const own = q && o.typed ? o.typed(q) : null;
        const rows = [...(own ? [{ x: own, m: null }] : []), ...hits];
        return { items: rows.map(({ x, m }) => ({ ...x, hl: m?.hl, accept: () => resolve(x.value !== undefined ? x.value : x) })), empty: 'No matching results' };
      },
      onCancel: () => resolve(undefined),
    });
  });
}

// one line typed, as an extension's showInputBox asks; validate returns a refusal or ''
function inputBox(o = {}) {
  return new Promise((resolve) => {
    quick({
      value: o.value || '', placeholder: o.placeholder || '', title: o.title, select: o.select, password: o.password,
      provide: (v) => {
        const why = o.validate?.(v) || '';
        return { items: [], message: why || `${o.prompt || ''}${o.prompt ? ' ' : ''}(Press 'Enter' to confirm or 'Escape' to cancel)`, bad: !!why, accept: why ? null : () => resolve(v) };
      },
      onCancel: () => resolve(undefined),
    });
  });
}

function quick(o) {
  closeQuick(true);
  const box = el('div', 'ide-quick');
  box.setAttribute('role', 'dialog');
  const title = el('div', 'ide-quick-title', o.title || '');
  title.hidden = !o.title;
  const input = Object.assign(el('input', 'ide-input ide-quick-input'), { value: o.value || '', placeholder: o.placeholder || '', spellcheck: false, autocomplete: 'off', type: o.password ? 'password' : 'text' });
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  const msg = el('div', 'ide-quick-msg');
  const list = el('div', 'ide-quick-list');
  list.setAttribute('role', 'listbox');
  list.id = `ide-ql-${(I.seq += 1)}`;
  input.setAttribute('aria-controls', list.id);
  box.append(title, input, msg, list);
  I.layer.append(box);
  const q = { box, input, list, msg, items: [], at: 0, o, gen: 0, accept: null };
  I.quick = q;
  const paint = () => {
    const gen = (q.gen += 1);
    const res = o.provide(input.value);
    const show = (r) => {
      if (gen !== q.gen || I?.quick !== q) return;
      q.items = r.items || [];
      q.accept = r.accept || null;
      q.at = 0;
      msg.textContent = r.message || (!q.items.length ? r.empty || '' : '');
      msg.hidden = !msg.textContent;
      msg.classList.toggle('bad', !!r.bad);
      list.replaceChildren(...q.items.slice(0, 500).map((x, i) => {
        const row = el('div', `ide-qi${x.sep ? ' sep' : ''}`);
        row.id = `${list.id}-${i}`;
        row.setAttribute('role', 'option');
        if (x.sep) row.dataset.sep = x.sep;
        if (x.ic) row.append(IC[x.ic] ? icon(x.ic, 'ide-fi') : fileIcon(x.ic));
        const main = el('span', 'ide-qi-main');
        main.append(hlText(x.label, x.hl));
        if (x.description) main.append(el('span', 'ide-qi-desc', x.description));
        if (x.detail) main.append(el('span', 'ide-qi-detail', x.detail));
        row.append(main);
        if (x.key) { const k = el('span', 'ide-qi-key'); k.append(...x.key.split(' ').map((part) => el('kbd', '', keyLabel(part)))); row.append(k); }
        row.addEventListener('pointermove', () => { if (q.at !== i) { q.at = i; mark(); } });
        row.addEventListener('pointerdown', (e) => e.preventDefault());
        row.addEventListener('click', () => accept(i));
        return row;
      }));
      mark();
      if (r.wait) r.wait.then((next) => { if (I?.quick === q && gen === q.gen) show(next); });
    };
    show(res);
  };
  const mark = () => {
    const rows = list.children;
    for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('on', i === q.at);
    const r = rows[q.at];
    input.setAttribute('aria-activedescendant', r ? r.id : '');
    r?.scrollIntoView({ block: 'nearest' });
  };
  const accept = (i) => {
    const x = q.items[i];
    const fn = x ? x.accept : q.accept;
    if (!fn) return;
    if (!x?.keep) { q.o.onCancel = null; closeQuick(); }
    fn();
  };
  input.addEventListener('input', paint);
  input.addEventListener('keydown', (e) => {
    const n = Math.min(q.items.length, 500);
    if (e.key === 'ArrowDown') { e.preventDefault(); if (n) { q.at = (q.at + 1) % n; mark(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) { q.at = (q.at - 1 + n) % n; mark(); } }
    else if (e.key === 'PageDown') { e.preventDefault(); q.at = Math.min(n - 1, q.at + 10); mark(); }
    else if (e.key === 'PageUp') { e.preventDefault(); q.at = Math.max(0, q.at - 10); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); accept(q.at); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeQuick(); }
    else return;
    e.stopPropagation();
  });
  input.addEventListener('blur', () => setTimeout(() => { if (I?.quick === q && !box.contains(document.activeElement)) closeQuick(); }, 0));
  q.restore = document.activeElement;
  input.focus();
  if (o.select) input.setSelectionRange(o.select[0], o.select[1]);
  else if (o.value && !/^[>:?]$/.test(o.value)) input.select();
  else input.setSelectionRange(input.value.length, input.value.length);
  paint();
}

function closeQuick(replacing = false) {
  const q = I?.quick;
  if (!q) return;
  I.quick = null;
  q.box.remove();
  q.o.onCancel?.();
  q.o.onCancel = null;
  if (!replacing && q.restore?.isConnected && I.root.contains(q.restore)) q.restore.focus({ preventScroll: true });
}

// --- the folder and file dialog, as Phosphorus's Files: places on the side (this computer's
// home and drives, the mesh's home and each of its machines), a folder's contents beside
// them, its path typed or stepped up; the same whether offline or on a mesh

// every place the dialog offers, grouped: this computer, then the mesh's machines
function dialogPlaces() {
  const groups = [];
  const local = standalone?.localHost || '';
  const localUser = standalone?.info?.user || acct.user;
  const meshUser = standalone?.meshUser || acct.user;
  const live = new Set(dkLiveHosts());
  const sharesOf = (h) => hostsInfo[String(h).toLowerCase()]?.files?.shares || [];
  const drives = (h) => sharesOf(h).filter((sh) => !sh.home).map((sh) => ({ loc: { host: h, share: String(sh.id) }, dir: '', label: sh.label, ic: 'drive', perms: sh.perms || 'rwd' }));
  const ownHome = (h, user, label = 'Home') => {
    const sh = sharesOf(h).find((x) => x.home);
    return sh ? [{ loc: { host: h, share: String(sh.id) }, dir: user, label, ic: 'home', detail: hostPath(h, String(sh.id), user) }] : [];
  };
  if (localDesktop()) {
    groups.push({ head: `This Computer · ${local}`, items: [{ loc: HOME_LOC, dir: acct.user, label: 'Home', ic: 'home', detail: hostPath(selfHost, 'home', acct.user) }, ...drives(selfHost)] });
  } else if (local && live.has(local) && !homeOnline().includes(local)) {
    groups.push({ head: `This Computer · ${local}`, items: [...ownHome(local, localUser), ...drives(local)] });
  }
  const mesh = localDesktop() ? (meshLinked() ? meshName() : '') : meshName() || 'Mesh';
  if (mesh) {
    const items = localDesktop() ? [] : [{ loc: HOME_LOC, dir: acct.user, label: 'Home', ic: 'home', detail: 'synced across the mesh' }];
    const hosts = [...new Set([...(localDesktop() ? otherHosts() : homeOnline()), ...live])].filter((h) => h && h !== local).sort();
    for (const h of hosts) {
      if (!live.has(h)) { items.push({ host: h, label: h, ic: 'host', off: true, detail: `log in ${loginWhere()}` }); continue; }
      items.push({ host: h, label: h, ic: 'host', head: true });
      // a machine's own home where the mesh's isn't merged over it here
      if (localDesktop()) items.push(...ownHome(h, meshUser).map((x) => ({ ...x, sub: true })));
      items.push(...drives(h).map((x) => ({ ...x, sub: true })));
    }
    groups.push({ head: mesh, items });
    if (acct.admin && !localDesktop()) items.push({ label: 'Add a Folder of a Machine…', ic: 'plus', act: () => addFolderDialog(), detail: 'publish one, like D:\\Projects or ~/src' });
  } else if (standalone) {
    groups.push({ head: 'Phosphorus Mesh', items: [{ label: 'Log into your mesh…', ic: 'remote', run: () => run('sulfur.mesh.connect'), detail: 'its machines here too' }] });
  }
  return groups;
}

// a folder (or with files, a file) picked: { loc, rel }, null if cancelled
function fileDialog(o = {}) {
  return new Promise((resolve) => {
    if (!I) { resolve(null); return; }
    const files = !!o.files;
    const back = el('div', 'ide-dialog-back ide-fd-back');
    const box = Object.assign(el('div', 'ide-dialog ide-fd'), { tabIndex: -1 });
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const restore = document.activeElement;
    const btn = (ic, title, fn) => { const b = Object.assign(el('button', 'ide-fd-tool'), { type: 'button', title }); b.append(icon(ic)); b.addEventListener('click', fn); return b; };
    const title = el('div', 'ide-fd-title', o.title || (files ? 'Open File' : 'Open Folder'));
    const st = { loc: null, dir: '', entries: [], sel: '', back: [], fwd: [], err: '', busy: false, filter: '' };
    const backB = btn('left', 'Back', () => hist(-1));
    const fwdB = btn('right', 'Forward', () => hist(1));
    const upB = btn('up', 'Up a folder', () => up());
    const refB = btn('refresh', 'Refresh', () => load());
    const crumbs = el('div', 'ide-fd-crumbs');
    const find = Object.assign(el('input', 'ide-input ide-fd-find'), { placeholder: 'Filter', spellcheck: false, autocomplete: 'off' });
    const bar = el('div', 'ide-fd-bar');
    bar.append(backB, fwdB, upB, refB, crumbs, find);
    const side = el('nav', 'ide-fd-side');
    const list = Object.assign(el('div', 'ide-fd-list'), { tabIndex: 0 });
    list.setAttribute('role', 'listbox');
    const split = el('div', 'ide-fd-split');
    split.append(side, list);
    const path = Object.assign(el('input', 'ide-input ide-fd-path'), { spellcheck: false, autocomplete: 'off', placeholder: files ? 'A file’s whole path, or pick one' : 'A folder’s whole path, or pick one' });
    const note = el('div', 'ide-fd-note');
    const foot = el('div', 'ide-fd-foot');
    const sys = standalone?.app && standalone.nativePick && !o.noSystem ? Object.assign(el('button', 'ide-button secondary ide-fd-sys', 'System Dialog…'), { type: 'button', title: 'This computer’s own dialog' }) : null;
    const ok = Object.assign(el('button', 'ide-button', o.okLabel || (files ? 'Open' : 'Open Folder')), { type: 'button' });
    const cancel = Object.assign(el('button', 'ide-button secondary', 'Cancel'), { type: 'button' });
    const fbtns = el('div', 'ide-fd-btns');
    fbtns.append(...(sys ? [sys] : []), el('span', 'ide-fd-gap'), cancel, ok);
    foot.append(path, note, fbtns);
    box.append(title, bar, split, foot);
    back.append(box);
    I.layer.append(back);
    I.dialog = back;

    const done = (v) => {
      back.remove();
      if (I) I.dialog = null;
      if (I?.fdPaint === paintSide) I.fdPaint = null;
      restore?.focus?.({ preventScroll: true });
      resolve(v);
    };
    const where = () => (st.loc ? (isHomeLoc(st.loc) ? hostPath(localDesktop() ? selfHost : homePick(st.dir), 'home', st.dir) || st.dir : hostPath(st.loc.host, st.loc.share, st.dir)) : '');
    const hostOf = (l) => (isHomeLoc(l) ? (localDesktop() ? selfHost : homePick(st.dir)) : l.host);
    const go = (loc, dir, how = '') => {
      if (how !== 'hist' && st.loc) { st.back.push({ loc: st.loc, dir: st.dir }); st.fwd = []; }
      const from = st.loc && sameLoc(st.loc, loc) ? st.dir : null;
      pathDirty = false;
      st.loc = loc;
      st.dir = dir;
      st.sel = from !== null && filesParent(from) === dir ? baseName(from) : '';
      st.filter = '';
      find.value = '';
      return load();
    };
    const hist = (k) => {
      const from = k < 0 ? st.back : st.fwd;
      const to = k < 0 ? st.fwd : st.back;
      const at = from.pop();
      if (!at) return;
      to.push({ loc: st.loc, dir: st.dir });
      go(at.loc, at.dir, 'hist');
    };
    const up = () => { if (st.loc && st.dir) go(st.loc, st.dir.includes('/') ? filesParent(st.dir) : ''); };
    async function load() {
      paintSide();
      if (!st.loc) { paint(); return; }
      const want = `${st.loc.host}\n${st.loc.share}\n${st.dir}`;
      st.want = want;
      st.busy = true;
      st.err = '';
      paint();
      let entries = [];
      try {
        // the merged home's top, the user's own folder and what's shared with them
        if (isHomeLoc(st.loc) && !st.dir) entries = [{ name: acct.user, dir: true }, ...(localDesktop() ? [] : [{ name: 'shared', dir: true }])];
        else entries = (await filesCall(apiLoc(st.loc), 'list', undefined, { path: st.dir })).entries || [];
      } catch (err) { if (st.want === want) st.err = err.message; }
      if (!I || st.want !== want) return;
      st.entries = sortEntries(entries);
      st.busy = false;
      paint();
    }
    function paintSide() {
      const out = [];
      for (const g of dialogPlaces()) {
        out.push(el('div', 'ide-fd-head', g.head));
        for (const x of g.items) {
          const row = Object.assign(el(x.loc || x.run || x.act ? 'button' : 'div', `ide-fd-place${x.sub ? ' sub' : ''}${x.off ? ' off' : ''}${x.head ? ' host' : ''}`), x.loc || x.run || x.act ? { type: 'button' } : {});
          row.append(icon(x.ic || 'folder'), el('span', 'ide-fd-place-name', x.label));
          row.title = x.detail ? `${x.label} · ${x.detail}` : x.label;
          if (x.loc && st.loc && sameLoc(x.loc, st.loc) && (isHomeLoc(x.loc) ? under(st.dir, x.dir) || !st.dir : true)) row.classList.add('here');
          if (x.loc) row.addEventListener('click', () => go(x.loc, x.dir || ''));
          else if (x.run) row.addEventListener('click', () => { done(null); x.run(); });
          else if (x.act) row.addEventListener('click', async () => { const got = await x.act(); if (got && I) go(got, ''); });
          out.push(row);
        }
      }
      side.replaceChildren(...out);
    }
    I.fdPaint = paintSide;
    function paint() {
      backB.disabled = !st.back.length;
      fwdB.disabled = !st.fwd.length;
      upB.disabled = !st.loc || !st.dir;
      // the path bar: the place, then each folder, any one a jump
      const bits = [];
      if (st.loc) {
        const host = hostOf(st.loc);
        const top = Object.assign(el('button', 'ide-fd-crumb'), { type: 'button' });
        top.append(icon(isHomeLoc(st.loc) ? 'home' : 'host'), el('span', '', isHomeLoc(st.loc) ? (localDesktop() ? 'Home' : 'Home (mesh)') : `${host}: ${shareOf(host, st.loc.share)?.label || st.loc.share}`));
        top.addEventListener('click', () => go(st.loc, ''));
        bits.push(top);
        const segs = st.dir.split('/').filter(Boolean);
        segs.forEach((s, i) => {
          bits.push(icon('right', 'ide-fd-sep'));
          const b = Object.assign(el('button', 'ide-fd-crumb', s), { type: 'button' });
          b.addEventListener('click', () => go(st.loc, segs.slice(0, i + 1).join('/')));
          bits.push(b);
        });
      }
      crumbs.replaceChildren(...bits);
      crumbs.scrollLeft = crumbs.scrollWidth;
      const skip = excluded();
      const f = st.filter.toLowerCase();
      const shown = st.entries.filter((e) => (e.dir || files) && !skip(e.name) && (!f || e.name.toLowerCase().includes(f)));
      const rows = shown.map((e) => {
        const row = Object.assign(el('div', `ide-fd-row${e.dir ? ' dir' : ''}${e.name === st.sel ? ' sel' : ''}`), { title: e.name });
        row.setAttribute('role', 'option');
        row.dataset.name = e.name;
        row.append(e.dir ? icon('folder') : fileIcon(e.name), el('span', 'ide-fd-name', e.name), el('span', 'ide-fd-meta', e.dir ? '' : humanSize(e.size)));
        row.addEventListener('click', () => { pathDirty = false; st.sel = e.name; paintSel(); });
        row.addEventListener('dblclick', () => enter(e));
        return row;
      });
      if (!st.loc) rows.push(el('div', 'ide-fd-empty', 'Pick a place on the left.'));
      else if (st.busy && !st.entries.length) rows.push(el('div', 'ide-fd-empty', 'Loading…'));
      else if (st.err) rows.push(el('div', 'ide-fd-empty bad', st.err));
      else if (!shown.length) rows.push(el('div', 'ide-fd-empty', f ? 'Nothing matches.' : files ? 'An empty folder.' : 'No folders in here.'));
      list.replaceChildren(...rows);
      list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
      paintSel();
    }
    function paintSel() {
      for (const r of list.querySelectorAll('.ide-fd-row')) r.classList.toggle('sel', r.dataset.name === st.sel);
      const e = st.entries.find((x) => x.name === st.sel);
      const cur = where();
      const sep = isWinPath(cur) ? '\\' : '/';
      if (!pathDirty && document.activeElement !== path) path.value = e ? `${cur.replace(/[\\/]+$/, '')}${sep}${e.name}` : cur;
      // the folder Open takes: the one picked, else the one shown
      const target = pickTarget();
      ok.disabled = !target;
      note.textContent = !st.loc ? '' : target ? '' : o.skip?.(st.loc) ? 'Somewhere else than where it is now.' : files ? 'Pick a file.' : !st.dir ? 'Pick a folder in it, not the whole drive.' : '';
    }
    const pickTarget = () => {
      if (!st.loc) return null;
      const e = st.entries.find((x) => x.name === st.sel);
      if (files) return e && !e.dir ? { loc: st.loc, rel: filesJoin(st.dir, e.name) } : null;
      const rel = e?.dir ? filesJoin(st.dir, e.name) : st.dir;
      if (o.skip?.(st.loc)) return null;
      if (!rel) return o.allowRoot && !isHomeLoc(st.loc) ? { loc: st.loc, rel: '' } : null;
      return inScope(rel, st.loc) ? { loc: isHomeLoc(st.loc) ? HOME_LOC : st.loc, rel } : null;
    };
    const enter = (e) => {
      if (e.dir) go(st.loc, filesJoin(st.dir, e.name));
      else if (files) done({ loc: isHomeLoc(st.loc) ? HOME_LOC : st.loc, rel: filesJoin(st.dir, e.name) });
    };
    // Accept a typed path on Open as well as Enter; never silently open the
    // folder that happened to be selected before the path was typed.
    let pathDirty = false;
    const typed = async (open = false) => {
      const host = hostOf(st.loc || HOME_LOC);
      const user = host === standalone?.localHost ? standalone.info.user : standalone?.meshUser || acct.user;
      const v = path.value.trim().replace(/^~(?=[\\/]|$)/, () => hostPath(host, 'home', user));
      if (!v) return;
      const hosts = [...new Set([st.loc ? hostOf(st.loc) : '', standalone?.localHost, selfHost].filter(Boolean))];
      let at = null;
      for (const h of hosts) { at = standalone?.locate?.(v, h); if (at) break; }
      if (!at || o.skip?.(at.loc) || (at.rel && !inScope(at.rel, at.loc))) { note.textContent = `${v} isn't in a place Sulfur reaches.`; return; }
      try {
        await filesCall(apiLoc(at.loc), 'list', undefined, { path: at.rel });
        if (open && !files && (at.rel || o.allowRoot)) { done(at); return; }
        pathDirty = false;
        go(at.loc, at.rel);
      } catch {
        if (!files) { note.textContent = `Couldn't open folder ${v}.`; return; }
        const parent = filesParent(at.rel);
        const name = baseName(at.rel);
        try {
          const b = await filesCall(apiLoc(at.loc), 'list', undefined, { path: parent });
          if (!b.entries?.some((e) => e.name === name && !e.dir)) throw new Error('not a file');
          if (open) { done(at); return; }
          pathDirty = false;
          await go(at.loc, parent);
          st.sel = name;
          paintSel();
        } catch { note.textContent = `Couldn't open file ${v}.`; }
      }
    };
    path.addEventListener('input', () => { pathDirty = true; ok.disabled = !path.value.trim(); });
    ok.addEventListener('click', () => { if (pathDirty) { typed(true); return; } const t = pickTarget(); if (t) done(t); });
    cancel.addEventListener('click', () => done(null));
    sys?.addEventListener('click', async () => {
      const got = await nativeOpen(!files, o.title || (files ? 'Open File' : 'Open Folder'));
      if (got) done({ loc: got.loc, rel: got.rel });
    });
    find.addEventListener('input', () => { st.filter = find.value.trim(); paint(); });
    path.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); typed(); } });
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); done(null); return; }
      if (e.target === path || e.target === find) { if (e.target === find && e.key === 'ArrowDown') { e.preventDefault(); list.focus(); } return; }
      if (e.target.closest('button')) return;
      const rows = [...list.querySelectorAll('.ide-fd-row')];
      const i = rows.findIndex((r) => r.dataset.name === st.sel);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (n) { st.sel = n.dataset.name; paintSel(); n.scrollIntoView({ block: 'nearest' }); }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const x = st.entries.find((y) => y.name === st.sel);
        if (x && (x.dir || files)) enter(x); else { const t = pickTarget(); if (t) done(t); }
      } else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) { e.preventDefault(); up(); }
      else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); hist(-1); }
      else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); hist(1); }
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // typed letters jump to the next name starting so
        const k = e.key.toLowerCase();
        const n = [...rows.slice(i + 1), ...rows.slice(0, i + 1)].find((r) => r.dataset.name.toLowerCase().startsWith(k));
        if (n) { st.sel = n.dataset.name; paintSel(); n.scrollIntoView({ block: 'nearest' }); }
      }
    });
    back.addEventListener('pointerdown', (e) => { if (e.target === back) { e.preventDefault(); box.classList.add('shake'); setTimeout(() => box.classList.remove('shake'), 300); } });
    // where it opens: the folder asked for, else the workspace's, else the first place
    const start = o.start || (I.st.root ? { loc: locOf(), dir: files && I.active?.rel && sameLoc(I.active.loc, locOf()) ? filesParent(I.active.rel) : I.st.root } : null);
    const first = dialogPlaces().flatMap((g) => g.items).find((x) => x.loc);
    if (start?.loc) go(start.loc, start.dir || '');
    else if (first) go(first.loc, first.dir || '');
    else load();
    list.focus({ preventScroll: true });
  });
}

// Open Folder: the dialog, offline or on a mesh alike
async function pickFolder(start, l = locOf()) {
  const at = await fileDialog({ title: 'Open Folder', start: start != null ? { loc: l, dir: start } : null });
  if (at && I) setRoot(at.rel, false, at.loc);
}

function recentItems() {
  const rk = (x) => (typeof x === 'string' ? { loc: HOME_LOC, root: x } : { loc: x.loc || HOME_LOC, root: x.root });
  const folders = (I.st.recentFolders || []).map(rk).filter((x) => inScope(x.root, x.loc))
    .map((x) => ({ label: baseName(x.root), description: isHomeLoc(x.loc) ? x.root : `${x.loc.host}: ${hostPath(x.loc.host, x.loc.share, x.root) || x.root}`, ic: 'folder', run: () => setRoot(x.root, false, x.loc) }));
  const files = (I.st.recent || []).map(keptLoc).filter((x) => x.rel && inScope(x.rel, x.loc)).slice(0, 10)
    .map((x) => ({ label: baseName(x.rel), description: filesParent(x.rel), ic: x.rel, run: () => openFile(x.rel, { preview: false, loc: x.loc }) }));
  const out = [...folders, ...(folders.length && files.length ? ['-'] : []), ...files];
  return out.length ? out : [{ label: 'Nothing opened yet', disabled: true }];
}

// --- menus: the title bar's, a right click's, a breadcrumb's --------------------------------

const cmdItem = (id, label, checked) => ({
  label, key: keyFor(id), checked, run: () => run(id),
  disabled: (() => { const c = I.commands.get(id); return !c || (c.when ? !c.when() : false); })(),
});

// at: an element (below it, or beside with side) or {x, y}
function menu(at, items, o = {}) {
  closeMenu();
  const m = { anchor: at instanceof Element ? at : null, bar: o.bar, onClose: o.onClose, subs: [] };
  I.menuOpen = m;
  const node = open(items, at, o, 0);
  m.node = node;
  const away = (e) => { if (![node, ...m.subs.map((s) => s.node)].some((n) => n.contains(e.target)) && !(m.anchor && m.anchor.contains(e.target))) closeMenu(); };
  document.addEventListener('pointerdown', away, true);
  m.off = () => document.removeEventListener('pointerdown', away, true);
  if (o.focusFirst || !(at instanceof Element) || o.search) focusItem(node, 0);
  else node.focus({ preventScroll: true });

  function open(list, anchor, opts, depth) {
    const box = Object.assign(el('div', 'ide-menu'), { tabIndex: -1 });
    box.setAttribute('role', 'menu');
    let filter = null;
    if (opts.search) {
      filter = Object.assign(el('input', 'ide-input ide-menu-filter'), { placeholder: 'Filter', spellcheck: false });
      box.append(filter);
    }
    const rows = [];
    const clean = list.filter(Boolean).reduce((out, x) => (x === '-' && (!out.length || out.at(-1) === '-') ? out : [...out, x]), []);
    if (clean.at(-1) === '-') clean.pop();
    for (const x of clean) {
      if (x === '-') { box.append(el('div', 'ide-menu-sep')); continue; }
      const row = Object.assign(el('div', `ide-mi${x.disabled ? ' disabled' : ''}${x.danger ? ' danger' : ''}`), { tabIndex: -1 });
      row.setAttribute('role', x.checked !== undefined ? 'menuitemcheckbox' : 'menuitem');
      if (x.checked !== undefined) row.setAttribute('aria-checked', String(!!x.checked));
      if (x.disabled) row.setAttribute('aria-disabled', 'true');
      const mark = el('span', 'ide-mi-check');
      if (x.checked) mark.append(icon('check'));
      else if (x.ic) mark.append(IC[x.ic] ? icon(x.ic, 'ide-fi') : fileIcon(x.ic));
      const lab = el('span', 'ide-mi-label', x.label);
      // a second line saying what it is, as VS Code's chat pickers have
      if (x.detail) { lab.append(el('span', 'ide-mi-detail', x.detail)); row.classList.add('two'); }
      row.append(mark, lab);
      if (x.key) row.append(el('span', 'ide-mi-key', keyLabel(x.key)));
      if (x.sub) { row.append(icon('right', 'ide-mi-sub')); row.setAttribute('aria-haspopup', 'true'); }
      row.item = x;
      row.addEventListener('pointerenter', () => {
        row.focus({ preventScroll: true });
        clearTimeout(m.hover);
        m.hover = setTimeout(() => { closeSubs(depth); if (x.sub && !x.disabled) openSub(row, x, depth); }, x.sub ? 150 : 250);
      });
      row.addEventListener('click', (e) => { e.stopPropagation(); choose(row, depth); });
      rows.push(row);
      box.append(row);
    }
    box.addEventListener('keydown', (e) => menuKey(e, box, depth, filter));
    if (filter) {
      filter.addEventListener('input', () => {
        const v = filter.value.toLowerCase();
        for (const r of rows) r.hidden = !!v && !r.item.label.toLowerCase().includes(v);
        focusItem(box, 0, true);
      });
    }
    I.layer.append(box);
    place(box, anchor, opts, depth);
    return box;
  }
  function place(box, anchor, opts, depth) {
    const R = I.root.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    let x;
    let y;
    if (anchor instanceof Element) {
      const a = anchor.getBoundingClientRect();
      if (depth > 0 || opts.side === 'right') { x = a.right; y = opts.up ? a.bottom - b.height : a.top - (depth ? 4 : 0); }
      else { x = a.left; y = a.bottom + 2; }
      if (depth > 0 && x + b.width > R.right) x = a.left - b.width;
    } else { x = anchor.x; y = anchor.y; }
    x = Math.max(R.left + 2, Math.min(x, R.right - b.width - 2));
    if (y + b.height > R.bottom - 2) y = Math.max(R.top + 2, (anchor instanceof Element && !depth && !opts.side ? anchor.getBoundingClientRect().top - b.height - 2 : R.bottom - b.height - 2));
    box.style.left = `${x - R.left}px`;
    box.style.top = `${y - R.top}px`;
    box.style.maxHeight = `${R.height - 8}px`;
  }
  function closeSubs(depth) {
    while (m.subs.length > depth) { const s = m.subs.pop(); s.node.remove(); s.row.classList.remove('open'); }
  }
  function openSub(row, x, depth) {
    closeSubs(depth);
    const node = open(x.sub(), row, {}, depth + 1);
    row.classList.add('open');
    m.subs.push({ node, row });
    return node;
  }
  function choose(row, depth) {
    const x = row.item;
    if (x.disabled) return;
    if (x.sub) { focusItem(openSub(row, x, depth), 0); return; }
    closeMenu();
    x.run?.();
  }
  function menuKey(e, box, depth, filter) {
    const items = [...box.querySelectorAll('.ide-mi:not(.disabled):not([hidden])')];
    const i = items.indexOf(document.activeElement);
    const k = e.key;
    if (k === 'ArrowDown') { e.preventDefault(); focusItem(box, i + 1); }
    else if (k === 'ArrowUp') { e.preventDefault(); focusItem(box, i < 0 ? items.length - 1 : i - 1); }
    else if (k === 'Home') { e.preventDefault(); focusItem(box, 0); }
    else if (k === 'End') { e.preventDefault(); focusItem(box, items.length - 1); }
    else if ((k === 'Enter' || (k === ' ' && !filter)) && i >= 0) { e.preventDefault(); choose(items[i], depth); }
    else if (k === 'ArrowRight' && items[i]?.item.sub) { e.preventDefault(); choose(items[i], depth); }
    else if (k === 'ArrowRight' && m.bar) { e.preventDefault(); stepBar(1); }
    else if (k === 'ArrowLeft' && depth > 0) { e.preventDefault(); const s = m.subs[depth - 1]; closeSubs(depth - 1); s.row.focus(); }
    else if (k === 'ArrowLeft' && m.bar) { e.preventDefault(); stepBar(-1); }
    else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); if (depth > 0) { const s = m.subs[depth - 1]; closeSubs(depth - 1); s.row.focus(); } else { const a = m.anchor; closeMenu(); a?.focus?.(); } }
    else if (k === 'Tab') { e.preventDefault(); }
    else return;
    e.stopPropagation();
  }
  function stepBar(d) {
    const tops = m.bar;
    const i = tops.indexOf(m.anchor);
    tops[(i + d + tops.length) % tops.length].openIt(true);
  }
}

function focusItem(box, i, keepFilter = false) {
  const items = [...box.querySelectorAll('.ide-mi:not(.disabled):not([hidden])')];
  if (!items.length) { if (!keepFilter) box.focus({ preventScroll: true }); return; }
  const n = items.length;
  const filter = box.querySelector('.ide-menu-filter');
  if (filter && keepFilter) { items.forEach((r, j) => r.classList.toggle('kbd', j === 0)); return; }
  items[((i % n) + n) % n].focus({ preventScroll: false });
}

function closeMenu() {
  const m = I?.menuOpen;
  if (!m) return;
  I.menuOpen = null;
  clearTimeout(m.hover);
  m.off?.();
  m.node?.remove();
  for (const s of m.subs) s.node.remove();
  m.onClose?.();
}

// --- dialogs and notifications ----------------------------------------------------------

// a modal question: resolves the value of the button pressed, '' for a cancel
function ask(o) {
  return new Promise((resolve) => {
    if (!I) { resolve(''); return; }
    const back = el('div', 'ide-dialog-back');
    const box = Object.assign(el('div', 'ide-dialog'), { tabIndex: -1 });
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');
    const head = el('div', 'ide-dialog-head');
    head.append(icon(o.buttons.some((b) => b.danger) ? 'warning' : 'info', `ide-dialog-ic${o.buttons.some((b) => b.danger) ? ' warn' : ''}`));
    const text = el('div', 'ide-dialog-text');
    const title = el('div', 'ide-dialog-title', o.title);
    title.id = `ide-dt-${(I.seq += 1)}`;
    box.setAttribute('aria-labelledby', title.id);
    text.append(title);
    if (o.detail) text.append(el('div', 'ide-dialog-detail', o.detail));
    head.append(text);
    box.append(head);
    let check = null;
    if (o.check) {
      const lab = el('label', 'ide-check');
      check = Object.assign(el('input'), { type: 'checkbox' });
      lab.append(check, el('span', '', o.check.label));
      box.append(lab);
    }
    const row = el('div', 'ide-dialog-btns');
    const done = (v) => {
      back.remove();
      I.dialog = null;
      if (check?.checked && v && o.check.key) setSetting(o.check.key, false);
      restore?.focus?.({ preventScroll: true });
      resolve(v);
    };
    for (const b of o.buttons) {
      const x = Object.assign(el('button', `ide-button${b.primary ? '' : ' secondary'}${b.danger ? ' danger' : ''}`, b.label), { type: 'button' });
      x.addEventListener('click', () => done(b.value));
      row.append(x);
    }
    box.append(row);
    back.append(box);
    back.addEventListener('pointerdown', (e) => { if (e.target === back) { e.preventDefault(); box.classList.add('shake'); setTimeout(() => box.classList.remove('shake'), 300); } });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(o.buttons.find((b) => !b.value) ? '' : o.buttons.at(-1).value); }
      else if (e.key === 'Tab') {
        const f = [...box.querySelectorAll('button, input')];
        const i = f.indexOf(document.activeElement);
        e.preventDefault();
        f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      }
      e.stopPropagation();
    });
    const restore = document.activeElement;
    closeMenu();
    closeQuick(true);
    I.layer.append(back);
    I.dialog = back;
    row.querySelector('.ide-button:not(.secondary)')?.focus() || row.firstChild?.focus();
  });
}

// --- the desktop app's own updates, off the signed feed on GitHub ---------------------------

async function checkUpdate(ask) {
  let r;
  try { r = await (await fetch('/api/sidecar/update', { cache: 'no-store' })).json(); } catch (err) { if (ask) notify('error', `Couldn’t check for updates: ${err.message}`); return; }
  if (!I) return;
  if (!r.latest) {
    if (ask) notify(r.error ? 'error' : 'info', r.error ? `Couldn’t check for updates: ${r.error}` : r.on ? `Sulfur ${r.version} is the latest.` : 'This build of Sulfur has no update feed.');
    return;
  }
  notify('info', `Sulfur ${r.latest} is available; you have ${r.version}.`, { sticky: true, actions: [{ label: 'Update and Restart', run: applyUpdate }, { label: 'Later' }] });
}

async function applyUpdate() {
  if (I.tabs.some((t) => t.ed?.dirty())) { notify('warning', 'Save or close your changed files first; the update restarts Sulfur.'); return; }
  const h = notify('info', 'Downloading the update…', { progress: true });
  let r;
  let b = {};
  try { r = await fetch('/api/sidecar/update', jsonPost({})); b = await r.json().catch(() => ({})); } catch (err) { b = { error: err.message }; }
  h.close();
  if (!I) return;
  if (!r?.ok) { notify('error', `The update failed: ${b.error || `status ${r?.status}`}`); return; }
  notify('info', `Sulfur ${b.version} is installing; it opens again in a moment.`);
  setTimeout(() => standalone.quit?.(), 800);
}

// a toast in the corner, kept in the bell's list; o: actions [{label, run}], sticky, progress
function notify(kind, text, o = {}) {
  const n = { id: (I ? (I.seq += 1) : 0), kind, text, at: Date.now(), source: o.source || '' };
  const handle = { close: () => {}, progress: () => {}, update: () => {} };
  if (!I) return handle;
  log(`[${kind}] ${o.source ? `${o.source}: ` : ''}${text}`);
  if (!o.progress) {
    I.notes.unshift(n);
    if (I.notes.length > 50) I.notes.length = 50;
    I.unseen = (I.unseen || 0) + 1;
  }
  let wrap = I.layer.querySelector('.ide-toasts');
  if (!wrap) { wrap = el('div', 'ide-toasts'); wrap.setAttribute('role', 'status'); I.layer.append(wrap); }
  const box = el('div', `ide-toast ${kind}`);
  const body = el('div', 'ide-toast-body');
  body.append(icon(kind === 'error' ? 'error' : kind === 'warning' ? 'warning' : 'info', `ide-toast-ic ${kind}`));
  const msg = el('span', 'ide-toast-text', text);
  body.append(msg);
  const x = btn('ide-toast-x', 'close', 'Clear Notification', () => close());
  body.append(x);
  box.append(body);
  if (o.source) box.append(el('div', 'ide-toast-source', `Source: ${o.source}`));
  const bar = el('div', 'ide-toast-bar');
  if (o.progress) box.append(bar);
  if (o.actions?.length) {
    const acts = el('div', 'ide-toast-acts');
    for (const a of o.actions) {
      const b = Object.assign(el('button', 'ide-button', a.label), { type: 'button' });
      b.addEventListener('click', () => { a.run?.(); close(); });
      acts.append(b);
    }
    box.append(acts);
  }
  wrap.append(box);
  while (wrap.children.length > 3) wrap.firstChild.remove();
  let timer = 0;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    box.classList.add('gone');
    setTimeout(() => box.remove(), 150);
    o.onClose?.();
    paintStatus();
  };
  const arm = () => { if (!o.sticky && kind !== 'error' && !o.actions?.length) timer = setTimeout(close, kind === 'warning' ? 12000 : 7000); };
  box.addEventListener('pointerenter', () => clearTimeout(timer));
  box.addEventListener('pointerleave', arm);
  arm();
  paintStatus();
  handle.close = close;
  handle.progress = (f) => { bar.style.setProperty('--p', `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`); };
  handle.update = (t) => { msg.textContent = t; };
  return handle;
}

function notesPopup(anchor) {
  I.unseen = 0;
  paintStatus();
  const items = I.notes.length ? I.notes.slice(0, 30).map((n) => ({ label: n.text, ic: n.kind === 'error' ? 'error' : n.kind === 'warning' ? 'warning' : 'info', run: () => {} })) : [{ label: 'No new notifications', disabled: true }];
  menu(anchor, [...items, '-', { label: 'Clear All Notifications', disabled: !I.notes.length, run: () => { I.notes = []; I.layer.querySelector('.ide-toasts')?.replaceChildren(); paintStatus(); } }], { side: 'right', up: true });
}

// --- the panel: problems, output, terminals ------------------------------------------------

const PANEL_VIEWS = [
  { id: 'problems', title: 'Problems', cmd: 'workbench.actions.view.problems' },
  { id: 'output', title: 'Output', cmd: 'workbench.action.output.toggleOutput' },
  { id: 'terminal', title: 'Terminal', cmd: 'workbench.action.terminal.toggleTerminal' },
];

function buildPanel() {
  for (const v of PANEL_VIEWS) {
    const tab = Object.assign(el('button', 'ide-ptab'), { type: 'button' });
    tab.setAttribute('role', 'tab');
    const label = el('span', '', v.title.toUpperCase());
    const badge = el('span', 'ide-badge');
    badge.hidden = true;
    tab.append(label, badge);
    tab.addEventListener('click', () => showPanel(v.id, true, true));
    const body = el('div', `ide-pview ide-pview-${v.id}`);
    body.hidden = true;
    I.panelTabs.append(tab);
    I.panelBody.append(body);
    I.panelViews.set(v.id, { ...v, tab, badge, body, acts: [] });
  }
  // problems
  const pv = I.panelViews.get('problems');
  pv.list = Object.assign(el('div', 'ide-problems'), { tabIndex: 0 });
  pv.list.setAttribute('role', 'tree');
  pv.body.append(pv.list);
  pv.acts = [btn('', 'collapse', 'Collapse All', () => { I.probShut = new Set(I.tabs.map((t) => t.rel).filter(Boolean)); paintProblems(); })];
  // output
  const ov = I.panelViews.get('output');
  ov.pick = el('select', 'ide-select');
  ov.pick.setAttribute('aria-label', 'Output channel');
  ov.pick.addEventListener('change', () => { I.outCh = ov.pick.value; paintOutput(true); });
  ov.text = Object.assign(el('pre', 'ide-output'), { tabIndex: 0 });
  ov.body.append(ov.text);
  ov.acts = [ov.pick, btn('', 'trash', 'Clear Output', () => { const ch = I.output.get(I.outCh); if (ch) ch.lines = []; paintOutput(true); })];
  // terminals: their views, and their list beside once there are two
  const tv = I.panelViews.get('terminal');
  tv.wrap = el('div', 'ide-term-wrap');
  tv.views = el('div', 'ide-term-views');
  tv.list = el('div', 'ide-term-list');
  tv.list.setAttribute('role', 'listbox');
  tv.empty = el('div', 'ide-term-empty');
  tv.wrap.append(tv.views, tv.list);
  tv.body.append(tv.wrap, tv.empty);
  const plus = btn('', 'plus', `New Terminal (${keyLabel('ctrl+shift+`')})`, () => newTerminal());
  const pickOn = btn('ide-btn-narrow', 'down', 'Launch Profile…', (e) => menu(e.currentTarget, [
    ...dkLiveHosts().sort().map((h) => ({ label: h, ic: 'host', checked: h === runHost() ? true : undefined, run: () => newTerminal({ host: h }) })),
    '-', { label: 'Select Default Host…', run: () => run('sulfur.selectHost') },
  ]));
  // one terminal killed from the title; with more, each from its own row
  tv.kill = btn('', 'trash', 'Kill Terminal', () => run('workbench.action.terminal.kill'));
  tv.acts = [plus, pickOn, tv.kill];
  I.panelMax = btn('', 'maximize', 'Maximize Panel Size', () => run('workbench.action.toggleMaximizedPanel'));
  I.panelClose = btn('', 'close', 'Hide Panel', () => showPanel(I.st.panel.view, false));
  I.output.set(I.outCh, { lines: [] });
  paintOutputChannels();
}

function showPanel(id, on = true, focus = false) {
  if (!I.panelViews.has(id)) id = 'terminal';
  const wasIn = I.panel.contains(document.activeElement);
  I.st.panel.view = id;
  I.st.panel.hidden = !on;
  for (const [k, v] of I.panelViews) {
    v.body.hidden = k !== id;
    v.tab.classList.toggle('on', k === id);
    v.tab.setAttribute('aria-selected', String(k === id));
    const key = keyLabel(keyFor(v.cmd));
    v.tab.title = key ? `${v.title} (${key})` : v.title;
  }
  const v = I.panelViews.get(id);
  I.panelMax.replaceChildren(icon(I.st.panel.max ? 'restore' : 'maximize'));
  I.panelMax.title = I.st.panel.max ? 'Restore Panel Size' : 'Maximize Panel Size';
  I.panelActs.replaceChildren(...v.acts, el('span', 'ide-act-sep'), I.panelMax, I.panelClose);
  paintLayout();
  if (on && focus) drawersAway();
  if (on && id === 'terminal') {
    paintTerms();
    if (!I.terms.length && dkLiveHosts().length && focus) newTerminal();
    else if (I.term) { if (focus) I.term.h.show(); else requestAnimationFrame(() => I.term?.h.fit()); }
  }
  if (on && id === 'problems') { paintProblems(); if (focus) v.list.focus(); }
  if (on && id === 'output') { paintOutput(true); if (focus) v.text.focus(); }
  if (!on && wasIn) focusActive();
}

// --- problems: the syntax errors of every open file --------------------------------------

const paintProblemsSoon = debounce(() => I && paintProblems(), 150);
function paintProblems() {
  const pv = I.panelViews.get('problems');
  // by file: the open files' syntax errors, then what the last build said
  const byFile = new Map();
  const at = (rel) => { if (!byFile.has(rel)) byFile.set(rel, []); return byFile.get(rel); };
  for (const t of I.tabs) {
    if (!t.info?.errors?.length || !sameLoc(t.loc, locOf())) continue;
    for (const x of t.info.errors.filter((e) => !e.source)) at(t.rel).push({ sev: 'error', msg: x.what, src: 'syntax', line: x.line, col: x.col, go: () => { activate(t); t.ed.select(x.from, Math.max(x.to, x.from + 1)); } });
  }
  for (const x of languages.problems()) {
    if (x.context.workspace !== wsKey()) continue;
    at(x.path).push({ sev: x.severity === 1 ? 'error' : x.severity === 2 ? 'warning' : 'info', msg: x.message, src: x.source || 'language server', line: x.range.start.line + 1, col: x.range.start.character + 1, go: () => openFile(x.path, { host: x.context.host, loc: x.context.loc, preview: false, line: x.range.start.line + 1, col: x.range.start.character + 1 }) });
  }
  for (const x of I.buildProblems || []) {
    at(x.rel).push({ sev: x.sev, msg: x.msg, src: x.code || 'build', line: x.line, col: x.col, go: () => openFile(x.rel, { preview: false, line: x.line, col: x.col }) });
  }
  const all = [...byFile.values()].flat();
  const errs = all.filter((x) => x.sev === 'error').length;
  pv.badge.hidden = !all.length;
  pv.badge.textContent = String(all.length);
  I.problemCounts = { errors: errs, warnings: all.filter((x) => x.sev === 'warning').length };
  paintStatus();
  if (pv.body.hidden) return;
  I.probShut ||= new Set();
  if (!all.length) {
    pv.list.replaceChildren(el('div', 'ide-empty-note', 'No problems have been detected in the open files or the last build.'));
    return;
  }
  const rows = [];
  const rank = { error: 0, warning: 1, info: 2 };
  for (const [rel, list] of [...byFile].sort((a, b) => a[0].localeCompare(b[0]))) {
    const open = !I.probShut.has(rel);
    const head = el('div', 'ide-prob-file');
    head.setAttribute('role', 'treeitem');
    head.setAttribute('aria-expanded', String(open));
    head.append(icon(open ? 'down' : 'right', 'ide-chev-ic'), fileIcon(rel), el('span', 'ide-prob-name', baseName(rel)), el('span', 'ide-prob-dir', filesParent(wsRel(rel))), el('span', 'ide-badge', String(list.length)));
    head.addEventListener('click', () => { if (open) I.probShut.add(rel); else I.probShut.delete(rel); paintProblems(); });
    rows.push(head);
    if (!open) continue;
    for (const x of [...list].sort((a, b) => rank[a.sev] - rank[b.sev] || a.line - b.line)) {
      const r = el('div', 'ide-prob');
      r.setAttribute('role', 'treeitem');
      r.append(icon(x.sev === 'warning' ? 'warning' : x.sev === 'info' ? 'info' : 'error', `ide-prob-ic ${x.sev}`), el('span', 'ide-prob-what', x.msg), el('span', 'ide-prob-src', x.src), el('span', 'ide-prob-at', `[Ln ${x.line}, Col ${x.col}]`));
      r.title = `${x.msg}
${rel}:${x.line}:${x.col}`;
      r.addEventListener('click', x.go);
      rows.push(r);
    }
  }
  pv.list.replaceChildren(...rows);
}

// --- output: the workbench's own log, and a channel per extension that asks -------------

function log(text, ch = 'Sulfur') {
  if (!I) return;
  let c = I.output.get(ch);
  if (!c) { c = { lines: [] }; I.output.set(ch, c); paintOutputChannels(); }
  const d = new Date();
  const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  for (const line of String(text).split('\n')) c.lines.push(ch === 'Sulfur' ? `${ts} ${line}` : line);
  if (c.lines.length > OUTPUT_MAX) c.lines.splice(0, c.lines.length - OUTPUT_MAX);
  if (I.outCh === ch) paintOutputSoon();
}
// a channel's raw text, an extension's appends not split into stamped lines
function outAppend(ch, text) {
  let c = I.output.get(ch);
  if (!c) { c = { lines: [''] }; I.output.set(ch, c); paintOutputChannels(); }
  if (!c.lines.length) c.lines.push('');
  const parts = String(text).split('\n');
  c.lines[c.lines.length - 1] += parts[0];
  c.lines.push(...parts.slice(1));
  if (c.lines.length > OUTPUT_MAX) c.lines.splice(0, c.lines.length - OUTPUT_MAX);
  if (I.outCh === ch) paintOutputSoon();
}
const paintOutputSoon = debounce(() => I && paintOutput(false), 60);
function paintOutput(jump) {
  const ov = I.panelViews.get('output');
  if (ov.body.hidden || I.st.panel.hidden) return;
  const t = ov.text;
  const atEnd = jump || t.scrollTop + t.clientHeight >= t.scrollHeight - 4;
  t.textContent = (I.output.get(I.outCh)?.lines || []).join('\n');
  if (atEnd) t.scrollTop = t.scrollHeight;
}
function paintOutputChannels() {
  const ov = I.panelViews?.get('output');
  if (!ov?.pick) return;
  ov.pick.replaceChildren(...[...I.output.keys()].map((k) => Object.assign(el('option', '', k), { value: k, selected: k === I.outCh })));
}

// --- terminals: a session on one of the hosts this desktop's logged into ----------------

// the host terminals and runs go to: the one picked, else this one, else any with a home
function runHost() {
  const live = dkLiveHosts();
  if (live.includes(I.st.runHost)) return I.st.runHost;
  if (!isHomeLoc() && live.includes(locOf().host)) return locOf().host;
  return [selfHost, ...live.sort()].find((h) => live.includes(h)) || '';
}
function setRunHost(h) {
  I.st.runHost = h;
  saveState();
  paintStatus();
  paintTabActions();
  paintRunView();
  setStatusFlash(`Terminals and runs now go to ${h}`);
}

// every host with a phosphorus, logged into or not, those that aren't said so
function pickHost(title) {
  const live = new Set(dkLiveHosts());
  const all = [...new Set([...homeOnline(), ...live])].sort((a, b) => (b === selfHost) - (a === selfHost) || a.localeCompare(b));
  const items = all.map((h) => ({
    label: h, ic: live.has(h) ? 'host' : 'lock', value: h,
    description: [h === selfHost && 'this desktop’s host', h === runHost() && 'default', !live.has(h) && 'not logged in', live.has(h) && hostIsWindows(h) && 'Windows'].filter(Boolean).join(' · '),
  }));
  return pick(items, { title, placeholder: 'Select a host', matchDescription: true }).then((h) => {
    if (h && !live.has(h)) { notify('warning', `Log into ${h} first, ${loginWhere()}.`); return undefined; }
    return h;
  });
}

// o: host, cwd (a home path), run (typed once logged in), name, kind (shell or run), focus
async function newTerminal(o = {}) {
  const host = o.host || runHost();
  const tv = I.panelViews.get('terminal');
  if (!host) {
    showPanel('terminal', true);
    notify('warning', `There is no host to open a terminal on: log into one ${loginWhere()}.`);
    return null;
  }
  const creds = dk.creds.get(host);
  if (!creds) { notify('warning', `Not logged into ${host}.`); return null; }
  await ensureHomeOwned(host);
  if (!I) return null;
  const cwd = o.cwd ?? I.st.root;
  const kind = o.kind || 'shell';
  // the folder as that host names it: the workspace's share, or that host's home
  const fl = isHomeLoc() ? { share: 'home' } : (host === locOf().host ? { share: locOf().share } : null);
  const abs = cwd && fl ? hostPath(host, fl.share, cwd) : '';
  const win = hostIsWindows(host);
  // pushd works in cmd and PowerShell alike, whichever sshd gives
  const cd = !abs ? '' : win ? `pushd "${abs}"` : `cd ${shQuote(abs)}`;
  const pwsh = hostsInfo[String(host).toLowerCase()]?.shell === 'powershell';
  const line = kind === 'shell' ? (cd ? (win ? (pwsh ? `${cd}; Clear-Host` : cd) : `${cd} && clear`) : '') : [cd, o.run].filter(Boolean).join(pwsh ? '; ' : win ? ' & ' : ' && ');
  const same = I.terms.filter((x) => x.base === (o.name || host)).length;
  const t = { id: `t${(I.termSeq += 1)}`, host, base: o.name || host, name: same ? `${o.name || host} (${same + 1})` : (o.name || host), kind, ended: false };
  t.view = el('div', 'ide-term-view');
  t.view.hidden = true;
  tv.views.append(t.view);
  t.h = startTerminal(t.view, host, newSid(), false, false, { ...creds, run: line }, {
    fontSize: setting('terminal.integrated.fontSize'), themeFrom: t.view, transparent: true,
    onEnd: () => { t.ended = true; paintTerms(); },
  });
  I.terms.push(t);
  log(`terminal ${t.name} on ${host}${cd ? ` in ${cwd}` : ''}`);
  selectTerm(t, o.focus !== false);
  showPanel('terminal', true);
  return t;
}

function selectTerm(t, focus = true) {
  I.term = t;
  for (const x of I.terms) x.view.hidden = x !== t;
  paintTerms();
  if (focus) t.h.show(); else requestAnimationFrame(() => t.h.fit());
}

function paintTerms() {
  const tv = I.panelViews.get('terminal');
  const many = I.terms.length > 1;
  tv.kill.hidden = many;
  tv.wrap.classList.toggle('many', many);
  tv.wrap.hidden = !I.terms.length;
  tv.empty.hidden = !!I.terms.length;
  if (!I.terms.length) {
    tv.empty.replaceChildren();
    if (dkLiveHosts().length) {
      const b = Object.assign(el('button', 'ide-button', `New Terminal on ${runHost()}`), { type: 'button' });
      b.addEventListener('click', () => newTerminal());
      tv.empty.append(b);
    } else tv.empty.append(el('p', '', `No host to open a terminal on. Log into one ${loginWhere()}, then come back.`));
  }
  tv.list.replaceChildren(...I.terms.map((t) => {
    const row = el('div', `ide-term-item${t === I.term ? ' on' : ''}${t.ended ? ' ended' : ''}`);
    row.setAttribute('role', 'option');
    row.title = `${t.name} on ${t.host}${t.ended ? ' (ended)' : ''}`;
    row.append(icon(t.kind === 'run' ? 'run' : 'terminal'), el('span', 'ide-term-name', t.name));
    const kill = btn('ide-term-kill', 'trash', 'Kill Terminal', (e) => { e.stopPropagation(); killTerm(t); });
    row.append(kill);
    row.addEventListener('click', () => selectTerm(t));
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); menu({ x: e.clientX, y: e.clientY }, [
      { label: 'Rename…', run: () => renameTerm(t) }, { label: 'Clear', run: () => t.h.clear() }, '-', { label: 'Kill Terminal', run: () => killTerm(t) },
    ]); });
    return row;
  }));
  const tab = I.panelViews.get('terminal').tab;
  tab.firstChild.textContent = 'TERMINAL';
}

function killTerm(t) {
  t.h.close();
  t.view.remove();
  const i = I.terms.indexOf(t);
  I.terms.splice(i, 1);
  if (I.term === t) I.term = I.terms[Math.min(i, I.terms.length - 1)] || null;
  if (I.term) selectTerm(I.term, I.panel.contains(document.activeElement));
  else { paintTerms(); if (I.st.panel.view === 'terminal') showPanel('terminal', false); }
}

async function renameTerm(t) {
  const v = await inputBox({ value: t.name, prompt: 'Enter a name for the terminal' });
  if (v?.trim()) { t.name = v.trim(); paintTerms(); }
}

function stepTerm(d) {
  if (!I.terms.length) return;
  const i = I.terms.indexOf(I.term);
  selectTerm(I.terms[(i + d + I.terms.length) % I.terms.length]);
}

function toggleTerminal() {
  const on = !I.st.panel.hidden && I.st.panel.view === 'terminal';
  if (on && I.panel.contains(document.activeElement)) { showPanel('terminal', false); return; }
  showPanel('terminal', true, true);
}

// the selection, or the caret's line, typed into the terminal
async function runSelection() {
  const t = I.active;
  if (!t?.ed) return;
  const text = t.ed.text();
  let [s, e] = t.ed.selection();
  if (s === e) [s, e] = lineSpan(text, s, s);
  const chunk = text.slice(s, e).replace(/\n+$/, '');
  if (!chunk) return;
  const term = I.term && !I.term.ended ? I.term : await newTerminal({ focus: false });
  if (!term) return;
  if (!term.h.send(`${chunk.replace(/\r?\n/g, '\r')}\r`)) notify('warning', 'The terminal is still connecting: try again in a moment.');
  showPanel('terminal', true);
}

// --- running a file: its runner, on the host it's on, in that host's run terminal -------

function runnerFor(rel) {
  if (!rel) return '';
  const x = extOf(rel);
  if (hostIsWindows(runHost()) && WIN_RUNNERS[x]) return WIN_RUNNERS[x];
  const mine = setting('sulfur.runners') || I.settings['ide.runners'];
  if (mine && typeof mine === 'object' && typeof mine[x] === 'string') return mine[x];
  return I.runners.get(x)?.cmd || '';
}

async function holdersOf(rel, l = locOf()) {
  if (!isHomeLoc(l)) return [l.host];
  try {
    const b = await filesCall(HOME, 'list', undefined, { path: filesParent(rel) });
    const e = (b.entries || []).find((x) => x.name === baseName(rel) && !x.dir);
    if (!e) return [];
    return e.all ? homeOnline() : (e.live?.length ? e.live : []);
  } catch { return []; }
}

async function runFileOn(rel) {
  const h = await pickHost(`Run ${baseName(rel)} on…`);
  if (h) runFile(rel, h);
}

async function runFile(rel, hostArg) {
  const runner = runnerFor(rel);
  if (!runner) {
    notify('info', `There's no runner for .${extOf(rel)} files yet.`, { actions: [
      { label: 'Add One in Settings', run: () => openUserFile(SETTINGS_PATH(), '{\n  "sulfur.runners": {\n  }\n}\n') },
      { label: 'Extension Guide', run: () => openGuide() },
    ] });
    return;
  }
  let host = hostArg || runHost();
  if (!host) { notify('warning', `Log into a host to run code, ${loginWhere()}.`); return; }
  if (hostIsWindows(host) && !WIN_RUNNERS[extOf(rel)] && !(setting('sulfur.runners') || {})[extOf(rel)]) {
    const other = dkLiveHosts().find((h) => !hostIsWindows(h));
    notify('warning', `${host} runs Windows, which has no runner for .${extOf(rel)} files yet.`, other ? { actions: [{ label: `Run on ${other}`, run: () => runFile(rel, other) }] } : {});
    return;
  }
  const t = I.tabs.find((x) => x.rel === rel && sameLoc(x.loc, locOf()));
  if (t?.ed?.dirty() && !(await saveTab(t))) return;
  const holders = await holdersOf(rel);
  if (!I) return;
  if (!holders.includes(host)) {
    if (!holders.length) { notify('error', `${rel} isn't on any host that's online.`); return; }
    if (!isHomeLoc()) {
      notify('warning', `${rel} is on ${locOf().host}'s disk: run it there, or copy the project to ${host} first.`, { actions: [
        { label: `Run on ${locOf().host}`, run: () => runFile(rel, locOf().host) },
        { label: 'Copy Project…', run: () => run('sulfur.project.transfer') },
      ] });
      return;
    }
    const there = holders.find((h) => dkLiveHosts().includes(h));
    const v = await ask({
      title: `${baseName(rel)} isn't on ${host}`,
      detail: `It's on ${holders.join(', ')}. Copy it to ${host} and run it there${there ? `, or run it on ${there}` : ''}? A copy takes this file alone, not the files beside it.`,
      buttons: [{ label: `Copy to ${host} and Run`, primary: true, value: 'copy' }, ...(there ? [{ label: `Run on ${there}`, value: 'there' }] : []), { label: 'Cancel', value: '' }],
    });
    if (!v || !I) return;
    if (v === 'there') host = there;
    else {
      try { await copyFile(homeAt(holders[0]), rel, homeAt(host), rel, () => {}); } catch (err) { notify('error', `Copy to ${host} failed: ${err.message}`); return; }
    }
  }
  const stem = baseName(rel).replace(/\.[^.]+$/, '') || 'a.out';
  const fl = fileLoc(rel, host);
  const abs = hostPath(host, fl.share, rel);
  const dir = hostPath(host, fl.share, filesParent(rel));
  if (!abs) { notify('error', `Can't tell where ${rel} is on ${host}.`); return; }
  let command;
  let vcvars = '';
  if (hostIsWindows(host)) {
    const w = (setting('sulfur.runners') || {})[extOf(rel)] || WIN_RUNNERS[extOf(rel)];
    const out = `%TEMP%\\sulfur-${stem.replace(/[^\w.-]/g, '_')}.exe`;
    command = w.replaceAll('{f}', abs).replaceAll('{o}', out);
    if (/\bcl\b/.test(w)) vcvars = (await toolchains(host).catch(() => null))?.vs?.[0]?.vcvars || '';
  } else {
    command = `f=${shQuote(abs)}; o="$(mktemp -d)"/${shQuote(stem)}; ${runner}`;
  }
  log(`run ${rel} on ${host}: ${command}`);
  emit('run', { path: rel, host });
  runTask({ host, abs: dir, command, vcvars, name: `Run: ${baseName(rel)}`, kind: 'run' });
}

// a file's run on a Windows host: {f} the file, {o} an output path
const WIN_RUNNERS = {
  py: 'python "{f}"', js: 'node "{f}"', mjs: 'node "{f}"', ts: 'npx --yes tsx "{f}"', ps1: 'powershell -NoProfile -ExecutionPolicy Bypass -File "{f}"',
  bat: 'call "{f}"', cmd: 'call "{f}"', cs: 'dotnet run "{f}"', go: 'go run "{f}"', rs: 'rustc "{f}" -o "{o}" && "{o}"',
  c: 'cl /nologo /W3 "{f}" /Fe:"{o}" && "{o}"', cpp: 'cl /nologo /W3 /EHsc /std:c++20 "{f}" /Fe:"{o}" && "{o}"',
};

// --- the status bar --------------------------------------------------------------------------

function sbItem(cls, title, onClick) {
  const b = Object.assign(el('button', `ide-sb ${cls}`), { type: 'button', title });
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

function buildStatus() {
  const S = {};
  S.branch = sbItem('ide-sb-branch', 'Checkout to…', () => run('sulfur.git.branch'));
  S.remote = sbItem('ide-sb-remote', standalone ? 'This computer and linked mesh machines' : 'Select the host terminals and runs use', () => (standalone ? menu(S.remote, meshItems(true), { side: 'right', up: true }) : run('sulfur.selectHost')));
  S.problems = sbItem('ide-sb-problems', 'No Problems', () => run('workbench.actions.view.problems'));
  S.build = sbItem('ide-sb-build', 'Build toolchain', () => run('sulfur.build.select'));
  S.config = sbItem('ide-sb-build ide-sb-config', 'Build configuration', () => run('sulfur.build.configuration'));
  S.people = sbItem('ide-sb-people', '');
  S.agent = sbItem('ide-sb-agent', 'Chat', () => showAux(true, true));
  S.flash = el('span', 'ide-sb-flash');
  S.chord = el('span', 'ide-sb-flash ide-sb-chord');
  S.extL = el('span', 'ide-sb-ext');
  S.pos = sbItem('ide-sb-pos', 'Go to Line/Column', () => run('workbench.action.gotoLine'));
  S.indent = sbItem('ide-sb-indent', 'Indentation, as the file has it');
  S.enc = sbItem('ide-sb-enc', 'Encoding');
  S.eol = sbItem('ide-sb-eol', 'End of Line Sequence');
  S.lang = sbItem('ide-sb-lang', 'Language Mode');
  S.host = sbItem('ide-sb-host', 'The host the file’s session is on', () => I.active?.rel && filesWin?.({ loc: HOME, dir: filesParent(I.active.rel) }));
  S.state = el('span', 'ide-sb ide-sb-state');
  S.extR = el('span', 'ide-sb-ext');
  S.bell = sbItem('ide-sb-bell', 'Notifications', (e) => notesPopup(e.currentTarget));
  I.statusL.append(S.remote, S.problems, S.build, S.config, S.people, S.agent, S.extL, S.flash, S.chord);
  I.statusR.append(S.pos, S.indent, S.enc, S.eol, S.lang, S.host, S.state, S.extR, S.bell);
  I.sb = S;
}

let sbFrame = 0;
function paintStatus() {
  if (!I?.sb || sbFrame) return;
  sbFrame = requestAnimationFrame(() => { sbFrame = 0; if (I) paintStatusNow(); });
}
function paintStatusNow() {
  const S = I.sb;
  const h = runHost();
  S.remote.replaceChildren(icon('remote'), el('span', '', h || 'no host'));
  S.remote.classList.toggle('none', !h);
  const sc = I.scm;
  S.branch.hidden = !sc?.top;
  if (sc?.top) {
    S.branch.replaceChildren(icon('branch'), el('span', '', `${sc.branch}${sc.staged.length + sc.changes.length ? '*' : ''}`));
    if (sc.upstream && (sc.ahead || sc.behind)) S.branch.append(el('span', 'ide-sb-sync', `${sc.behind}↓ ${sc.ahead}↑`));
    S.branch.title = `${sc.branch}${sc.upstream ? ` · ${sc.upstream}` : ' · not published'}: checkout to…`;
  }
  const pc = I.problemCounts || { errors: 0, warnings: 0 };
  S.problems.replaceChildren(icon('error'), el('span', '', String(pc.errors)), icon('warning'), el('span', '', String(pc.warnings)));
  S.problems.title = pc.errors || pc.warnings ? `${pc.errors} errors, ${pc.warnings} warnings` : 'No Problems';
  const bc = buildCfg();
  S.build.hidden = !bc?.toolchain;
  S.config.hidden = !bc?.toolchain;
  if (bc?.toolchain) {
    S.build.replaceChildren(icon('tools'), el('span', '', `${bc.toolchain.label} · ${bc.host}`));
    S.build.title = `Ctrl+B builds ${baseName(projDir())} with ${bc.toolchain.label} on ${bc.host}. Click to pick another toolchain.`;
    S.config.replaceChildren(el('span', '', bc.configuration || 'Debug'), icon('down'));
    S.config.title = `Configuration ${bc.configuration || 'Debug'}: click to pick another`;
  }
  const t = I.active;
  const info = t?.info;
  const code = !!(t?.ed && info);
  for (const n of [S.pos, S.indent, S.enc, S.eol, S.lang, S.state]) n.hidden = !code;
  S.host.hidden = !t?.rel;
  if (t?.rel) S.host.replaceChildren(icon('host'), el('span', '', t.host));
  if (code) {
    S.pos.textContent = `Ln ${info.line}, Col ${info.col}${info.sel ? ` (${info.sel} selected)` : ''}`;
    S.indent.textContent = info.indent === 'tab' ? 'Tab Size: 4' : `Spaces: ${info.indent}`;
    S.enc.textContent = 'UTF-8';
    S.eol.textContent = info.eol;
    S.lang.textContent = LANG_NAMES[info.lang] || info.lang;
    S.state.textContent = info.readOnly && info.ready ? 'read-only' : info.state;
    S.state.classList.toggle('bad', info.bad);
  }
  const people = info?.people || [];
  S.people.hidden = !people.length;
  if (people.length) {
    S.people.replaceChildren(icon('people'), el('span', '', people.map((p) => p.name).join(', ')));
    S.people.title = `${people.map((p) => p.name).join(', ')} ${people.length === 1 ? 'is' : 'are'} in this file with you`;
  }
  const busy = currentAgent()?.busy();
  S.agent.hidden = !busy;
  if (busy) S.agent.replaceChildren(icon('spark', 'ide-spin'), el('span', '', `${currentAgent().label} is answering`));
  S.bell.replaceChildren(icon('bell'));
  S.bell.classList.toggle('dot', !!I.unseen);
  S.bell.title = I.unseen ? `${I.unseen} new notification${I.unseen === 1 ? '' : 's'}` : 'No new notifications';
  for (const [, x] of [...I.statusItems].sort((a, b) => (b[1].priority || 0) - (a[1].priority || 0))) {
    (x.align === 'right' ? S.extR : S.extL).append(x.el);
  }
}

function setStatusFlash(text) {
  if (!I?.sb) return;
  const f = I.sb.flash;
  f.textContent = text;
  clearTimeout(I.flashT);
  I.flashT = setTimeout(() => { if (I) f.textContent = ''; }, 4000);
}
function setChord(text) { if (I?.sb) I.sb.chord.textContent = text; }

// --- the chat: the secondary side bar ----------------------------------------------------
// the mesh's models, chimp first, asked straight through the model gateway as
// claude code asks them, each seeing the file that's open here; an extension's
// agent (a harness bridged in, say) beside them; each conversation kept per
// user in this browser

const ROLE_SUB = { chimp: 'quick', orangutan: 'thorough' };
// a conversation's open file at most this much of its text
const SEEN_MAX = 24000;

// the gateway's roles and whether each has a model answering
async function refreshRoles() {
  try {
    if (localDesktop() && !meshLinked()) { I.roles = []; paintChat(); return; }
    const r = await fetch(meshApi('/api/model/v1/models'), { cache: 'no-store' });
    const b = await r.json().catch(() => ({}));
    if (!I) return;
    if (r.ok) I.roles = (b.data || []).filter((m) => m && m.id).map((m) => ({ id: m.id, ready: !!m.ready }));
  } catch {}
  if (I) paintChat();
}

// the extensions' agents, beside the harnesses
function agentList() {
  return [...I.providers.values()].map((p) => ({ id: p.key, label: p.label, sub: p.ext, up: true, kind: 'ext', p }));
}

// a conversation, a mesh one back from this browser's keeping
function chatOf(id) {
  let c = I.chats.get(id);
  if (!c) {
    let turns = [];
    if (id.startsWith('mesh:')) { try { turns = JSON.parse(localStorage.getItem(`${STATE_KEY()}:chat:${id}`)) || []; } catch {} }
    c = { turns: Array.isArray(turns) ? turns : [], busy: false, live: '' };
    I.chats.set(id, c);
  }
  return c;
}
function keepChat(id) {
  const c = I.chats.get(id);
  if (!c || !id.startsWith('mesh:')) return;
  try { localStorage.setItem(`${STATE_KEY()}:chat:${id}`, JSON.stringify(c.turns.slice(-CHAT_KEEP))); } catch {}
}

// the chat's agent as one shape for every harness: the mesh model, an agent session, an extension's
function currentAgent() {
  if (!I) return null;
  const h = chatHarness();
  if (h === 'ext') {
    const a = agentList().find((x) => x.id === I.st.aux.agent);
    if (a) {
      const c = chatOf(a.id);
      return {
        ...a, harness: 'ext', turns: () => c.turns, busy: () => c.busy, ready: () => true,
        send: (text) => providerAsk(a.p, c, text),
        stop: () => { c.busy = false; c.req = null; c.turns.push({ role: 'notice', text: 'stopped', at: Date.now() }); paintChat(); },
        clear: () => { c.turns = []; c.busy = false; c.req = null; paintChat(); },
        sees: true,
      };
    }
  }
  if (isAgent(h)) {
    const S = agentNow();
    return {
      id: S.key, kind: 'agent', harness: h, label: harnessName(h), sub: chatModel(), S,
      busy: () => agentLive(S), ready: () => true,
      send: (text) => agentSend(S, text),
      stop: () => { if (S.id) codeCall(sapi(S.id, 'stop'), 'POST', {}).catch((err) => agentNote(S, err.message, 'bad')); else { S.pending = false; paintChat(); } },
      clear: () => { agentForget(S); paintChat(true); },
      sees: true,
    };
  }
  const role = provOf(chatModel()) === 'mesh' ? chatModel() : 'chimp';
  const m = (I.roles || []).find((x) => x.id === role);
  const a = { id: `mesh:${role}`, label: role, sub: ROLE_SUB[role] || 'mesh model', up: m ? m.ready !== false : true, kind: 'mesh', role, harness: 'chat' };
  const c = chatOf(a.id);
  return {
    ...a,
    turns: () => c.turns,
    busy: () => c.busy,
    ready: () => true,
    send: (text) => meshAsk(a, c, text),
    stop: () => c.ctrl?.abort(),
    clear: () => { c.ctrl?.abort(); c.turns = []; keepChat(a.id); paintChat(true); },
    sees: true,
  };
}

function buildAux() {
  // an older keeping's agent: a mesh role is the model, an extension's its harness
  const was = I.st.aux.agent || '';
  if (was.startsWith('mesh:')) { I.st.aux.model = was.slice(5); I.st.aux.agent = ''; }
  else if (was && I.st.aux.harness === 'chat') I.st.aux.harness = 'ext';
  const head = el('div', 'ide-aux-head');
  const title = el('span', 'ide-side-title', 'CHAT');
  const acts = el('span', 'ide-actions');
  acts.append(btn('', 'plus', 'New Chat', () => run('workbench.action.chat.newChat')));
  head.append(title, acts);
  // the harness, the model, and for an agent how freely it works
  const bar = el('div', 'ide-chat-bar');
  const pill = (cls, title, onClick) => { const b = Object.assign(el('button', `ide-chat-pill ${cls}`), { type: 'button', title }); b.addEventListener('click', () => onClick(b)); return b; };
  const harness = pill('harness', 'Harness: who answers', pickHarness);
  const model = pill('model', 'Model', pickModel);
  const perm = pill('perm', 'How freely the agent works', pickPerm);
  bar.append(harness, model, perm);
  const banner = el('div', 'ide-chat-banner');
  banner.hidden = true;
  const log = Object.assign(el('div', 'ide-chat-log'), { tabIndex: -1 });
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  const foot = el('div', 'ide-chat-foot');
  const ctx = el('div', 'ide-chat-ctx');
  const box = el('div', 'ide-chat-box');
  const ta = Object.assign(el('textarea', 'ide-chat-input'), { rows: 1, spellcheck: true });
  ta.setAttribute('aria-label', 'Chat input');
  const go = (cls, d, title, fn) => {
    const b = Object.assign(el('button', `chat-go ${cls}`), { type: 'button', title, ariaLabel: title });
    b.append(dkGlyph(d));
    b.addEventListener('click', fn);
    return b;
  };
  const send = go('ide-chat-send', 'M8 12.5V3.5M4 7.5L8 3.5l4 4', 'Send (Enter)', () => sendChat());
  const stop = go('ide-chat-stop', 'M5 5h6v6H5z', 'Stop (Escape)', () => currentAgent()?.stop());
  box.append(el('span', 'chat-prompt', '>'), ta, send, stop);
  foot.append(ctx, box);
  I.aux.append(head, bar, banner, log, foot);
  I.chat = { harness, model, perm, banner, log, ta, send, stop, ctx, sig: '' };
  const grow = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    ta.style.overflowY = ta.scrollHeight > 200 ? 'auto' : 'hidden';
    paintChatButtons();
  };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.stopPropagation(); sendChat(); }
    else if (e.key === 'Escape' && currentAgent()?.busy()) { e.preventDefault(); e.stopPropagation(); currentAgent().stop(); }
  });
  I.chat.grow = grow;
  // the code service's harnesses, the picker's only agents
  if (!localDesktop() || meshLinked()) loadCodeOpts();
}

function showAux(on, focus = false) {
  const wasIn = I.aux.contains(document.activeElement);
  I.st.aux.hidden = !on;
  if (on && narrow()) { I.st.side.hidden = true; for (const b of I.actBtns.values()) b.classList.remove('on'); }
  paintLayout();
  if (on) { paintChat(true); if (focus) I.chat.ta.focus(); }
  if (!on && wasIn) focusActive();
}

function paintChatButtons() {
  const a = currentAgent();
  const busy = !!a?.busy();
  I.chat.send.hidden = busy;
  I.chat.stop.hidden = !busy;
  I.chat.send.disabled = !I.chat.ta.value.trim() || !a?.ready();
}

// redrawn only when the conversation's moved
function paintChat(force = false) {
  if (!I?.chat) return;
  const a = currentAgent();
  const c = I.chat;
  const h = chatHarness();
  const hx = harnessList().find((x) => x.id === h) || CHAT;
  c.harness.replaceChildren(icon(h === 'ext' ? 'ext' : hx.ic), el('span', '', h === 'ext' ? a?.label || 'Extension' : hx.label), icon('down'));
  c.model.hidden = h === 'ext';
  c.model.replaceChildren(icon('spark'), el('span', '', chatModel()), icon('down'));
  const agent = a?.kind === 'agent';
  c.perm.hidden = !agent;
  if (agent) c.perm.replaceChildren(el('span', '', (AGENT_PERMS.find(([id]) => id === (I.st.aux.perm || 'acceptEdits')) || AGENT_PERMS[0])[1]), icon('down'));
  c.ta.placeholder = !a ? 'No agent' : agent ? `Ask ${a.label} to work on ${baseName(I.st.root)}…` : `Ask ${a.label}…`;
  c.ta.title = 'Enter to send, Shift+Enter for a new line';
  paintChatCtx();
  paintChatButtons();
  paintStatus();
  // the banner: why an ask may not land, and for a harness missing on its host an optional install
  let why = '';
  let fix = null;
  if (localDesktop() && !meshLinked() && a?.kind !== 'ext') why = standalone.server ? `The chat's models and agents come from ${meshName()}: log in to it (the remote item, bottom left of the status bar) and they work on this computer's projects too.` : 'The chat\u2019s models and agents come from a Phosphorus mesh: connect to one (the remote item, bottom left of the status bar) and they work on this computer\u2019s projects too.';
  else if (!a) why = 'No model is set up on the mesh. The status app’s model card picks one.';
  else if (a.kind === 'mesh' && !a.up) why = `${a.label} has no model answering right now. The status app’s model card shows why.`;
  else if (agent && !a.S.id) {
    const where = agentWhere(h);
    why = where.why || '';
    const st = where.host && harnessOn(where.host, h);
    if (!why && st && st.why) why = st.why;
    else if (!why && st && st.installed === false) {
      why = `${hx.label} isn’t installed on ${where.host}. Installing it is optional; until then pick another harness.`;
      fix = harnessInstallBtn(where.host, h);
    }
  }
  c.banner.replaceChildren(why);
  if (fix) c.banner.append(' ', fix);
  c.banner.hidden = !why;
  if (I.st.aux.hidden && !force) return;
  const nearEnd = c.log.scrollTop + c.log.clientHeight >= c.log.scrollHeight - 40;
  if (agent) {
    const S = a.S;
    const busy = agentLive(S);
    const sig = `${S.key}\n${S.id}\n${S.node.childElementCount}\n${busy}`;
    if (sig === c.sig && !force) return;
    c.sig = sig;
    if (!S.node.childElementCount && !busy) { c.log.replaceChildren(chatWelcome(a)); return; }
    S.wait ||= el('div', 'ide-agent-wait');
    S.wait.replaceChildren(el('span', 'ide-dots', ''), el('span', '', S.pending ? ` starting ${a.label}…` : ` ${a.label} is working`));
    if (c.log.firstChild !== S.node) c.log.replaceChildren(S.node);
    if (busy) c.log.append(S.wait); else S.wait.remove();
    if (nearEnd || force) c.log.scrollTop = c.log.scrollHeight;
    return;
  }
  const turns = a ? a.turns() : [];
  const busy = !!a?.busy();
  const sig = `${a?.id}\n${turns.length}\n${turns.at(-1)?.at}\n${turns.at(-1)?.edits?.length || 0}\n${busy}\n${I.chats.get(a?.id)?.live?.length || 0}`;
  if (sig === c.sig && !force) return;
  c.sig = sig;
  if (!turns.length && !busy) { c.log.replaceChildren(chatWelcome(a)); return; }
  const rows = turns.map((t) => chatTurn(a, t));
  if (busy) {
    const live = I.chats.get(a.id)?.live;
    const p = chatTurn(a, { role: 'assistant', text: live || '', pending: !live });
    p.classList.add('pending');
    rows.push(p);
  }
  c.log.replaceChildren(...rows);
  if (nearEnd || force) c.log.scrollTop = c.log.scrollHeight;
}

function chatWelcome(a) {
  const w = el('div', 'ide-chat-welcome');
  w.append(icon('spark', 'ide-chat-art'), el('h3', '', a ? `Ask ${a.label}` : 'Chat'));
  let about = 'Pick a harness above.';
  if (a?.kind === 'mesh') about = `${a.label} is the mesh’s ${a.sub} model, asked straight through its gateway. It sees the file you have open, and when you ask it to change code its edits are typed into the editor as it answers.`;
  else if (a?.kind === 'agent') {
    const where = agentWhere(a.harness);
    about = where.why || `${a.label} works in ${baseName(I.st.root)} on ${where.host}, under your login there, on ${chatModel()}. It reads, runs commands and edits files itself, and each edit lands in the editor as it makes it.`;
  } else if (a?.kind === 'ext') about = `${a.label}, from the ${a.sub} extension.`;
  w.append(el('p', '', about));
  const tries = a?.kind === 'agent'
    ? ['Explain how this project is laid out', 'Find and fix the bug in this file', 'Add tests for this file and run them', 'Build it and fix what fails']
    : ['Explain this file', 'Find the bugs in this file', 'Add comments to this file', 'How do I build and run this?'];
  const row = el('div', 'ide-chat-tries');
  for (const t of tries) {
    const b = Object.assign(el('button', 'ide-chip', t), { type: 'button' });
    b.addEventListener('click', () => { I.chat.ta.value = t; I.chat.grow(); sendChat(); });
    row.append(b);
  }
  if (a) w.append(row);
  return w;
}

// a line's head as the chat app draws one: who, the model for an agent, when
function msgHead(role, who, at, model = '') {
  const head = el('div', 'ide-msg-head');
  head.append(el('span', `ide-msg-name${role === 'user' ? '' : ' agent'}`, role === 'user' ? 'you' : who));
  if (model) head.append(el('span', 'ide-msg-model', model));
  if (at) head.append(el('span', 'ide-msg-ts', new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
  return head;
}

function chatTurn(a, t) {
  const row = el('div', `ide-msg ${t.role}`);
  if (t.role !== 'notice') row.append(msgHead(t.role, t.by || a.label, t.at));
  const body = el('div', 'ide-msg-body');
  if (t.role === 'user') body.textContent = t.text;
  else if (t.role === 'notice') body.textContent = t.text;
  else if (t.pending) body.append(el('span', 'ide-dots', ''));
  else {
    const edits = parseEdits(t.text).length;
    renderMd(body, edits ? showEdits(t.text) : t.text, true, edits ? null : t.html || null);
    decorateCode(body);
  }
  row.append(body);
  // what its edit blocks did in the editor, and a way back
  if (t.edits?.length) {
    const bar = el('div', 'ide-msg-edits');
    for (const e of t.edits) {
      const chip = Object.assign(el('button', `ide-edit-chip${e.bad ? ' bad' : ''}`), { type: 'button', title: e.bad ? `${e.rel}: ${e.bad}` : `Open ${e.rel}` });
      chip.append(icon(e.bad ? 'warning' : 'check'), el('span', '', baseName(e.rel)));
      if (!e.bad) chip.addEventListener('click', () => openFile(e.rel, { preview: false }));
      bar.append(chip);
    }
    const undo = I.chatUndo?.get(t.at);
    if (undo) {
      const u = Object.assign(el('button', 'ide-link', 'Undo'), { type: 'button', title: 'Put back what was there before these edits' });
      u.addEventListener('click', async () => { u.disabled = true; if (await undoEdits(undo)) { I.chatUndo.delete(t.at); u.replaceWith(el('span', 'ide-edit-undone', 'undone')); } else u.disabled = false; });
      bar.append(u);
    }
    row.append(bar);
  }
  return row;
}

// a reply's code: copied, put at the caret, or typed into the terminal, as VS Code's chat offers
function decorateCode(body) {
  const apply = () => {
    for (const pre of body.querySelectorAll('pre')) {
      if (pre.dataset.ide) continue;
      pre.dataset.ide = '1';
      const code = () => pre.querySelector('code')?.textContent ?? pre.textContent;
      const bar = el('div', 'ide-code-acts');
      bar.append(
        btn('', 'copy', 'Copy', () => copyText(code()).then(() => setStatusFlash('Copied'), () => {})),
        btn('', 'insert', 'Insert at Cursor', () => {
          const t = I.active;
          if (!t?.ed) { notify('info', 'Open a file to insert into.'); return; }
          const [s, e] = t.ed.selection();
          if (!t.ed.edit(s, e, code())) notify('warning', 'The file is read-only here.');
        }),
        btn('', 'terminal', 'Run in Terminal', async () => {
          const term = I.term && !I.term.ended ? I.term : await newTerminal({ focus: false });
          if (term && !term.h.send(`${code().replace(/\n+$/, '').replace(/\r?\n/g, '\r')}\r`)) notify('warning', 'The terminal is still connecting.');
          showPanel('terminal', true);
        }),
      );
      const wrap = el('div', 'ide-code-wrap');
      pre.replaceWith(wrap);
      wrap.append(bar, pre);
    }
  };
  apply();
  // the server's render lands later for a reply without its own html
  const mo = new MutationObserver(apply);
  mo.observe(body, { childList: true });
  setTimeout(() => mo.disconnect(), 15000);
}

// what the agent's told it sees: the active file, a click turning it off
function paintChatCtx() {
  const c = I.chat;
  const t = I.active;
  const on = setting('chat.includeActiveFile');
  c.ctx.replaceChildren();
  if (!t?.rel || !currentAgent()?.sees) { c.ctx.hidden = true; return; }
  c.ctx.hidden = false;
  const chip = Object.assign(el('button', `ide-ctx-chip${on ? '' : ' off'}`), { type: 'button', title: on ? `The agent sees ${t.rel} and knows "this file" means it. Click to keep it out.` : `Click to let the agent see ${t.rel}.` });
  chip.append(fileIcon(t.rel), el('span', '', t.title), el('span', 'ide-ctx-state', on ? 'Current file' : 'Not shared'));
  chip.addEventListener('click', () => setSetting('chat.includeActiveFile', !on));
  c.ctx.append(chip);
}

function sendChat() {
  const a = currentAgent();
  const text = I.chat.ta.value.trim();
  if (!a || !text) return;
  if (localDesktop() && !meshLinked() && a.kind !== 'ext') { notify('info', `The chat's models and agents come from ${standalone.server ? meshName() : 'a Phosphorus mesh'}: ${standalone.server ? 'log in to it' : 'connect to one'} first.`, { actions: [{ label: standalone.server ? 'Log In…' : 'Connect…', run: () => run('sulfur.mesh.connect') }] }); return; }
  if (a.busy()) { setStatusFlash(`${a.label} is still answering`); return; }
  if (!a.ready()) { notify('warning', 'The mesh chat isn’t connected yet: try again in a moment.'); return; }
  if (a.send(text) === false) { notify('warning', `${a.label} didn’t take the message: the chat’s connection dropped.`); return; }
  I.chat.ta.value = '';
  I.chat.grow();
  paintChat(true);
}

function newChat() {
  const a = currentAgent();
  if (!a) return;
  a.clear();
  paintChat(true);
  showAux(true, true);
}

// the selection's lines named in the box, the agent seeing the file itself
function askSelection() {
  const t = I.active;
  if (!t?.ed) return;
  const text = t.ed.text();
  const [s, e] = t.ed.selection();
  const l1 = text.slice(0, s).split('\n').length;
  const l2 = text.slice(0, e).split('\n').length;
  if (!setting('chat.includeActiveFile')) setSetting('chat.includeActiveFile', true);
  showAux(true, true);
  const ta = I.chat.ta;
  ta.value = s === e ? `In ${t.title}, ` : `In ${t.title}, lines ${l1}${l2 > l1 ? `-${l2}` : ''}: `;
  I.chat.grow();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

// what a mesh model's told: who it is, where, and the file open here if shared
// what a mesh model's told: who it is, where, how to edit, and the file open here if shared
function meshSystem(a) {
  const t = I.active;
  const parts = [
    `You are ${a.label}, the phosphorus mesh's own assistant, answering ${name || acct.user} in Sulfur, the phosphorus code editor over their files on the mesh's machines. `
    + 'Answer plainly and exactly. Put code in fenced blocks with their language: Sulfur puts a block at the caret or runs it in a terminal.',
    `Today is ${new Date().toDateString()}. The workspace is ${I.st.root} in ${locLabel()}; terminals and runs go to ${runHost() || 'no machine yet'}.`,
    'When asked to create a file, or to rewrite one whole, put its path alone on a line and its whole text in a fenced block right under it, as\nMakefile\n```make\n(all of it)\n```\nSulfur writes it and opens it. Never just show a file you were asked to create: write it that way.\n'
    + 'When asked to change part of a file, change it yourself with edit blocks: Sulfur types each into the editor as soon as you finish. For each change write\n'
    + '<<<<<<< SEARCH path/from/the/workspace\n(the exact lines there now, enough of them to be unique)\n=======\n(the lines to put in their place)\n>>>>>>> REPLACE\n'
    + 'Leave the path off for the open file. Keep each block small, then say in a sentence what you changed; don\'t repeat the code outside the blocks.',
  ];
  if (t?.ed && t.info?.ready && setting('chat.includeActiveFile')) {
    const text = t.ed.text();
    const [s, e] = t.ed.selection();
    const l1 = text.slice(0, s).split('\n').length;
    const l2 = text.slice(0, e).split('\n').length;
    const cut = text.length > SEEN_MAX ? `, its first ${SEEN_MAX} characters` : '';
    parts.push(`They have ${under(t.rel, I.st.root) ? wsRel(t.rel) : t.rel} open (${LANG_NAMES[t.info.lang] || t.info.lang}, on ${t.host})${s !== e ? `, lines ${l1}-${l2} selected` : `, the caret on line ${l1}`}. `
      + 'When they say "this file", "this" or "here" without naming another, they mean it. '
      + `Its text as they see it now${cut}:\n<file path="${under(t.rel, I.st.root) ? wsRel(t.rel) : t.rel}">\n${text.slice(0, SEEN_MAX)}\n</file>`);
  }
  return parts.join('\n\n');
}

// the Messages API's turns: user first, the roles alternating, notices left out
function alternate(turns) {
  const out = [];
  for (const t of turns) {
    if (t.role !== 'user' && t.role !== 'assistant') continue;
    if (!out.length && t.role !== 'user') continue;
    if (out.at(-1)?.role === t.role) out.at(-1).content += `\n\n${t.text}`;
    else out.push({ role: t.role, content: t.text });
  }
  return out;
}

const paintChatSoon = debounce(() => I && paintChat(), 60);
// a mesh model asked through the gateway, its answer streamed in; a stop keeps what came
async function meshAsk(a, c, text) {
  c.turns.push({ role: 'user', text, at: Date.now() });
  if (c.turns.length > CHAT_KEEP) c.turns.splice(0, c.turns.length - CHAT_KEEP);
  c.busy = true;
  c.live = '';
  c.ctrl = new AbortController();
  keepChat(a.id);
  paintChat(true);
  let out = '';
  try {
    const r = await fetch(meshApi('/api/model/v1/messages'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: c.ctrl.signal,
      body: JSON.stringify({ model: a.role, max_tokens: 8192, stream: true, system: meshSystem(a), messages: alternate(c.turns.slice(-60)) }),
    });
    if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error?.message || `status ${r.status}`); }
    if (!(r.headers.get('content-type') || '').includes('event-stream')) {
      const b = await r.json();
      out = (b.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('');
    } else {
      const rd = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          buf = buf.slice(i + 2);
          if (!data) continue;
          let ev;
          try { ev = JSON.parse(data); } catch { continue; }
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') { out += ev.delta.text || ''; c.live = out; paintChatSoon(); }
          else if (ev.type === 'error') throw new Error(ev.error?.message || 'the model failed');
        }
      }
    }
    const turn = { role: 'assistant', text: out.trim() || '(no answer)', at: Date.now(), by: a.label };
    c.turns.push(turn);
    const edits = parseEdits(out);
    if (edits.length && I) {
      c.busy = false;
      c.live = '';
      keepChat(a.id);
      paintChat();
      const done = await applyChatEdits(edits);
      if (!I) return;
      turn.edits = done.list;
      if (done.undo.length) (I.chatUndo ||= new Map()).set(turn.at, done.undo);
      keepChat(a.id);
    }
  } catch (err) {
    if (out.trim()) c.turns.push({ role: 'assistant', text: out, at: Date.now(), by: a.label });
    c.turns.push({ role: 'notice', text: err.name === 'AbortError' ? 'stopped' : `${a.label}: ${err.message}`, at: Date.now() });
  }
  c.busy = false;
  c.live = '';
  c.ctrl = null;
  keepChat(a.id);
  if (!I) return;
  paintChat();
}

// an extension's agent asked: the conversation so far, the open file, its answer back
function providerAsk(p, c, text) {
  c.turns.push({ role: 'user', text, at: Date.now() });
  if (c.turns.length > CHAT_KEEP) c.turns.splice(0, c.turns.length - CHAT_KEEP);
  c.busy = true;
  c.live = '';
  const t = I.active;
  const file = t?.ed && setting('chat.includeActiveFile') ? { path: t.rel, language: t.info?.lang, text: t.ed.text().slice(0, 200000) } : null;
  const req = { text, history: c.turns.slice(0, -1).filter((x) => x.role !== 'notice').map(({ role, text: tx }) => ({ role, text: tx })), file };
  const x = I.exts.get(p.ext);
  const id = `${p.key}:${(I.seq += 1)}`;
  c.req = id;
  extRequest(x, { t: 'provider', pid: p.id, req, rid: id }).then((v) => {
    if (c.req !== id) return;
    c.turns.push({ role: 'assistant', text: String(v ?? ''), at: Date.now() });
  }, (err) => {
    if (c.req !== id) return;
    c.turns.push({ role: 'notice', text: `${p.label} failed: ${err.message}`, at: Date.now() });
  }).finally(() => {
    if (c.req !== id) return;
    c.busy = false;
    c.req = null;
    c.live = '';
    paintChat();
  });
  paintChat(true);
  return true;
}

// --- the chat's harness and model: the mesh's models asked straight, or an agent at work in the project

// Chat the mesh's models asked here; every other harness the code service's own
const CHAT = { id: 'chat', label: 'Chat', ic: 'chat', about: 'the mesh’s models, asked straight; their edits typed into the editor' };
const harnessList = () => [CHAT, ...(I.codeOpts?.harnesses || []).map((h) => ({ id: h.id, label: h.label, ic: h.icon || 'spark', about: h.about, meshOnly: !!h.meshOnly }))];
const isAgent = (h) => h !== 'chat' && h !== 'ext' && (I.codeOpts?.harnesses || []).some((x) => x.id === h);
const meshOnly = (h) => h === 'chat' || !!(I.codeOpts?.harnesses || []).find((x) => x.id === h)?.meshOnly;
const ANTH = ['opus', 'sonnet', 'haiku'];
const provOf = (m) => (ANTH.includes(m) ? 'anthropic' : 'mesh');
const AGENT_PERMS = [
  ['acceptEdits', 'Edit Automatically', 'its edits land as it makes them; commands still ask'],
  ['default', 'Ask First', 'every edit and command asks you first'],
  ['plan', 'Plan Only', 'it reads and plans, and changes nothing'],
  ['bypassPermissions', 'Full Access', 'nothing asks'],
];
// what Sulfur tells an agent with each prompt, left out of the transcript
const CTX_RE = /^<sulfur>[\s\S]*?<\/sulfur>\n*/;
const chatHarness = () => (I.st.aux.harness === 'ext' || isAgent(I.st.aux.harness) ? I.st.aux.harness : 'chat');
const chatModel = () => I.st.aux.model || 'chimp';
const harnessName = (h) => harnessList().find((x) => x.id === h)?.label || h;

async function codeCall(url, method = 'GET', body) {
  const init = { method, cache: 'no-store' };
  if (body !== undefined) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(body); }
  const r = await fetch(meshApi(url), init);
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(out.error || `status ${r.status}`), { status: r.status });
  return out;
}
const sapi = (id, op = '') => `/api/code/sessions/${encodeURIComponent(id)}${op ? `/${op}` : ''}`;

// the Code app's options: the logins it can work under, the Claude models if a token's saved
async function loadCodeOpts(fresh = false) {
  if (I.codeOpts && !fresh) return I.codeOpts;
  try { I.codeOpts = await codeCall('/api/code/options'); } catch (err) { I.codeOpts = { hosts: [], models: [], harnesses: [], anthropic: false, error: err.message }; }
  if (I) { paintChat(); harnessCheck(); }
  return I.codeOpts;
}

// each host's harnesses as the code service finds them, looked for once a host
function harnessOn(host, h) {
  const x = I.hosted?.get(host);
  if (!x) return null;
  return x.why ? { why: x.why } : x.byId[h] || null;
}
async function harnessCheck(fresh = false, host = isAgent(chatHarness()) ? agentWhere(chatHarness()).host : '') {
  if (!host) return;
  I.hosted ||= new Map();
  if (I.hosted.has(host) && !fresh) return;
  I.hosted.set(host, { why: '', byId: {} });
  let r;
  try { r = await codeCall(`/api/code/harnesses?host=${encodeURIComponent(host)}${fresh ? '&fresh=1' : ''}`); } catch { I?.hosted?.delete(host); return; }
  if (!I) return;
  I.hosted.set(host, { why: r.why || '', byId: Object.fromEntries((r.harnesses || []).map((x) => [x.id, x])) });
  paintChat(true);
}

// the harness's own installer run on host, the chat told once it's there
function harnessInstallBtn(host, h) {
  const b = Object.assign(el('button', 'ide-link'), { type: 'button', textContent: `Install on ${host}` });
  b.addEventListener('click', async () => {
    b.disabled = true;
    b.textContent = 'Installing…';
    let r;
    try { r = await codeCall('/api/code/install', 'POST', { host, harness: h }); } catch (err) { r = { ok: false, out: err.message }; }
    if (!I) return;
    if (!r.ok) { b.disabled = false; b.textContent = 'Try Again'; setStatusFlash(`Installing ${harnessName(h)} on ${host} failed: ${String(r.out || '').trim().split('\n').pop()}`); return; }
    setStatusFlash(`${harnessName(h)} is installed on ${host}`);
    harnessCheck(true, host);
  });
  return b;
}

function pickHarness(anchor) {
  const cur = chatHarness();
  const items = harnessList().map((h) => {
    const host = h.id !== 'chat' && I.codeOpts ? agentWhere(h.id).host : '';
    const st = host ? harnessOn(host, h.id) : null;
    const detail = st && st.installed === false ? `not installed on ${host}` : h.about;
    return { label: h.label, detail, ic: h.ic, checked: cur === h.id ? true : undefined, run: () => setHarness(h.id) };
  });
  if (I.codeOpts?.error && (!localDesktop() || meshLinked())) items.push({ label: 'No agents', detail: `the code service didn’t answer: ${I.codeOpts.error}`, ic: 'lock', disabled: true });
  const ext = [...I.providers.values()];
  if (ext.length) items.push('-', ...ext.map((p) => ({ label: p.label, detail: p.ext, ic: 'ext', checked: cur === 'ext' && I.st.aux.agent === p.key ? true : undefined, run: () => setHarness('ext', p.key) })));
  menu(anchor, items);
}

function setHarness(h, ext = '') {
  I.st.aux.harness = h;
  I.st.aux.agent = h === 'ext' ? ext : '';
  if (meshOnly(h) && provOf(chatModel()) === 'anthropic') {
    I.st.aux.model = 'chimp';
    setStatusFlash(`Claude models run in Claude Code: ${harnessName(h)} is on chimp`);
  }
  saveState();
  paintChat(true);
  harnessCheck();
}

function pickModel(anchor) {
  const cur = chatModel();
  const roles = I.roles?.length ? I.roles : [{ id: 'chimp' }, { id: 'orangutan' }];
  const items = roles.map((m) => ({ label: m.id, detail: `${ROLE_SUB[m.id] || 'mesh model'}${m.ready === false ? ' · offline' : ''}`, ic: 'spark', checked: cur === m.id ? true : undefined, run: () => setModel(m.id) }));
  const anth = (I.codeOpts?.models || []).filter((m) => m.provider === 'anthropic');
  items.push('-');
  if (anth.length) items.push(...anth.map((m) => ({ label: m.label, detail: 'Claude, in Claude Code', ic: 'spark', checked: cur === m.id ? true : undefined, run: () => setModel(m.id) })));
  else items.push({ label: 'Opus, Sonnet and Haiku', detail: 'save your Anthropic token in the Code app first', ic: 'lock', disabled: true });
  menu(anchor, items);
  if (!I.codeOpts) loadCodeOpts();
}

function setModel(m) {
  I.st.aux.model = m;
  const any = harnessList().find((h) => !h.meshOnly);
  if (provOf(m) === 'anthropic' && meshOnly(chatHarness()) && any) {
    I.st.aux.harness = any.id;
    setStatusFlash(`Claude models run in ${any.label}: the harness is ${any.label}`);
    harnessCheck();
  }
  saveState();
  // the same agent's session takes the new model; a switch between providers starts another
  const S = agentNow();
  if (S?.id && S.rec && S.rec.model !== m) {
    codeCall(sapi(S.id, 'model'), 'POST', { model: m }).then(() => { S.rec.model = m; paintChat(); }, (err) => agentNote(S, err.message, 'bad'));
  }
  paintChat(true);
}

function pickPerm(anchor) {
  const cur = I.st.aux.perm || 'acceptEdits';
  menu(anchor, AGENT_PERMS.map(([id, label, about]) => ({ label, detail: about, checked: id === cur ? true : undefined, run: () => setPerm(id) })));
}
function setPerm(v) {
  I.st.aux.perm = v;
  saveState();
  const S = agentNow();
  if (S?.id) codeCall(sapi(S.id, 'perm'), 'POST', { mode: v }).then(() => { if (S.rec) S.rec.perm = v; }, (err) => agentNote(S, err.message, 'bad'));
  paintChat();
}

// --- agents: Claude Code and opencode in the project, their edits landing in the editor ---------
// a session of the Code app's on a machine holding the project, under your login there;
// what it writes replayed into the open tabs as it writes it

const agentKey = (h = chatHarness(), m = chatModel()) => `${h}:${provOf(m)}\n${wsKey()}`;
const agentLive = (S) => !!S && (S.pending || S.rec?.status === 'working' || S.rec?.status === 'starting');

// the session of the harness picked, for this project
function agentNow() {
  const h = chatHarness();
  if (!isAgent(h)) return null;
  const key = agentKey();
  I.agents ||= new Map();
  let S = I.agents.get(key);
  if (!S) {
    S = { key, harness: h, root: I.st.root, loc: locOf(), id: (I.st.agentSess ||= {})[key] || '', rec: null, where: null, node: el('div', 'ide-agent-log'), seq: 0, sock: null, cards: new Map(), perms: new Map(), cur: null, liveText: null, pending: false, watching: false };
    I.agents.set(key, S);
    if (S.id) agentAttach(S);
  }
  return S;
}

async function agentAttach(S) {
  try {
    S.rec = await codeCall(sapi(S.id));
  } catch (err) {
    if (err.status === 404) agentForget(S);
    else agentNote(S, `Couldn't reach the session: ${err.message}`, 'bad');
    if (I) paintChat(true);
    return;
  }
  if (!I) return;
  S.where = { host: S.rec.host, dir: S.rec.dir, remote: thisComputer(S.loc) };
  agentConnect(S);
  paintChat(true);
}

// the session let go here (the Code app still lists it), a fresh one taken on the next ask
function agentForget(S) {
  if (I.st.agentSess?.[S.key] === S.id) { delete I.st.agentSess[S.key]; saveState(); }
  const ws = S.sock;
  S.sock = null;
  if (ws) { ws.onclose = null; try { ws.close(); } catch {} }
  Object.assign(S, { id: '', rec: null, where: null, seq: 0, cur: null, liveText: null, pending: false, watching: false });
  S.cards.clear();
  S.perms.clear();
  S.node.replaceChildren();
}

function agentConnect(S) {
  if (S.sock || !S.id || !I) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${meshApi(`/api/code/ws/${encodeURIComponent(S.id)}`)}?since=${S.seq}`);
  S.sock = ws;
  ws.onopen = () => { S.retry = 0; };
  ws.onmessage = (e) => {
    let m = null;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.seq && m.seq <= S.seq) return;
    const log = I?.chat?.log;
    const stick = !!log && S.node.isConnected && log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
    agentTake(S, m);
    if (m.seq) S.seq = m.seq;
    if (stick) log.scrollTop = log.scrollHeight;
    paintChatSoon();
  };
  ws.onclose = () => {
    if (S.sock !== ws) return;
    S.sock = null;
    if (!I || !S.id || S.closed) return;
    S.retry = Math.min(10000, (S.retry || 500) * 2);
    setTimeout(() => { if (I && S.id && !S.closed) agentConnect(S); }, S.retry);
  };
}

function agentNote(S, text, kind = '') {
  const n = el('div', `ide-agent-note ${kind}`, text);
  S.node.append(n);
  paintChatSoon();
  return n;
}

// the agent's reply so far: one message, its text, thoughts and tools in turn
function agentBody(S) {
  if (S.cur?.isConnected) return S.cur;
  const row = el('div', 'ide-msg assistant');
  const head = msgHead('assistant', harnessName(S.harness), Date.now(), S.rec?.model || chatModel());
  const body = el('div', 'ide-msg-body ide-agent-body');
  row.append(head, body);
  S.node.append(row);
  S.cur = body;
  return body;
}

function agentTake(S, m) {
  if (m.truncated) return;
  switch (m.kind) {
    case 'claude': agentEv(S, m.ev || {}); break;
    case 'user': {
      S.cur = null;
      S.liveText = null;
      const row = el('div', 'ide-msg user');
      row.append(msgHead('user', '', m.at), el('div', 'ide-msg-body', String(m.text || '').replace(CTX_RE, '')));
      S.node.append(row);
      break;
    }
    case 'permission': agentPerm(S, m); break;
    case 'permission_done': S.perms.get(m.reqId)?.(m.allow, m.cancelled); break;
    case 'status': {
      if (!m.record) break;
      const was = agentLive(S);
      S.rec = m.record;
      if (S.rec.status === 'working' || S.rec.status === 'starting') { S.watching = true; S.pending = false; }
      if (was && !agentLive(S)) { S.cur = null; S.liveText = null; }
      paintChatButtons();
      paintStatus();
      break;
    }
    case 'error': S.pending = false; agentNote(S, m.text || 'error', 'bad'); break;
    default:
  }
}

function agentEv(S, ev) {
  const nested = ev.parent_tool_use_id ? S.cards.get(ev.parent_tool_use_id) : null;
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') agentNote(S, [ev.model, ev.cwd].filter(Boolean).join(' · ') || 'started', 'quiet');
      else if (ev.subtype === 'api_retry') agentNote(S, `retrying: ${ev.error_status || ev.error || 'no answer'} (try ${ev.attempt || '?'} of ${ev.max_retries || '?'})`, 'warn');
      break;
    case 'stream_event': {
      if (nested) break;
      const e = ev.event || {};
      if (e.type === 'content_block_start' && e.content_block?.type === 'text') {
        S.liveText = el('div', 'ide-agent-text streaming');
        S.liveText.raw = '';
        agentBody(S).append(S.liveText);
      } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && S.liveText) {
        S.liveText.raw += e.delta.text || '';
        S.liveText.textContent = S.liveText.raw;
      }
      break;
    }
    case 'assistant':
      for (const b of ev.message?.content || []) {
        if (b.type === 'text') {
          if (nested || !b.text?.trim()) continue;
          const d = el('div', 'ide-agent-text md');
          renderMd(d, b.text, true);
          decorateCode(d);
          if (S.liveText?.isConnected) S.liveText.replaceWith(d); else agentBody(S).append(d);
          S.liveText = null;
        } else if (b.type === 'thinking' && !nested) {
          const d = el('details', 'ide-agent-think');
          d.append(el('summary', '', 'Thought'), el('div', 'ide-agent-think-body', b.thinking || ''));
          agentBody(S).append(d);
        } else if (b.type === 'tool_use') agentCard(S, b, nested ? nested.body : agentBody(S));
      }
      break;
    case 'user':
      for (const b of Array.isArray(ev.message?.content) ? ev.message.content : []) if (b.type === 'tool_result') agentResult(S, b);
      break;
    case 'result': {
      S.liveText?.remove();
      S.liveText = null;
      const u = ev.usage || {};
      const tin = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      const bad = ev.is_error || (ev.subtype && ev.subtype !== 'success');
      const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
      const bits = [bad ? String(ev.subtype || 'error').replace(/_/g, ' ') : 'done'];
      if (ev.num_turns) bits.push(`${ev.num_turns} step${ev.num_turns === 1 ? '' : 's'}`);
      if (ev.duration_ms) bits.push(`${(ev.duration_ms / 1000).toFixed(1)}s`);
      if (tin || u.output_tokens) bits.push(`↑${k(tin)} ↓${k(u.output_tokens)}`);
      agentNote(S, bits.join(' · '), bad ? 'bad foot' : 'foot');
      if (bad && typeof ev.result === 'string' && ev.result) agentNote(S, ev.result, 'bad');
      for (const e of Array.isArray(ev.errors) ? ev.errors : []) if (!/^\[ede_diagnostic\]/.test(String(e))) agentNote(S, String(e), 'bad');
      S.cur = null;
      S.pending = false;
      if (S.where?.remote) meshSyncDown(S).finally(() => { if (I && S.watching) agentSyncTabs(S); });
      else if (S.watching) agentSyncTabs(S);
      break;
    }
    default:
  }
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);
// a path the agent named as the workspace names it
function agentRel(S, abs) {
  if (!abs || !S.where?.dir) return '';
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const base = norm(S.where.dir);
  const a = norm(abs);
  const rest = a.startsWith(`${base}/`) ? a.slice(base.length + 1) : !a.startsWith('/') && !/^[A-Za-z]:/.test(a) && !a.startsWith('~') ? a : '';
  const rel = rest ? cleanPath(`${S.root}/${rest}`) : null;
  return rel && inScope(rel, S.loc) ? rel : '';
}
const agentHere = (S) => S.root === I.st.root && sameLoc(S.loc, locOf());

function agentArg(S, n, x = {}) {
  switch (n) {
    case 'Bash': return x.description || x.command || '';
    case 'Read': case 'Edit': case 'MultiEdit': case 'Write': { const r = agentRel(S, x.file_path); return r ? wsRel(r) : x.file_path || ''; }
    case 'Glob': case 'Grep': return x.pattern || '';
    case 'WebFetch': return x.url || '';
    case 'WebSearch': return x.query || '';
    case 'Task': case 'Agent': return x.description || '';
    case 'TodoWrite': return `${(x.todos || []).filter((y) => y.status === 'completed').length}/${(x.todos || []).length} done`;
    default: { const v = Object.values(x).find((y) => typeof y === 'string'); return v ? v.slice(0, 120) : ''; }
  }
}
// an edit's lines out and in, as a short diff
function agentDiff(a, b) {
  const box = el('div', 'ide-agent-diff');
  const add = (sign, l) => box.append(el('div', `ide-dl${sign === '+' ? ' add' : ' del'}`, `${sign} ${l}`));
  const A = a ? String(a).replace(/\n$/, '').split('\n') : [];
  const B = b ? String(b).replace(/\n$/, '').split('\n') : [];
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let q = 0;
  while (q < A.length - p && q < B.length - p && A[A.length - 1 - q] === B[B.length - 1 - q]) q++;
  const del = A.slice(p, A.length - q);
  const ins = B.slice(p, B.length - q);
  for (const l of del.slice(0, 200)) add('-', l);
  for (const l of ins.slice(0, 200)) add('+', l);
  if (del.length > 200 || ins.length > 200) box.append(el('div', 'ide-dl gap', '…'));
  if (!del.length && !ins.length) box.append(el('div', 'ide-dl gap', 'no change'));
  return box;
}

function agentCard(S, b, where) {
  const n = b.name || 'tool';
  const x = b.input || {};
  const c = el('div', `ide-tool run${EDIT_TOOLS.has(n) ? ' edit' : ''}`);
  const h = Object.assign(el('button', 'ide-tool-head'), { type: 'button' });
  h.append(el('span', 'ide-tool-pip'), el('span', 'ide-tool-name', n.startsWith('mcp__') ? n.slice(5).replace('__', ' · ') : n), el('span', 'ide-tool-arg', agentArg(S, n, x)));
  const out = el('div', 'ide-tool-out');
  const body = el('div', 'ide-tool-body');
  body.hidden = true;
  if (n === 'Bash') body.append(el('pre', 'ide-tool-cmd', `$ ${x.command || ''}`));
  else if (n === 'Edit') body.append(agentDiff(x.old_string, x.new_string));
  else if (n === 'MultiEdit') for (const e of x.edits || []) body.append(agentDiff(e.old_string, e.new_string));
  else if (n === 'Write') body.append(agentDiff('', x.content));
  h.addEventListener('click', () => { body.hidden = !body.hidden; c.classList.toggle('open', !body.hidden); });
  c.append(h, out, body);
  where.append(c);
  S.cards.set(b.id, { el: c, out, body, name: n, input: x });
}

function agentResult(S, b) {
  const c = S.cards.get(b.tool_use_id);
  if (!c) return;
  const text = (typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n') : '').replace(/\s+$/, '');
  const bad = !!b.is_error;
  c.el.classList.remove('run');
  c.el.classList.add(bad ? 'bad' : 'ok');
  const first = text.split('\n')[0].slice(0, 160);
  const lines = text ? text.split('\n').length : 0;
  c.out.textContent = bad ? first || 'failed' : EDIT_TOOLS.has(c.name) ? 'edited' : c.name === 'Read' ? `${lines} lines` : first ? `${first}${lines > 1 ? `  (+${lines - 1} lines)` : ''}` : 'done';
  if (text && (bad || !EDIT_TOOLS.has(c.name)) && c.name !== 'Read') c.body.append(el('pre', `ide-tool-res${bad ? ' bad' : ''}`, text.length > 16000 ? `${text.slice(0, 16000)}\n…` : text));
  if (!bad && EDIT_TOOLS.has(c.name)) {
    const rel = agentRel(S, c.input.file_path);
    if (rel) {
      const open = Object.assign(el('button', 'ide-link', 'Open'), { type: 'button' });
      open.addEventListener('click', () => openFile(rel, { preview: false, loc: S.loc }));
      c.out.append(' ', open);
      if (S.watching && agentHere(S)) agentApply(S, c, rel);
    }
  }
}

// the agent's edit replayed into the file's tab, typed in where the user sees it;
// a tab opened for it already has it from disk, so is only lit
async function agentApply(S, c, rel) {
  let t = I.tabs.find((x) => x.rel === rel && sameLoc(x.loc, S.loc) && x.kind === 'code');
  let fresh = !t;
  if (!t && S.where?.remote) {
    // the file here is as it was: an edit's typed in, a whole file written first
    if (c.name === 'Write') { try { await writeAt(rel, String(c.input.content ?? ''), S.loc); } catch {} } else fresh = false;
    if (!I) return;
  }
  if (!t) t = openFile(rel, { preview: false, focus: false, host: isHomeLoc(S.loc) && !S.where?.remote ? S.where?.host : undefined });
  if (!t) return;
  if (I.active !== t) activate(t, false);
  for (let i = 0; i < 120 && I && I.tabs.includes(t) && !t.ed?.ready?.(); i++) await sleep(80);
  if (!I || !t.ed?.ready?.()) return;
  const wasDirty = t.ed.dirty();
  const x = c.input;
  const ops = c.name === 'Write' ? [{ write: String(x.content ?? '') }] : c.name === 'MultiEdit' ? (x.edits || []) : [x];
  const undo = [];
  let missed = 0;
  for (const e of ops) {
    const text = t.ed.text();
    if ('write' in e) {
      if (text === e.write) { if (fresh) await t.ed.agentFlash(0, Math.min(text.length, 20000)); continue; }
      let p = 0;
      while (p < text.length && p < e.write.length && text[p] === e.write[p]) p++;
      let q = 0;
      while (q < text.length - p && q < e.write.length - p && text[text.length - 1 - q] === e.write[e.write.length - 1 - q]) q++;
      const old = text.slice(p, text.length - q);
      const nu = e.write.slice(p, e.write.length - q);
      if (fresh) { await t.ed.agentFlash(p, p + nu.length); continue; }
      if (await t.ed.agentEdit(p, text.length - q, nu)) undo.push({ at: p, old, nu }); else missed += 1;
      continue;
    }
    const from = String(e.old_string ?? '');
    const to = String(e.new_string ?? '');
    const at = from ? text.indexOf(from) : -1;
    if (fresh || at < 0) {
      const there = to ? text.indexOf(to) : -1;
      if (there >= 0) await t.ed.agentFlash(there, there + to.length);
      else if (!fresh && to) missed += 1;
      continue;
    }
    let pos = at;
    for (let k = 0; pos >= 0 && (k === 0 || e.replace_all); k++) {
      if (!(await t.ed.agentEdit(pos, pos + from.length, to))) { missed += 1; break; }
      undo.push({ at: pos, old: from, nu: to });
      pos = t.ed.text().indexOf(from, pos + to.length);
    }
  }
  if (!I) return;
  if (missed) {
    notify('warning', `${baseName(rel)} has changes here the agent didn't see, so its edit didn't land in the editor. Revert File shows the file as the agent left it.`, { actions: [{ label: 'Revert File', run: () => { activate(t); run('workbench.action.revertFile'); } }] });
  } else if (!wasDirty) t.ed.save();
  if (undo.length) {
    const u = Object.assign(el('button', 'ide-link', 'Undo'), { type: 'button', title: 'Put back what was there before this edit' });
    u.addEventListener('click', async () => { u.disabled = true; if (await undoEdits([{ t, list: undo }])) u.textContent = 'Undone'; else u.disabled = false; });
    c.out.append(' ', u);
  }
}

// a turn's end: a clean tab of the project the agent changed some other way (a command, a formatter) made what's on disk
async function agentSyncTabs(S) {
  if (!agentHere(S)) return;
  for (const t of I.tabs.filter((x) => x.kind === 'code' && x.rel && sameLoc(x.loc, S.loc) && under(x.rel, S.root) && x.ed?.ready?.() && !x.ed.dirty())) {
    let disk = null;
    try {
      const b = await filesCall(isHomeLoc(S.loc) && !S.where?.remote ? homeAt(S.where?.host || homePick(t.rel)) : apiLoc(S.loc), 'read', undefined, { path: t.rel });
      disk = typeof b.text === 'string' ? b.text : null;
    } catch {}
    if (!I || disk === null || !t.ed || t.ed.dirty()) continue;
    const text = t.ed.text();
    if (text === disk) continue;
    let p = 0;
    while (p < text.length && p < disk.length && text[p] === disk[p]) p++;
    let q = 0;
    while (q < text.length - p && q < disk.length - p && text[text.length - 1 - q] === disk[disk.length - 1 - q]) q++;
    if (await t.ed.agentEdit(p, text.length - q, disk.slice(p, disk.length - q), { instant: disk.length - p - q > 4000 })) t.ed.save();
  }
}

// edits taken back, newest first, each only where its text still is
async function undoEdits(groups) {
  let all = true;
  for (const g of [...groups].reverse()) {
    const { t } = g;
    if (!I.tabs.includes(t) || !t.ed?.ready?.()) { all = false; continue; }
    const wasDirty = t.ed.dirty();
    for (const e of [...g.list].reverse()) {
      const text = t.ed.text();
      let at = text.startsWith(e.nu, e.at) ? e.at : text.indexOf(e.nu);
      if (!e.nu) at = Math.min(e.at, text.length);
      if (at < 0 || !(await t.ed.agentEdit(at, at + e.nu.length, e.old))) all = false;
    }
    if (!wasDirty && all) t.ed.save();
  }
  if (!all) notify('warning', 'Some of it had changed since, so not all of it went back.');
  return all;
}

function agentPerm(S, m) {
  const c = el('div', 'ide-perm');
  const h = el('div', 'ide-perm-head');
  h.append(icon('warning', 'ide-perm-ic'), el('span', 'ide-tool-name', m.tool || 'tool'), el('span', 'ide-tool-arg', agentArg(S, m.tool, m.input || {})));
  c.append(h);
  if (m.reason) c.append(el('div', 'ide-perm-why', m.reason));
  const x = m.input || {};
  if (m.tool === 'Bash') c.append(el('pre', 'ide-tool-cmd', `$ ${x.command || ''}`));
  else if (m.tool === 'Edit') c.append(agentDiff(x.old_string, x.new_string));
  else if (m.tool === 'Write') c.append(agentDiff('', x.content));
  else if (m.tool === 'MultiEdit') for (const e of x.edits || []) c.append(agentDiff(e.old_string, e.new_string));
  const acts = el('div', 'ide-perm-acts');
  const msg = el('span', 'ide-perm-msg');
  const answer = (allow, always) => {
    for (const b of acts.querySelectorAll('button')) b.disabled = true;
    msg.textContent = 'sending…';
    codeCall(sapi(S.id, 'permission'), 'POST', { reqId: m.reqId, allow, always, message: '' })
      .then(() => done(allow, false), (err) => { msg.textContent = err.message; for (const b of acts.querySelectorAll('button')) b.disabled = false; });
  };
  const mk = (label, cls, allow, always) => { const b = Object.assign(el('button', `ide-button ${cls}`, label), { type: 'button' }); b.addEventListener('click', () => answer(allow, always)); return b; };
  acts.append(mk('Allow', '', true, false), mk('Always Allow', 'secondary', true, true), mk('Deny', 'secondary', false, false), msg);
  c.append(acts);
  const done = (allow, cancelled) => {
    if (c.classList.contains('answered')) return;
    c.classList.add('answered', allow ? 'allowed' : 'denied');
    acts.replaceChildren(el('span', 'ide-perm-msg', allow ? 'allowed' : cancelled ? 'no longer asked' : 'denied'));
  };
  S.perms.set(m.reqId, done);
  agentBody(S).append(c);
}

// where the agent works: the project's own machine, or a holder of the home; a Linux or macOS one
function agentWhere(h) {
  const o = I.codeOpts;
  if (o?.blocked) return { why: o.blocked };
  const logins = new Set(o?.hosts?.length ? o.hosts : dkLiveHosts());
  const n = harnessName(h);
  // offline, or a project on this computer: the mesh's Code service, on one of its machines, the project copied there
  if (thisComputer(locOf())) {
    if (localDesktop() && !meshLinked()) return { why: `${n} runs on your mesh's machines: log into your mesh (the remote item, bottom left of the status bar) to use it on this computer's files.` };
    if (o && !o.error && !(o.hosts || []).length) return { why: `Save a login for one of ${meshName()}'s Linux or macOS machines in Phosphorus (open a terminal on it there) for ${n} to work on it.` };
    return { mesh: true };
  }
  if (!isHomeLoc()) {
    const host = locOf().host;
    if (hostIsWindows(host)) return { why: `${n} runs on Linux and macOS machines, and ${baseName(I.st.root)} is on ${host}, a Windows one. Copy it to one (File › Copy or Move Project), or use Chat.` };
    if (!logins.has(host)) return { why: `Log into ${host} for ${n} to work in ${baseName(I.st.root)} there.` };
    return { host, dir: hostPath(host, locOf().share, I.st.root) };
  }
  const hosts = [runHost(), selfHost, ...homeOnline()].filter((x, i, a) => x && a.indexOf(x) === i && logins.has(x) && !hostIsWindows(x) && shareOf(x, 'home'));
  if (!hosts.length) return { why: `${n} runs on a Linux or macOS machine holding your home: log into one ${loginWhere()}.` };
  return { host: hosts[0], dir: hostPath(hosts[0], 'home', I.st.root) };
}

// --- offline, the mesh's Code service: this computer's project copied to a mesh machine
// (its home, .sulfur/sync), the agent working there, what it changes brought back

const SYNC_MAX = 32 * 1024 * 1024;
const meshFilesUrl = (host, op, params = {}) => meshApi(`/api/files/${encodeURIComponent(host)}/${op}?${new URLSearchParams({ share: 'home', ...params })}`);
async function meshJSON(url, init) {
  const r = await fetch(url, init);
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(b.error || `status ${r.status}`), { status: r.status });
  return b;
}
// a mesh machine's home folder, as its shell names it
function meshHomeOf(host) {
  I.meshHomes ||= new Map();
  if (!I.meshHomes.has(host)) I.meshHomes.set(host, meshJSON(meshApi(`/api/files/${encodeURIComponent(host)}/info`)).then((b) => (b.shares || []).find((x) => x.id === 'home')?.label || '', () => ''));
  return I.meshHomes.get(host);
}
// a short stamp of this computer's folder, so two projects of one name keep apart there
const syncName = (S) => {
  let h = 5381;
  for (const ch of `${wsKey()}\n${S.root}`) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return `${baseName(S.root) || 'project'}-${h.toString(36)}`;
};
// the mesh machine the agent works on: one the user has a login for, Linux or macOS, the last one first
async function meshWhere(S) {
  const n = harnessName(S.harness);
  const o = await loadCodeOpts(true);
  if (!I) return { why: '' };
  if (o.error) return { why: `Couldn't reach ${meshName()}'s Code service: ${o.error}` };
  if (o.blocked) return { why: o.blocked };
  const homes = await Promise.all((o.hosts || []).map(async (h) => [h, await meshHomeOf(h)]));
  const ok = homes.filter(([, l]) => l && !isWinPath(l));
  if (!ok.length) return { why: `${n} needs a Linux or macOS machine on ${meshName()} with your login saved: ${(o.hosts || []).length ? `${o.hosts.join(', ')} ${o.hosts.length === 1 ? 'is' : 'are'} Windows or ${o.hosts.length === 1 ? 'has' : 'have'} no home folder` : 'save one in Phosphorus by opening a terminal on it'}.` };
  const [host, label] = ok.find(([h]) => h === I.st.meshAgentHost) || ok[0];
  const rel = `${standalone.meshUser}/.sulfur/sync/${syncName(S)}`;
  return { host, rel, dir: `${label.replace(/\/+$/, '')}/${rel}`, remote: true };
}
// a mesh session's folder in its machine's home, from its absolute path
async function meshRelOf(S) {
  const w = S.where;
  if (w.rel) return w.rel;
  const label = String(await meshHomeOf(w.host)).replace(/\/+$/, '');
  if (label && w.dir.startsWith(`${label}/`)) w.rel = w.dir.slice(label.length + 1);
  return w.rel || '';
}
// what's been copied: this computer's files' size and time, the mesh's after
function syncState(S, w) {
  const k = `sulfur.meshSync:${w.host}:${w.dir}`;
  I.syncs ||= new Map();
  if (!I.syncs.has(k)) {
    let v = null;
    try { v = JSON.parse(localStorage.getItem(k) || 'null'); } catch {}
    I.syncs.set(k, { k, local: v?.local || {}, remote: v?.remote || {} });
  }
  return I.syncs.get(k);
}
function syncKeep(st) { try { localStorage.setItem(st.k, JSON.stringify({ local: st.local, remote: st.remote })); } catch {} }
const sigOf = (e) => `${e.size}:${e.mtime}`;
async function localFiles(S) {
  const b = await filesCall(apiLoc(S.loc), 'tree', undefined, { path: S.root, depth: 24, skip: searchSkip() });
  const skip = excluded();
  return (b.entries || []).filter((e) => !e.path.endsWith('/') && !e.path.split('/').some(skip));
}
async function meshFiles(w, rel) {
  const b = await meshJSON(meshFilesUrl(w.host, 'tree', { path: rel, depth: 24, skip: searchSkip() }));
  return (b.entries || []).filter((e) => !e.path.endsWith('/'));
}
// in parallel, a few at a time
async function each(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length && I) await fn(list[i++]); }));
}
async function meshPut(host, path, blob) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join('');
  const CH = 4 * 1024 * 1024;
  let offset = 0;
  do {
    const end = Math.min(offset + CH, blob.size);
    await meshJSON(meshFilesUrl(host, 'upload', { path, id, offset, total: blob.size }), { method: 'POST', body: blob.slice(offset, end) });
    offset = end;
  } while (offset < blob.size);
}

// this computer's project up to the mesh machine: what changed since the last copy
async function meshSyncUp(S, w) {
  const rel = await meshRelOf(S);
  if (!I || !rel) { agentNote(S, `Can't tell where ${w.host}'s home is.`, 'bad'); return false; }
  const st = syncState(S, w);
  let files;
  try { files = await localFiles(S); } catch (err) { agentNote(S, `Couldn't list ${baseName(S.root)}: ${err.message}`, 'bad'); return false; }
  if (!I) return false;
  const big = files.filter((e) => e.size > SYNC_MAX);
  const todo = files.filter((e) => e.size <= SYNC_MAX && st.local[e.path] !== sigOf(e));
  if (!todo.length) return true;
  const bytes = todo.reduce((a, e) => a + (e.size || 0), 0);
  if (!Object.keys(st.local).length && (todo.length > 3000 || bytes > 300 * 1024 * 1024)) {
    const v = await ask({
      title: `Copy ${baseName(S.root)} to ${w.host}?`,
      detail: `${harnessName(S.harness)} works on ${meshName()}'s ${w.host}, so the project goes there first: ${todo.length.toLocaleString()} files, ${humanSize(bytes)} (build folders and Search: Exclude left out). Later prompts copy only what's changed.`,
      buttons: [{ label: 'Copy and Ask', primary: true, value: 'go' }, { label: 'Cancel', value: '' }],
    });
    if (v !== 'go' || !I) return false;
  }
  // the home there its user's own login's, so the agent can write in it
  if (!I.meshOwned?.has(w.host)) {
    (I.meshOwned ||= new Set()).add(w.host);
    await meshJSON(meshFilesUrl(w.host, 'own'), jsonPost({ path: standalone.meshUser })).catch(() => null);
  }
  const note = agentNote(S, `Copying ${todo.length.toLocaleString()} file${todo.length === 1 ? '' : 's'} (${humanSize(bytes)}) to ${w.host}…`, 'quiet');
  let done = 0;
  let bad = null;
  await each(todo, 6, async (e) => {
    if (bad) return;
    try {
      const r = await fetch(filesApi(apiLoc(S.loc), 'download', { path: e.path }));
      if (!r.ok) throw new Error(`${e.path}: status ${r.status}`);
      await meshPut(w.host, `${rel}/${e.path.slice(S.root.length + 1)}`, await r.blob());
      st.local[e.path] = sigOf(e);
      done += 1;
      if (done % 25 === 0) note.textContent = `Copying to ${w.host}: ${done.toLocaleString()} of ${todo.length.toLocaleString()}…`;
    } catch (err) { bad = err; }
  });
  if (!I) return false;
  // what's there now, so a turn's end brings back only what the agent changed
  try { for (const e of await meshFiles(w, rel)) st.remote[e.path] = sigOf(e); } catch {}
  syncKeep(st);
  if (bad) { note.textContent = `Copying to ${w.host} failed: ${bad.message}`; note.classList.add('bad'); return false; }
  note.textContent = `Copied ${done.toLocaleString()} file${done === 1 ? '' : 's'} to ${w.host}${big.length ? ` (${big.length} over ${humanSize(SYNC_MAX)} left here)` : ''}.`;
  return true;
}

// a turn's end: what the agent changed on the mesh machine brought back to this computer
async function meshSyncDown(S) {
  const w = S.where;
  const rel = await meshRelOf(S);
  if (!I || !rel) return;
  const st = syncState(S, w);
  let there;
  try { there = await meshFiles(w, rel); } catch { return; }
  const changed = there.filter((e) => st.remote[e.path] !== sigOf(e) && e.size <= SYNC_MAX);
  if (!changed.length) return;
  const back = [];
  await each(changed, 6, async (e) => {
    const local = cleanPath(`${S.root}/${e.path.slice(rel.length + 1)}`);
    try {
      const r = await fetch(meshFilesUrl(w.host, 'download', { path: e.path }));
      if (!r.ok) return;
      const blob = await r.blob();
      const tab = I.tabs.find((x) => x.rel === local && sameLoc(x.loc, S.loc) && x.ed?.ready?.());
      // a tab with the agent's edit typed in has it already, its save the same bytes
      if (!(tab && !tab.ed.dirty() && tab.ed.text() === await blob.text())) await putFile(apiLoc(S.loc), local, blob);
      st.remote[e.path] = sigOf(e);
      back.push(local);
    } catch {}
  });
  if (!I) return;
  // this computer's copies are as the mesh's now: not copied up again
  try { for (const e of await localFiles(S)) if (back.includes(e.path)) st.local[e.path] = sigOf(e); } catch {}
  syncKeep(st);
  if (back.length) {
    agentNote(S, `Brought back ${back.length} changed file${back.length === 1 ? '' : 's'} from ${w.host}.`, 'quiet');
    for (const d of new Set(back.map(filesParent))) if (I.tree.has(d)) loadDir(d, true);
  }
}

// the harness on that machine before a session starts there; the banner offers its install when not
async function agentInstalled(S, where) {
  await harnessCheck(false, where.host);
  const st = harnessOn(where.host, S.harness);
  if (!st || st.installed) return true;
  agentNote(S, st.why || `${harnessName(S.harness)} isn’t installed on ${where.host}: install it from the banner above, or pick another harness.`, 'bad');
  return false;
}

// what the agent's told beside the ask: the file open here, the selection
function agentPrompt(text) {
  const t = I.active;
  if (!t?.ed || !t.rel || !under(t.rel, I.st.root) || !setting('chat.includeActiveFile')) return text;
  const all = t.ed.text();
  const [s, e] = t.ed.selection();
  const l1 = all.slice(0, s).split('\n').length;
  const l2 = all.slice(0, e).split('\n').length;
  return `<sulfur>The user has ${wsRel(t.rel)} open in Sulfur's editor${s !== e ? `, lines ${l1}-${l2} selected` : `, the caret on line ${l1}`}. "This file" means it. Your edits show in their editor as you make them.</sulfur>\n\n${text}`;
}

async function agentSend(S, text) {
  let where = S.where && S.id ? S.where : agentWhere(S.harness);
  if (where.mesh) where = await meshWhere(S);
  if (!I) return true;
  if (where.why) { agentNote(S, where.why, 'bad'); paintChat(true); return true; }
  const prompt = agentPrompt(text);
  S.pending = true;
  S.watching = true;
  paintChat(true);
  try {
    // this computer's project copied up first: what's changed since the last prompt
    if (where.remote && !(await meshSyncUp(S, where))) { S.pending = false; paintChat(true); return true; }
    if (!I) return true;
    if (S.id) {
      try { await codeCall(sapi(S.id, 'send'), 'POST', { text: prompt }); paintChat(true); return true; } catch (err) { if (err.status !== 404) throw err; agentForget(S); }
    }
    if (!(await agentInstalled(S, where))) { S.pending = false; paintChat(true); return true; }
    const rec = await codeCall('/api/code/sessions', 'POST', { host: where.host, dir: where.dir, model: chatModel(), perm: I.st.aux.perm || 'acceptEdits', harness: S.harness, prompt });
    if (!I) return true;
    Object.assign(S, { id: rec.id, rec, where: { ...where, host: rec.host, dir: rec.dir } });
    (I.st.agentSess ||= {})[S.key] = rec.id;
    saveState();
    agentConnect(S);
  } catch (err) {
    S.pending = false;
    agentNote(S, err.message, 'bad');
  }
  paintChat(true);
  return true;
}

// --- the base chat's edits: blocks in its answer, typed into the editor once it's answered

const EDIT_RE = /^<{5,9} ?SEARCH\b[ \t:]*(.*)\n([\s\S]*?)^={5,9}[ \t]*\n([\s\S]*?)^>{5,9} ?REPLACE\b.*$/gm;
// a block's text, a fence the model put round it taken off
const unfence = (t) => {
  const x = String(t).replace(/\n$/, '');
  const m = x.match(/^```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  return m ? m[1] : x;
};
// a path line before a SEARCH: "path/to/file" alone on the marker's next line, when the marker named none
function editOf(m) {
  let path = m[1].trim().replace(/^[`*]+|[`*:]+$/g, '');
  let search = m[2];
  if (!path) {
    const first = search.split('\n')[0].trim();
    if (FILE_NAME_RE.test(first) && !/[;{}()=]/.test(first)) { path = first; search = search.slice(search.indexOf('\n') + 1); }
  }
  return { path, search: unfence(search), replace: unfence(m[3]) };
}
// a name a model writes alone above a block, as a file's
const FILE_NAME_RE = /^(?:[\w.-]+\/)*(?:[\w-][\w.-]*\.[A-Za-z0-9]{1,10}|makefile|gnumakefile|dockerfile|cmakelists\.txt|justfile|procfile)$/i;
// a whole file in a fenced block: its path the line just above it (bare, `code`, **bold**, File: x, x:)
// or in the fence's info string after its language (```c src/main.c, ```c title="main.c", ```make:Makefile)
const NAMED_RE = /(?:^|\n)[ \t]*(?:(?:\*\*|`)?(?:file(?:name)?:\s*)?((?:[\w.-]+\/)*[\w.-]+)(?:\*\*|`)?:?[ \t]*\n)?```([^\n]*)\n([\s\S]*?)\n```/gi;
function namedBlocks(text) {
  const out = [];
  for (const m of String(text).matchAll(NAMED_RE)) {
    const info = m[2].trim();
    const fromInfo = (info.match(/title=["']?([^"'\s]+)/) || info.match(/^[\w+-]*[\s:]+((?:[\w.-]+\/)*[\w.-]+\.\w+|(?:[\w.-]+\/)*(?:Makefile|makefile|Dockerfile|CMakeLists\.txt))$/) || [])[1];
    const above = m[1] && FILE_NAME_RE.test(m[1]) ? m[1] : '';
    const path = fromInfo || above;
    if (!path || /^<{5,9} ?SEARCH/m.test(m[3])) continue;
    out.push({ path, whole: m[3] });
  }
  return out;
}
const parseEdits = (text) => [...[...String(text).matchAll(EDIT_RE)].map(editOf), ...namedBlocks(String(text).replace(EDIT_RE, ''))];
// an answer shown with its edit blocks as diffs
const showEdits = (text) => String(text).replace(EDIT_RE, (...m) => {
  const e = editOf(m);
  const lines = (s, sign) => (s ? s.split('\n').map((l) => `${sign} ${l}`) : []);
  return `\`\`\`diff\n${e.path ? `@@ ${e.path}\n` : ''}${[...lines(e.search, '-'), ...lines(e.replace, '+')].join('\n')}\n\`\`\``;
});

// a Makefile's recipe lines tabbed, as make needs and models forget
function makeTabs(rel, text) {
  if (!/(^|\/)(gnu)?makefile$|\.mk$/i.test(rel)) return text;
  let inRule = false;
  return text.split('\n').map((l) => {
    if (/^[^\s#][^=]*:(?!=)/.test(l)) { inRule = true; return l; }
    if (inRule && /^ {2,}\S/.test(l)) return l.replace(/^ +/, '\t');
    if (inRule && l.startsWith('\t')) return l;
    if (!l.trim()) return l;
    inRule = false;
    return l;
  }).join('\n');
}

// a search found as written, else line by line with trailing blanks, then indents, let go
function findLoose(text, search) {
  const at = text.indexOf(search);
  if (at >= 0) return [at, at + search.length];
  const lines = text.split('\n');
  const starts = [];
  let off = 0;
  for (const l of lines) { starts.push(off); off += l.length + 1; }
  for (const norm of [(l) => l.trimEnd(), (l) => l.trim()]) {
    const want = search.split('\n').map(norm);
    while (want.length && !want.at(-1)) want.pop();
    while (want.length && !want[0]) want.shift();
    if (!want.length) return null;
    for (let i = 0; i + want.length <= lines.length; i++) {
      let k = 0;
      while (k < want.length && norm(lines[i + k]) === want[k]) k++;
      if (k === want.length) return [starts[i], starts[i + want.length - 1] + lines[i + want.length - 1].length];
    }
  }
  return null;
}

async function applyChatEdits(edits) {
  const out = [];
  const groups = new Map();
  for (const e of edits) {
    const p = e.path.replace(/^\.\//, '');
    const rel = p ? cleanPath(under(p, I.st.root) ? p : `${I.st.root}/${p}`) : I.active?.rel;
    if (!rel || !inScope(rel)) { out.push({ rel: e.path || '(no file open)', bad: 'outside the workspace' }); continue; }
    let t = I.tabs.find((x) => x.rel === rel && sameLoc(x.loc, locOf()) && x.kind === 'code');
    if (e.whole !== undefined) e.whole = makeTabs(rel, e.whole.endsWith('\n') ? e.whole : `${e.whole}\n`);
    if (e.replace !== undefined) e.replace = makeTabs(rel, e.replace);
    if (!t && !e.search && (await readAt(rel)) === null) {
      try { await writeAt(rel, '', locOf(), name || acct.user); } catch (err) { out.push({ rel, bad: err.message }); continue; }
      loadDir(filesParent(rel), true);
    }
    if (!I) return { list: out, undo: [] };
    if (!t) t = openFile(rel, { preview: false, focus: false });
    if (I.active !== t) activate(t, false);
    for (let i = 0; i < 120 && I && I.tabs.includes(t) && !t.ed?.ready?.(); i++) await sleep(80);
    if (!I) return { list: out, undo: [] };
    if (!t.ed?.ready?.()) { out.push({ rel, bad: 'it didn’t open' }); continue; }
    const text = t.ed.text();
    let span = null;
    if (e.whole !== undefined) {
      // the whole file: only where it differs changed, so the edit shows where it is
      let p0 = 0;
      while (p0 < text.length && p0 < e.whole.length && text[p0] === e.whole[p0]) p0++;
      let q0 = 0;
      while (q0 < text.length - p0 && q0 < e.whole.length - p0 && text[text.length - 1 - q0] === e.whole[e.whole.length - 1 - q0]) q0++;
      if (p0 === text.length && p0 === e.whole.length) { out.push({ rel }); continue; }
      span = [p0, text.length - q0];
      e.replace = e.whole.slice(p0, e.whole.length - q0);
      e.search = text.slice(p0, text.length - q0) || '\0';
    } else if (!e.search) span = [text.length, text.length];
    else span = findLoose(text, e.search);
    if (!span) { out.push({ rel, bad: 'what it meant to change isn’t there' }); continue; }
    const g = groups.get(t) || { t, list: [], wasDirty: t.ed.dirty() };
    groups.set(t, g);
    const old = text.slice(span[0], span[1]);
    const nu = !e.search && text && !text.endsWith('\n') ? `\n${e.replace}` : e.replace;
    if (e.search === '\0') e.search = '';
    if (await t.ed.agentEdit(span[0], span[1], nu)) { g.list.push({ at: span[0], old, nu }); out.push({ rel }); } else out.push({ rel, bad: 'the file is read-only here' });
  }
  for (const g of groups.values()) if (!g.wasDirty && g.list.length) g.t.ed.save();
  return { list: out, undo: [...groups.values()].filter((g) => g.list.length) };
}

// --- source control: git where the project is, the mesh's Forgejo beside it -----------------
// git run by the app's own server offline, or by the mesh's over your login on the
// project's machine; Forgejo as you, with the login your vault keeps for it

const SCM_LETTER = { M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', U: 'U', T: 'M', '?': 'U' };

// where git runs: the project's machine and its folder there
function gitWhere() {
  const host = isHomeLoc() ? runHost() : locOf().host;
  if (!host) return null;
  return { host, dir: hostPath(host, isHomeLoc() ? 'home' : locOf().share, I.st.root) };
}

// the mesh's Forgejo as you: its reply, and its domain and your name there kept
async function forgejo(method, path, body) {
  if (localDesktop() && !meshLinked()) throw new Error(standalone.server ? `log in to ${meshName()} for its Forgejo` : 'connect to a Phosphorus mesh for its Forgejo');
  const r = await fetch(meshApi('/api/sulfur/forgejo'), jsonPost({ method, path, body }));
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error || `status ${r.status}`);
  I.forgejo = { domain: b.domain, host: b.host, user: b.user };
  if (b.status >= 400) throw Object.assign(new Error(b.body?.message || (typeof b.body === 'string' ? b.body.slice(0, 200) : `Forgejo said ${b.status}`)), { status: b.status });
  return b.body;
}

// your Forgejo login for git offline, from the mesh's vault, for its own host only
async function forgejoCreds() {
  const l = standalone?.meshVault?.pages?.git;
  if (!localDesktop() || !meshLinked() || !l?.user) return null;
  if (!I.forgejo?.host) await forgejo('GET', '/user').catch(() => null);
  return I.forgejo?.host ? { host: I.forgejo.host, user: l.user, pass: l.pass } : null;
}

// git in the project's folder: its output, or why it failed in git's own last lines
async function git(args, o = {}) {
  const w = o.where || gitWhere();
  if (!w) throw new Error(`no machine to run git on: log into one ${loginWhere()}`);
  const body = { host: w.host, dir: o.dir || w.dir, args };
  if (['clone', 'push', 'pull', 'fetch'].includes(args[0])) body.creds = await forgejoCreds().catch(() => null);
  const r = await fetch(hostUrl(w.host, '/api/sulfur/git'), jsonPost(body));
  const b = await r.json().catch(() => ({}));
  if (r.status === 404) throw new Error(`${w.host}'s Phosphorus is older than this Sulfur: update the mesh for Source Control there`);
  if (!r.ok) throw Object.assign(new Error(b.error || `status ${r.status}`), b);
  if (b.code !== 0 && !o.anyCode) {
    const said = String(b.err || b.out || '').trim().split('\n').filter(Boolean).slice(-3).join('\n');
    throw Object.assign(new Error(said || `git ${args[0]} failed (${b.code})`), b);
  }
  return b;
}

// a path git gives (from the repository's top) as the workspace's own, '' if outside it
function scmRel(p) {
  const pre = I.scm?.prefix || '';
  if (pre && !p.startsWith(pre)) return '';
  return `${I.st.root}/${p.slice(pre.length)}`;
}
const top = (p) => `:(top)${p}`;

function buildScm() {
  const v = I.sideViews.get('scm');
  v.acts = [
    btn('', 'refresh', 'Refresh', () => scmRefresh(true)),
    btn('', 'more', 'More Actions…', (e) => menu(e.currentTarget, scmMenu(), { side: 'left' })),
  ];
  v.onShow = () => scmRefresh();
  v.focus = () => v.body.querySelector('textarea')?.focus();
  I.scm = null;
}

function scmMenu() {
  const s = I.scm;
  const repo = !!s?.top;
  return [
    { label: 'Pull', disabled: !repo, run: () => scmOp(['pull'], 'Pulling') },
    { label: 'Push', disabled: !repo, run: () => scmPush() },
    { label: 'Sync (Pull, then Push)', disabled: !repo, run: () => scmSync() },
    { label: 'Fetch', disabled: !repo, run: () => scmOp(['fetch', '--prune'], 'Fetching') },
    '-',
    { label: 'Checkout to…', disabled: !repo, run: () => run('sulfur.git.branch') },
    { label: 'Create Branch…', disabled: !repo, run: () => scmNewBranch() },
    { label: 'Stash Changes', disabled: !repo, run: () => scmOp(['stash', 'push', '--include-untracked'], 'Stashing') },
    { label: 'Pop Latest Stash', disabled: !repo, run: () => scmOp(['stash', 'pop'], 'Unstashing') },
    { label: 'View History…', disabled: !repo, run: () => scmHistory() },
    '-',
    { label: 'Open on Forgejo', disabled: !repo, run: () => run('sulfur.forgejo.open') },
    { label: 'Create Pull Request…', disabled: !repo, run: () => run('sulfur.forgejo.pr') },
    { label: 'Pull Requests…', disabled: !repo, run: () => run('sulfur.forgejo.prs') },
    { label: 'Publish to Forgejo…', disabled: !repo || !!s?.upstream, run: () => run('sulfur.forgejo.publish') },
    '-',
    cmdItem('sulfur.git.clone', 'Clone Repository…'),
  ];
}

// the repository's state read again: its top, its branch, what's staged and what's changed
async function scmRefresh(loud = false) {
  const v = I.sideViews.get('scm');
  if (!v) return;
  const key = wsKey();
  let s = { key, top: '', prefix: '', branch: '', upstream: '', ahead: 0, behind: 0, staged: [], changes: [], why: '' };
  try {
    const where = await git(['rev-parse', '--show-toplevel', '--show-prefix'], { anyCode: true });
    if (where.code !== 0) {
      s.why = /not a git repository/i.test(where.err) ? 'none' : (where.err || 'git failed').trim();
    } else {
      const [t, pre = ''] = where.out.replace(/\r/g, '').split('\n');
      s.top = t.trim();
      s.prefix = pre.trim();
      const st = await git(['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all']);
      const parts = st.out.split('\0');
      for (let i = 0; i < parts.length; i++) {
        const e = parts[i];
        if (!e) continue;
        if (e.startsWith('## ')) {
          const h = e.slice(3);
          const m = h.match(/^(?:No commits yet on )?([^.\s]+(?:\.(?!\.)[^.\s]*)*)(?:\.\.\.(\S+))?(?: \[(.*)\])?/);
          s.branch = m?.[1] || h;
          s.upstream = m?.[2] || '';
          s.ahead = Number((m?.[3] || '').match(/ahead (\d+)/)?.[1] || 0);
          s.behind = Number((m?.[3] || '').match(/behind (\d+)/)?.[1] || 0);
          continue;
        }
        const x = e[0];
        const y = e[1];
        const path = e.slice(3);
        let from = '';
        if (x === 'R' || x === 'C') from = parts[++i] || '';
        if (x === '?' && y === '?') { s.changes.push({ path, code: 'U', untracked: true }); continue; }
        if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) { s.changes.push({ path, code: '!', conflict: true }); continue; }
        if (x !== ' ') s.staged.push({ path, from, code: SCM_LETTER[x] || x });
        if (y !== ' ') s.changes.push({ path, code: SCM_LETTER[y] || y, deleted: y === 'D' });
      }
    }
  } catch (err) {
    s.why = err.message;
  }
  if (!I || wsKey() !== key) return;
  I.scm = s;
  if (loud && s.why && s.why !== 'none') notify('error', `Source Control: ${s.why}`);
  paintScm();
  paintStatus();
}

function paintScm() {
  const v = I.sideViews.get('scm');
  if (!v) return;
  const s = I.scm;
  const btnEl = I.actBtns.get('scm');
  const n = (s?.staged.length || 0) + (s?.changes.length || 0);
  btnEl?.querySelector('.ide-act-badge')?.remove();
  if (n) btnEl?.append(el('span', 'ide-act-badge', n > 99 ? '99+' : String(n)));
  if (v.body.hidden && v.body.childElementCount) return;
  const body = v.body;
  const keepMsg = body.querySelector('.ide-scm-msg')?.value || I.scmMsg || '';
  body.replaceChildren();
  if (!s) { body.append(el('p', 'ide-empty-note', 'Looking for a repository…')); return; }
  if (!s.top) {
    const box = el('div', 'ide-scm-empty');
    if (s.why === 'none') {
      box.append(el('p', '', `${baseName(I.st.root)} isn’t in a Git repository.`));
      const init = Object.assign(el('button', 'ide-button'), { type: 'button', textContent: 'Initialize Repository' });
      init.addEventListener('click', () => scmOp(['init'], 'Making a repository'));
      box.append(init);
    } else box.append(el('p', 'bad', s.why));
    const clone = Object.assign(el('button', 'ide-button secondary'), { type: 'button', textContent: 'Clone Repository…' });
    clone.addEventListener('click', () => run('sulfur.git.clone'));
    box.append(clone, el('p', 'ide-run-note', 'Clone from your mesh’s Forgejo, or any address.'));
    body.append(box);
    return;
  }
  // the message and the commit, as VS Code's
  const commitBox = el('div', 'ide-scm-commit');
  const msg = Object.assign(el('textarea', 'ide-input ide-scm-msg'), { rows: 1, value: keepMsg, placeholder: `Message (Ctrl+Enter to commit on “${s.branch}”)`, spellcheck: true });
  msg.addEventListener('input', () => { I.scmMsg = msg.value; msg.style.height = 'auto'; msg.style.height = `${Math.min(msg.scrollHeight, 160)}px`; });
  msg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); scmCommit(); } });
  const row = el('div', 'ide-run-row');
  const commit = Object.assign(el('button', 'ide-button ide-run-go'), { type: 'button' });
  commit.append(icon('check'), el('span', '', s.staged.length || !s.changes.length ? 'Commit' : 'Commit All'));
  commit.disabled = !s.staged.length && !s.changes.length;
  commit.addEventListener('click', () => scmCommit());
  const more = Object.assign(el('button', 'ide-button'), { type: 'button', title: 'More commit actions' });
  more.append(icon('down'));
  more.addEventListener('click', () => menu(more, [
    { label: 'Commit & Push', run: () => scmCommit({ push: true }) },
    { label: 'Commit & Sync', run: () => scmCommit({ sync: true }) },
    { label: 'Commit All (Stage Everything)', run: () => scmCommit({ all: true }) },
    { label: 'Amend Last Commit', run: () => scmCommit({ amend: true }) },
  ]));
  row.append(commit, more);
  commitBox.append(msg, row);
  // the branch and how far it is from its upstream
  const br = el('div', 'ide-scm-branch');
  const bname = Object.assign(el('button', 'ide-link'), { type: 'button', title: 'Checkout to…' });
  bname.append(icon('branch'), el('span', '', s.branch || '(detached)'));
  bname.addEventListener('click', () => run('sulfur.git.branch'));
  br.append(bname);
  const sync = Object.assign(el('button', 'ide-link'), { type: 'button', title: s.upstream ? `Sync with ${s.upstream}` : 'Publish this branch' });
  sync.append(icon('refresh'), el('span', '', s.upstream ? `${s.behind}↓ ${s.ahead}↑` : 'Publish Branch'));
  sync.addEventListener('click', () => (s.upstream ? scmSync() : scmPush()));
  br.append(sync);
  body.append(commitBox, br);

  const section = (title, list, staged) => {
    if (!list.length) return;
    const head = el('div', 'ide-sec-head static ide-scm-head');
    head.append(el('span', 'ide-sec-title', title), el('span', 'ide-badge', String(list.length)));
    const acts = el('span', 'ide-actions');
    if (staged) acts.append(btn('', 'minus', 'Unstage All Changes', () => scmOp(['restore', '--staged', '--', top('.')], 'Unstaging')));
    else {
      acts.append(btn('', 'undo', 'Discard All Changes', () => scmDiscard(list)));
      acts.append(btn('', 'plus', 'Stage All Changes', () => scmOp(['add', '-A', '--', top('.')], 'Staging')));
    }
    head.append(acts);
    body.append(head);
    for (const x of list) body.append(scmRow(x, staged));
  };
  section('Staged Changes', s.staged, true);
  section('Changes', s.changes, false);
  if (!s.staged.length && !s.changes.length) body.append(el('p', 'ide-empty-note', `Nothing to commit on ${s.branch}: the working tree is clean.`));
}

function scmRow(x, staged) {
  const rel = scmRel(x.path);
  const r = Object.assign(el('div', `ide-scm-row c-${x.conflict ? 'conflict' : x.code}`), { tabIndex: 0, title: `${x.path}${x.from ? ` (from ${x.from})` : ''}` });
  r.append(fileIcon(x.path), el('span', 'ide-scm-name', baseName(x.path)), el('span', 'ide-scm-dir', filesParent(x.path)));
  const acts = el('span', 'ide-actions');
  if (rel && !x.deleted) acts.append(btn('', 'file', 'Open File', (e) => { e.stopPropagation(); openFile(rel, { preview: false }); }));
  if (staged) acts.append(btn('', 'minus', 'Unstage Changes', (e) => { e.stopPropagation(); scmOp(['restore', '--staged', '--', top(x.path)], 'Unstaging'); }));
  else {
    acts.append(btn('', 'undo', 'Discard Changes', (e) => { e.stopPropagation(); scmDiscard([x]); }));
    acts.append(btn('', 'plus', 'Stage Changes', (e) => { e.stopPropagation(); scmOp(['add', '--', top(x.path)], 'Staging'); }));
  }
  r.append(acts, el('span', 'ide-scm-code', x.conflict ? '!' : x.code));
  const open = () => (x.conflict && rel ? openFile(rel, { preview: false }) : openDiff(x, staged));
  r.addEventListener('click', open);
  r.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  return r;
}

// a git command that changes the tree: said while it runs, the view, the explorer and clean tabs after
async function scmOp(args, doing, o = {}) {
  const note = notify('info', `${doing}…`, { progress: true, sticky: true });
  let r;
  try { r = await git(args, o); } catch (err) { note.close(); notify('error', `${doing.replace(/ing$/, '')}: ${err.message}`); await scmAfter(); return null; }
  note.close();
  await scmAfter();
  return r;
}
async function scmAfter() {
  if (!I) return;
  await scmRefresh();
  if (!I) return;
  loadDir(I.st.root, true);
  for (const d of I.expanded) if (d !== I.st.root) loadDir(d, true);
  syncCleanTabs();
  I.index = null;
}

// every clean tab of the workspace made what its disk now holds: a pull's, a checkout's
async function syncCleanTabs() {
  for (const t of I.tabs.filter((x) => x.kind === 'code' && x.rel && sameLoc(x.loc, locOf()) && x.ed?.ready?.() && !x.ed.dirty())) {
    let disk = null;
    try {
      const b = await filesCall(isHomeLoc() ? homeAt(t.host) : apiLoc(), 'read', undefined, { path: t.rel });
      disk = typeof b.text === 'string' ? b.text : null;
    } catch {}
    if (!I || disk === null || t.ed.dirty()) continue;
    const text = t.ed.text();
    if (text === disk) continue;
    let p = 0;
    while (p < text.length && p < disk.length && text[p] === disk[p]) p++;
    let q = 0;
    while (q < text.length - p && q < disk.length - p && text[text.length - 1 - q] === disk[disk.length - 1 - q]) q++;
    if (await t.ed.agentEdit(p, text.length - q, disk.slice(p, disk.length - q), { instant: true })) t.ed.save();
  }
}

async function scmDiscard(list) {
  const n = list.length;
  const v = await ask({
    title: n === 1 ? `Discard the changes in ${baseName(list[0].path)}?` : `Discard all ${n} changes?`,
    detail: list.some((x) => x.untracked) ? 'New files are deleted. This can’t be undone.' : 'This can’t be undone.',
    buttons: [{ label: n === 1 ? 'Discard File' : 'Discard All', danger: true, primary: true, value: 'yes' }, { label: 'Cancel', value: '' }],
  });
  if (v !== 'yes' || !I) return;
  const tracked = list.filter((x) => !x.untracked).map((x) => top(x.path));
  if (tracked.length) await scmOp(['restore', '--worktree', '--', ...tracked], 'Discarding');
  for (const x of list.filter((y) => y.untracked)) {
    const rel = scmRel(x.path);
    if (rel) await filesCall(apiLoc(), 'delete', jsonPost({ path: rel })).catch((err) => notify('error', `${x.path}: ${err.message}`));
  }
  await scmAfter();
}

async function scmCommit(o = {}) {
  const s = I.scm;
  if (!s?.top) { notify('info', 'There’s no repository here to commit to.'); return; }
  const box = I.sideViews.get('scm').body.querySelector('.ide-scm-msg');
  let msg = (box?.value || I.scmMsg || '').trim();
  if (!msg && !o.amend) {
    msg = (await inputBox({ title: `Commit on ${s.branch}`, placeholder: 'The commit message' }))?.trim() || '';
    if (!msg || !I) return;
  }
  await saveAll();
  if (!I) return;
  // nothing staged: everything, as VS Code's smart commit asks
  if (o.all || (!s.staged.length && s.changes.length)) {
    if (!o.all) {
      const v = await ask({ title: 'There are no staged changes. Stage all your changes and commit them directly?', buttons: [{ label: 'Yes', primary: true, value: 'yes' }, { label: 'Cancel', value: '' }] });
      if (v !== 'yes' || !I) return;
    }
    if (!(await scmOp(['add', '-A', '--', top('.')], 'Staging'))) return;
  }
  const paras = msg ? msg.split(/\n\s*\n/).flatMap((p) => ['-m', p]) : ['--no-edit'];
  const done = await scmOp(['commit', ...(o.amend ? ['--amend'] : []), ...paras], o.amend ? 'Amending' : 'Committing');
  if (!done || !I) return;
  I.scmMsg = '';
  const b = I.sideViews.get('scm').body.querySelector('.ide-scm-msg');
  if (b) b.value = '';
  setStatusFlash(`Committed on ${s.branch}`);
  if (o.push) await scmPush();
  else if (o.sync) await scmSync();
}

async function scmPush() {
  const s = I.scm;
  if (!s?.top) return;
  if (s.upstream) await scmOp(['push'], 'Pushing');
  else await scmOp(['push', '-u', 'origin', s.branch], `Publishing ${s.branch}`);
}
async function scmSync() {
  if (await scmOp(['pull'], 'Pulling')) await scmPush();
}

async function scmNewBranch() {
  const name = await inputBox({ title: 'Create Branch', placeholder: 'Branch name', validate: (v) => (/^[\w./-]+$/.test(v.trim()) && !v.includes('..') ? '' : 'Letters, digits, . / - and _') });
  if (!name || !I) return;
  await scmOp(['switch', '-c', name.trim()], `Creating ${name.trim()}`);
}

async function scmBranchPick() {
  if (!I.scm?.top) await scmRefresh();
  if (!I.scm?.top) { notify('info', 'There’s no repository here.'); return; }
  let refs = [];
  try { refs = (await git(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%09%(refname)%09%(committerdate:relative)', 'refs/heads', 'refs/remotes'])).out.trim().split('\n').filter(Boolean).map((l) => l.split('\t')); } catch (err) { notify('error', err.message); return; }
  const local = refs.filter((r) => r[1].startsWith('refs/heads/'));
  const remote = refs.filter((r) => r[1].startsWith('refs/remotes/') && !r[0].endsWith('/HEAD') && !local.some((l) => r[0].endsWith(`/${l[0]}`)));
  const v = await pick([
    { label: 'Create New Branch…', ic: 'plus', value: { make: true } },
    ...local.map((r, i) => ({ label: r[0], description: r[0] === I.scm.branch ? 'current' : '', detail: r[2], ic: 'branch', value: { name: r[0] }, sep: i === 0 ? 'branches' : '' })),
    ...remote.map((r, i) => ({ label: r[0], detail: r[2], ic: 'remote', value: { remote: r[0] }, sep: i === 0 ? 'remote branches' : '' })),
  ], { title: 'Checkout to…', placeholder: 'Select a branch to switch to', matchDescription: true });
  if (!v || !I) return;
  if (v.make) { await scmNewBranch(); return; }
  await saveAll();
  if (v.remote) await scmOp(['switch', '--track', v.remote], `Switching to ${v.remote}`);
  else if (v.name !== I.scm.branch) await scmOp(['switch', v.name], `Switching to ${v.name}`);
}

async function scmHistory() {
  let lines = [];
  try { lines = (await git(['log', '-n', '200', '--format=%h%x09%s%x09%an%x09%ar'])).out.trim().split('\n').filter(Boolean).map((l) => l.split('\t')); } catch (err) { notify('error', err.message); return; }
  const v = await pick(lines.map(([h, subj, who, when]) => ({ label: subj, description: `${h} · ${who}`, detail: when, ic: 'branch', value: h })), { title: `History of ${I.scm?.branch || 'this branch'}`, placeholder: 'Search the commits', matchDescription: true });
  if (!v || !I) return;
  const r = await git(['show', '--stat', '--patch', '--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n%w(0,4,4)%B', v]).catch((err) => { notify('error', err.message); return null; });
  if (r) showDiffPage(`commit:${v}`, `Commit ${v}`, r.out, null);
}

// a file's changes against its last commit, or what's staged, as a page
async function openDiff(x, staged) {
  const rel = scmRel(x.path);
  let text = '';
  if (x.untracked) {
    const body = rel ? await readAt(rel) : null;
    text = (body ?? '').split('\n').map((l) => `+${l}`).join('\n');
    text = `@@ new file @@\n${text}`;
  } else {
    const r = await git(['diff', ...(staged ? ['--cached'] : []), '--', top(x.path)], { anyCode: true }).catch((err) => ({ out: '', err: err.message }));
    text = r.out || r.err || '';
  }
  showDiffPage(`diff:${staged ? 'i' : 'w'}:${x.path}`, `${baseName(x.path)} (${x.untracked ? 'Untracked' : staged ? 'Index' : 'Working Tree'})`, text, rel && !x.deleted ? rel : null);
}

function showDiffPage(key, title, text, rel) {
  const t = openPage(key, title, 'split', (p) => { p.diffBody = el('div', 'ide-diff'); p.view.append(p.diffBody); });
  const head = el('div', 'ide-page-head');
  if (rel) {
    const open = Object.assign(el('button', 'ide-button secondary'), { type: 'button' });
    open.append(icon('file'), el('span', '', 'Open File'));
    open.addEventListener('click', () => openFile(rel, { preview: false }));
    head.append(open);
  }
  const rows = [];
  let a = 0;
  let b = 0;
  for (const l of String(text).replace(/\r/g, '').split('\n')) {
    const hunk = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (hunk) { a = +hunk[1]; b = +hunk[2]; rows.push(['hunk', '', '', l]); continue; }
    if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |commit |Author:|Date:)/.test(l) || (!a && !b && !/^[+-]/.test(l))) { rows.push(['meta', '', '', l]); continue; }
    if (l.startsWith('+')) rows.push(['add', '', b++, l.slice(1)]);
    else if (l.startsWith('-')) rows.push(['del', a++, '', l.slice(1)]);
    else if (l.startsWith('\\')) rows.push(['meta', '', '', l]);
    else rows.push(['', a++, b++, l.slice(1)]);
  }
  const box = el('div', 'ide-diff-lines');
  for (const [k, x, y, l] of rows.slice(0, 20000)) {
    const r = el('div', `ide-diff-l ${k}`);
    r.append(el('span', 'ide-diff-n', String(x)), el('span', 'ide-diff-n', String(y)), el('span', 'ide-diff-t', l || ' '));
    box.append(r);
  }
  if (!rows.length || rows.every((r) => r[0] === 'meta')) box.append(el('p', 'ide-empty-note', 'No changes.'));
  t.diffBody?.replaceChildren(head, box);
  return t;
}

// --- Forgejo: clone, publish, open, pull requests ----------------------------------------------

// a web address, in the system's browser from the app
function openExternal(url) {
  const t = window.__TAURI__;
  if (t?.opener?.openUrl) t.opener.openUrl(url).catch(() => window.open(url, '_blank', 'noopener'));
  else if (t?.core?.invoke) t.core.invoke('plugin:opener|open_url', { url }).catch(() => window.open(url, '_blank', 'noopener'));
  else window.open(url, '_blank', 'noopener');
}

// the repository's origin as Forgejo's owner and name, null if it isn't the mesh's Forgejo
async function forgejoRepo() {
  const r = await git(['remote', 'get-url', 'origin'], { anyCode: true });
  const url = r.out.trim();
  if (!url) return null;
  if (!I.forgejo?.host) await forgejo('GET', '/user').catch(() => null);
  const host = I.forgejo?.host;
  const m = url.match(/^(?:https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/|ssh:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/|[^@]+@([^:]+):)([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const at = m[1] || m[2] || m[3];
  if (host && at !== host) return null;
  return { owner: m[4], repo: m[5], web: `https://${host || at}/${m[4]}/${m[5]}` };
}

async function forgejoOpen(rel) {
  const r = await forgejoRepo().catch((err) => { notify('error', err.message); return null; });
  if (!r) { notify('info', 'This repository’s origin isn’t on the mesh’s Forgejo.', { actions: [{ label: 'Publish to Forgejo…', run: () => run('sulfur.forgejo.publish') }] }); return; }
  const branch = encodeURIComponent(I.scm?.branch || 'main');
  const path = rel && under(rel, I.st.root) ? `${I.scm?.prefix || ''}${wsRel(rel)}` : (I.scm?.prefix || '').replace(/\/$/, '');
  openExternal(`${r.web}/src/branch/${branch}${path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : ''}`);
}

async function forgejoPublish() {
  if (!I.scm?.top) await scmRefresh();
  if (!I.scm?.top) { notify('info', 'Initialize a repository here first.'); return; }
  let me;
  try { me = await forgejo('GET', '/user'); } catch (err) { notify('error', `Forgejo: ${err.message}`); return; }
  const name = await inputBox({ title: `Publish to ${I.forgejo.host}`, value: baseName(I.st.root), prompt: `A new repository of ${me.login}'s.`, validate: (v) => (/^[\w.-]+$/.test(v.trim()) ? '' : 'Letters, digits, . - and _') });
  if (!name || !I) return;
  const vis = await pick([{ label: 'Private', description: 'only you, and who you add', value: true }, { label: 'Public', description: 'everyone on the mesh can see it', value: false }], { title: `Publish ${name.trim()}` });
  if (vis === undefined || !I) return;
  let repo;
  try { repo = await forgejo('POST', '/user/repos', { name: name.trim(), private: vis, auto_init: false }); } catch (err) { notify('error', `Forgejo: ${err.message}`); return; }
  const hasOrigin = (await git(['remote'], { anyCode: true })).out.split('\n').includes('origin');
  await git(['remote', hasOrigin ? 'set-url' : 'add', 'origin', repo.clone_url]).catch((err) => notify('error', err.message));
  if (await scmOp(['push', '-u', 'origin', I.scm.branch || 'main'], `Publishing to ${repo.full_name}`)) notify('info', `Published ${repo.full_name} on Forgejo.`, { actions: [{ label: 'Open', run: () => openExternal(repo.html_url) }] });
}

async function forgejoPR() {
  if (!I.scm?.top) await scmRefresh();
  const s = I.scm;
  if (!s?.top) return;
  const r = await forgejoRepo().catch(() => null);
  if (!r) { notify('info', 'This repository’s origin isn’t on the mesh’s Forgejo.'); return; }
  let info;
  try { info = await forgejo('GET', `/repos/${r.owner}/${r.repo}`); } catch (err) { notify('error', `Forgejo: ${err.message}`); return; }
  if (s.branch === info.default_branch) { notify('info', `You're on ${s.branch}, the repository's default branch: create a branch for the pull request first.`, { actions: [{ label: 'Create Branch…', run: () => scmNewBranch() }] }); return; }
  if (!s.upstream || s.ahead) await scmPush();
  if (!I) return;
  const subject = (await git(['log', '-1', '--format=%s'], { anyCode: true }).catch(() => ({ out: '' }))).out.trim();
  const title = await inputBox({ title: `Pull request: ${s.branch} into ${info.default_branch}`, value: subject, placeholder: 'Its title' });
  if (!title?.trim() || !I) return;
  try {
    const pr = await forgejo('POST', `/repos/${r.owner}/${r.repo}/pulls`, { base: info.default_branch, head: s.branch, title: title.trim() });
    notify('info', `Pull request #${pr.number} opened on ${r.owner}/${r.repo}.`, { actions: [{ label: 'Open', run: () => openExternal(pr.html_url) }] });
  } catch (err) { notify('error', `Forgejo: ${err.message}`); }
}

async function forgejoPRs() {
  const r = await forgejoRepo().catch(() => null);
  if (!r) { notify('info', 'This repository’s origin isn’t on the mesh’s Forgejo.'); return; }
  let prs;
  try { prs = await forgejo('GET', `/repos/${r.owner}/${r.repo}/pulls?state=open&limit=50`); } catch (err) { notify('error', `Forgejo: ${err.message}`); return; }
  if (!prs?.length) { notify('info', `No open pull requests on ${r.owner}/${r.repo}.`, { actions: [{ label: 'Create One…', run: () => forgejoPR() }] }); return; }
  const v = await pick(prs.map((p) => ({ label: `#${p.number} ${p.title}`, description: `${p.head?.ref} → ${p.base?.ref}`, detail: `by ${p.user?.login}`, ic: 'branch', value: p.html_url })), { title: `Pull Requests: ${r.owner}/${r.repo}`, matchDescription: true });
  if (v) openExternal(v);
}

// a repository cloned: from the mesh's Forgejo or any address, into a folder picked, then opened
async function gitClone() {
  let url = '';
  const items = [];
  if (!localDesktop() || meshLinked()) {
    try {
      const found = await forgejo('GET', '/repos/search?limit=50&sort=updated&order=desc');
      for (const x of found?.data || []) items.push({ label: x.full_name, description: x.description || '', detail: x.private ? 'private' : '', ic: 'branch', value: x.clone_url, sep: items.length ? '' : `${I.forgejo.host}` });
    } catch {}
  }
  items.push({ label: 'Clone from an Address…', description: 'https://, ssh:// or git@', ic: 'remote', value: '__url', sep: 'more' });
  const v = await pick(items, { title: 'Clone Repository', placeholder: items.length > 1 ? 'A repository of your mesh’s Forgejo, or an address' : 'Clone from an address', matchDescription: true });
  if (!v || !I) return;
  url = v;
  if (v === '__url') {
    url = (await inputBox({ title: 'Clone from an Address', placeholder: 'https://git.example.com/owner/repo.git' }))?.trim() || '';
    if (!url || !I) return;
  }
  const where = await pickPlace(`Clone ${url.split('/').pop().replace(/\.git$/, '')}: into`, { placeholder: 'The folder the repository goes in' });
  if (!where || !I) return;
  const name = await inputBox({ title: 'Its folder’s name', value: url.split('/').pop().replace(/\.git$/, ''), validate: projectNameWhy });
  if (!name || !I) return;
  const host = isHomeLoc(where.loc) ? (localDesktop() ? selfHost : runHost()) : where.loc.host;
  const parent = hostPath(host, isHomeLoc(where.loc) ? 'home' : where.loc.share, where.dir);
  if (!parent) { notify('error', `Can't tell where ${where.dir} is on ${host}.`); return; }
  const note = notify('info', `Cloning ${url}…`, { progress: true, sticky: true });
  try { await git(['clone', '--progress', url, name.trim()], { where: { host }, dir: parent }); } catch (err) { note.close(); notify('error', `Clone: ${err.message}`); return; }
  note.close();
  if (!I) return;
  setRoot(filesJoin(where.dir, name.trim()), false, where.loc);
  notify('info', `Cloned into ${name.trim()}.`);
}

// --- search: the workspace's text on every online host ---------------------------------------
// the hosts' own search, case-blind substrings with a name glob; case and whole
// words narrowed here, so what's offered is only what's kept

function buildSearch() {
  const v = I.sideViews.get('search');
  const form = el('div', 'ide-search-form');
  const field = el('div', 'ide-find-field');
  const q = Object.assign(el('input', 'ide-input'), { placeholder: 'Search', spellcheck: false, autocomplete: 'off' });
  q.setAttribute('aria-label', 'Search');
  const opt = (label, title, key, cls = '') => {
    const b = Object.assign(el('button', `ide-opt ${cls}`, label), { type: 'button', title });
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => { S[key] = !S[key]; b.classList.toggle('on', S[key]); b.setAttribute('aria-pressed', String(S[key])); go(); });
    return b;
  };
  const S = { caseS: false, word: false, results: [], open: new Set(), gen: 0 };
  field.append(q, opt('Aa', 'Match Case', 'caseS'), opt('ab', 'Match Whole Word', 'word', 'ide-opt-word'));
  const more = btn('ide-search-more', 'more', 'Toggle Search Details', () => { details.hidden = !details.hidden; more.classList.toggle('on', !details.hidden); });
  const top = el('div', 'ide-search-top');
  top.append(field, more);
  const details = el('div', 'ide-search-details');
  details.hidden = true;
  const inc = Object.assign(el('input', 'ide-input'), { placeholder: 'e.g. *.c', spellcheck: false });
  const exc = Object.assign(el('input', 'ide-input'), { placeholder: 'e.g. *.min.js, build', spellcheck: false });
  details.append(el('label', 'ide-search-lab', 'files to include'), inc, el('label', 'ide-search-lab', 'files to exclude'), exc);
  form.append(top, details);
  const summary = el('div', 'ide-search-summary');
  const list = Object.assign(el('div', 'ide-search-results'), { tabIndex: 0 });
  list.setAttribute('role', 'tree');
  v.body.append(form, summary, list);
  const go = debounce(() => runSearch(), 300);
  for (const x of [q, inc, exc]) {
    x.addEventListener('input', go);
    x.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go.cancel(); runSearch(); } });
  }
  v.focus = () => { q.focus(); q.select(); };
  v.acts = [
    btn('', 'trash', 'Clear Search Results', () => { q.value = ''; S.results = []; paint(); q.focus(); }),
    btn('', 'collapse', 'Collapse All', () => { S.open = new Set(); paint(); }),
  ];
  I.search = { q, S, paint: () => paint(), list };

  async function runSearch() {
    const query = q.value;
    const gen = (S.gen += 1);
    if (!query.trim()) { S.results = []; paint(); return; }
    summary.textContent = 'Searching…';
    const glob = inc.value.trim().split(',')[0]?.trim() || '';
    const root = I.st.root;
    const where = isHomeLoc() ? homeOnline().map((h) => [h, homeAt(h)]) : [[locOf().host, apiLoc()]];
    const got = await Promise.all(where.map(([h, at]) => filesCall(at, 'search', undefined, { path: root, query, content: 'true', skip: searchSkip(), ...(glob ? { glob } : {}) })
      .then((b) => ({ h, b }), () => null)));
    if (!I || gen !== S.gen) return;
    const skip = excluded();
    const exGlobs = exc.value.split(',').map((s) => s.trim()).filter(Boolean)
      .map((g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`));
    const word = S.word ? new RegExp(`(^|[^\\p{L}\\p{N}_])${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}_])`, S.caseS ? 'u' : 'iu') : null;
    const by = new Map();
    let truncated = false;
    for (const g of got) {
      if (!g) continue;
      truncated ||= !!g.b.truncated;
      for (const r of g.b.results || []) {
        const segs = r.path.split('/');
        if (segs.some(skip) || segs.some((s) => exGlobs.some((re) => re.test(s)))) continue;
        const hits = (r.matches || []).filter((m) => (!S.caseS || m.text.includes(query)) && (!word || word.test(m.text)));
        if (!hits.length) continue;
        if (!by.has(r.path)) by.set(r.path, { path: r.path, host: g.h, matches: hits });
      }
    }
    S.results = [...by.values()].sort((a, b) => a.path.localeCompare(b.path));
    S.open = new Set(S.results.map((r) => r.path));
    S.truncated = truncated;
    S.query = query;
    paint();
  }

  function paint() {
    const n = S.results.reduce((k, r) => k + r.matches.length, 0);
    summary.textContent = !q.value.trim() ? '' : n ? `${n} result${n === 1 ? '' : 's'} in ${S.results.length} file${S.results.length === 1 ? '' : 's'}${S.truncated ? ' (the hosts stopped early: narrow the search)' : ''}` : 'No results found. Review your settings for configured exclusions.';
    summary.title = 'Each host reports at most 5 matching lines per file.';
    const rows = [];
    const rel = (p) => (under(p, I.st.root) ? p.slice(I.st.root.length + 1) : p);
    for (const r of S.results) {
      const open = S.open.has(r.path);
      const head = el('div', 'ide-sr-file');
      head.setAttribute('role', 'treeitem');
      head.setAttribute('aria-expanded', String(open));
      head.title = `${r.path}\non ${r.host}`;
      head.append(icon(open ? 'down' : 'right', 'ide-chev-ic'), fileIcon(r.path), el('span', 'ide-sr-name', baseName(r.path)), el('span', 'ide-sr-dir', filesParent(rel(r.path))), el('span', 'ide-badge', String(r.matches.length)));
      head.addEventListener('click', () => { if (open) S.open.delete(r.path); else S.open.add(r.path); paint(); });
      rows.push(head);
      if (!open) continue;
      for (const m of r.matches) {
        const row = el('div', 'ide-sr-match');
        row.setAttribute('role', 'treeitem');
        row.title = `${m.text}\nLn ${m.line}`;
        const text = m.text;
        const lower = S.caseS ? text : text.toLowerCase();
        const needle = S.caseS ? S.query : S.query.toLowerCase();
        const hl = [];
        for (let i = lower.indexOf(needle); i >= 0 && hl.length < 20; i = lower.indexOf(needle, i + needle.length)) hl.push([i, i + needle.length]);
        const span = el('span', 'ide-sr-text');
        span.append(hlText(text, hl));
        row.append(span, el('span', 'ide-sr-line', String(m.line)));
        row.addEventListener('click', () => openMatch(r, m));
        rows.push(row);
      }
    }
    list.replaceChildren(...rows);
  }
}

// a hit opened at its line, its match picked out once the text's in
function openMatch(r, m) {
  const t = openFile(r.path, { preview: true, host: r.host, focus: true });
  if (!t || t.kind !== 'code') return;
  const q = I.search.S.query;
  t.pendingSel = null;
  const place = () => {
    const text = t.ed.text();
    const a = offsetOf(text, m.line, 1);
    const end = text.indexOf('\n', a);
    const line = text.slice(a, end < 0 ? text.length : end);
    const i = I.search.S.caseS ? line.indexOf(q) : line.toLowerCase().indexOf(q.toLowerCase());
    if (i >= 0) t.ed.select(a + i, a + i + q.length); else t.ed.select(a, a);
  };
  if (t.info?.ready) place(); else t.pendingSel = { line: m.line, col: 1, then: place };
}

function findInFiles() {
  const t = I.active;
  showSide('search', true, true);
  if (t?.ed) {
    const [s, e] = t.ed.selection();
    const sel = t.ed.text().slice(s, e);
    if (sel && !sel.includes('\n')) { I.search.q.value = sel; I.search.q.dispatchEvent(new Event('input')); }
  }
}

// --- run and hosts: where terminals and runs go, and what runs what -------------------------

function buildRunView() {
  const v = I.sideViews.get('run');
  v.onShow = () => paintRunView();
  v.acts = [];
  v.focus = () => v.body.querySelector('button')?.focus();
}

function paintRunView(fresh = false) {
  const v = I.sideViews.get('run');
  if (!v || v.body.hidden) return;
  const live = new Set(dkLiveHosts());
  const def = runHost();
  const t = I.active;
  const runner = t?.rel ? runnerFor(t.rel) : '';
  const context = activeRunContext();
  const body = v.body;
  const top = body.scrollTop;
  body.replaceChildren();
  const ctrlB = keyLabel(keyFor('sulfur.build') || 'ctrl+b');

  // the project's build: its toolchain on its machine, Ctrl+B, its tasks
  const bc = buildCfg();
  const bbox = el('div', 'ide-run-box');
  const bgo = Object.assign(el('button', 'ide-button ide-run-go'), { type: 'button', title: `Build (${ctrlB})` });
  const alone = I.projHas === false && !!singleBuilds(I.active?.rel);
  bgo.append(icon('gear'), el('span', '', context?.pending ? 'Finding Project…' : alone ? `Build ${baseName(I.active.rel)}` : bc?.toolchain ? `Build ${baseName(projDir())}` : 'Pick a Toolchain and Build'));
  bgo.disabled = !!context?.pending;
  bgo.addEventListener('click', () => run('sulfur.build'));
  const bmore = Object.assign(el('button', 'ide-button secondary'), { type: 'button', title: 'Run Task…' });
  bmore.append(icon('more'));
  bmore.addEventListener('click', () => run('sulfur.task.run'));
  const brow = el('div', 'ide-run-row');
  brow.append(bgo, bmore);
  bbox.append(brow);
  if (context?.pending) {
    bbox.append(el('p', 'ide-run-note', 'Finding the active file’s project.'));
  } else if (alone) {
    bbox.append(el('p', 'ide-run-note', `No build file in ${baseName(filesParent(I.active.rel))} or above it: ${ctrlB} builds ${baseName(I.active.rel)} alone with its machine's compiler, its output in a writable temporary folder shown in the terminal.`));
  } else if (bc?.toolchain) {
    const pickRow = el('div', 'ide-build-pick');
    const tcb = Object.assign(el('button', 'ide-link'), { type: 'button', title: 'Pick another toolchain or machine' });
    tcb.append(icon('host'), el('span', '', `${bc.toolchain.label} · ${bc.host}`));
    tcb.addEventListener('click', () => run('sulfur.build.select'));
    const cfb = Object.assign(el('button', 'ide-link'), { type: 'button', title: 'Switch between Debug and Release' });
    cfb.append(el('span', '', bc.configuration || 'Debug'));
    cfb.addEventListener('click', () => run('sulfur.build.configuration'));
    pickRow.append(tcb, cfb);
    bbox.append(pickRow);
    const tl = el('div', 'ide-task-list');
    detectProject().then((proj) => {
      if (!I || !proj || !tl.isConnected) return;
      for (const task of tasksFor(bc, proj)) {
        const r = Object.assign(el('div', 'ide-task'), { tabIndex: 0, title: task.command });
        r.append(icon(task.group === 'test' ? 'check' : task.group === 'run' ? 'run' : 'gear'), el('span', 'ide-task-name', task.label));
        const acts = el('span', 'ide-actions');
        acts.append(btn('', 'run', `Run ${task.label}`, (e) => { e.stopPropagation(); runProjectTask(bc, task); }));
        r.append(acts);
        r.addEventListener('dblclick', () => runProjectTask(bc, task));
        r.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runProjectTask(bc, task); } });
        tl.append(r);
      }
      const foot = el('div', 'ide-build-foot');
      const add = Object.assign(el('button', 'ide-link'), { type: 'button' });
      add.append(icon('plus'), el('span', '', 'Add a Task'));
      add.addEventListener('click', () => run('sulfur.task.add'));
      const json = Object.assign(el('button', 'ide-link'), { type: 'button', title: 'The build settings as JSON, kept with the project' });
      json.append(icon('file'), el('span', '', BUILD_FILE));
      json.addEventListener('click', () => run('sulfur.build.editJson'));
      foot.append(add, json);
      tl.append(foot);
    });
    bbox.append(tl);
  } else {
    bbox.append(el('p', 'ide-run-note', `${ctrlB} looks over your machines for compilers that suit this project and asks which to build with, once.`));
  }
  body.append(sectionTitle('Build'), bbox);

  const projectRun = context?.project;
  const runBox = el('div', 'ide-run-box');
  const go = Object.assign(el('button', 'ide-button secondary ide-run-go'), { type: 'button', disabled: !!context?.pending || (!projectRun && (!runner || !def)) });
  go.append(icon('run'), el('span', '', context?.pending ? 'Finding Run Target…' : projectRun ? `Run ${context.item?.label || baseName(projDir())}` : runner ? `Run ${t.title}` : 'Run Active File'));
  go.addEventListener('click', () => run('sulfur.run.context'));
  const on = Object.assign(el('button', 'ide-button secondary'), { type: 'button', disabled: !!context?.pending || (!projectRun && !runner), title: projectRun ? 'Select startup target' : 'Run on another machine' });
  on.append(icon('more'));
  on.addEventListener('click', () => run(projectRun ? 'sulfur.run.startup' : 'sulfur.run.fileOn'));
  const row = el('div', 'ide-run-row');
  row.append(go, on);
  const detail = context?.pending ? 'Resolving the active file’s project and selected build configuration.' : context?.error ? context.error : projectRun ? `${context.cfg?.configuration || 'Select a toolchain'} · ${context.cfg?.host || def || ''}${context.item ? `\n${context.item.executable || context.item.command}` : `\n${context.targetMessage || 'Select a startup target for this project.'}`}` : !t?.rel ? 'Open a file to run it.' : runner ? `on ${def || 'no machine'}: ${runner}` : `No runner for .${extOf(t.rel)} files: add one in your settings (sulfur.runners) or with an extension.`;
  runBox.append(row, el('p', 'ide-run-note', detail));
  body.append(sectionTitle('Run'), runBox);

  // every machine, and what it builds with as it tells your login
  const th = sectionTitle('Machines');
  th.append(btn('ide-sec-act', 'refresh', 'Look at the machines again', () => run('sulfur.toolchains.refresh')));
  body.append(th);
  const hosts = [...new Set([...homeOnline(), ...live])].sort((a, b) => (b === selfHost) - (a === selfHost) || a.localeCompare(b));
  const list = el('div', 'ide-host-list');
  I.hostOpen ||= new Set([selfHost, bc?.host].filter(Boolean));
  for (const h of hosts) {
    const box = el('div', 'ide-host-box');
    const open = live.has(h) && I.hostOpen.has(h);
    const r = Object.assign(el('div', `ide-host${h === def ? ' on' : ''}${live.has(h) ? '' : ' locked'}`), { tabIndex: live.has(h) ? 0 : -1 });
    r.append(icon(!live.has(h) ? 'lock' : open ? 'down' : 'right', 'ide-host-chev'), el('span', 'ide-host-name', h));
    const tags = [h === selfHost && 'this machine', h === def && 'default', hostIsWindows(h) && 'Windows', !live.has(h) && 'not logged in'].filter(Boolean);
    r.append(el('span', 'ide-host-tags', tags.join(' · ')));
    const acts = el('span', 'ide-actions');
    if (live.has(h)) {
      acts.append(btn('', 'terminal', `New Terminal on ${h}`, (e) => { e.stopPropagation(); newTerminal({ host: h }); }));
      if (h !== def) acts.append(btn('', 'check', `Use ${h} for Terminals and Runs`, (e) => { e.stopPropagation(); setRunHost(h); }));
    }
    r.append(acts);
    r.title = live.has(h) ? `${h}: its compilers and build tools` : `${h}: log in ${loginWhere()}`;
    if (!live.has(h) && standalone?.logIn) acts.append(btn('', 'lock', `Log In to ${h}…`, (e) => { e.stopPropagation(); hostLogIn(h); }));
    if (live.has(h)) {
      r.setAttribute('aria-expanded', String(open));
      const flip = () => { if (I.hostOpen.has(h)) I.hostOpen.delete(h); else I.hostOpen.add(h); paintRunView(); };
      r.addEventListener('click', flip);
      r.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
    }
    box.append(r);
    if (open) {
      const tcEl = el('div', 'ide-tc');
      tcEl.append(el('span', 'ide-tc-note', 'looking…'));
      box.append(tcEl);
      toolchains(h, fresh).then((tc) => {
        if (!tcEl.isConnected) return;
        const chips = [];
        for (const vs of tc?.vs || []) chips.push([`MSVC ${vs.msvc?.[0] || vs.version}`, `${vs.name} ${vs.version}\n${vs.path}`]);
        const majors = [...new Set((tc?.dotnet || []).map((x) => x.split('.')[0]))];
        if (majors.length) chips.push([`.NET ${majors.join(', ')}`, `SDKs ${tc.dotnet.join(', ')}`]);
        for (const x of tc?.tools || []) if (!['dotnet', 'git'].includes(x.id)) chips.push([`${x.name} ${x.version}`.trim(), x.path]);
        tcEl.replaceChildren(...(chips.length ? chips.map(([label, title]) => Object.assign(el('span', 'ide-tc-chip', label), { title })) : [el('span', 'ide-tc-note', 'no compilers or build tools found')]));
      }, (err) => { if (tcEl.isConnected) tcEl.replaceChildren(el('span', 'ide-tc-note bad', err.message)); });
    }
    list.append(box);
  }
  body.append(list);

  body.append(sectionTitle('Runners'));
  const tbl = el('div', 'ide-runners');
  const mine = setting('sulfur.runners') || {};
  const all = new Map([...I.runners].map(([x, r]) => [x, { cmd: r.cmd, by: r.by || 'built in' }]));
  for (const [x, cmd] of Object.entries(mine)) if (typeof cmd === 'string') all.set(x, { cmd, by: 'settings' });
  for (const [x, r] of [...all].sort((a, b) => a[0].localeCompare(b[0]))) {
    const line = el('div', 'ide-runner');
    line.append(el('span', 'ide-runner-ext', `.${x}`), el('code', 'ide-runner-cmd', r.cmd), el('span', 'ide-runner-by', r.by));
    tbl.append(line);
  }
  const edit = Object.assign(el('button', 'ide-link', 'Edit in settings.json'), { type: 'button' });
  edit.addEventListener('click', () => openUserFile(SETTINGS_PATH(), '{\n  "sulfur.runners": {\n  }\n}\n'));
  body.append(tbl, edit);
  body.scrollTop = top;
}

// a host's login, asked for here when Sulfur runs alone, kept as the desktop keeps it
async function hostLogIn(h) {
  const user = await inputBox({ title: `Log In to ${h}`, placeholder: 'User', prompt: `Your login on ${h}, for its terminals, runs and builds.`, value: acct.user });
  if (!user?.trim() || !I) return;
  const pass = await inputBox({ title: `Log In to ${h}: ${user.trim()}`, placeholder: 'Password', password: true });
  if (pass === undefined || !I) return;
  try { await standalone.logIn(h, user.trim(), pass); } catch (err) { notify('error', `Couldn't keep the login: ${err.message}`); return; }
  if (!I) return;
  notify('info', `Logged in to ${h} as ${user.trim()}.`);
  paintRunView();
  paintStatus();
}

// the project's build settings, written from the pick when there's no file yet
async function openBuildJson() {
  const path = `${projDir()}/${BUILD_FILE}`;
  if ((await readAt(path)) === null) {
    const cfg = buildCfg() || {};
    const keep = { host: cfg.host || runHost(), toolchain: cfg.toolchain || null, configuration: cfg.configuration || 'Debug', defaultTask: cfg.defaultTask || 'build', tasks: cfg.tasks || [] };
    try { await writeAt(path, `${JSON.stringify(keep, null, 2)}\n`); } catch (err) { notify('error', `Couldn't write ${BUILD_FILE}: ${err.message}`); return; }
    if (!I) return;
    loadDir(`${projDir()}/.sulfur`, true);
  }
  if (I) openFile(path, { preview: false });
}

// --- projects: started from a kind anywhere, copied or moved between machines ---------------

const IGNORE = 'build/\nout/\nbin/\nobj/\ntarget/\nnode_modules/\n__pycache__/\n.vs/\n*.o\n*.obj\n*.pdb\n*.exe\n';
const ident = (n) => n.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');
const TEMPLATES = [
  { id: 'empty', label: 'Empty Folder', description: 'a folder, nothing in it yet', ic: 'folder', files: () => ({}) },
  {
    id: 'c', label: 'C', description: 'main.c and a Makefile: gcc or clang through make', ic: 'main.c', main: 'main.c',
    files: (n) => ({
      'main.c': `#include <stdio.h>\n\nint main(void) {\n  printf("hello from ${n}\\n");\n  return 0;\n}\n`,
      Makefile: `CC ?= cc\nCFLAGS ?= -Wall -Wextra -O2 -g\n\n${ident(n)}: main.c\n\t$(CC) $(CFLAGS) -o $@ $^\n\nrun: ${ident(n)}\n\t./${ident(n)}\n\nclean:\n\trm -f ${ident(n)}\n\n.PHONY: run clean\n`,
      '.gitignore': `${IGNORE}${ident(n)}\n`,
    }),
  },
  {
    id: 'cpp', label: 'C++ (CMake)', description: 'CMakeLists.txt and src/main.cpp: MSVC, gcc or clang', ic: 'main.cpp', main: 'src/main.cpp',
    files: (n) => ({
      'CMakeLists.txt': `cmake_minimum_required(VERSION 3.21)\nproject(${ident(n)} LANGUAGES CXX)\n\nset(CMAKE_CXX_STANDARD 20)\nset(CMAKE_CXX_STANDARD_REQUIRED ON)\n\nadd_executable(${ident(n)} src/main.cpp)\n\nenable_testing()\nadd_test(NAME runs COMMAND ${ident(n)})\n`,
      'src/main.cpp': `#include <iostream>\n\nint main() {\n    std::cout << "hello from ${n}\\n";\n    return 0;\n}\n`,
      '.gitignore': IGNORE,
    }),
  },
  {
    id: 'dotnet', label: '.NET 10 Console', description: 'a C# console app: dotnet build and run', ic: 'Program.cs', main: 'Program.cs',
    files: (n) => ({
      [`${ident(n)}.csproj`]: '<Project Sdk="Microsoft.NET.Sdk">\n\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net10.0</TargetFramework>\n    <ImplicitUsings>enable</ImplicitUsings>\n    <Nullable>enable</Nullable>\n  </PropertyGroup>\n\n</Project>\n',
      'Program.cs': `Console.WriteLine("hello from ${n}");\n`,
      '.gitignore': IGNORE,
    }),
  },
  {
    id: 'python', label: 'Python', description: 'main.py, run where you pick', ic: 'main.py', main: 'main.py',
    files: (n) => ({ 'main.py': `def main() -> None:\n    print("hello from ${n}")\n\n\nif __name__ == "__main__":\n    main()\n`, '.gitignore': IGNORE }),
  },
  {
    id: 'node', label: 'Node.js', description: 'package.json and index.js: npm scripts', ic: 'index.js', main: 'index.js',
    files: (n) => ({
      'package.json': `${JSON.stringify({ name: n.toLowerCase().replace(/[^a-z0-9._-]/g, '-'), version: '0.1.0', private: true, type: 'module', scripts: { start: 'node index.js', test: 'node --test' } }, null, 2)}\n`,
      'index.js': `console.log('hello from ${n.replace(/'/g, "\\'")}');\n`,
      '.gitignore': IGNORE,
    }),
  },
  {
    id: 'go', label: 'Go', description: 'go.mod and main.go', ic: 'main.go', main: 'main.go',
    files: (n) => ({
      'go.mod': `module ${n.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}\n\ngo 1.22\n`,
      'main.go': `package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello from ${n}")\n}\n`,
    }),
  },
  {
    id: 'rust', label: 'Rust', description: 'Cargo.toml and src/main.rs', ic: 'main.rs', main: 'src/main.rs',
    files: (n) => ({
      'Cargo.toml': `[package]\nname = "${n.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n`,
      'src/main.rs': `fn main() {\n    println!("hello from ${n}");\n}\n`,
      '.gitignore': '/target\n',
    }),
  },
];

const projectNameWhy = (v) => {
  const n = v.trim();
  if (!n) return 'A name is needed.';
  if (/[\\/:*?"<>|]/.test(n) || n === '.' || n === '..') return 'A folder name, without \\ / : * ? " < > |';
  if (n.startsWith('.')) return 'A name that doesn\'t start with a dot.';
  return '';
};

// a place for a project: the home's own folder, or a machine's published folder
async function pickPlace(title, o = {}) {
  const at = await fileDialog({ title, okLabel: 'Select Folder', allowRoot: true, skip: o.skip });
  if (!at || !I) return null;
  return { loc: at.loc, dir: at.rel, label: isHomeLoc(at.loc) ? (localDesktop() ? hostPath(selfHost, 'home', at.rel) : 'your home') : `${at.loc.host}: ${hostPath(at.loc.host, at.loc.share, at.rel)}` };
}

// does a folder exist there: its listing answers
const dirThere = (l, path) => filesCall(apiLoc(l), 'list', undefined, { path }).then(() => true, () => false);

async function newProject() {
  const k = await pick(TEMPLATES.map((x, i) => ({ label: x.label, description: x.description, ic: x.ic, value: i })), { title: 'New Project', placeholder: 'What kind of project to start', matchDescription: true });
  if (k === undefined || !I) return;
  const tpl = TEMPLATES[k];
  const where = await pickPlace(`New ${tpl.label} Project: where`, { placeholder: localDesktop() ? 'Your home folder, or anywhere on this computer' : 'Where it lives: your home, synced across the mesh, or a folder on one machine' });
  if (!where || !I) return;
  const typed = await inputBox({ title: `New ${tpl.label} Project: its name`, value: tpl.id === 'empty' ? 'project' : `hello-${tpl.id}`, prompt: `A new folder in ${where.label}.`, validate: projectNameWhy });
  if (typed === undefined || !I) return;
  const n = typed.trim();
  const root = filesJoin(where.dir, n);
  if (await dirThere(where.loc, root)) { notify('error', `${n} is already there, in ${where.label}.`); return; }
  if (!I) return;
  const busy = notify('info', `Making ${n} in ${where.label}…`, { progress: true, sticky: true });
  try {
    await filesCall(apiLoc(where.loc), 'mkdir', jsonPost({ path: root }));
    for (const [rel, text] of Object.entries(tpl.files(n))) await writeAt(`${root}/${rel}`, text, where.loc, 'Sulfur');
  } catch (err) {
    busy.close();
    notify('error', `Couldn't make ${n}: ${err.message}`);
    return;
  }
  busy.close();
  if (!I) return;
  setRoot(root, false, where.loc);
  if (tpl.main) openFile(`${root}/${tpl.main}`, { preview: false });
  const builds = !['empty', 'python'].includes(tpl.id);
  notify('info', `${n} is ready in ${where.label}.${builds ? ` ${keyLabel(keyFor('sulfur.build') || 'ctrl+b')} builds it.` : ''}`, builds ? { actions: [{ label: 'Build', run: () => run('sulfur.build') }] } : {});
}

// what a copy leaves behind: what a build makes again
const BUILD_DIRS = new Set(['build', 'out', 'obj', 'target', 'node_modules', '.vs', '__pycache__', '.pytest_cache', '.gradle']);
const buildOutput = (name, siblings) => BUILD_DIRS.has(name) || name.startsWith('cmake-build-') || (name === 'bin' && siblings.has('obj'));

async function transferProject() {
  const from = { loc: locOf(), root: I.st.root };
  const name0 = baseName(from.root);
  const fromLabel = isHomeLoc(from.loc) ? 'your home' : `${from.loc.host}`;
  const how = await pick([
    { label: 'Copy', description: `keep ${name0} where it is too`, ic: 'copy', value: 'copy' },
    { label: 'Move', description: `delete it from ${fromLabel} once it's copied`, ic: 'right', value: 'move' },
  ], { title: `Copy or Move ${name0}`, placeholder: `From ${fromLabel} to another machine or the home` });
  if (!how || !I) return;
  const verb = how === 'move' ? 'Move' : 'Copy';
  const where = await pickPlace(`${verb} ${name0}: to where`, { placeholder: 'The machine, or the home, it goes to' });
  if (!where || !I) return;
  const typed = await inputBox({ title: `${verb} ${name0}: its name there`, value: name0, prompt: `A new folder in ${where.label}.`, validate: projectNameWhy });
  if (typed === undefined || !I) return;
  const to = { loc: where.loc, root: filesJoin(where.dir, typed.trim()) };
  if (sameLoc(to.loc, from.loc) && (under(to.root, from.root) || under(from.root, to.root))) { notify('error', 'That\'s the project itself, or a folder of it.'); return; }
  if (await dirThere(to.loc, to.root)) { notify('error', `${baseName(to.root)} is already there, in ${where.label}.`); return; }
  await saveAll();
  if (!I) return;
  const busy = notify('info', `Looking over ${name0}…`, { progress: true, sticky: true });
  // the tree walked first, so the copy knows how far it's got
  const files = [];
  const dirs = [];
  let skipped = 0;
  try {
    const walk = async (dir) => {
      const entries = (await filesCall(apiLoc(from.loc), 'list', undefined, { path: dir })).entries || [];
      const names = new Set(entries.filter((e) => e.dir).map((e) => e.name));
      for (const e of entries) {
        const rel = filesJoin(dir, e.name);
        if (e.dir) {
          if (buildOutput(e.name, names)) { skipped += 1; continue; }
          dirs.push(rel);
          await walk(rel);
        } else files.push({ rel, size: e.size || 0 });
      }
    };
    await walk(from.root);
  } catch (err) { busy.close(); notify('error', `Couldn't read ${name0}: ${err.message}`); return; }
  const total = files.reduce((n, f) => n + f.size, 0) || 1;
  const dest = (rel) => `${to.root}${rel.slice(from.root.length)}`;
  const fromAt = (rel) => (isHomeLoc(from.loc) ? homeAt(homePick(rel)) : apiLoc(from.loc));
  const toAt = (rel) => (isHomeLoc(to.loc) ? homeAt(homePick(rel)) : apiLoc(to.loc));
  let done = 0;
  const failed = [];
  try {
    await filesCall(apiLoc(to.loc), 'mkdir', jsonPost({ path: to.root }));
    for (const d of dirs) await filesCall(apiLoc(to.loc), 'mkdir', jsonPost({ path: dest(d) })).catch(() => {});
    const queue = [...files];
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        if (!I) return;
        busy.update(`${verb === 'Move' ? 'Moving' : 'Copying'} ${name0} to ${where.label}: ${wsRel(f.rel).replace(`${name0}/`, '')}`);
        let part = 0;
        try {
          await copyFile(fromAt(f.rel), f.rel, toAt(dest(f.rel)), dest(f.rel), (x) => { part = x * f.size; busy.progress((done + part) / total); });
        } catch (err) { failed.push(`${f.rel}: ${err.message}`); }
        done += f.size;
        busy.progress(done / total);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  } catch (err) { busy.close(); notify('error', `Couldn't ${verb.toLowerCase()} ${name0}: ${err.message}`); return; }
  busy.close();
  if (!I) return;
  const left = skipped ? ` Build outputs (${skipped} folder${skipped === 1 ? '' : 's'}) stayed behind: a build makes them again.` : '';
  if (failed.length) {
    log(`copy of ${from.root} failed for:\n${failed.join('\n')}`);
    notify('error', `${failed.length} of ${files.length} files didn't copy to ${where.label}${how === 'move' ? ', so nothing was deleted' : ''}: the Output panel has the list.`);
    return;
  }
  if (how === 'move') {
    const v = await ask({ title: `Delete ${name0} from ${fromLabel}?`, detail: `All ${files.length} files are in ${where.label} now. Deleting here is for good: there's no trash.`, buttons: [{ label: 'Delete', danger: true, primary: true, value: 'del' }, { label: 'Keep Both', value: 'keep' }] });
    if (!I) return;
    if (v === 'del') {
      for (const t of I.tabs.filter((x) => sameLoc(x.loc, from.loc) && x.rel && under(x.rel, from.root))) await closeTab(t, true, false);
      try { await filesCall(apiLoc(from.loc), 'delete', jsonPost({ path: from.root })); } catch (err) { notify('error', `Couldn't delete ${from.root}: ${err.message}`); }
      if (!I) return;
      setRoot(to.root, false, to.loc);
      notify('info', `${name0} moved to ${where.label}.${left}`);
      return;
    }
  }
  notify('info', `${name0} copied to ${where.label}.${left}`, { actions: [{ label: 'Open It', run: () => setRoot(to.root, false, to.loc) }] });
}

// an admin's folder of a machine published for projects; resolves its place once the host has it
async function addFolderDialog() {
  if (!acct.admin) return null;
  const hosts = [...new Set([...homeOnline(), ...dkLiveHosts()])].sort((a, b) => (b === selfHost) - (a === selfHost) || a.localeCompare(b));
  const h = await pick(hosts.map((x) => ({ label: x, description: [x === selfHost && 'this machine', hostIsWindows(x) && 'Windows'].filter(Boolean).join(' · '), ic: 'host', value: x })), { title: 'Add a Folder: which machine', placeholder: 'The machine the folder is on' });
  if (!h || !I) return null;
  const win = hostIsWindows(h);
  const typed = await inputBox({
    title: `Add a Folder of ${h}`, value: win ? 'D:\\Projects' : '/srv/projects', placeholder: win ? 'D:\\Projects' : '/home/you/src',
    prompt: `Its full path on ${h}. Every user of the mesh sees it as one of ${h}'s folders, read and write.`,
    validate: (v) => (win ? /^[A-Za-z]:[\\/]./ : /^\/./).test(v.trim()) ? (v.includes(',') ? 'No commas in it.' : '') : `A full path, like ${win ? 'D:\\Projects' : '/srv/projects'}.`,
  });
  if (typed === undefined || !I) return null;
  const dir = typed.trim().replace(/[\\/]+$/, '');
  const busy = notify('info', `Publishing ${dir} on ${h}…`, { progress: true, sticky: true });
  try {
    const r = await fetch('/api/sulfur/share', jsonPost({ host: h, dir }));
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error || `status ${r.status}`);
  } catch (err) { busy.close(); notify('error', `Couldn't publish ${dir}: ${err.message}`); return null; }
  // the host takes its new config and says so in its next report
  const norm = (x) => String(x || '').replace(/[\\/]+$/, '').toLowerCase();
  for (let i = 0; i < 40 && I; i++) {
    const sh = (hostsInfo[h.toLowerCase()]?.files?.shares || []).find((x) => !x.home && norm(x.label) === norm(dir));
    if (sh) { busy.close(); notify('info', `${dir} is a folder of ${h} now.`); return { host: h, share: String(sh.id) }; }
    busy.progress(i / 40);
    await sleep(750);
  }
  busy.close();
  if (I) notify('warning', `${h} took ${dir}, but hasn't listed it yet: it shows in Open Folder once it does.`);
  return null;
}

// --- color themes ---------------------------------------------------------------------------

async function pickTheme() {
  const cur = paletteNow();
  const look = setting('window.appearance');
  // on its own, light and dark Sulfur's to pick; in the desktop, the desktop's
  const appearance = standalone ? [['system', 'Follow the System', 'light or dark as the system is'], ['light', 'Light', 'Phosphorus light'], ['dark', 'Dark', 'Phosphorus dark']]
    .map(([id, label, description], i) => ({ label, description, detail: id === look ? 'current' : '', value: `look:${id}`, sep: i === 0 ? 'Appearance' : '' })) : [];
  const items = [...appearance, ...PALETTES.map((t, i) => ({ label: t.label, description: t.about, detail: t.id === cur ? 'current' : '', value: t.id, sep: i === 0 ? 'Color Theme, phosphorus wide' : '' }))];
  const v = await pick(items, { title: 'Color Theme', placeholder: standalone ? 'Select Color Theme, or Light or Dark' : 'Select Color Theme (light or dark follows the desktop)' });
  if (!v || !I) return;
  if (v.startsWith('look:')) {
    if (v !== 'look:system') setPalette('phosphorus');
    setSetting('window.appearance', v.slice(5));
  } else setPalette(v);
}

const sectionTitle = (t) => el('div', 'ide-sec-head static', t.toUpperCase());

// --- settings and keys: the user's own files, VS Code's way ----------------------------------

// a text file of a place, null when it isn't one
async function readAt(path, l = locOf()) {
  if (isHomeLoc(l)) return readUser(path);
  try {
    const b = await filesCall(apiLoc(l), 'read', undefined, { path });
    return typeof b.text === 'string' ? b.text : null;
  } catch { return null; }
}
async function writeAt(path, text, l = locOf(), by = '') {
  if (isHomeLoc(l)) { await writeText(path, text, by); return; }
  await filesCall(apiLoc(l), 'save', jsonPost({ path, text, by: { name: by || name || acct.user } }));
}

async function readUser(path) {
  try {
    await filesCall(HOME, 'list', undefined, { path: filesParent(path) });
    const b = await filesCall(HOME, 'read', undefined, { path });
    return typeof b.text === 'string' ? b.text : null;
  } catch { return null; }
}

async function loadUserFiles() {
  // the folder listed once, so only files that are there are read; ~/.ide, its
  // name before Sulfur, moved over the first time
  let names = null;
  try { names = ((await filesCall(HOME, 'list', undefined, { path: CONF_DIR() })).entries || []).map((e) => e.name); } catch {}
  if (!names) {
    try {
      await filesCall(HOME, 'list', undefined, { path: OLD_CONF_DIR() });
      await filesCall(HOME, 'rename', jsonPost({ from: OLD_CONF_DIR(), to: CONF_DIR() }));
      names = ((await filesCall(HOME, 'list', undefined, { path: CONF_DIR() })).entries || []).map((e) => e.name);
      log(`moved ${OLD_CONF_DIR()} to ${CONF_DIR()}`);
    } catch { names = []; }
  }
  if (!I) return;
  const read = (p) => (names.includes(baseName(p)) ? filesCall(HOME, 'read', undefined, { path: p }).then((b) => (typeof b.text === 'string' ? b.text : null), () => null) : null);
  const [s, k] = await Promise.all([read(SETTINGS_PATH()), read(KEYS_PATH())]);
  if (!I) return;
  if (s !== null) {
    try {
      const v = parseJsonc(s);
      if (v && typeof v === 'object' && !Array.isArray(v)) { if (JSON.stringify(I.settings?.['sulfur.languageServerSettings']) !== JSON.stringify(v['sulfur.languageServerSettings'])) languages.reset(); I.settings = v; cacheSettings(); applySettings(); }
    } catch (err) { notify('warning', `settings.json: ${err.message}`, { actions: [{ label: 'Open Settings (JSON)', run: () => openFile(SETTINGS_PATH(), { preview: false }) }] }); }
  }
  if (k !== null) {
    try {
      const v = parseJsonc(k);
      I.userKeys = (Array.isArray(v) ? v : []).filter((x) => x && typeof x.key === 'string' && typeof x.command === 'string').map((x) => ({ key: normKey(x.key), command: x.command }));
    } catch (err) { notify('warning', `keybindings.json: ${err.message}`); }
  } else I.userKeys = [];
  buildKeys();
  if (I.tabs.some((t) => t.page === 'keys')) paintKeysPage();
}

const cacheSettings = () => { try { localStorage.setItem(`${STATE_KEY()}:settings`, JSON.stringify(I.settings)); } catch {} };

// light or dark when Sulfur runs on its own, the system's unless picked; the desktop's own otherwise
const systemLight = matchMedia('(prefers-color-scheme: light)');
function applyAppearance() {
  if (!standalone) return;
  const a = setting('window.appearance');
  const light = a === 'light' || (a !== 'dark' && systemLight.matches);
  const root = document.documentElement;
  const was = root.dataset.theme === 'light';
  if (light) root.dataset.theme = 'light'; else delete root.dataset.theme;
  try { localStorage.setItem('sulfur-appearance', a); } catch {}
  if (was !== light) requestAnimationFrame(() => termsRetheme());
}

function applySettings() {
  const r = I.root;
  applyAppearance();
  r.style.setProperty('--ide-code-font', `${setting('editor.fontSize')}px`);
  // vs code Sulfur's own look; the others the desktop's tokens, medieval its own type too
  const theme = paletteNow();
  for (const t of PALETTES) I.w.node.classList.toggle(`ide-theme-${t.id}`, t.id === theme && t.id !== 'vscode');
  if (I.themeNow !== theme) { I.themeNow = theme; requestAnimationFrame(() => termsRetheme()); }
  I.exclude = null;
  paintTreeSoon();
  if (I.chat) paintChatCtx();
  if (I.tabs.some((t) => t.page === 'settings')) paintSettingsPage();
}

function setSetting(k, v) {
  const def = SETTINGS[k]?.def;
  if (JSON.stringify(v) === JSON.stringify(def)) delete I.settings[k]; else I.settings[k] = v;
  cacheSettings();
  applySettings();
  writeSettings();
}
// the file rewritten as the settings stand
const writeSettings = debounce(() => I && writeUserFile(SETTINGS_PATH(), `${JSON.stringify(I.settings, null, 2)}\n`), 500);

// through the host's save, which makes the folders and types into any open tab live
async function writeText(path, text, by = '') {
  await filesCall(homeAt(homePick(path)), 'save', jsonPost({ path, text, by: { name: by || name || acct.user } }));
}
async function writeUserFile(path, text) {
  try { await writeText(path, text); return true; } catch (err) { notify('error', `Couldn't write ${path}: ${err.message}`); return false; }
}

async function openUserFile(path, template) {
  const have = await readUser(path);
  if (!I) return;
  if (have === null && !(await writeUserFile(path, template))) return;
  if (have === null) await filesCall(HOME, 'list', undefined, { path: filesParent(path) }).catch(() => {});
  openFile(path, { preview: false });
}

// --- the workbench's own pages ----------------------------------------------------------------

function openSettings() {
  openPage('settings', 'Settings', 'gear', (t) => {
    const head = el('div', 'ide-page-head');
    const q = Object.assign(el('input', 'ide-input ide-page-search'), { placeholder: 'Search settings', spellcheck: false });
    const json = Object.assign(el('button', 'ide-link'), { type: 'button', title: 'Open Settings (JSON)' });
    json.append(icon('file'), el('span', '', 'Open settings.json'));
    json.addEventListener('click', () => run('workbench.action.openSettingsJson'));
    head.append(q, json);
    const list = el('div', 'ide-settings');
    t.view.append(head, el('p', 'ide-page-note', `Saved to ${SETTINGS_PATH()} in your home, so they follow you to every browser.`), list);
    t.settingsQ = q;
    t.settingsList = list;
    q.addEventListener('input', () => paintSettingsPage());
    paintSettingsPage();
    setTimeout(() => q.focus(), 0);
  });
}

function paintSettingsPage() {
  const t = I.tabs.find((x) => x.page === 'settings');
  if (!t) return;
  const v = t.settingsQ.value.toLowerCase();
  const rows = [];
  for (const [k, s] of Object.entries(SETTINGS)) {
    if (v && !`${k} ${s.title} ${s.about}`.toLowerCase().includes(v)) continue;
    const row = el('div', `ide-setting${k in I.settings ? ' changed' : ''}`);
    const [cat, name] = s.title.includes(': ') ? [s.title.slice(0, s.title.lastIndexOf(': ') + 1), s.title.slice(s.title.lastIndexOf(': ') + 2)] : ['', s.title];
    const title = el('div', 'ide-setting-title');
    title.append(el('span', 'ide-setting-cat', cat ? `${cat} ` : ''), el('b', '', name));
    row.append(title);
    const about = el('div', 'ide-setting-about', s.about);
    const val = setting(k);
    if (s.type === 'boolean') {
      const lab = el('label', 'ide-check');
      const box = Object.assign(el('input'), { type: 'checkbox', checked: !!val });
      box.addEventListener('change', () => setSetting(k, box.checked));
      lab.append(box, about);
      row.append(lab);
    } else if (s.type === 'enum') {
      row.append(about);
      const sel = el('select', 'ide-input ide-select');
      for (const [v, label] of s.options) sel.append(Object.assign(el('option', '', label), { value: v, selected: v === val }));
      sel.addEventListener('change', () => setSetting(k, sel.value));
      row.append(sel);
    } else if (s.type === 'object') {
      row.append(about);
      const b = Object.assign(el('button', 'ide-link', 'Edit in settings.json'), { type: 'button' });
      b.addEventListener('click', () => run('workbench.action.openSettingsJson'));
      row.append(b);
    } else {
      row.append(about);
      const input = Object.assign(el('input', 'ide-input'), { type: s.type === 'number' ? 'number' : 'text', value: String(val), spellcheck: false });
      if (s.type === 'number') Object.assign(input, { min: s.min, max: s.max, step: 1 });
      input.addEventListener('change', () => {
        if (s.type === 'number') {
          const n = Number(input.value);
          if (!Number.isFinite(n) || n < s.min || n > s.max) { input.value = String(setting(k)); notify('warning', `${s.title} takes ${s.min} to ${s.max}.`); return; }
          setSetting(k, n);
        } else setSetting(k, input.value);
      });
      row.append(input);
    }
    if (k in I.settings) {
      const reset = Object.assign(el('button', 'ide-link ide-setting-reset', 'Reset'), { type: 'button', title: `Back to the default: ${JSON.stringify(s.def)}` });
      reset.addEventListener('click', () => setSetting(k, s.def));
      title.append(reset);
    }
    rows.push(row);
  }
  t.settingsList.replaceChildren(...(rows.length ? rows : [el('p', 'ide-empty-note', 'No settings found')]));
}

function openKeysPage() {
  openPage('keys', 'Keyboard Shortcuts', 'keyboard', (t) => {
    const head = el('div', 'ide-page-head');
    const q = Object.assign(el('input', 'ide-input ide-page-search'), { placeholder: 'Type to search in keybindings', spellcheck: false });
    const json = Object.assign(el('button', 'ide-link'), { type: 'button' });
    json.append(icon('file'), el('span', '', 'Open keybindings.json'));
    json.addEventListener('click', () => run('workbench.action.openGlobalKeybindingsFile'));
    head.append(q, json);
    const table = el('div', 'ide-keys');
    t.view.append(head, el('p', 'ide-page-note', 'Double click a row to change its keys. Some keys belong to the browser (ctrl+n, ctrl+t, ctrl+w in most), which no page can take.'), table);
    t.keysQ = q;
    t.keysTable = table;
    q.addEventListener('input', () => paintKeysPage());
    paintKeysPage();
    setTimeout(() => q.focus(), 0);
  });
}

function paintKeysPage() {
  const t = I.tabs.find((x) => x.page === 'keys');
  if (!t) return;
  const v = t.keysQ.value.toLowerCase();
  const head = el('div', 'ide-key-row head');
  head.append(el('span', '', 'Command'), el('span', '', 'Keybinding'), el('span', '', 'Source'));
  const rows = [...I.commands.values()].filter((c) => !c.hidden || c.key).map((c) => ({ c, key: keyFor(c.id), user: I.userKeys.some((u) => u.command === c.id) }))
    .filter(({ c, key }) => !v || `${c.category} ${c.title} ${c.id} ${keyLabel(key)}`.toLowerCase().includes(v))
    .sort((a, b) => (!!b.key - !!a.key) || `${a.c.category}${a.c.title}`.localeCompare(`${b.c.category}${b.c.title}`))
    .map(({ c, key, user }) => {
      const r = Object.assign(el('div', 'ide-key-row'), { tabIndex: 0, title: c.id });
      const n = el('span', 'ide-key-cmd');
      n.append(el('span', '', c.category ? `${c.category}: ${c.title}` : c.title), el('span', 'ide-key-id', c.id));
      const k = el('span', 'ide-key-keys');
      if (key) k.append(...key.split(' ').map((part) => el('kbd', '', keyLabel(part))));
      r.append(n, k, el('span', 'ide-key-src', user ? 'User' : c.ext ? `Extension: ${c.ext}` : 'Default'));
      const change = () => recordKey(c);
      r.addEventListener('dblclick', change);
      r.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); change(); } });
      return r;
    });
  t.keysTable.replaceChildren(head, ...rows);
}

// a new key for a command, pressed in a box, written to keybindings.json
function recordKey(c) {
  const back = el('div', 'ide-dialog-back');
  const box = Object.assign(el('div', 'ide-keyrec'), { tabIndex: 0 });
  const shown = el('div', 'ide-keyrec-keys', ' ');
  box.append(el('div', '', `Press desired key combination for "${c.title}" and then press ENTER.`), shown);
  back.append(box);
  I.layer.append(back);
  I.dialog = back;
  let k = '';
  box.addEventListener('keydown', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const now = keyOf(e);
    if (!now) return;
    if (now === 'escape') { back.remove(); I.dialog = null; return; }
    if (now === 'enter' && k) {
      back.remove();
      I.dialog = null;
      I.userKeys = [...I.userKeys.filter((u) => u.command !== c.id), { key: k, command: c.id }];
      buildKeys();
      paintKeysPage();
      await writeUserFile(KEYS_PATH(), `${JSON.stringify(I.userKeys, null, 2)}\n`);
      setStatusFlash(`${c.title}: ${keyLabel(k)}`);
      return;
    }
    k = now;
    shown.replaceChildren(el('kbd', '', keyLabel(k)));
    const taken = (I.keys.get(k) || []).filter((id) => id !== c.id).map((id) => I.commands.get(id)?.title).filter(Boolean);
    if (taken.length) shown.append(el('div', 'ide-keyrec-taken', `${taken.length} existing command${taken.length === 1 ? ' has' : 's have'} this keybinding: ${taken.join(', ')}`));
  });
  box.focus();
}

function openWelcome() {
  openPage('welcome', 'Welcome', 'spark', (t) => {
    const w = el('div', 'ide-welcome');
    t.view.append(w);
    t.paint = () => paintWelcome(w);
    t.paint();
  });
}

function paintWelcome(w) {
  const hero = el('div', 'ide-welcome-hero');
  hero.append(Object.assign(el('img', 'ide-welcome-mark'), { src: '/sulfur/icon.svg', alt: '', draggable: false }));
  const words = el('div');
  words.append(el('h1', '', 'Sulfur'), el('p', '', localDesktop()
    ? `Open any file or folder on ${selfHost} and start: nothing to log into.`
    : standalone ? `${meshName()}: your home, its machines’ shells and its agents. Signed in as ${acct.user}.` : `Your home on the mesh, its hosts’ shells and its agents, in one workbench. Signed in as ${acct.user}.`));
  hero.append(words);
  const link = (label, cmd, ic, detail = '') => {
    const b = Object.assign(el('button', 'ide-welcome-link'), { type: 'button' });
    b.append(icon(ic), el('span', '', label));
    if (detail) b.append(el('span', 'ide-welcome-dim', detail));
    b.addEventListener('click', () => (typeof cmd === 'function' ? cmd() : run(cmd)));
    return b;
  };
  const cols = el('div', 'ide-welcome-cols');
  const start = el('div', 'ide-welcome-col');
  start.append(el('h2', '', 'Start'));
  const f = (id) => keyLabel(keyFor(id) || '');
  start.append(link('Open File…', 'workbench.action.files.openFile', 'file', f('workbench.action.files.openFile')));
  start.append(link('Open Folder…', 'workbench.action.files.openFolder', 'folder', f('workbench.action.files.openFolder')),
    link('New Project…', 'sulfur.project.new', 'plus'), link('New File…', 'explorer.newFile', 'newFile'));
  if (I.commands.has('sulfur.git.clone')) start.append(link('Clone a Repository…', 'sulfur.git.clone', 'branch'));
  start.append(link('New Terminal', 'workbench.action.terminal.new', 'terminal', f('workbench.action.terminal.new')));

  const recent = el('div', 'ide-welcome-col');
  recent.append(el('h2', '', 'Recent'));
  const rk = (x) => (typeof x === 'string' ? { loc: HOME_LOC, root: x } : { loc: x.loc || HOME_LOC, root: x.root });
  const folders = (I.st.recentFolders || []).map(rk).filter((x) => inScope(x.root, x.loc)).slice(0, 7);
  if (!folders.length) recent.append(el('p', 'ide-empty-note', 'Folders you open show here.'));
  for (const x of folders) {
    const b = Object.assign(el('button', 'ide-welcome-link'), { type: 'button', title: isHomeLoc(x.loc) && !localDesktop() ? x.root : `${x.loc.host === '*' ? selfHost : x.loc.host}: ${hostPath(x.loc.host === '*' ? selfHost : x.loc.host, x.loc.share, x.root)}` });
    b.append(icon('folder'), el('span', '', baseName(x.root)), el('span', 'ide-welcome-dim', localDesktop() ? hostPath(selfHost, isHomeLoc(x.loc) ? 'home' : x.loc.share, filesParent(x.root)) : filesParent(x.root)));
    b.addEventListener('click', () => setRoot(x.root, false, x.loc));
    recent.append(b);
  }

  const side = el('div', 'ide-welcome-col');
  if (standalone) {
    side.append(el('h2', '', 'Phosphorus Mesh'));
    const card = el('div', 'ide-welcome-mesh');
    const line = (text, cls = '') => card.append(el('p', cls, text));
    if (!localDesktop()) {
      line(`Working on ${meshName()} as ${acct.user}: its machines and homes, their terminals and builds, its agents.`);
    } else if (standalone.meshUser) {
      line(`Logged in to ${meshName()} as ${standalone.meshUser}. Its models, agents and Forgejo work on this computer’s projects too.`);
      card.append(link(`Open ${meshName()}’s Machines`, 'sulfur.mesh.open', 'remote', 'its homes and folders'), link('Sign Out', 'sulfur.mesh.signOut', 'lock'));
    } else if (standalone.server) {
      line(standalone.signedOut ? `Your session on ${meshName()} ended. This computer is still available.` : `${meshName()} is remembered. Log in for its machines, its agents in the chat, and its Forgejo.`);
      card.append(link(`Log In to ${meshName()}…`, 'sulfur.mesh.connect', 'user'), link('Another Mesh…', 'sulfur.mesh.other', 'remote'));
    } else {
      line('Connect to your mesh for its machines and homes, its agents in the chat, and its Forgejo: by its address (https://mulab.dev) from anywhere, or a host’s name on the tailnet.');
      card.append(link('Connect to a Phosphorus Mesh…', 'sulfur.mesh.connect', 'remote'));
    }
    side.append(card);
  }
  side.append(el('h2', '', 'Learn'));
  for (const [label, cmd, ic] of [['Extension Guide', 'sulfur.extensions.guide', 'book'], ['Create an Extension', 'sulfur.extensions.create', 'ext']]) side.append(link(label, cmd, ic));
  cols.append(start, recent, side);
  w.replaceChildren(hero, cols);
}
// the welcome repainted where it's open, the mesh's state moved
function paintWelcomeSoon() { const t = I?.tabs.find((x) => x.page === 'welcome'); t?.paint?.(); }

// --- the mesh, from Sulfur on its own: connected to, logged into, remembered -----------

function meshItems(withHost = false) {
  const name = meshName();
  if (!localDesktop()) {
    return [
      { label: `${acct.user} on ${name}`, disabled: true },
      '-',
      ...(withHost ? [cmdItem('sulfur.selectHost', 'Select the Host for Terminals and Runs…')] : []),
      { label: 'Hosts and Logins', run: () => showSide('run', true, true) },
      '-',
      cmdItem('sulfur.mesh.signOut', `Sign Out of ${name}`),
    ];
  }
  if (standalone.meshUser) {
    return [
      { label: `This Computer · ${selfHost}`, disabled: true },
      { label: `Logged in to ${name} as ${standalone.meshUser}`, disabled: true },
      '-',
      cmdItem('sulfur.mesh.open', `Open ${name}’s Machines`),
      cmdItem('sulfur.mesh.other', 'Connect to Another Mesh…'),
      cmdItem('sulfur.mesh.signOut', `Sign Out of ${name}`),
    ];
  }
  return [
    { label: `This Computer · ${selfHost}`, disabled: true },
    '-',
    standalone.server ? cmdItem('sulfur.mesh.connect', `Log In to ${name}…`) : cmdItem('sulfur.mesh.connect', 'Connect to a Phosphorus Mesh…'),
    ...(standalone.server ? [cmdItem('sulfur.mesh.other', 'Connect to Another Mesh…')] : []),
  ];
}

// a mesh connected to from offline: its address (the remembered one unless asked), its
// login, then working on it or staying here with its agents
async function meshConnect(other = false) {
  let server = standalone.server;
  if (!server || other) {
    const typed = await inputBox({ title: 'Connect to a Phosphorus Mesh', value: other ? '' : meshName(), placeholder: 'https://mulab.dev, or a host on your tailnet like d6', prompt: 'Its address from anywhere, or a host’s name on your tailnet.' });
    if (!typed?.trim() || !I) return;
    const r = await standalone.sidecarMode('link', typed.trim());
    if (!I) return;
    if (!r.ok) { notify('error', r.error || `Couldn't reach ${typed.trim()}.`); return; }
    server = r.server;
    standalone.meshUser = '';
  }
  let me = await standalone.meshMe().catch(() => null);
  if (!I) return;
  if (!me) {
    const user = await inputBox({ title: `Log In to ${meshName(server)}`, placeholder: 'User', prompt: `Your Phosphorus login on ${meshName(server)}.` });
    if (!user?.trim() || !I) return;
    const pass = await inputBox({ title: `Log In to ${meshName(server)}: ${user.trim()}`, placeholder: 'Password', password: true });
    if (pass === undefined || !I) return;
    const r = await standalone.meshLogIn(user.trim(), pass);
    if (!I) return;
    if (!r.ok) { notify('error', `${meshName(server)}: ${r.error || 'that login didn’t work'}`); return; }
    me = r;
  }
  standalone.signedOut = '';
  refreshRoles();
  paintWelcomeSoon();
  paintChat(true);
  paintRunView();
  notify('info', `Logged in to ${meshName(server)} as ${standalone.meshUser}. Open Folder includes this computer and the mesh’s machines.`);
}

async function meshOpen() {
  await pickFolder();
}

async function meshSignOut() {
  const name = meshName();
  await standalone.meshLogOut();
  if (!localDesktop()) { await standalone.sidecarMode('local'); location.reload(); return; }
  if (!I) return;
  I.roles = [];
  paintChat(true);
  paintWelcomeSoon();
  notify('info', `Signed out of ${name}. It's remembered: log in again from the remote item in the status bar.`);
}

function openGuide() {
  openPage('guide', 'Extension Guide', 'book', (t) => {
    const bar = el('div', 'ide-page-head');
    const make = Object.assign(el('button', 'ide-button'), { type: 'button' });
    make.append(icon('plus'), el('span', '', 'Create New Extension'));
    make.addEventListener('click', () => run('sulfur.extensions.create'));
    bar.append(make);
    const doc = el('div', 'ide-md');
    renderMd(doc, guideText, false);
    t.view.append(bar, doc);
  });
}

// --- extensions ---------------------------------------------------------------------------
// each one a folder in ~/.sulfur/extensions with a package.json and its main module,
// run in a frame sandboxed off this origin (no cookies, no page, no phosphorus
// api), talking to the workbench over one message port: what it can do is what
// the workbench answers there, and that's the api in the guide

// the extension host's page: runs in the sandbox, turns the port into the api
function extHostMain() {
  let port = null;
  let mod = null;
  let seq = 0;
  let sbSeq = 0;
  let wvSeq = 0;
  const pending = new Map();
  const cmds = new Map();
  const subs = new Map();
  const providers = new Map();
  const views = new Map();
  const call = (m, ...a) => new Promise((res, rej) => {
    if (!port) { rej(new Error('the extension host is not connected')); return; }
    seq += 1;
    pending.set(seq, { res, rej });
    port.postMessage({ t: 'call', id: seq, m, a });
  });
  const disposable = (fn) => ({ dispose: fn });
  const on = (name) => (fn) => {
    if (!subs.has(name)) { subs.set(name, new Set()); call('events.subscribe', name).catch(() => {}); }
    subs.get(name).add(fn);
    return disposable(() => subs.get(name).delete(fn));
  };
  const message = (kind) => (text, ...actions) => call('window.message', kind, String(text), actions.map(String));
  const api = {
    commands: {
      register(id, fn) {
        cmds.set(id, fn);
        call('commands.register', id).catch((e) => console.error(e.message));
        return disposable(() => { cmds.delete(id); call('commands.unregister', id).catch(() => {}); });
      },
      execute: (id, ...args) => call('commands.execute', id, args),
    },
    window: {
      showInformationMessage: message('info'),
      showWarningMessage: message('warning'),
      showErrorMessage: message('error'),
      showQuickPick: (items, opts = {}) => call('window.quickPick', items, opts),
      showInputBox: (opts = {}) => call('window.inputBox', opts),
      setStatusBarMessage: (text) => call('window.flash', String(text)),
      createStatusBarItem(opts = {}) {
        sbSeq += 1;
        const id = `s${sbSeq}`;
        let props = { text: '', tooltip: '', command: '', align: 'left', priority: 0, ...opts };
        return {
          update(p) { props = { ...props, ...p }; return call('statusBar.set', id, props); },
          show() { return call('statusBar.set', id, props); },
          hide() { return call('statusBar.remove', id); },
          dispose() { return call('statusBar.remove', id); },
        };
      },
      createOutputChannel(name) {
        const n = String(name);
        return {
          append: (t) => call('output.append', n, String(t)),
          appendLine: (t) => call('output.append', n, `${t}\n`),
          clear: () => call('output.clear', n),
          show: () => call('output.show', n),
        };
      },
      createWebviewPanel(opts = {}) {
        wvSeq += 1;
        const id = `w${wvSeq}`;
        const fns = new Set();
        views.set(id, fns);
        call('webview.create', id, String(opts.title || 'Webview'), String(opts.html || ''));
        return {
          post: (msg) => call('webview.post', id, msg),
          setHtml: (h) => call('webview.html', id, String(h)),
          onMessage: (fn) => { fns.add(fn); return disposable(() => fns.delete(fn)); },
          dispose: () => { views.delete(id); return call('webview.dispose', id); },
        };
      },
      onDidChangeActiveEditor: on('activeEditor'),
    },
    workspace: {
      root: () => call('workspace.root'),
      readFile: (p) => call('workspace.read', String(p)),
      writeFile: (p, text) => call('workspace.write', String(p), String(text)),
      list: (p = '') => call('workspace.list', String(p)),
      openFile: (p, opts = {}) => call('workspace.open', String(p), opts),
      onDidSaveFile: on('save'),
      onDidOpenFile: on('open'),
    },
    editor: {
      active: () => call('editor.active'),
      insert: (text) => call('editor.insert', String(text)),
      replaceSelection: (text) => call('editor.insert', String(text)),
      select: (from, to) => call('editor.select', from, to ?? from),
    },
    terminal: {
      hosts: () => call('terminal.hosts'),
      run: (command, opts = {}) => call('terminal.run', String(command), opts),
    },
    runners: {
      register(ext, command) {
        call('runners.register', String(ext), String(command));
        return disposable(() => call('runners.unregister', String(ext)).catch(() => {}));
      },
    },
    agents: {
      registerProvider(opts, handler) {
        const id = String(opts.id);
        providers.set(id, handler);
        call('agents.register', id, String(opts.label || id));
        return disposable(() => { providers.delete(id); call('agents.unregister', id).catch(() => {}); });
      },
    },
    onDidRunFile: on('run'),
  };
  const clone = (v) => { try { return structuredClone(v); } catch { return undefined; } };
  const reply = (id, p) => p.then(
    (v) => port.postMessage({ t: 'ret', id, v: clone(v) }),
    (e) => port.postMessage({ t: 'err', id, e: String((e && e.message) || e) }),
  );
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const was = console[level].bind(console);
    console[level] = (...args) => {
      was(...args);
      const text = args.map((x) => (x instanceof Error ? x.stack || x.message : typeof x === 'object' ? (() => { try { return JSON.stringify(x); } catch { return String(x); } })() : String(x))).join(' ');
      if (port) port.postMessage({ t: 'log', level, text });
    };
  }
  addEventListener('error', (e) => console.error(e.error || e.message));
  addEventListener('unhandledrejection', (e) => console.error(e.reason));
  addEventListener('message', (e) => {
    const d = e.data;
    if (port || !d || d.t !== 'init' || !e.ports[0]) return;
    port = e.ports[0];
    port.onmessage = async (ev) => {
      const m = ev.data;
      if (m.t === 'ret' || m.t === 'err') {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.t === 'ret') p.res(m.v); else p.rej(new Error(m.e));
      } else if (m.t === 'cmd') {
        reply(m.id, Promise.resolve().then(() => {
          const fn = cmds.get(m.cmd);
          if (!fn) throw new Error(`command '${m.cmd}' isn't registered`);
          return fn(...(m.args || []));
        }));
      } else if (m.t === 'provider') {
        reply(m.id, Promise.resolve().then(() => {
          const fn = providers.get(m.pid);
          if (!fn) throw new Error(`agent '${m.pid}' isn't registered`);
          return fn({ ...m.req, progress: (text) => call('agents.progress', m.rid, String(text)).catch(() => {}) });
        }));
      } else if (m.t === 'event') {
        for (const fn of subs.get(m.name) || []) { try { fn(m.data); } catch (err) { console.error(err); } }
      } else if (m.t === 'webview') {
        for (const fn of views.get(m.wid) || []) { try { fn(m.msg); } catch (err) { console.error(err); } }
      } else if (m.t === 'deactivate') {
        try { await (mod && mod.deactivate && mod.deactivate()); } catch (err) { console.error(err); }
        port.postMessage({ t: 'bye' });
      }
    };
    const url = URL.createObjectURL(new Blob([d.code], { type: 'text/javascript' }));
    import(url).then(async (m) => {
      mod = m;
      if (typeof m.activate !== 'function') throw new Error('the main module exports no activate(api, context)');
      await m.activate(api, d.context);
      port.postMessage({ t: 'ready' });
    }).catch((err) => port.postMessage({ t: 'fail', e: String((err && err.stack) || err) }));
  });
}
const HOST_HTML = `<!doctype html><meta charset="utf-8"><title>extension host</title><script>(${extHostMain.toString()})()<\/script>`;

const extName = (x) => x.manifest?.displayName || x.manifest?.name || x.id;
const extChannel = (x, n) => (n ? `${extName(x)}: ${n}` : `Extension: ${extName(x)}`);

function buildExtView() {
  const v = I.sideViews.get('extensions');
  v.body.classList.add('ide-extensions-body');
  const q = Object.assign(el('input', 'ide-input ide-ext-search'), { placeholder: 'Search Extensions in ~/.sulfur/extensions', spellcheck: false });
  const head = sectionHead('installed', 'Installed', []);
  const list = el('div', 'ide-ext-list');
  list.setAttribute('role', 'list');
  const note = el('div', 'ide-tree-note');
  v.body.append(el('div', 'ide-search-form', ''), head.node, list, note);
  v.body.firstChild.append(q);
  languages.mount(v.body);
  head.node.addEventListener('ide-section', () => { list.hidden = !head.open(); });
  head.paint();
  q.addEventListener('input', () => paintExtView());
  v.focus = () => q.focus();
  v.acts = [
    btn('', 'plus', 'Create New Extension…', () => run('sulfur.extensions.create')),
    btn('', 'refresh', 'Reload Extensions', () => run('workbench.extensions.action.refreshExtension')),
  ];
  I.extView = { q, head, list, note };
}

function paintExtView() {
  const E = I.extView;
  if (!E) return;
  const v = E.q.value.toLowerCase();
  const all = [...I.exts.values()].sort((a, b) => extName(a).localeCompare(extName(b)));
  const shown = all.filter((x) => !v || `${extName(x)} ${x.id} ${x.manifest?.description || ''}`.toLowerCase().includes(v));
  E.head.title.textContent = `Installed`;
  E.head.node.querySelector('.ide-badge')?.remove();
  E.head.title.after(Object.assign(el('span', 'ide-badge'), { textContent: String(all.length) }));
  E.list.replaceChildren(...shown.map((x) => {
    const row = Object.assign(el('div', `ide-ext${x.state === 'on' ? '' : ' off'}`), { tabIndex: 0 });
    row.setAttribute('role', 'listitem');
    const ic = el('span', 'ide-ext-ic');
    ic.append(icon('ext'));
    const main = el('div', 'ide-ext-main');
    const top = el('div', 'ide-ext-top');
    top.append(el('span', 'ide-ext-name', extName(x)), el('span', 'ide-ext-ver', x.manifest?.version ? `v${x.manifest.version}` : ''));
    const desc = el('div', 'ide-ext-desc', x.bad || x.manifest?.description || '');
    const foot = el('div', 'ide-ext-foot');
    foot.append(el('span', 'ide-ext-by', x.id));
    const state = { on: '', loading: 'Activating…', error: 'Failed to activate', off: 'Disabled', bad: 'Invalid' }[x.bad ? 'bad' : x.state];
    if (state) foot.append(el('span', `ide-ext-state ${x.state}`, state));
    const acts = el('span', 'ide-ext-acts');
    if (!x.bad) {
      const b = Object.assign(el('button', `ide-button small${x.state === 'on' || x.state === 'loading' ? ' secondary' : ''}`, x.state === 'on' || x.state === 'loading' ? 'Disable' : 'Enable'), { type: 'button' });
      b.addEventListener('click', (e) => { e.stopPropagation(); setExtEnabled(x, !(x.state === 'on' || x.state === 'loading')); });
      acts.append(b);
    }
    acts.append(btn('', 'gear', 'Manage', (e) => { e.stopPropagation(); menu(e.currentTarget, extItems(x)); }));
    foot.append(acts);
    main.append(top, desc, foot);
    row.append(ic, main);
    row.addEventListener('click', () => openExtPage(x));
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') openExtPage(x); });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); menu({ x: e.clientX, y: e.clientY }, extItems(x)); });
    return row;
  }));
  E.note.replaceChildren();
  if (!all.length) {
    E.note.append(el('p', '', 'No extensions yet. An extension is a folder in ~/.sulfur/extensions: a package.json and a module that exports activate(api).'));
    const make = Object.assign(el('button', 'ide-button', 'Create New Extension'), { type: 'button' });
    make.addEventListener('click', () => run('sulfur.extensions.create'));
    const read = Object.assign(el('button', 'ide-link', 'Read the Extension Guide'), { type: 'button' });
    read.addEventListener('click', () => run('sulfur.extensions.guide'));
    E.note.append(make, read);
  }
  for (const t of I.tabs) if (t.page?.startsWith('ext:')) t.paint?.();
}

function extItems(x) {
  return [
    !x.bad && { label: x.state === 'on' ? 'Disable' : 'Enable', run: () => setExtEnabled(x, x.state !== 'on') },
    x.state === 'on' && { label: 'Restart Extension', run: () => { deactivateExt(x); activateExt(x); } },
    '-',
    { label: 'Open package.json', run: () => openFile(`${x.dir}/package.json`, { preview: false }) },
    x.manifest && { label: `Open ${x.manifest.main || 'extension.js'}`, run: () => openFile(`${x.dir}/${x.manifest.main || 'extension.js'}`, { preview: false }) },
    { label: 'Reveal in Explorer', run: () => { if (!under(x.dir, I.st.root)) setRoot(x.dir); else { showSide('explorer', true); revealPath(x.dir); } } },
    { label: 'Show Output', run: () => { I.outCh = extChannel(x); log('', I.outCh); paintOutputChannels(); showPanel('output', true, true); } },
    '-',
    { label: 'Uninstall', danger: true, run: () => uninstallExt(x) },
  ].filter(Boolean);
}

// every folder's package.json read, the enabled ones started
async function loadExtensions(restart = false) {
  if (restart) for (const x of I.exts.values()) deactivateExt(x);
  let entries = [];
  try { entries = (await filesCall(HOME, 'list', undefined, { path: EXT_DIR() })).entries || []; } catch {}
  if (!I) return;
  const seen = new Set();
  for (const e of entries.filter((y) => y.dir && /^[\w.-]+$/.test(y.name))) {
    seen.add(e.name);
    const had = I.exts.get(e.name);
    if (had && !restart && had.state === 'on') continue;
    if (had) deactivateExt(had);
    const dir = filesJoin(EXT_DIR(), e.name);
    const x = { id: e.name, dir, manifest: null, bad: '', state: 'off', cmds: new Set(), status: new Set(), runners: new Set(), providers: new Set(), subs: new Set(), views: new Map(), pending: new Map(), seq: 0 };
    const text = await readUser(`${dir}/package.json`);
    if (!I) return;
    if (text === null) x.bad = 'No package.json in its folder.';
    else {
      try {
        const m = parseJsonc(text);
        if (!m || typeof m !== 'object') throw new Error('not an object');
        x.manifest = m;
      } catch (err) { x.bad = `package.json: ${err.message}`; }
    }
    I.exts.set(x.id, x);
    contribute(x);
    if (!x.bad && I.st.ext.enabled[x.id]) activateExt(x);
  }
  for (const [id, x] of I.exts) if (!seen.has(id)) { deactivateExt(x); uncontribute(x, true); I.exts.delete(id); }
  buildKeys();
  paintExtView();
}

// a manifest's commands in the palette and its keys bound, live once it's on
function contribute(x) {
  const c = x.manifest?.contributes || {};
  const keys = new Map((Array.isArray(c.keybindings) ? c.keybindings : []).filter((k) => k && k.command && k.key).map((k) => [k.command, IS_MAC && k.mac ? k.mac : k.key]));
  for (const cmd of Array.isArray(c.commands) ? c.commands : []) {
    if (!cmd?.command || (I.commands.has(cmd.command) && I.commands.get(cmd.command).ext !== x.id)) continue;
    command(cmd.command, String(cmd.title || cmd.command), (...args) => extRequest(x, { t: 'cmd', cmd: cmd.command, args: args.map((a) => { try { return structuredClone(a); } catch { return undefined; } }) }), {
      category: String(cmd.category || extName(x)), key: keys.get(cmd.command) || '', ext: x.id, when: () => x.state === 'on',
    });
    x.cmds.add(cmd.command);
  }
  for (const [ext, cmd] of Object.entries(c.runners || {})) if (typeof cmd === 'string') { I.runners.set(ext.replace(/^\./, ''), { cmd, by: extName(x) }); x.runners.add(ext.replace(/^\./, '')); }
}
function uncontribute(x, all) {
  for (const id of x.cmds) if (all || !((x.manifest?.contributes?.commands) || []).some((c) => c?.command === id)) I.commands.delete(id);
  for (const ext of x.runners) if (I.runners.get(ext)?.by === extName(x)) { const def = DK_RUNNERS[ext]; if (def) I.runners.set(ext, { cmd: def, by: '' }); else I.runners.delete(ext); }
}

async function setExtEnabled(x, on) {
  if (on && !I.st.ext.enabled[x.id] && I.st.ext.enabled[x.id] !== false) {
    const v = await ask({
      title: `Enable the extension '${extName(x)}'?`,
      detail: 'It runs sandboxed, away from this page and your login, but through Sulfur it can read and write the files in your space, type commands into terminals on the hosts you’re logged into, and answer as an agent. Enable only what you wrote or trust.',
      buttons: [{ label: 'Trust and Enable', primary: true, value: 'y' }, { label: 'Cancel', value: '' }],
    });
    if (v !== 'y') return;
  }
  I.st.ext.enabled[x.id] = on;
  saveState();
  if (on) activateExt(x); else { deactivateExt(x); paintExtView(); }
}

async function activateExt(x) {
  if (!I || x.bad || x.state === 'on' || x.state === 'loading') return;
  x.state = 'loading';
  x.error = '';
  paintExtView();
  const mainRel = cleanPath(filesJoin(x.dir, x.manifest.main || 'extension.js'));
  const code = mainRel && under(mainRel, x.dir) ? await readUser(mainRel) : null;
  if (!I) return;
  if (code === null) { extFailed(x, `its main module ${x.manifest.main || 'extension.js'} wasn't found, or is over 16MB`); return; }
  const frame = el('iframe', 'ide-ext-frame');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.title = `extension host: ${x.id}`;
  const ch = new MessageChannel();
  x.port = ch.port1;
  x.frame = frame;
  ch.port1.onmessage = (ev) => extMessage(x, ev.data);
  frame.addEventListener('load', () => {
    frame.contentWindow.postMessage({ t: 'init', code, context: { id: x.id, extensionPath: x.dir, user: acct.user, workspace: I.st.root, host: selfHost } }, '*', [ch.port2]);
  }, { once: true });
  frame.srcdoc = HOST_HTML;
  I.root.append(frame);
  x.timer = setTimeout(() => { if (x.state === 'loading') extFailed(x, 'activate() didn’t finish within 15 seconds'); }, 15000);
}

function extFailed(x, why) {
  clearTimeout(x.timer);
  x.state = 'error';
  x.error = why;
  log(why, extChannel(x));
  notify('error', `Activating extension '${extName(x)}' failed: ${why.split('\n')[0]}`, { source: extName(x), actions: [{ label: 'Show Output', run: () => { I.outCh = extChannel(x); paintOutputChannels(); showPanel('output', true, true); } }] });
  teardownExt(x);
  paintExtView();
}

function deactivateExt(x) {
  if (x.port) {
    try { x.port.postMessage({ t: 'deactivate' }); } catch {}
    const frame = x.frame;
    setTimeout(() => frame?.remove(), 500);
    teardownExt(x, true);
  }
  x.state = 'off';
}

// what it made of the workbench taken back, its contributed commands kept, sleeping
function teardownExt(x, keepFrame = false) {
  clearTimeout(x.timer);
  for (const [, p] of x.pending) p.rej(new Error('the extension stopped'));
  x.pending.clear();
  for (const k of x.status) I.statusItems.get(k)?.el.remove();
  for (const k of x.status) I.statusItems.delete(k);
  x.status.clear();
  for (const k of x.providers) { I.providers.delete(k); const c = I.chats.get(k); if (c) { c.busy = false; c.req = null; } }
  x.providers.clear();
  for (const [, v] of x.views) closeTab(v.t, true);
  x.views.clear();
  x.subs.clear();
  uncontribute(x, false);
  contribute(x);
  buildKeys();
  if (!keepFrame) x.frame?.remove();
  x.frame = null;
  x.port = null;
  if (I.chat) paintChat();
  paintStatus();
}

function extRequest(x, msg) {
  return new Promise((res, rej) => {
    if (!x.port || x.state !== 'on') { rej(new Error(`the extension '${extName(x)}' isn't running`)); return; }
    x.seq += 1;
    x.pending.set(x.seq, { res, rej });
    x.port.postMessage({ ...msg, id: x.seq });
  });
}

function extMessage(x, d) {
  if (!I || !d) return;
  if (d.t === 'ready') {
    clearTimeout(x.timer);
    x.state = 'on';
    log(`activated ${x.id}`, extChannel(x));
    paintExtView();
  } else if (d.t === 'fail') extFailed(x, d.e);
  else if (d.t === 'log') outAppend(extChannel(x), `[${d.level}] ${d.text}\n`);
  else if (d.t === 'ret' || d.t === 'err') {
    const p = x.pending.get(d.id);
    if (!p) return;
    x.pending.delete(d.id);
    if (d.t === 'ret') p.res(d.v); else p.rej(new Error(d.e));
  } else if (d.t === 'call') {
    Promise.resolve().then(() => extCall(x, d.m, d.a || [])).then(
      (v) => { let out; try { out = structuredClone(v); } catch { out = undefined; } x.port?.postMessage({ t: 'ret', id: d.id, v: out }); },
      (err) => x.port?.postMessage({ t: 'err', id: d.id, e: String(err?.message || err) }),
    );
  }
}

// an extension's path: from the workspace, or from the home's top with a leading slash
function extPath(p) {
  const s = String(p || '');
  const home = s.startsWith('/');
  const l = home ? HOME_LOC : locOf();
  const c = cleanPath(home ? s : filesJoin(I.st.root, s));
  if (c === null || !inScope(c, l)) throw new Error(`${s} is outside your space`);
  return { path: c, loc: l };
}

const EXT_CALLS = {
  'commands.register': (x, id) => {
    const had = I.commands.get(id);
    if (had && had.ext !== x.id) throw new Error(`command '${id}' already exists`);
    if (!had) {
      command(id, id, (...args) => extRequest(x, { t: 'cmd', cmd: id, args }), { category: extName(x), ext: x.id, when: () => x.state === 'on' });
      buildKeys();
    }
    x.cmds.add(id);
  },
  'commands.unregister': (x, id) => { if (I.commands.get(id)?.ext === x.id && !(x.manifest?.contributes?.commands || []).some((c) => c?.command === id)) { I.commands.delete(id); x.cmds.delete(id); buildKeys(); } },
  'commands.execute': (x, id, args) => run(id, ...(args || [])),
  'window.message': (x, kind, text, actions) => new Promise((res) => {
    notify(['info', 'warning', 'error'].includes(kind) ? kind : 'info', text, { source: extName(x), actions: (actions || []).map((label) => ({ label, run: () => res(label) })), onClose: () => res(undefined) });
  }),
  'window.quickPick': (x, items, o) => pick((items || []).map((it) => (typeof it === 'string' ? { label: it, value: it } : { label: String(it.label), description: it.description, detail: it.detail, value: it })), { placeholder: o?.placeholder, title: o?.title, matchDescription: !!o?.matchOnDescription }),
  'window.inputBox': (x, o) => inputBox({ value: o?.value, prompt: o?.prompt, placeholder: o?.placeholder, title: o?.title }),
  'window.flash': (x, text) => setStatusFlash(text),
  'statusBar.set': (x, sid, p) => {
    const key = `${x.id}:${sid}`;
    let it = I.statusItems.get(key);
    if (!it) {
      const node = sbItem('ide-sb-x', '', () => { if (it.command) run(it.command); });
      it = { el: node };
      I.statusItems.set(key, it);
      x.status.add(key);
    }
    Object.assign(it, { align: p.align === 'right' ? 'right' : 'left', priority: Number(p.priority) || 0, command: String(p.command || '') });
    it.el.textContent = String(p.text || '');
    it.el.title = String(p.tooltip || '');
    it.el.classList.toggle('link', !!it.command);
    paintStatus();
  },
  'statusBar.remove': (x, sid) => { const key = `${x.id}:${sid}`; I.statusItems.get(key)?.el.remove(); I.statusItems.delete(key); x.status.delete(key); },
  'output.append': (x, n, text) => outAppend(extChannel(x, n), text),
  'output.clear': (x, n) => { const c = I.output.get(extChannel(x, n)); if (c) c.lines = []; paintOutput(false); },
  'output.show': (x, n) => { I.outCh = extChannel(x, n); if (!I.output.has(I.outCh)) outAppend(I.outCh, ''); paintOutputChannels(); showPanel('output', true); },
  'workspace.root': () => I.st.root,
  'workspace.read': async (x, p) => {
    const { path, loc } = extPath(p);
    const t = I.tabs.find((y) => y.rel === path && sameLoc(y.loc, loc) && y.info?.ready);
    if (t) return t.ed.text();
    const text = await readAt(path, loc);
    if (text === null) throw new Error(`${p}: not found, not text, or over 16MB`);
    return text;
  },
  'workspace.write': async (x, p, text) => {
    const { path, loc } = extPath(p);
    await writeAt(path, text, loc, `${extName(x)} (extension)`);
    if (sameLoc(loc, locOf())) loadDir(filesParent(path), true);
    I.index = null;
    return true;
  },
  'workspace.list': async (x, p) => {
    const { path, loc } = extPath(p);
    const b = await filesCall(apiLoc(loc), 'list', undefined, { path });
    return (b.entries || []).map((e) => ({ name: e.name, dir: !!e.dir, size: e.size, mtime: e.mtime, hosts: e.live || e.hosts || [loc.host].filter((h) => h !== '*') }));
  },
  'workspace.open': (x, p, o) => {
    const { path, loc } = extPath(p);
    return !!openFile(path, { preview: false, loc, line: Number(o?.line) || undefined, col: Number(o?.col) || undefined });
  },
  'editor.active': () => {
    const t = I.active;
    if (!t?.ed || !t.info?.ready) return null;
    const [s, e] = t.ed.selection();
    return { path: t.rel, language: t.info.lang, text: t.ed.text(), selection: [s, e], line: t.info.line, col: t.info.col, host: t.host };
  },
  'editor.insert': (x, text) => { const t = I.active; if (!t?.ed) return false; const [s, e] = t.ed.selection(); return t.ed.edit(s, e, text); },
  'editor.select': (x, from, to) => { const t = I.active; if (!t?.ed) return false; const n = t.ed.text().length; t.ed.select(Math.max(0, Math.min(n, from)), Math.max(0, Math.min(n, to))); return true; },
  'terminal.hosts': () => dkLiveHosts(),
  'terminal.run': async (x, cmd, o) => {
    const host = o?.host || runHost();
    if (!dkLiveHosts().includes(host)) throw new Error(`not logged into ${host || 'any host'}`);
    const nm = o?.name ? String(o.name) : `${extName(x)}: ${host}`;
    const term = I.terms.find((t) => t.base === nm && t.host === host && !t.ended);
    if (term && term.h.send(`${cmd}\r`)) { selectTerm(term, false); showPanel('terminal', true); return true; }
    return !!(await newTerminal({ host, kind: 'run', name: nm, run: cmd, cwd: o?.cwd !== undefined ? extPath(o.cwd) : I.st.root, focus: false }));
  },
  'runners.register': (x, ext, cmd) => { const e = ext.replace(/^\./, ''); I.runners.set(e, { cmd, by: extName(x) }); x.runners.add(e); paintRunView(); paintTabActions(); },
  'runners.unregister': (x, ext) => { const e = ext.replace(/^\./, ''); if (I.runners.get(e)?.by === extName(x)) { if (DK_RUNNERS[e]) I.runners.set(e, { cmd: DK_RUNNERS[e], by: '' }); else I.runners.delete(e); } x.runners.delete(e); paintRunView(); },
  'agents.register': (x, pid, label) => {
    const key = `ext:${x.id}:${pid}`;
    I.providers.set(key, { key, id: pid, label, ext: x.id });
    x.providers.add(key);
    paintChat(true);
  },
  'agents.unregister': (x, pid) => { const key = `ext:${x.id}:${pid}`; I.providers.delete(key); x.providers.delete(key); paintChat(true); },
  'agents.progress': (x, rid, text) => { for (const c of I.chats.values()) if (c.req === rid) { c.live = text; paintChat(); } },
  'events.subscribe': (x, n) => { x.subs.add(n); },
  'webview.create': (x, wid, title, html) => {
    const t = openPage(`wv:${x.id}:${wid}`, title, 'ext', (pg) => {
      const frame = el('iframe', 'ide-webview');
      frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals');
      frame.title = title;
      frame.srcdoc = webviewDoc(html);
      pg.view.append(frame);
      pg.frame = frame;
      pg.dispose = () => x.views.delete(wid);
    });
    x.views.set(wid, { t, frame: t.frame });
  },
  'webview.post': (x, wid, msg) => { x.views.get(wid)?.frame.contentWindow?.postMessage({ phosphorusHost: msg }, '*'); },
  'webview.html': (x, wid, html) => { const v = x.views.get(wid); if (v) v.frame.srcdoc = webviewDoc(html); },
  'webview.dispose': (x, wid) => { const v = x.views.get(wid); if (v) closeTab(v.t, true); },
};
function extCall(x, m, a) {
  const fn = EXT_CALLS[m];
  if (!fn) throw new Error(`no such call: ${m}`);
  return fn(x, ...a);
}

// a webview's page: the extension's html, the workbench's colours and a bridge
function webviewDoc(html) {
  const css = getComputedStyle(I.root);
  const v = (n) => css.getPropertyValue(n).trim();
  const vars = ['--ide-bg', '--ide-fg', '--ide-muted', '--ide-accent', '--ide-border', '--ide-input', '--ide-button', '--ide-button-fg']
    .map((n) => `${n}:${v(n)}`).join(';');
  return `<!doctype html><meta charset="utf-8"><style>:root{${vars}}body{background:var(--ide-bg);color:var(--ide-fg);font:13px system-ui,sans-serif;margin:16px}a{color:var(--ide-accent)}</style>`
    + '<script>window.phosphorus={post:function(m){parent.postMessage({phosphorusWebview:m},"*")},onMessage:function(f){addEventListener("message",function(e){if(e.source===parent&&e.data&&"phosphorusHost" in e.data)f(e.data.phosphorusHost)})}};<\/script>'
    + html;
}

// a webview's word back to its extension
function onWebviewMessage(e) {
  if (!I || !e.data || !('phosphorusWebview' in e.data)) return;
  for (const x of I.exts.values()) {
    for (const [wid, v] of x.views) {
      if (v.frame?.contentWindow === e.source) { x.port?.postMessage({ t: 'webview', wid, msg: e.data.phosphorusWebview }); return; }
    }
  }
}

// an event to the extensions that asked for it
function emit(name, data) {
  if (!I) return;
  let d = data;
  if (name === 'activeEditor' && d === undefined) d = I.active?.rel ? { path: I.active.rel, language: I.active.info?.lang || '' } : null;
  for (const x of I.exts.values()) if (x.port && x.state === 'on' && x.subs.has(name)) x.port.postMessage({ t: 'event', name, data: d });
}

function openExtPage(x) {
  const t = openPage(`ext:${x.id}`, `Extension: ${extName(x)}`, 'ext', (pg) => { pg.paint = () => paintExtPage(pg, x); });
  t.paint();
}

async function paintExtPage(t, x) {
  const m = x.manifest || {};
  const head = el('div', 'ide-extp-head');
  const ic = el('div', 'ide-extp-ic');
  ic.append(icon('ext'));
  const info = el('div', 'ide-extp-info');
  info.append(el('h1', '', extName(x)), el('div', 'ide-extp-id', `${x.id}${m.version ? ` · v${m.version}` : ''} · ${x.dir}`), el('p', '', x.bad || m.description || ''));
  const acts = el('div', 'ide-extp-acts');
  if (!x.bad) {
    const b = Object.assign(el('button', `ide-button${x.state === 'on' ? ' secondary' : ''}`, x.state === 'on' ? 'Disable' : 'Enable'), { type: 'button' });
    b.addEventListener('click', () => setExtEnabled(x, x.state !== 'on'));
    acts.append(b);
  }
  const un = Object.assign(el('button', 'ide-button secondary', 'Uninstall'), { type: 'button' });
  un.addEventListener('click', () => uninstallExt(x));
  acts.append(un);
  if (x.state === 'error') acts.append(el('span', 'ide-ext-state error', 'Failed to activate: see its output'));
  info.append(acts);
  head.append(ic, info);
  const c = m.contributes || {};
  const contrib = el('div', 'ide-extp-contrib');
  const cmds = Array.isArray(c.commands) ? c.commands : [];
  if (cmds.length) {
    contrib.append(el('h2', '', 'Commands'));
    for (const cmd of cmds) {
      const r = el('div', 'ide-key-row');
      const k = el('span', 'ide-key-keys');
      const key = keyFor(cmd.command);
      if (key) k.append(...key.split(' ').map((part) => el('kbd', '', keyLabel(part))));
      r.append(el('span', '', `${cmd.category ? `${cmd.category}: ` : ''}${cmd.title || cmd.command}`), k, el('span', 'ide-key-id', cmd.command));
      contrib.append(r);
    }
  }
  if (c.runners && Object.keys(c.runners).length) {
    contrib.append(el('h2', '', 'Runners'));
    for (const [ext, cmd] of Object.entries(c.runners)) {
      const r = el('div', 'ide-runner');
      r.append(el('span', 'ide-runner-ext', `.${ext.replace(/^\./, '')}`), el('code', 'ide-runner-cmd', String(cmd)));
      contrib.append(r);
    }
  }
  const readme = el('div', 'ide-md');
  t.view.replaceChildren(head, contrib, readme);
  const text = await readUser(`${x.dir}/README.md`);
  if (text !== null && t.view.isConnected) renderMd(readme, text, false);
}

async function uninstallExt(x) {
  const v = await ask({
    title: `Uninstall '${extName(x)}'?`,
    detail: `Its folder ${x.dir} is deleted from every host holding it, for good.`,
    buttons: [{ label: 'Uninstall', primary: true, danger: true, value: 'y' }, { label: 'Cancel', value: '' }],
  });
  if (v !== 'y') return;
  deactivateExt(x);
  try { await filesCall(HOME, 'delete', jsonPost({ path: x.dir })); } catch (err) { notify('error', `Couldn't delete ${x.dir}: ${err.message}`); return; }
  uncontribute(x, true);
  I.exts.delete(x.id);
  delete I.st.ext.enabled[x.id];
  saveState();
  for (const t of I.tabs.filter((y) => y.page === `ext:${x.id}` || (y.rel && under(y.rel, x.dir)))) closeTab(t, true);
  buildKeys();
  paintExtView();
}

// a working extension to start from, enabled at once: the user wrote it
async function createExtension() {
  const id = await inputBox({
    prompt: 'Name the extension (its folder in ~/.sulfur/extensions)', placeholder: 'e.g. word-count',
    validate: (v) => (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(v) ? 'Lowercase letters, digits and dashes, starting with a letter or digit.' : I.exts.has(v) ? `An extension named ${v} already exists.` : ''),
  });
  if (!id || !I) return;
  const dir = filesJoin(EXT_DIR(), id);
  const files = {
    'package.json': `${JSON.stringify({
      name: id, displayName: id, version: '0.0.1', description: 'A Sulfur extension.', main: 'extension.js',
      contributes: {
        commands: [
          { command: `${id}.hello`, title: 'Say Hello', category: id },
          { command: `${id}.wordCount`, title: 'Count Words in the Active File', category: id },
        ],
        keybindings: [{ command: `${id}.wordCount`, key: 'ctrl+alt+w' }],
      },
    }, null, 2)}\n`,
    'extension.js': EXT_SAMPLE.replaceAll('NAME', id),
    'README.md': `# ${id}\n\nA Sulfur extension. **Help: Extension Guide** in Sulfur says how it works.\n\n- \`${id}: Say Hello\` greets you.\n- \`${id}: Count Words in the Active File\` (ctrl+alt+w), its count kept in the status bar.\n`,
  };
  try {
    for (const [f, text] of Object.entries(files)) await writeText(`${dir}/${f}`, text);
  } catch (err) { notify('error', `Couldn't create the extension: ${err.message}`); return; }
  if (!I) return;
  I.st.ext.enabled[id] = true;
  saveState();
  await loadExtensions();
  if (!I) return;
  openFile(`${dir}/extension.js`, { preview: false });
  notify('info', `Created ${id} in ${dir} and enabled it. Edit extension.js, then run Developer: Reload Extensions.`, { actions: [{ label: 'Open Extension Guide', run: () => openGuide() }] });
}

const EXT_SAMPLE = `// NAME: a Sulfur extension. It runs in a sandboxed frame of its own and
// reaches Sulfur only through the api handed to activate; Help: Extension Guide
// lists all of it. Edit, save, then run "Developer: Reload Extensions".

export function activate(api, context) {
  const out = api.window.createOutputChannel('log');
  out.appendLine(\`NAME activated for \${context.user} in \${context.workspace}\`);

  // a command, its title and keys in package.json's contributes
  api.commands.register('NAME.hello', async () => {
    const pick = await api.window.showInformationMessage(\`Hello from NAME, \${context.user}!\`, 'Show Log');
    if (pick === 'Show Log') out.show();
  });

  // a status bar item kept up to date with the active file
  const status = api.window.createStatusBarItem({ align: 'right', priority: 10, command: 'NAME.wordCount', tooltip: 'Words in the active file' });
  async function count() {
    const ed = await api.editor.active();
    if (!ed) { status.hide(); return 0; }
    const n = (ed.text.match(/\\S+/g) || []).length;
    status.update({ text: \`\${n} words\` });
    return n;
  }
  api.commands.register('NAME.wordCount', async () => {
    api.window.showInformationMessage(\`\${await count()} words\`);
  });
  api.window.onDidChangeActiveEditor(count);
  api.workspace.onDidSaveFile(count);
  count();
}

export function deactivate() {}
`;

// --- building: a host's toolchains, the project's kind, its tasks run there ----------------
// what a host can build with comes from the host itself, as the user's login sees
// it; what the project is comes from its files; the two met in a pick kept in
// the project's .sulfur/build.json, Ctrl+B running its build from then on

const BUILD_FILE = '.sulfur/build.json';

// a host's toolchains, kept a while; fresh asks the host again
async function toolchains(host, fresh = false) {
  I.tc ||= new Map();
  const had = I.tc.get(host);
  // a failure kept a little while, so a view painting over and over doesn't ask each time
  if (had && !fresh && (had.pr || Date.now() - had.at < (had.err ? 30 * 1000 : 10 * 60 * 1000))) {
    if (had.err) throw new Error(had.err);
    return had.pr || had.v;
  }
  const pr = fetch(hostUrl(host, `/api/sulfur/toolchains?host=${encodeURIComponent(host)}${fresh ? '&fresh=1' : ''}`), { cache: 'no-store' })
    .then(async (r) => {
      const b = await r.json().catch(() => ({}));
      // a host whose Phosphorus predates Sulfur's builds has no such call
      if (r.status === 404) throw new Error(`${host}'s Phosphorus is older than this Sulfur: update the mesh to build there`);
      if (!r.ok) throw new Error(b.error || `status ${r.status}`);
      return b;
    });
  I.tc.set(host, { pr });
  try {
    const v = await pr;
    if (I) I.tc.set(host, { v, at: Date.now() });
    return v;
  } catch (err) {
    if (I) I.tc.set(host, { err: err.message, at: Date.now(), v: null });
    throw err;
  }
}
const tool = (tc, id) => tc?.tools?.find((x) => x.id === id) || null;

// what the project is, by its files: cmake, dotnet, msbuild, cargo, go, npm, make, python
// the project the open file's in: its folder, or the nearest one above it up to the
// workspace's, that has a build file; the workspace's own when none has
async function detectProject() {
  const state = I;
  const workspace = wsKey();
  const active = state.active;
  const current = () => I === state && state.active === active && wsKey() === workspace;
  const root = I.st.root;
  const t = I.active;
  let dir = t?.rel && sameLoc(t.loc, locOf()) && under(t.rel, root) && t.rel !== root ? filesParent(t.rel) : root;
  for (;;) {
    const p = await projectAt(dir);
    if (!current()) return null;
    if (p.kinds.length || dir === root || !under(dir, root)) {
      if (p.kinds.length && dir !== root && under(dir, root)) {
        let top = '';
        for (let d = filesParent(dir); under(d, root); d = filesParent(d)) {
          const names = (await loadDir(d)).map((e) => e.name.toLowerCase());
          if (!current()) return null;
          if ((p.kinds.includes('cmake') && names.includes('cmakelists.txt')) || names.some((n) => n.endsWith('.sln') || n.endsWith('.slnx'))) top = d;
          if (d === root || !d) break;
        }
        if (top) { dir = top; continue; }
      }
      const had = I.projHas;
      I.projHas = !!p.kinds.length;
      await useProject(p.kinds.length ? dir : root);
      if (!current()) return null;
      if (I && had !== I.projHas) { paintStatus(); paintRunView(); }
      return p.kinds.length ? p : { ...p, dir: root };
    }
    dir = filesParent(dir);
  }
}

// a folder's own build files, as a project
async function projectAt(root) {
  const list = await loadDir(root);
  if (!I) return { kinds: [], dir: root };
  const names = (list || []).map((e) => e.name);
  const lower = names.map((n) => n.toLowerCase());
  const has = (n) => lower.includes(n.toLowerCase());
  const ext = (x) => names.filter((n) => n.toLowerCase().endsWith(x));
  const p = { dir: root, kinds: [], sln: [...ext('.sln'), ...ext('.slnx')], proj: [...ext('.csproj'), ...ext('.fsproj'), ...ext('.vbproj')], vcx: ext('.vcxproj'), presets: [], scripts: [], targets: [] };
  if (has('CMakeLists.txt')) {
    p.kinds.push('cmake');
    await cmakeOf(root, names, p);
  }
  // a solution, as Visual Studio reads it: C++ in it builds with MSBuild, C# alone with dotnet
  if (p.sln.length) await slnOf(root, p);
  const cpp = p.vcx.length || p.slnCpp;
  if (cpp) p.kinds.push('msbuild');
  if (!cpp && (p.proj.length || p.sln.length)) p.kinds.push('dotnet');
  if (has('global.json')) { try { p.sdk = JSON.parse(await readAt(`${root}/global.json`) || '{}').sdk?.version || ''; } catch {} }
  if (has('Cargo.toml')) p.kinds.push('cargo');
  if (has('go.mod')) p.kinds.push('go');
  if (has('package.json')) {
    p.kinds.push('npm');
    try { p.scripts = Object.keys(JSON.parse(await readAt(`${root}/package.json`) || '{}').scripts || {}); } catch {}
  }
  const mkName = names.find((n) => ['makefile', 'gnumakefile'].includes(n.toLowerCase()));
  if (mkName) {
    p.kinds.push('make');
    const mk = await readAt(`${root}/${mkName}`) || '';
    p.targets = [...new Set([...mk.matchAll(/^([A-Za-z0-9][\w.-]*)\s*:(?!=)/gm)].map((m) => m[1]))].filter((x) => !x.startsWith('.')).slice(0, 30);
  }
  if (has('meson.build')) p.kinds.push('meson');
  if (has('pyproject.toml') || has('setup.py') || has('requirements.txt')) p.kinds.push('python');
  return p;
}

// CMake as Visual Studio drives it: CMakeSettings.json's configurations, CMakePresets'
// presets, and the trees already configured (build, out/build/*, cmake-build-*)
async function cmakeOf(root, names, p) {
  p.cmakeSettings = [];
  p.presets = [];
  p.buildPresets = [];
  p.trees = [];
  if (names.includes('CMakeSettings.json')) {
    try { p.cmakeSettings = (parseJsonc(await readAt(`${root}/CMakeSettings.json`) || '{}').configurations || []).filter((x) => x && x.name); } catch {}
  }
  const all = [];
  for (const f of ['CMakePresets.json', 'CMakeUserPresets.json']) {
    if (!names.includes(f)) continue;
    try {
      const j = parseJsonc(await readAt(`${root}/${f}`) || '{}');
      all.push(...(j.configurePresets || []));
      p.buildPresets.push(...(j.buildPresets || []).filter((x) => x && x.name && !x.hidden));
    } catch {}
  }
  // a preset's own fields, else what it inherits
  const field = (x, k, seen = new Set()) => {
    if (!x || seen.has(x.name)) return undefined;
    seen.add(x.name);
    if (x[k] !== undefined) return x[k];
    for (const n of [].concat(x.inherits || [])) { const v = field(all.find((y) => y.name === n), k, seen); if (v !== undefined) return v; }
    return undefined;
  };
  p.presets = all.filter((x) => x && x.name && !x.hidden).map((x) => ({
    name: x.name, displayName: x.displayName || x.name, generator: field(x, 'generator') || '',
    configurationType: String(field(x, 'cacheVariables')?.CMAKE_BUILD_TYPE?.value || field(x, 'cacheVariables')?.CMAKE_BUILD_TYPE || ''),
    binaryDir: String(field(x, 'binaryDir') || '').replaceAll('${sourceDir}', '.').replaceAll('${presetName}', x.name).replaceAll('${sourceParentDir}', '..').replaceAll('${sourceDirName}', baseName(root)),
  }));
  // configured trees: where a CMakeCache.txt says how it was configured
  const dirs = new Set();
  for (const n of names) if (n === 'build' || n.startsWith('cmake-build-')) dirs.add(n);
  if (names.includes('out')) {
    const ob = await loadDir(`${root}/out/build`).catch(() => null);
    for (const e of ob || []) if (e.dir) dirs.add(`out/build/${e.name}`);
  }
  for (const x of p.cmakeSettings) dirs.add(cmakeRoot(x));
  for (const x of p.presets) if (x.binaryDir) dirs.add(x.binaryDir.replace(/^\.\//, ''));
  for (const d of dirs) {
    const cache = await readAt(`${root}/${d}/CMakeCache.txt`).catch(() => null);
    if (!cache) continue;
    const v = (k) => (cache.match(new RegExp(`^${k}:[A-Z]+=(.*)$`, 'm')) || [])[1]?.trim() || '';
    p.trees.push({ dir: d, generator: v('CMAKE_GENERATOR'), type: v('CMAKE_BUILD_TYPE'), configs: v('CMAKE_CONFIGURATION_TYPES').split(';').filter(Boolean), cxx: v('CMAKE_CXX_COMPILER') || v('CMAKE_C_COMPILER'), platform: v('CMAKE_GENERATOR_PLATFORM') });
  }
}
// a CMakeSettings configuration's build folder, from the project's
const cmakeRoot = (x) => String(x.buildRoot || '${projectDir}\\out\\build\\${name}').replaceAll('${projectDir}', '.').replaceAll('${workspaceRoot}', '.').replaceAll('${name}', x.name)
  .replace(/\\/g, '/').replace(/^\.\//, '');
const samePath = (a, b) => String(a).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase() === String(b).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();

// a solution's projects and configurations, and the Visual Studio it was made with
async function slnOf(root, p) {
  const text = await readAt(`${root}/${p.sln[0]}`).catch(() => null);
  if (!text) return;
  p.slnProjects = [...text.matchAll(/^Project\("\{[^}]+\}"\)\s*=\s*"([^"]+)",\s*"([^"]+)"/gm)].map((m) => ({ name: m[1], path: m[2].replace(/\\/g, '/') })).filter((x) => /\.\w+proj$/i.test(x.path));
  p.slnCpp = p.slnProjects.some((x) => /\.vcxproj$/i.test(x.path));
  const sec = (text.match(/GlobalSection\(SolutionConfigurationPlatforms\)[^\n]*\n([\s\S]*?)EndGlobalSection/) || [])[1] || '';
  p.slnConfigs = [...sec.matchAll(/^\s*([^=\n]+?)\s*=/gm)].map((m) => m[1].trim()).filter(Boolean);
  p.slnVs = (text.match(/^# Visual Studio Version (\d+)/m) || text.match(/^VisualStudioVersion\s*=\s*(\d+)/m) || [])[1] || '';
}

// Visual Studio's year, by its major version
const VS_YEARS = { 15: '2017', 16: '2019', 17: '2022', 18: '2026' };
const vsYear = (v) => VS_YEARS[String(v.version || '').split('.')[0]] || String(v.version || '').split('.')[0];
// the Visual Studio a project was made with: the compiler its trees were configured with (those
// given first), else their generator's, its solution's version, else the newest
function vsFor(tc, proj, trees = proj.trees || []) {
  const vs = [...(tc?.vs || [])].sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }));
  const norm = (x) => String(x || '').replace(/\\/g, '/').toLowerCase();
  const all = [...trees, ...(proj.trees || []).filter((t) => !trees.includes(t))];
  for (const t of all) {
    const hit = vs.find((v) => v.path && norm(t.cxx).startsWith(`${norm(v.path)}/`));
    if (hit) return hit;
  }
  for (const t of all) {
    const gen = (t.generator.match(/Visual Studio (\d+)/) || [])[1];
    const byGen = gen && vs.find((v) => String(v.version).startsWith(`${gen}.`));
    if (byGen) return byGen;
  }
  if (proj.slnVs) { const hit = vs.find((v) => String(v.version).startsWith(`${proj.slnVs}.`)); if (hit) return hit; }
  return vs[0] || null;
}
// the vcvars script an environment names: msvc_x64_x64, msvc_x86, msvc_arm64…
function vcvarsFor(v, envs = []) {
  const env = [].concat(envs).join(' ');
  const script = /x86(?!_x64)|win32/i.test(env) ? 'vcvars32.bat' : /arm64/i.test(env) ? 'vcvarsamd64_arm64.bat' : 'vcvars64.bat';
  return String(v.vcvars || '').replace(/vcvars64\.bat$/i, script);
}

// the project builds and the status bar talk of; its build settings read once it's known
const projDir = () => (I.projDir && under(I.projDir, I.st.root) ? I.projDir : I.st.root);
const bkey = (dir = projDir()) => (dir === I.st.root ? wsKey() : `${wsKey()}\n${dir}`);
async function useProject(dir) {
  if (I.projDir === dir) return;
  I.projDir = dir;
  if (!I.st.build[bkey(dir)]) await loadBuildConfig(dir);
  if (!I) return;
  paintStatus();
  paintRunView();
}
// the open file moved to another tab: maybe another project
const refreshProjectSoon = debounce(() => {
  if (!I) return;
  const state = I;
  const pending = refreshRunContext();
  const generation = state.runGeneration;
  pending.catch((err) => {
    if (I !== state || state.runGeneration !== generation) return;
    state.runContext = { tabId: state.active?.id, workspace: wsKey(), project: !!state.projHas, error: err.message };
    paintTabActions(); paintRunView();
  });
}, 150);

const KIND_NAMES = { cmake: 'CMake', dotnet: '.NET', msbuild: 'MSBuild C++', cargo: 'Cargo', go: 'Go', npm: 'npm', make: 'Make', meson: 'Meson', python: 'Python' };

// every way a host can build the project, each a toolchain choice
function buildChoices(host, tc, proj) {
  const out = [];
  const add = (id, label, detail, extra = {}) => out.push({ id, host, label, detail, ...extra });
  const vs = tc?.vs || [];
  const cc = (id) => tool(tc, id);
  const vsBest = vsFor(tc, proj);
  // CMakeSettings' own trees say which Visual Studio configured them
  const vsCm = vsFor(tc, proj, (proj.trees || []).filter((t) => proj.cmakeSettings?.some((x) => samePath(cmakeRoot(x), t.dir))));
  for (const k of proj.kinds) {
    if (k === 'cmake' && proj.cmakeSettings?.length && vsCm) {
      add('cmake-vs', `Visual Studio ${vsYear(vsCm)} · CMake`, `${vsCm.name}, CMakeSettings.json: ${proj.cmakeSettings.map((x) => x.name).join(', ')}`, { vcvars: vsCm.vcvars, vs: vsCm.name, cmake: vsCm.cmake || '', rank: 1 });
    }
    if (k === 'cmake' && proj.presets?.length && (cc('cmake') || vsBest)) {
      add('cmake-preset', 'CMake Presets', proj.presets.map((x) => x.name).join(', '), { vcvars: tc.vs?.length ? vsBest?.vcvars || '' : '', rank: 2 });
    }
    if (k === 'cmake') {
      for (const t of proj.trees || []) {
        if (proj.cmakeSettings?.some((x) => samePath(cmakeRoot(x), t.dir)) || proj.presets?.some((x) => samePath(x.binaryDir, t.dir))) continue;
        const msvc = /cl\.exe$/i.test(t.cxx) || /Visual Studio/.test(t.generator);
        if (!cc('cmake') && !(msvc && vsBest)) continue;
        add('cmake-tree', `CMake · ${t.dir}`, `${t.generator}${t.type ? `, ${t.type}` : ''}, as it was configured`, { dir: t.dir, generator: t.generator, vcvars: msvc && /Ninja|NMake/.test(t.generator) ? vsBest?.vcvars || '' : '', rank: 3 });
      }
    }
    if (k === 'cmake' && cc('cmake')) {
      for (const v of vs) add('cmake-msvc', `CMake · MSVC ${v.msvc[0] || ''}`.trim(), `${v.name}, its own generator`, { vcvars: v.vcvars, vs: v.name });
      const ninja = !!cc('ninja');
      if (cc('gcc') || cc('g++')) add('cmake-gcc', `CMake · GCC ${cc('g++')?.version || cc('gcc')?.version || ''}`.trim(), ninja ? 'Ninja' : 'Makefiles', { ninja });
      if (cc('clang') || cc('clang++')) add('cmake-clang', `CMake · Clang ${cc('clang++')?.version || cc('clang')?.version || ''}`.trim(), ninja ? 'Ninja' : 'Makefiles', { ninja });
    }
    if (k === 'dotnet' && cc('dotnet')) {
      const pinned = proj.sdk && !(tc.dotnet || []).some((x) => x === proj.sdk || x.startsWith(proj.sdk.replace(/\.\d+$/, '.')));
      add('dotnet', `.NET ${proj.sdk || tc.dotnet?.at(-1) || cc('dotnet').version}`, pinned ? `global.json wants SDK ${proj.sdk}, not installed (${(tc.dotnet || []).join(', ')})` : tc.dotnet?.length ? `SDKs ${tc.dotnet.join(', ')}` : '', { rank: 1 });
    }
    if (k === 'msbuild') for (const v of vs) add('msbuild', `Visual Studio ${vsYear(v)} · MSBuild`, `${v.name}, MSVC ${v.msvc[0] || ''}`, { vcvars: v.vcvars, vs: v.name, rank: v === vsBest ? 1 : 4 });
    if (k === 'cargo' && cc('cargo')) add('cargo', `Cargo ${cc('cargo').version}`, cc('rustc') ? `rustc ${cc('rustc').version}` : '');
    if (k === 'go' && cc('go')) add('go', `Go ${cc('go').version}`, '');
    if (k === 'npm' && cc('npm')) add('npm', `npm ${cc('npm').version}`, cc('node') ? `Node ${cc('node').version}` : '');
    if (k === 'make' && cc('make')) add('make', `Make ${cc('make').version}`, cc('gcc') ? `GCC ${cc('gcc').version}` : cc('clang') ? `Clang ${cc('clang').version}` : '');
    if (k === 'meson' && cc('meson')) add('meson', `Meson ${cc('meson').version}`, cc('ninja') ? 'Ninja' : '');
    if (k === 'python' && cc('python')) add('python', `Python ${cc('python').version}`, '');
  }
  return out;
}

// a source file with no project round it, built alone by its machine's own
// compiler, its output beside it, as VS Code's Build Active File: {f} the file, {o} the output
const SINGLE_BUILDS = {
  c: [['gcc', 'GCC', 'gcc -g -Wall "{f}" -o "{o}"'], ['clang', 'Clang', 'clang -g -Wall "{f}" -o "{o}"'], ['msvc', 'MSVC', 'cl /nologo /W3 /Zi "{f}" /Fe:"{o}"']],
  cpp: [['g++', 'G++', 'g++ -g -Wall -std=c++20 "{f}" -o "{o}"'], ['clang++', 'Clang++', 'clang++ -g -Wall -std=c++20 "{f}" -o "{o}"'], ['msvc', 'MSVC', 'cl /nologo /W3 /Zi /EHsc /std:c++20 "{f}" /Fe:"{o}"']],
  rs: [['rustc', 'Rust', 'rustc -g "{f}" -o "{o}"']],
  go: [['go', 'Go', 'go build -o "{o}" "{f}"']],
  zig: [['zig', 'Zig', 'zig build-exe "{f}" -femit-bin="{o}"']],
  cs: [['dotnet', '.NET', 'dotnet build "{f}" --artifacts-path .']],
  java: [['javac', 'Java', 'javac -d . "{f}"']],
  swift: [['swift', 'Swift', 'swiftc "{f}" -o "{o}"']],
};
SINGLE_BUILDS.cc = SINGLE_BUILDS.cxx = SINGLE_BUILDS.cpp;
const singleBuilds = (rel) => (rel ? SINGLE_BUILDS[extOf(rel)] || null : null);

async function buildFile(asked = false) {
  const t = I.active;
  const rel = t?.rel;
  const kinds = singleBuilds(rel);
  if (!kinds) return;
  if (!(await saveAll()).every(Boolean) || !I) return;
  const live = dkLiveHosts();
  const held = isHomeLoc() ? await holdersOf(rel) : [locOf().host];
  if (!I) return;
  const hosts = live.filter((h) => held.includes(h)).sort((a, b) => (b === runHost()) - (a === runHost()) || (b === selfHost) - (a === selfHost));
  if (!hosts.length) { notify('warning', `Log into a machine that has ${baseName(rel)} to build it, ${loginWhere()}.`); return; }
  const key = `${wsKey()}\n.${extOf(rel)}`;
  I.st.fileBuild ||= {};
  const kept = I.st.fileBuild[key];
  const note = notify('info', `Looking at ${hosts.join(', ')} for a compiler…`, { progress: true, sticky: true });
  const got = await Promise.all(hosts.map((h) => toolchains(h).then((tc) => ({ h, tc }), (err) => ({ h, err: err.message }))));
  note.close();
  if (!I) return;
  const choices = [];
  for (const { h, tc } of got) {
    if (!tc) continue;
    for (const [id, label, cmd] of kinds) {
      const vs = id === 'msvc' ? (tc.vs || [])[0] : null;
      const tl = id === 'msvc' ? null : tool(tc, id);
      if (id === 'msvc' ? !vs : !tl) continue;
      choices.push({ host: h, id, cmd, vcvars: vs?.vcvars || '', label: `${label} ${vs ? vs.msvc[0] || '' : tl.version}`.trim(), detail: vs ? vs.name : tl.path });
    }
  }
  if (!choices.length) {
    const why = got.find((x) => x.err)?.err;
    notify('warning', `No compiler for .${extOf(rel)} files on ${hosts.join(', ')}${why ? ` (${why})` : ''}. Install one there, or add a build file.`);
    return;
  }
  let c = !asked && kept && choices.find((x) => x.host === kept.host && x.id === kept.id);
  if (!asked && !c && choices.length === 1) c = choices[0];
  if (!c) {
    const v = await pick(choices.map((x, i) => ({ label: x.label, description: x.detail, detail: `on ${x.host}${x.host === selfHost ? ' (this machine)' : ''}`, ic: 'host', value: i, sep: i === 0 || choices[i - 1].host !== x.host ? x.host : '' })),
      { title: `Build ${baseName(rel)}: pick a compiler`, placeholder: 'Build the file alone in a writable temporary folder', matchDescription: true });
    if (v === undefined || !I) return;
    c = choices[v];
  }
  I.st.fileBuild[key] = { host: c.host, id: c.id };
  saveState();
  const win = hostIsWindows(c.host);
  const stem = baseName(rel).replace(/\.[^.]+$/, '') || 'a.out';
  const fl = fileLoc(rel, c.host);
  const dir = filesParent(rel);
  const abs = hostPath(c.host, fl.share, dir);
  if (!abs) { notify('error', `Can't tell where ${dir} is on ${c.host}.`); return; }
  const source = hostPath(c.host, fl.share, rel);
  const command = singleFileCommand(c.cmd, source, win ? `${stem}.exe` : stem, win, newSid());
  if (asked && choices.length > 1) setStatusFlash(`No build file here: building ${baseName(rel)} alone with ${c.label} on ${c.host}`);
  runTask({ host: c.host, abs, command, vcvars: c.vcvars, name: `Build ${baseName(rel)} · ${c.host}`, kind: 'task', problems: true, root: dir, label: `Build ${baseName(rel)}`, onDone: () => I && loadDir(dir, true) });
}

// the project's build pick: kept in its own .sulfur/build.json, this browser's copy first
function buildCfg() { return I.st.build[bkey()] || null; }
async function loadBuildConfig(dir = projDir()) {
  const key = bkey(dir);
  const text = await readAt(`${dir}/${BUILD_FILE}`).catch(() => null);
  if (!I || bkey(dir) !== key) return;
  if (text) {
    try {
      const j = parseJsonc(text);
      if (j && typeof j === 'object') {
        const old = I.st.build[key];
        const next = { ...old, ...j };
        if (old && JSON.stringify(old) !== JSON.stringify(next)) languages.reset();
        I.st.build[key] = next;
      }
    } catch (err) { notify('warning', `${BUILD_FILE}: ${err.message}`); }
  }
  I.runContext = { tabId: I.active?.id, workspace: wsKey(), pending: true };
  paintStatus();
  paintRunView();
  refreshProjectSoon();
}
async function saveBuildCfg(cfg) {
  languages.reset();
  const dir = projDir();
  const key = bkey(dir);
  I.st.build[key] = cfg;
  I.runContext = { tabId: I.active?.id, workspace: wsKey(), pending: true };
  saveState();
  paintStatus();
  paintRunView();
  refreshProjectSoon();
  const keep = { host: cfg.host, toolchain: cfg.toolchain, configuration: cfg.configuration || 'Debug', defaultTask: cfg.defaultTask || 'build', tasks: cfg.tasks || [], ...(cfg.startup ? { startup: cfg.startup } : {}) };
  try { await writeAt(`${dir}/${BUILD_FILE}`, `${JSON.stringify(keep, null, 2)}\n`); } catch (err) { notify('warning', `Couldn't keep the pick in ${BUILD_FILE}: ${err.message}`); }
}

// the hosts the project can build on: a share's host alone, the home's holders
async function buildHosts() {
  const live = dkLiveHosts();
  if (!isHomeLoc()) return live.includes(locOf().host) ? [locOf().host] : [];
  const hs = await holdersOf(projDir());
  const held = hs.length ? hs : homeOnline();
  return live.filter((h) => held.includes(h)).sort((a, b) => (b === selfHost) - (a === selfHost) || a.localeCompare(b));
}

// the toolchain to build with, asked for: every host's that suits the project
async function pickToolchain(known = null, ask = false) {
  const proj = known || await detectProject();
  if (!I || !proj) return null;
  if (!proj.kinds.length) {
    if (singleBuilds(I.active?.rel)) { buildFile(true); return null; }
    notify('info', `Nothing here to build: no build file (CMakeLists.txt, a .sln or .csproj, Cargo.toml, go.mod, package.json, a Makefile) in ${baseName(I.active?.rel ? filesParent(I.active.rel) : I.st.root)} or above it, and ${I.active?.rel ? `.${extOf(I.active.rel)} files have no compiler to build them alone` : 'no file open to build alone'}.`, { actions: [{ label: 'Add a Task…', run: () => run('sulfur.task.add') }] });
    return null;
  }
  const hosts = await buildHosts();
  if (!hosts.length) {
    notify('warning', isHomeLoc() ? 'Log into a host that holds this project to build it.' : `Log into ${locOf().host} to build there.`);
    return null;
  }
  const note = notify('info', `Looking at ${hosts.join(', ')} for toolchains…`, { progress: true, sticky: true });
  const got = await Promise.all(hosts.map((h) => toolchains(h).then((tc) => ({ h, tc }), (err) => ({ h, err: err.message }))));
  note.close();
  if (!I) return null;
  const items = [];
  for (const { h, tc, err } of got) {
    if (err) { items.push({ label: `${h}: couldn\u2019t look`, description: err, ic: 'warning', value: null, sep: h }); continue; }
    const cs = buildChoices(h, tc, proj);
    cs.forEach((c, i) => items.push({ label: c.label, description: c.detail, detail: `on ${h}${h === selfHost ? ' (this machine)' : ''}`, ic: 'host', value: c, sep: i === 0 ? h : '' }));
    if (!cs.length) items.push({ label: `${h} has nothing for ${proj.kinds.map((k) => KIND_NAMES[k]).join(', ')}`, description: `it has ${(tc.tools || []).map((x) => x.name).join(', ') || 'no tools found'}`, ic: 'info', value: null, sep: h });
  }
  if (singleBuilds(I.active?.rel)) items.push({ label: `Build ${baseName(I.active.rel)} Alone…`, description: 'with its machine’s own compiler, the build file left aside', ic: 'gear', value: 'alone', sep: 'more' });
  // the project says how it builds (CMakeSettings, presets, a configured tree, a solution): no question
  const own = got.filter((x) => x.tc).flatMap(({ h, tc }) => buildChoices(h, tc, proj)).filter((c) => (c.rank || 9) <= 3).sort((a, b) => (a.rank || 9) - (b.rank || 9) || (b.host === runHost()) - (a.host === runHost()));
  if (!ask && own.length) {
    const v = own[0];
    const cfg = { host: v.host, toolchain: v, configuration: configsFor({ toolchain: v }, proj)[0] || 'Debug', defaultTask: 'build', tasks: buildCfg()?.tasks || [] };
    await saveBuildCfg(cfg);
    setStatusFlash(`Building ${baseName(projDir())} with ${v.label} (${cfg.configuration}) on ${v.host}, as the project says: Run › Select Toolchain… for another`);
    return cfg;
  }
  if (!isHomeLoc()) items.push({ label: 'Build on another machine…', description: 'copies the project there first', ic: 'remote', value: 'move', sep: singleBuilds(I.active?.rel) ? '' : 'more' });
  const v = await pick(items.map((x) => ({ ...x, value: x.value === null ? '__none' : x.value })), { title: `Build ${baseName(projDir())}: pick a toolchain`, placeholder: 'A compiler on one of your machines', matchDescription: true });
  if (!I || v === undefined || v === '__none') return null;
  if (v === 'move') { run('sulfur.project.transfer'); return null; }
  if (v === 'alone') { buildFile(true); return null; }
  const cfg = { host: v.host, toolchain: v, configuration: configsFor({ toolchain: v }, proj)[0] || 'Debug', defaultTask: 'build', tasks: buildCfg()?.tasks || [] };
  await saveBuildCfg(cfg);
  setStatusFlash(`Building ${baseName(projDir())} with ${v.label} on ${v.host}`);
  return cfg;
}

// the tasks a pick gives: build first, then the rest, the project's own after
function tasksFor(cfg, proj) {
  const c = cfg.configuration || 'Debug';
  const tc = cfg.toolchain || {};
  const out = [];
  const add = (id, label, command, group = 'build', extra = {}) => out.push({ id, label, command, group, vcvars: tc.vcvars || '', ...extra });
  const q = (s) => (/[\s"']/.test(s) ? `"${s}"` : s);
  switch (tc.id) {
    case 'cmake-vs': {
      const sc = (proj.cmakeSettings || []).find((x) => x.name === c) || (proj.cmakeSettings || [])[0];
      if (!sc) break;
      const root = cmakeRoot(sc);
      const configured = (proj.trees || []).some((t) => samePath(t.dir, root));
      const exp = (v) => String(v || '').replaceAll('${projectDir}', '.').replaceAll('${name}', sc.name);
      const vars = (sc.variables || []).map((v) => ` -D${v.name}${v.type ? `:${v.type}` : ''}=${q(String(v.value))}`).join('');
      const conf = `cmake -S . -B ${q(root)} -G ${q(sc.generator || 'Ninja')} -DCMAKE_BUILD_TYPE=${sc.configurationType || 'Debug'}${sc.installRoot ? ` -DCMAKE_INSTALL_PREFIX=${q(exp(sc.installRoot))}` : ''}${vars}${sc.cmakeCommandArgs ? ` ${sc.cmakeCommandArgs}` : ''}`;
      const bargs = sc.buildCommandArgs ? ` -- ${sc.buildCommandArgs}` : '';
      const vc = vcvarsFor({ vcvars: tc.vcvars }, sc.inheritEnvironments);
      // Visual Studio's own CMake, as it configures the project with, not whichever's first on the PATH
      const cm = tc.cmake ? q(tc.cmake) : 'cmake';
      const ct = tc.cmake ? q(tc.cmake.replace(/cmake(\.exe)?$/i, 'ctest$1')) : 'ctest';
      const confCmd = conf.replace(/^cmake /, `${cm} `);
      add('build', `Build (${sc.name})`, `${configured ? '' : `${confCmd} && `}${cm} --build ${q(root)}${bargs}`, 'build', { vcvars: vc });
      add('configure', 'Configure (Generate Cache)', confCmd, 'other', { vcvars: vc });
      add('rebuild', `Rebuild (${sc.name})`, `${configured ? '' : `${confCmd} && `}${cm} --build ${q(root)} --clean-first${bargs}`, 'build', { vcvars: vc });
      add('test', 'Test (CTest)', `${ct} --test-dir ${q(root)} --output-on-failure`, 'test', { vcvars: vc });
      add('install', 'Install', `${cm} --install ${q(root)}`, 'other', { vcvars: vc });
      add('clean', 'Clean', `${cm} --build ${q(root)} --target clean`, 'other', { vcvars: vc });
      out.buildRoot = root;
      break;
    }
    case 'cmake-preset': {
      const pr = (proj.presets || []).find((x) => x.name === c) || (proj.presets || [])[0];
      if (!pr) break;
      const bp = (proj.buildPresets || []).find((x) => x.configurePreset === pr.name);
      const root = pr.binaryDir || `build/${pr.name}`;
      const configured = (proj.trees || []).some((t) => samePath(t.dir, root));
      const conf = `cmake --preset ${q(pr.name)}`;
      const build = bp ? `cmake --build --preset ${q(bp.name)}` : `cmake --build ${q(root)}`;
      add('build', `Build (${pr.displayName})`, `${configured ? '' : `${conf} && `}${build}`);
      add('configure', 'Configure', conf, 'other');
      add('rebuild', `Rebuild (${pr.displayName})`, `${configured ? '' : `${conf} && `}${build} --clean-first`);
      add('test', 'Test (CTest)', `ctest --test-dir ${q(root)} --output-on-failure`, 'test');
      add('clean', 'Clean', `cmake --build ${q(root)} --target clean`, 'other');
      out.buildRoot = root;
      break;
    }
    case 'cmake-tree': {
      const multi = /Visual Studio|Multi-Config|Xcode/.test(tc.generator || '');
      const cf = multi ? ` --config ${c}` : '';
      const configure = !multi ? `cmake -S . -B ${q(tc.dir)} -DCMAKE_BUILD_TYPE=${q(c)} && ` : '';
      add('build', `Build (${tc.dir}, ${c})`, `${configure}cmake --build ${q(tc.dir)}${cf}`);
      add('rebuild', 'Rebuild', `${configure}cmake --build ${q(tc.dir)}${cf} --clean-first`);
      add('configure', 'Configure Again', `cmake ${q(tc.dir)}`, 'other');
      add('test', 'Test (CTest)', `ctest --test-dir ${q(tc.dir)}${multi ? ` -C ${c}` : ''} --output-on-failure`, 'test');
      add('clean', 'Clean', `cmake --build ${q(tc.dir)}${cf} --target clean`, 'other');
      out.buildRoot = tc.dir;
      break;
    }
    case 'cmake-msvc': {
      const b = 'build/msvc';
      add('build', `Build (${c})`, `cmake -S . -B ${b} && cmake --build ${b} --config ${c}`);
      add('configure', 'Configure', `cmake -S . -B ${b}`);
      add('rebuild', `Rebuild (${c})`, `cmake -S . -B ${b} && cmake --build ${b} --config ${c} --clean-first`);
      add('test', 'Test (CTest)', `ctest --test-dir ${b} -C ${c} --output-on-failure`, 'test');
      add('clean', 'Clean', `cmake --build ${b} --config ${c} --target clean`, 'other');
      break;
    }
    case 'cmake-gcc': case 'cmake-clang': {
      const b = `build/${tc.id.slice(6)}-${c.toLowerCase()}`;
      const ccs = tc.id === 'cmake-gcc' ? '-DCMAKE_C_COMPILER=gcc -DCMAKE_CXX_COMPILER=g++' : '-DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++';
      const conf = `cmake -S . -B ${b}${tc.ninja ? ' -G Ninja' : ''} -DCMAKE_BUILD_TYPE=${c} -DCMAKE_EXPORT_COMPILE_COMMANDS=ON ${ccs}`;
      add('build', `Build (${c})`, `${conf} && cmake --build ${b} -j`);
      add('configure', 'Configure', conf);
      add('rebuild', `Rebuild (${c})`, `${conf} && cmake --build ${b} -j --clean-first`);
      add('test', 'Test (CTest)', `ctest --test-dir ${b} --output-on-failure`, 'test');
      add('clean', 'Clean', `cmake --build ${b} --target clean`, 'other');
      out.buildRoot = b;
      break;
    }
    case 'dotnet': {
      const target = proj.sln[0] || proj.proj[0] || '';
      const t = target ? ` ${q(target)}` : '';
      const [cn, plat] = c.split('|');
      const pf = plat && plat.trim() !== 'Any CPU' ? ` -p:Platform=${q(plat.trim())}` : '';
      add('build', `Build (${c})`, `dotnet build${t} -c ${cn}${pf}`);
      add('rebuild', `Rebuild (${c})`, `dotnet build${t} -c ${cn}${pf} --no-incremental`);
      add('test', 'Test', `dotnet test${t} -c ${cn}${pf}`, 'test');
      add('publish', 'Publish (Release)', `dotnet publish${t} -c Release`, 'other');
      add('clean', 'Clean', `dotnet clean${t} -c ${cn}${pf}`, 'other');
      break;
    }
    case 'msbuild': {
      const target = proj.sln[0] || proj.vcx[0];
      const [cn, plat = 'x64'] = c.includes('|') ? c.split('|') : [c, 'x64'];
      const props = `/p:Configuration=${q(cn.trim())} ${q(`/p:Platform=${plat.trim()}`)}`;
      add('build', `Build (${cn.trim()}|${plat.trim()})`, `msbuild ${q(target)} /m /nologo ${props}`);
      add('rebuild', `Rebuild (${cn.trim()}|${plat.trim()})`, `msbuild ${q(target)} /m /nologo /t:Rebuild ${props}`);
      add('clean', 'Clean', `msbuild ${q(target)} /m /nologo /t:Clean ${props}`, 'other');
      break;
    }
    case 'cargo': {
      const r = c === 'Release' ? ' --release' : '';
      add('build', `Build (${c})`, `cargo build${r}`);
      add('run', 'Run', `cargo run${r}`, 'run');
      add('test', 'Test', `cargo test${r}`, 'test');
      add('check', 'Check', 'cargo check', 'other');
      add('clean', 'Clean', 'cargo clean', 'other');
      break;
    }
    case 'go':
      add('build', 'Build', 'go build ./...');
      add('run', 'Run', 'go run .', 'run');
      add('test', 'Test', 'go test ./...', 'test');
      add('vet', 'Vet', 'go vet ./...', 'other');
      break;
    case 'npm':
      add('install', 'Install', 'npm install', 'other');
      if (proj.scripts.includes('build')) add('build', 'Build (npm run build)', 'npm run build');
      for (const sc of proj.scripts.filter((x) => x !== 'build')) add(`npm:${sc}`, `npm run ${sc}`, `npm run ${sc}`, sc === 'test' ? 'test' : sc === 'start' || sc === 'dev' ? 'run' : 'other');
      break;
    case 'make':
      add('build', 'Build (make)', 'make -j');
      for (const t of proj.targets.filter((x) => x !== 'all')) add(`make:${t}`, `make ${t}`, `make ${t}`, t === 'test' || t === 'check' ? 'test' : t === 'clean' ? 'other' : 'build');
      break;
    case 'meson':
      add('build', 'Build', 'meson setup build --reconfigure >/dev/null 2>&1 || meson setup build; meson compile -C build');
      add('test', 'Test', 'meson test -C build', 'test');
      break;
    case 'python':
      add('build', 'Install (pip, editable)', 'python -m pip install -e .');
      add('test', 'Test (pytest)', 'python -m pytest', 'test');
      break;
    default:
  }
  for (const t of cfg.tasks || []) if (t && t.label && t.command) out.push({ id: `user:${t.label}`, label: t.label, command: t.command, group: t.group || 'other', vcvars: tc.vcvars || '', user: true });
  return out;
}

// Ctrl+B: the project's build, a toolchain asked for the first time
async function buildProject(taskId) {
  const proj = await detectProject();
  if (!I || !proj) return;
  // no build file: the open file built alone, as VS Code's Build Active File
  if (!proj.kinds.length) { await pickToolchain(proj); return; }
  let cfg = buildCfg();
  if (!cfg?.toolchain?.id || !dkLiveHosts().includes(cfg.host)) cfg = await pickToolchain(proj);
  if (!cfg || !I) return;
  const tasks = tasksFor(cfg, proj);
  const want = taskId || cfg.defaultTask || 'build';
  const t = tasks.find((x) => x.id === want) || tasks.find((x) => x.group === 'build');
  if (!t) { notify('warning', `${cfg.toolchain.label} has no build task for this project.`); return; }
  await runProjectTask(cfg, t);
}

async function runProjectTask(cfg, t) {
  const state = I;
  const dir = projDir();
  const workspace = wsKey();
  if (!(await saveAll()).every(Boolean) || I !== state || wsKey() !== workspace || projDir() !== dir) return;
  if (cfg.toolchain?.id?.startsWith('cmake-') && ['build', 'rebuild', 'configure'].includes(t.id)) {
    const project = await projectAt(dir);
    const model = await cmakeModel(cfg, project);
    if (I !== state || wsKey() !== workspace) return;
    const root = tasksFor(cfg, project).buildRoot || 'build';
    const where = buildFileLocation(cfg.host, joinPath(dir, `${root}/.cmake/api/v1/query/client-sulfur/codemodel-v2`));
    await filesCall(where.at, 'save', jsonPost({ path: where.path, text: '' }));
    if (!model.available && t.id !== 'configure' && !t.command.includes(' -S ') && !/^(?:"[^"]+"|\S+) --preset /.test(t.command)) {
      const q = hostIsWindows(cfg.host) ? (s) => `"${s}"` : shQuote;
      const cm = cfg.toolchain.cmake ? q(cfg.toolchain.cmake) : 'cmake';
      const configure = cfg.toolchain.id === 'cmake-preset' ? `${cm} --preset ${q(cfg.configuration)}` : `${cm} -S . -B ${q(root)}`;
      t = { ...t, command: `${configure} && ${t.command}` };
    }
  }
  if (I !== state || wsKey() !== workspace) return;
  const abs = hostPath(cfg.host, isHomeLoc() ? 'home' : locOf().share, dir);
  if (!abs) { notify('error', `Can't tell where ${dir} is on ${cfg.host}.`); return; }
  runTask({ host: cfg.host, abs, command: t.command, vcvars: t.vcvars, name: `${t.label} · ${cfg.host}`, kind: 'task', problems: true, root: dir, label: t.label, onDone: () => { if (I === state) { state.targetModels?.clear(); loadDir(dir, true); refreshProjectSoon(); } } });
}

async function chooseTask() {
  const cfg = buildCfg() || await pickToolchain();
  if (!cfg || !I) return;
  const proj = await detectProject();
  if (!I) return;
  const tasks = tasksFor(cfg, proj);
  const v = await pick([
    ...tasks.map((t, i) => ({ label: t.label, description: t.command, detail: t.user ? 'yours' : '', ic: t.group === 'test' ? 'check' : t.group === 'run' ? 'run' : 'gear', value: t, sep: i === 0 ? `${cfg.toolchain.label} on ${cfg.host}` : '' })),
    { label: 'Add a Task…', ic: 'plus', value: 'add', sep: 'more' },
    { label: 'Pick Another Toolchain…', ic: 'host', value: 'pick' },
  ], { title: 'Run Task', placeholder: 'Select the task to run', matchDescription: true });
  if (!I || v === undefined) return;
  if (v === 'add') { addTask(); return; }
  if (v === 'pick') { await pickToolchain(null, true); return; }
  runProjectTask(cfg, v);
}

async function addTask() {
  const cfg = buildCfg() || await pickToolchain();
  if (!cfg || !I) return;
  const label = await inputBox({ prompt: 'Name the task', placeholder: 'e.g. Package' });
  if (!label?.trim() || !I) return;
  const command = await inputBox({ prompt: `The command, run in the project's folder on ${cfg.host}`, placeholder: hostIsWindows(cfg.host) ? 'e.g. msbuild app.sln /t:Pack' : 'e.g. ./scripts/package.sh' });
  if (!command?.trim() || !I) return;
  await saveBuildCfg({ ...cfg, tasks: [...(cfg.tasks || []).filter((t) => t.label !== label.trim()), { label: label.trim(), command: command.trim(), group: 'other' }] });
  setStatusFlash(`Added ${label.trim()} to ${BUILD_FILE}`);
}

async function toggleConfiguration() {
  const cfg = buildCfg();
  if (!cfg) { await pickToolchain(); return; }
  const proj = await detectProject();
  if (!I || !proj) return;
  const v = await pick(configsFor(cfg, proj).map((c) => ({ label: c, description: configDetail(cfg, proj, c), value: c, ic: c === cfg.configuration ? 'check' : '' })), { title: 'Build Configuration', placeholder: 'As the project names them', matchDescription: true });
  // a startup program built by another configuration is that one's: asked for again
  if (v && I) await saveBuildCfg({ ...cfg, configuration: v, startup: v !== cfg.configuration && cfg.startup?.build && !cfg.startup.target ? undefined : cfg.startup });
}

function activeRunContext() {
  const context = I?.runContext;
  return context?.tabId === I?.active?.id && context.workspace === wsKey() ? context : null;
}

async function refreshRunContext() {
  const state = I;
  if (!state) return null;
  const tab = state.active;
  const workspace = wsKey();
  const generation = state.runGeneration = (state.runGeneration || 0) + 1;
  const current = () => I === state && state.active === tab && wsKey() === workspace && state.runGeneration === generation;
  state.runContext = { tabId: tab?.id, workspace, pending: true };
  paintTabActions(); paintRunView();
  const project = await detectProject();
  if (!current()) return null;
  const cfg = buildCfg();
  const context = { tabId: tab?.id, workspace, project: !!project?.kinds.length, cfg, item: null, items: [] };
  if (context.project && cfg?.toolchain) {
    const items = await startupItems(cfg, project);
    if (!current()) return null;
    context.items = items;
    if (items.targetModel && !items.length) context.targetMessage = `Configure/build ${cfg.configuration || 'Debug'} to discover its executable targets.`;
    context.item = cfg.startup?.custom ? cfg.startup : items.targetModel ? targetForFile(items.targetModel, tab?.rel ? hostPath(cfg.host, isHomeLoc(tab.loc) ? 'home' : tab.loc.share, tab.rel) : '', cfg.startup, baseName(project.dir), hostIsWindows(cfg.host)) : items.find((x) => x.label === cfg.startup?.label) || (items.length === 1 ? items[0] : null);
  }
  if (!current()) return null;
  state.runContext = context;
  paintTabActions(); paintRunView();
  return context;
}

async function runActiveContext() {
  const context = await refreshRunContext();
  if (!context || !I) return;
  if (context.project) return startProject(false, false);
  if (I.active?.rel) return runFile(I.active.rel);
  notify('info', 'Open a project or a file to run it.');
}

// Resolve paths on the build host, including out-of-source build directories.
function buildFileLocation(host, path, loc = locOf()) {
  if (!absolutePath(path)) return { at: isHomeLoc(loc) ? homeAt(host) : apiLoc(loc), path };
  const win = hostIsWindows(host);
  const norm = (s) => { const p = String(s).replace(/\\/g, '/').replace(/\/+$/, ''); return win ? p.toLowerCase() : p; };
  const absolute = norm(path);
  const shares = hostsInfo[String(host).toLowerCase()]?.files?.shares || [];
  const share = [...shares].sort((a, b) => b.label.length - a.label.length).find((s) => absolute === norm(s.label) || absolute.startsWith(norm(s.label) + '/'));
  if (!share) throw new Error(`Can't read build metadata at ${path} on ${host}`);
  return { at: { host, share: String(share.id) }, path: String(path).replace(/\\/g, '/').slice(norm(share.label).length).replace(/^\/+/, '') };
}

async function cmakeModel(cfg, project) {
  const state = I;
  const loc = locOf();
  const root = joinPath(project.dir, tasksFor(cfg, project).buildRoot || 'build');
  const configuration = cmakeConfiguration(cfg, project);
  const key = `${locKey(loc)}\n${cfg.host}\n${root}\n${configuration}`;
  state.targetModels ||= new Map();
  const cached = state.targetModels.get(key);
  if (cached && Date.now() - cached.at < 10000) return cached.promise;
  const read = async (path) => {
    const where = buildFileLocation(cfg.host, path, loc);
    const b = await filesCall(where.at, 'read', undefined, { path: where.path });
    if (typeof b.text !== 'string') throw new Error(`Couldn't read ${path}`);
    return b.text;
  };
  const list = async (path) => {
    const where = buildFileLocation(cfg.host, path, loc);
    return (await filesCall(where.at, 'list', undefined, { path: where.path })).entries || [];
  };
  const promise = cmakeTargets({ read, list, root, configuration, windows: hostIsWindows(cfg.host) }).catch((error) => ({ available: false, items: [], error: error.message }));
  state.targetModels.set(key, { at: Date.now(), promise });
  const model = await promise;
  for (const item of model.items) item.command = executableCommand(absolutePath(item.executable) ? item.executable : item.executable.slice(project.dir.length + 1), hostIsWindows(cfg.host));
  return model;
}

// Ctrl+F5: the project's startup item, built first where its toolchain doesn't build as it runs.
// The item's asked for once, kept in the project's build settings
async function startProject(choose = false, buildFirst = true) {
  const state = I;
  const tab = state.active;
  const workspace = wsKey();
  const current = () => I === state && state.active === tab && wsKey() === workspace;
  const proj = await detectProject();
  if (!current() || !proj) return;
  if (!proj.kinds.length) { if (I.active?.rel) runFile(I.active.rel); else notify('info', 'Open a project or a file to start it.'); return; }
  let cfg = buildCfg();
  if (!cfg?.toolchain?.id || !dkLiveHosts().includes(cfg.host)) cfg = await pickToolchain(proj);
  if (!cfg || !current()) return;
  const sameConfiguration = () => current() && buildCfg()?.configuration === cfg.configuration && buildCfg()?.host === cfg.host && buildCfg()?.toolchain?.id === cfg.toolchain.id;
  const items = await startupItems(cfg, proj);
  if (!sameConfiguration()) return;
  if (!choose && items.targetModel && !items.length && !cfg.startup?.custom) {
    notify('info', `Configure/build ${cfg.configuration || 'Debug'} first to discover its executable targets (Ctrl+B).`);
    return;
  }
  const context = activeRunContext();
  const activeTarget = items.targetModel ? targetForFile(items.targetModel, I.active?.rel ? hostPath(cfg.host, isHomeLoc(I.active.loc) ? 'home' : I.active.loc.share, I.active.rel) : '', cfg.startup, baseName(proj.dir), hostIsWindows(cfg.host)) : null;
  let item = !choose && (cfg.startup?.custom ? cfg.startup : activeTarget || (context?.cfg?.configuration === cfg.configuration && context?.cfg?.host === cfg.host ? context.item : null) || items.find((x) => cfg.startup?.target ? x.target === cfg.startup.target : x.label === cfg.startup?.label) || (items.length === 1 ? items[0] : null));
  if (!item) {
    const note = notify('info', 'Looking for what the project starts…', { progress: true, sticky: true });
    note.close();
    if (!current()) return;
    const win = hostIsWindows(cfg.host);
    const v = await pick([
      ...items.map((x, i) => ({ label: x.label, description: x.command, ic: 'run', value: x, sep: i === 0 ? `${cfg.toolchain.label} on ${cfg.host}` : '' })),
      { label: 'Another Command…', description: 'run in the project’s folder after the build', ic: 'terminal', value: 'other', sep: 'more' },
    ], { title: 'Select Startup Item', placeholder: items.length ? 'What Ctrl+F5 runs' : 'Nothing built to start yet: build first (Ctrl+B), or give the command', matchDescription: true });
    if (!current() || v === undefined) return;
    item = v;
    if (v === 'other') {
      const command = await inputBox({ prompt: `The command that starts the project, in its folder on ${cfg.host}`, placeholder: win ? 'e.g. out\\build\\x64-Debug\\app.exe' : 'e.g. ./build/app' });
      if (!command?.trim() || !current()) return;
      item = { label: command.trim(), command: command.trim(), build: true, custom: true };
    }
    if (!sameConfiguration()) return;
    cfg = { ...cfg, startup: item };
    await saveBuildCfg(cfg);
    if (choose) { setStatusFlash(`Ctrl+F5 starts ${item.label}`); return; }
  }
  if (!buildFirst && item.executable) {
    const where = buildFileLocation(cfg.host, item.executable);
    const entries = (await filesCall(where.at, 'list', undefined, { path: filesParent(where.path) })).entries || [];
    if (!current()) return;
    if (!entries.some((e) => !e.dir && (hostIsWindows(cfg.host) ? e.name.toLowerCase() === baseName(where.path).toLowerCase() : e.name === baseName(where.path)))) { notify('info', `${item.label} (${cfg.configuration}) hasn't been built. Build it with Ctrl+B first.`); return; }
  }
  if (!sameConfiguration()) return;
  const build = buildFirst && item.build ? tasksFor(cfg, proj).find((x) => x.id === 'build') : null;
  const command = build ? `${build.command} && ${item.command}` : item.command;
  await runProjectTask(cfg, { label: `Start ${item.label}`, command, vcvars: build?.vcvars || (cfg.toolchain.vcvars || '') });
}

// what a build can start: .NET's programs, Cargo's and Go's own, npm's start, else the programs in its build folder
async function startupItems(cfg, proj) {
  const tc = cfg.toolchain || {};
  const c = (cfg.configuration || 'Debug').split('|')[0].trim();
  const q = (x) => (/[\s"']/.test(x) ? `"${x}"` : x);
  const dir = projDir();
  if (tc.id?.startsWith('cmake-')) {
    const model = await cmakeModel(cfg, proj);
    const items = [...model.items];
    items.targetModel = model;
    return items;
  }
  switch (tc.id) {
    case 'dotnet': {
      const projs = [...proj.proj];
      for (const x of proj.slnProjects || []) if (/\.(cs|fs|vb)proj$/i.test(x.path) && !projs.includes(x.path)) projs.push(x.path);
      const out = [];
      for (const pr of projs) {
        const text = await readAt(`${dir}/${pr}`).catch(() => null);
        const kind = (String(text || '').match(/<OutputType>\s*(\w+)\s*<\/OutputType>/i) || [])[1] || '';
        const web = /Sdk="Microsoft\.NET\.Sdk\.(Web|BlazorWebAssembly|Worker)"/i.test(text || '');
        if (/^(Exe|WinExe)$/i.test(kind) || web) out.push({ label: baseName(pr).replace(/\.\w+proj$/i, ''), command: `dotnet run --project ${q(pr)} -c ${c}` });
      }
      return out;
    }
    case 'cargo': return [{ label: 'cargo run', command: `cargo run${/release/i.test(c) ? ' --release' : ''}` }];
    case 'go': return [{ label: 'go run .', command: 'go run .' }];
    case 'npm': return ['start', 'dev', 'serve', 'preview'].filter((x) => (proj.scripts || []).includes(x)).map((x) => ({ label: `npm run ${x}`, command: x === 'start' ? 'npm start' : `npm run ${x}` }));
    case 'python': return [];
  }
  // a native build's programs: what its build folder holds
  const root = tasksFor(cfg, proj).buildRoot || (tc.id === 'msbuild' ? '' : 'build');
  const win = hostIsWindows(cfg.host);
  const at = isHomeLoc() ? homeAt(cfg.host) : apiLoc();
  const base = root ? `${dir}/${root}` : dir;
  const b = await filesCall(at, 'tree', undefined, { path: base, depth: 6, match: win ? '*.exe' : '*', skip: 'CMakeFiles,.git,obj,_deps,vcpkg_installed,node_modules' }).catch(() => null);
  const progs = (b?.entries || []).map((e) => e.path).filter((x) => !x.endsWith('/') && (win ? /\.exe$/i.test(x) : !/\.[^/]+$/.test(baseName(x)) && !/^(Makefile|GNUmakefile)$/.test(baseName(x))))
    .filter((x) => !/(^|\/)(CompilerId|CMakeScratch|cmake-|test_|gtest)/i.test(x))
    .filter((x) => tc.id !== 'msbuild' || new RegExp(`/(x64|Win32|ARM64)?/?${c}/`, 'i').test(`/${x}`) || !/\/(Debug|Release)\//i.test(`/${x}`));
  const rel = (x) => (x.startsWith(`${dir}/`) ? x.slice(dir.length + 1) : x);
  return progs.slice(0, 40).map((x) => ({ label: baseName(x), command: win ? q(rel(x).replace(/\//g, '\\')) : `./${q(rel(x))}`, build: true }));
}

// what a configuration is: a CMakeSettings one's build type, generator and folder, a preset's
function configDetail(cfg, proj, c) {
  const tc = cfg.toolchain || {};
  if (tc.id === 'cmake-vs') {
    const sc = (proj.cmakeSettings || []).find((x) => x.name === c);
    if (!sc) return '';
    const root = cmakeRoot(sc);
    const there = (proj.trees || []).some((t) => samePath(t.dir, root));
    return [sc.configurationType || 'Debug', sc.generator || 'Ninja', root, there ? '' : 'not configured yet'].filter(Boolean).join(' · ');
  }
  if (tc.id === 'cmake-preset') {
    const pr = (proj.presets || []).find((x) => x.name === c);
    return pr ? [pr.displayName !== pr.name ? pr.displayName : '', pr.generator, pr.binaryDir].filter(Boolean).join(' · ') : '';
  }
  return '';
}

// the configurations a build has: its CMakeSettings', its presets, its solution's, else Debug and Release

// a task in the Terminal panel, a terminal of its own named for it; one of the
// same name that's done gives way to it
// a mesh home on a Linux or macOS machine handed to your own login there, once:
// Phosphorus writes homes as root, so without it a build there can't write its output
async function ensureHomeOwned(host) {
  const local = standalone?.localHost;
  if (!host || host === local || hostIsWindows(host)) return;
  const home = isHomeLoc() || String(locOf().share) === 'home';
  if (!home) return;
  const login = dk.creds.get(host)?.user;
  if (!login || login === 'root') return;
  const user = localDesktop() ? standalone.meshUser : acct.user;
  if (!user) return;
  I.owned ||= new Map();
  const owned = I.owned;
  const k = `${host}\n${login}\n${user}`;
  if (owned.has(k)) return owned.get(k);
  const pending = (async () => {
    try {
      const r = await fetch(filesApi(homeAt(host), 'own'), jsonPost({ path: user, login }));
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { owned.delete(k); if (r.status !== 404 && r.status !== 409) log(`couldn't hand the home on ${host} to ${login}: ${b.error || r.status}`); }
    } catch { owned.delete(k); }
  })();
  owned.set(k, pending);
  await pending;
}

// Start after ownership has settled, including remote home shares in the
// desktop's unified host list.
function runTask(o) {
  ensureHomeOwned(o.host).finally(() => { if (I) runTaskNow(o); });
}

function runTaskNow(o) {
  const host = o.host;
  if (!dk.creds.get(host)) { notify('warning', `Not logged into ${host}: log in ${loginWhere()}.`); return null; }
  for (const old of I.terms.filter((x) => x.base === o.name && x.kind !== 'shell' && x.ended)) killTerm(old);
  const tv = I.panelViews.get('terminal');
  const same = I.terms.filter((x) => x.base === o.name).length;
  const t = { id: `t${(I.termSeq += 1)}`, host, base: o.name, name: same ? `${o.name} (${same + 1})` : o.name, kind: o.kind || 'task', ended: false };
  t.view = el('div', 'ide-term-view');
  t.view.hidden = true;
  tv.views.append(t.view);
  const pm = o.problems ? problemMatcher(host, o.abs, o.root) : null;
  if (pm) clearBuildProblems();
  const started = Date.now();
  t.h = taskTerminal(t.view, host, { dir: o.abs, command: o.command, vcvars: o.vcvars || '', windows: hostIsWindows(host) }, {
    fontSize: setting('terminal.integrated.fontSize'), themeFrom: t.view, transparent: true,
    banner: `\x1b[2m> ${o.command}\r\n  ${host}: ${o.abs}${o.vcvars ? '  (Visual Studio\u2019s environment)' : ''}\x1b[0m\r\n\r\n`,
    onText: pm ? (s) => pm.feed(s) : null,
    onExit: (code) => {
      t.ended = true;
      pm?.end();
      o.onDone?.(code);
      paintTerms();
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (o.kind === 'task') {
        const errs = (I.buildProblems || []).filter((x) => x.sev === 'error').length;
        if (code === 0) setStatusFlash(`${o.label || 'Task'} done in ${secs}s${errs ? `, ${errs} errors` : ''}`);
        else notify(code === -1 ? 'warning' : 'error', `${o.label || 'Task'} on ${host} ${code === -1 ? 'stopped' : `failed (exit ${code})`}${errs ? `: ${errs} error${errs === 1 ? '' : 's'}` : ''}.`, errs ? { actions: [{ label: 'Show Problems', run: () => showPanel('problems', true, true) }] } : {});
      }
    },
  });
  I.terms.push(t);
  log(`${o.kind || 'task'} on ${host} in ${o.abs}: ${o.command}`);
  selectTerm(t, false);
  showPanel('terminal', true);
  return t;
}

// --- problems out of a task's output: MSVC, MSBuild and dotnet, GCC and Clang,
// Rust, Go, CMake; their paths brought back into the workspace

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;
const MATCHERS = [
  // C:\p\a.cpp(12,5): error C2065: 'x': undeclared identifier [C:\p\a.vcxproj]
  { re: /^\s*(.+?)\((\d+)(?:,(\d+))?(?:,\d+,\d+)?\)\s*:\s*(fatal error|error|warning)\s+([A-Z]+\d+)\s*:\s*(.*?)(?:\s+\[[^\]]+\])?\s*$/, f: 1, l: 2, c: 3, s: 4, code: 5, m: 6 },
  // src/a.c:12:5: error: expected ';' (gcc, clang, and go's file:line:col: msg)
  { re: /^(.+?\.[A-Za-z0-9+]+):(\d+):(\d+):\s*(fatal error|error|warning|note)?:?\s*(.*)$/, f: 1, l: 2, c: 3, s: 4, m: 5 },
  // CMake Error at CMakeLists.txt:12 (add_executable):
  { re: /^CMake (Error|Warning)(?: \(dev\))? at (.+?):(\d+)/, f: 2, l: 3, s: 1, m: 0 },
];

function problemMatcher(host, absRoot, root) {
  let buf = '';
  let rustSev = '';
  let rustMsg = '';
  let cmakeAt = null;
  const win = hostIsWindows(host);
  const norm = (p) => (win ? p.replace(/\//g, '\\').toLowerCase() : p);
  const base = norm(absRoot).replace(/[\\/]+$/, '');
  const sep = win ? '\\' : '/';
  // a path as the workspace names it, or null for one outside it
  const toRel = (p) => {
    let a = p.trim();
    if (!(win ? /^[A-Za-z]:[\\/]/.test(a) : a.startsWith('/'))) a = `${absRoot}${sep}${a}`;
    const n = norm(a);
    if (n !== base && !n.startsWith(base + sep)) return null;
    const rest = a.slice(base.length + 1).replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
    const out = [];
    for (const s of rest) { if (s === '..') out.pop(); else out.push(s); }
    return out.length ? `${root}/${out.join('/')}` : null;
  };
  const push = (x) => {
    if (!x.rel) return;
    const sev = /error/i.test(x.sev || '') ? 'error' : /warn/i.test(x.sev || '') ? 'warning' : x.sev === 'note' ? 'info' : 'error';
    const key = `${x.rel}:${x.line}:${x.col}:${x.msg}`;
    if (I.buildSeen.has(key)) return;
    I.buildSeen.add(key);
    I.buildProblems.push({ rel: x.rel, line: x.line, col: x.col || 1, sev, msg: x.msg, code: x.code || '', host });
    paintProblemsSoon();
  };
  const line = (raw) => {
    const s = raw.replace(ANSI_RE, '').replace(/\r$/, '');
    // rust: "error[E0425]: msg" then "  --> src/main.rs:3:5"
    const rh = s.match(/^(error|warning)(\[\w+\])?: (.*)$/);
    if (rh) { rustSev = rh[1]; rustMsg = `${rh[2] ? `${rh[2].slice(1, -1)}: ` : ''}${rh[3]}`; return; }
    const ra = s.match(/^\s*--> (.+?):(\d+):(\d+)$/);
    if (ra && rustSev) { push({ rel: toRel(ra[1]), line: +ra[2], col: +ra[3], sev: rustSev, msg: rustMsg }); rustSev = ''; return; }
    if (cmakeAt && s.trim()) { push({ ...cmakeAt, msg: s.trim() }); cmakeAt = null; return; }
    for (const m of MATCHERS) {
      const x = s.match(m.re);
      if (!x) continue;
      if (m.m === 0) { cmakeAt = { rel: toRel(x[m.f]), line: +x[m.l], col: 1, sev: x[m.s] }; return; }
      if (m.s === 4 && m.re === MATCHERS[1].re && !x[m.s] && !/\.go$/.test(x[m.f])) return;
      push({ rel: toRel(x[m.f]), line: +x[m.l], col: +(x[m.c] || 1), sev: x[m.s] || 'error', code: m.code ? x[m.code] : '', msg: x[m.m] });
      return;
    }
  };
  return {
    feed: (text) => {
      buf += text;
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const p of parts) line(p);
    },
    end: () => { if (buf) line(buf); buf = ''; paintProblemsSoon(); },
  };
}

function clearBuildProblems() {
  I.buildProblems = [];
  I.buildSeen = new Set();
  paintProblemsSoon();
}
