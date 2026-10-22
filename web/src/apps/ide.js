import {
  DK_RUNNERS,
  HOME,
  acct,
  codeKey,
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
} from '../app.js';
import { codeEditor } from './editor.js';
import { startTerminal } from './terminal.js';
import { renderMd } from '../md.js';
import guideText from '../../../docs/ide-extensions.md';

// --- the ide ---------------------------------------------------------------------
// a workbench in one desktop window, laid out and keyed as VS Code is: a folder
// of the user's own home (theirs or shared, nobody else's) its workspace, every
// file in it one of the editor's live sessions on the host holding it, its
// terminals on the hosts this desktop is logged into, its chat the mesh's models
// asked straight through their gateway, its extensions each in a sandboxed frame of its own,
// reaching the workbench only through the messages it answers

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform || '');
const STATE_KEY = () => `phosphorus-ide:${acct?.user || ''}`;
// where the user's ide keeps what follows them across browsers
const CONF_DIR = () => `${acct.user}/.ide`;
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
  runSide: 'M3.5 3v10l7-5zM11.5 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  ext: 'M2 2h5v5H2zM9.5 2.5l3.5 3.5-3.5 3.5L6 6zM2 9h5v5H2zM9 9h5v5H9z',
  chat: 'M2 2.5h12v8.5H6.5L3.5 13.5V11H2zM5 6h6M5 8.5h4',
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
  collapse: 'M2.5 2.5h11v11h-11zM5 8h6',
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
  layoutSide: 'M1.5 2.5h13v11h-13zM5.5 2.5v11',
  layoutPanel: 'M1.5 2.5h13v11h-13zM1.5 9.5h13',
  layoutAux: 'M1.5 2.5h13v11h-13zM10.5 2.5v11',
  replaceAll: 'M2 3.5h7M2 6.5h5M9.5 8.5l2.5 2.5 2.5-2.5M12 3v8M2 10.5h5M2 13.5h7',
  replaceOne: 'M2 4.5h7M2 8h5M9.5 9.5l2.5 2.5 2.5-2.5M12 4v8',
  word: 'M2 12.5h12M3.5 5l1.5 5.5L6.5 7l1.5 3.5L9.5 5M11 5.5h2M11 8h2',
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
// the user's own space and the shared one, nobody else's
function inScope(rel) {
  const c = cleanPath(rel);
  if (c === null || !acct) return false;
  const top = c.split('/')[0];
  return top === acct.user || top === 'shared';
}
const under = (p, dir) => p === dir || p.startsWith(`${dir}/`);
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

const DEFAULTS = () => ({
  root: acct.user, tabs: [], active: '', recent: [], recentFolders: [],
  side: { view: 'explorer', w: 260, hidden: false },
  panel: { h: 260, hidden: true, view: 'terminal', max: false },
  aux: { w: 360, hidden: true, agent: 'mesh:chimp' },
  expanded: {}, runHost: '', sections: { open: true, tree: true },
  ext: { enabled: {} },
});
const SETTINGS = {
  'editor.fontSize': { def: 13, type: 'number', min: 8, max: 40, title: 'Editor: Font Size', about: 'Controls the font size in pixels.' },
  'editor.enablePreview': { def: true, type: 'boolean', title: 'Workbench › Editor: Enable Preview', about: 'Controls whether a file opened from the explorer is shown as a preview, its tab reused until you edit it or double click.' },
  'explorer.confirmDelete': { def: true, type: 'boolean', title: 'Explorer: Confirm Delete', about: 'Controls whether the explorer asks before deleting a file or folder. A delete here is for good: there is no trash.' },
  'explorer.autoReveal': { def: true, type: 'boolean', title: 'Explorer: Auto Reveal', about: 'Controls whether the explorer reveals and selects the active file.' },
  'files.exclude': { def: '.git, node_modules, __pycache__, .DS_Store', type: 'string', title: 'Files: Exclude', about: 'Comma separated names or simple globs (*.o) hidden from the explorer, quick open and search.' },
  'terminal.integrated.fontSize': { def: 13, type: 'number', min: 8, max: 40, title: 'Terminal › Integrated: Font Size', about: 'Controls the font size in pixels of the terminal. New terminals take it.' },
  'workbench.restoreEditors': { def: true, type: 'boolean', title: 'Workbench: Restore Editors', about: 'Controls whether the open editors come back when the ide opens again.' },
  'ide.runners': { def: {}, type: 'object', title: 'Run: Runners', about: 'Commands that run a file, by extension, over the built-in ones, as {"py": "python3 -u \\"$f\\""}: $f is the file, $o a fresh output path beside it.' },
  'chat.includeActiveFile': { def: true, type: 'boolean', title: 'Chat: Include Active File', about: 'Controls whether the mesh agents see the file you have open, and know "this file" means it.' },
};
const setting = (k) => (I?.settings && k in I.settings ? I.settings[k] : SETTINGS[k]?.def);

function loadState() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(STATE_KEY())); } catch {}
  const d = DEFAULTS();
  if (!v || typeof v !== 'object') return d;
  return { ...d, ...v, side: { ...d.side, ...v.side }, panel: { ...d.panel, ...v.panel }, aux: { ...d.aux, ...v.aux }, ext: { ...d.ext, ...v.ext }, sections: { ...d.sections, ...v.sections } };
}
const saveState = debounce(() => {
  if (!I) return;
  const st = I.st;
  st.tabs = I.tabs.filter((t) => t.kind === 'code' || t.kind === 'image').map((t) => t.rel);
  st.active = I.active?.rel || '';
  try { localStorage.setItem(STATE_KEY(), JSON.stringify(st)); } catch {}
}, 300);

// --- start and stop -----------------------------------------------------------------

// the window's body made the workbench; open: {dir} a folder, {path} a file
export function ideStart(w, open) {
  if (I) teardown();
  const st = loadState();
  if (!inScope(st.root)) st.root = acct.user;
  let cached = {};
  try { cached = JSON.parse(localStorage.getItem(`${STATE_KEY()}:settings`)) || {}; } catch {}
  I = {
    w, st, settings: cached, userKeys: [], tabs: [], active: null, mru: [], closed: [], tree: new Map(), loading: new Map(),
    sel: '', terms: [], term: null, termSeq: 0, output: new Map(), outCh: 'Phosphorus IDE', commands: new Map(), keys: new Map(),
    exts: new Map(), runners: new Map(), providers: new Map(), statusItems: new Map(), notes: [], chord: '', chats: new Map(),
    index: null, offs: [], seq: 0,
  };
  build();
  registerCommands();
  applySettings();
  for (const [ext, cmd] of Object.entries(DK_RUNNERS)) I.runners.set(ext, { cmd, by: '' });
  log(`started as ${acct.user} on ${selfHost}, workspace ${st.root}`);
  setRoot(st.root, true);
  if (setting('workbench.restoreEditors')) {
    for (const rel of st.tabs) if (inScope(rel)) openFile(rel, { preview: false, focus: false, quiet: true });
    const back = I.tabs.find((t) => t.rel === st.active);
    if (back) activate(back, false);
  }
  paintEditors();
  showSide(st.side.view, !st.side.hidden);
  showPanel(st.panel.view, !st.panel.hidden);
  showAux(!st.aux.hidden);
  loadUserFiles();
  loadExtensions();
  // the mesh's models looked at now and then, while the chat's in view
  refreshRoles();
  const roles = setInterval(() => { if (I && !I.st.aux.hidden) refreshRoles(); }, 30000);
  I.offs.push(() => clearInterval(roles));
  addEventListener('message', onWebviewMessage);
  I.offs.push(() => removeEventListener('message', onWebviewMessage));
  if (open) openRequest(open);
  return {
    focus: () => focusActive(),
    open: (o) => openRequest(o),
    holdClose: (done) => holdClose(done),
    close: () => teardown(),
  };
}

function openRequest(o) {
  if (!I || !o) return;
  if (o.dir !== undefined) {
    const d = cleanPath(o.dir);
    if (d !== null && inScope(d)) setRoot(d); else notify('warning', `${o.dir} is outside your space`);
  } else if (o.path) {
    const p = cleanPath(o.path);
    if (p && inScope(p)) openFile(p, { preview: false }); else notify('warning', `${o.path} is outside your space`);
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
}

// --- the layout -----------------------------------------------------------------------
// title bar, activity bar, side bar, editors over the panel, the chat beside, the
// status bar under all; overlays in a layer of their own

function build() {
  const root = Object.assign(el('div', 'ide'), { tabIndex: -1 });
  const layer = el('div', 'ide-layer');
  // the title bar: menus, the command center, the layout's toggles
  // the window's own title bar made VS Code's: its menus, its command center, its
  // layout toggles, the window's buttons and drag kept
  const title = el('div', 'ide-titlebar');
  const menubar = el('div', 'ide-menubar');
  menubar.setAttribute('role', 'menubar');
  const cc = Object.assign(el('button', 'ide-cc'), { type: 'button' });
  const ccText = el('span', 'ide-cc-text');
  cc.append(icon('search'), ccText);
  cc.addEventListener('click', () => quickOpen(''));
  const layout = el('div', 'ide-layout-btns');
  const lay = {
    side: btn('', 'layoutSide', 'Toggle Primary Side Bar', () => run('workbench.action.toggleSidebarVisibility')),
    panel: btn('', 'layoutPanel', 'Toggle Panel', () => run('workbench.action.togglePanel')),
    aux: btn('', 'layoutAux', 'Toggle Secondary Side Bar', () => run('workbench.action.toggleAuxiliaryBar')),
  };
  layout.append(lay.side, lay.panel, lay.aux);
  title.append(menubar, cc, layout);

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
    root, layer, titleBar: title, menubar, cc, ccText, lay, activity, actTop, actFoot, side, sideTitle, sideActs, sideBody, center, editorsPart,
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
  I.lay.side.classList.toggle('on', !st.side.hidden);
  I.lay.panel.classList.toggle('on', !st.panel.hidden);
  I.lay.aux.classList.toggle('on', !st.aux.hidden);
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
  { id: 'run', title: 'Run and Hosts', ic: 'runSide', cmd: 'workbench.view.run' },
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
  const account = Object.assign(el('button', 'ide-act'), { type: 'button', ariaLabel: 'Accounts', title: 'Accounts' });
  account.append(icon('user'));
  account.addEventListener('click', () => menu(account, [
    { label: `${acct.user}${acct.admin ? ' (admin)' : ''}`, disabled: true },
    { label: `Desktop served by ${selfHost}`, disabled: true },
    '-',
    { label: 'Hosts and Logins', run: () => showSide('run', true, true) },
  ], { side: 'right', up: true }));
  const manage = Object.assign(el('button', 'ide-act'), { type: 'button', ariaLabel: 'Manage', title: 'Manage' });
  manage.append(icon('gear'));
  manage.addEventListener('click', () => menu(manage, [
    cmdItem('workbench.action.showCommands', 'Command Palette…'),
    '-',
    cmdItem('workbench.action.openSettings', 'Settings'),
    cmdItem('workbench.action.openSettingsJson', 'Settings (JSON)'),
    cmdItem('workbench.action.openGlobalKeybindings', 'Keyboard Shortcuts'),
    cmdItem('workbench.view.extensions', 'Extensions'),
    '-',
    cmdItem('ide.extensions.guide', 'Extension Guide'),
  ], { side: 'right', up: true }));
  I.actFoot.append(account, manage);
  buildExplorer();
  buildSearch();
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
    cmdItem('explorer.newFile', 'New File…'), cmdItem('explorer.newFolder', 'New Folder…'), '-',
    cmdItem('workbench.action.files.openFolder', 'Open Folder…'),
    { label: 'Open Recent', sub: () => recentItems() }, '-',
    cmdItem('workbench.action.files.save', 'Save'), cmdItem('workbench.action.files.saveAll', 'Save All'), '-',
    { label: 'Preferences', sub: () => [
      cmdItem('workbench.action.openSettings', 'Settings'), cmdItem('workbench.action.openSettingsJson', 'Settings (JSON)'),
      cmdItem('workbench.action.openGlobalKeybindings', 'Keyboard Shortcuts'), cmdItem('workbench.action.openGlobalKeybindingsFile', 'Keyboard Shortcuts (JSON)'),
      cmdItem('workbench.view.extensions', 'Extensions'),
    ] }, '-',
    cmdItem('workbench.action.revertFile', 'Revert File'),
    cmdItem('workbench.action.closeActiveEditor', 'Close Editor'), cmdItem('workbench.action.closeAllEditors', 'Close All Editors'), '-',
    cmdItem('ide.closeWindow', 'Close Window'),
  ]],
  ['Edit', () => [
    cmdItem('undo', 'Undo'), cmdItem('redo', 'Redo'), '-',
    cmdItem('actions.find', 'Find'), cmdItem('editor.action.startFindReplaceAction', 'Replace'), '-',
    cmdItem('workbench.action.findInFiles', 'Find in Files'), '-',
    cmdItem('editor.action.commentLine', 'Toggle Line Comment'),
  ]],
  ['Selection', () => [
    cmdItem('editor.action.selectAll', 'Select All'), cmdItem('expandLineSelection', 'Expand Line Selection'), '-',
    cmdItem('editor.action.copyLinesUpAction', 'Copy Line Up'), cmdItem('editor.action.copyLinesDownAction', 'Copy Line Down'),
    cmdItem('editor.action.moveLinesUpAction', 'Move Line Up'), cmdItem('editor.action.moveLinesDownAction', 'Move Line Down'),
    cmdItem('editor.action.duplicateSelection', 'Duplicate Selection'),
  ]],
  ['View', () => [
    cmdItem('workbench.action.showCommands', 'Command Palette…'), '-',
    cmdItem('workbench.view.explorer', 'Explorer'), cmdItem('workbench.view.search', 'Search'), cmdItem('workbench.view.run', 'Run and Hosts'),
    cmdItem('workbench.view.extensions', 'Extensions'), cmdItem('workbench.action.chat.open', 'Chat'), '-',
    cmdItem('workbench.actions.view.problems', 'Problems'), cmdItem('workbench.action.output.toggleOutput', 'Output'), cmdItem('workbench.action.terminal.toggleTerminal', 'Terminal'), '-',
    { label: 'Appearance', sub: () => [
      cmdItem('workbench.action.toggleSidebarVisibility', 'Primary Side Bar', !I.st.side.hidden),
      cmdItem('workbench.action.toggleAuxiliaryBar', 'Secondary Side Bar', !I.st.aux.hidden),
      cmdItem('workbench.action.togglePanel', 'Panel', !I.st.panel.hidden),
      cmdItem('workbench.action.toggleMaximizedPanel', 'Maximized Panel', I.st.panel.max), '-',
      cmdItem('editor.action.fontZoomIn', 'Zoom In'), cmdItem('editor.action.fontZoomOut', 'Zoom Out'), cmdItem('editor.action.fontZoomReset', 'Reset Zoom'),
    ] },
    cmdItem('markdown.showPreview', 'Toggle Markdown Preview'),
  ]],
  ['Go', () => [
    cmdItem('workbench.action.quickOpen', 'Go to File…'), cmdItem('workbench.action.gotoLine', 'Go to Line/Column…'), '-',
    cmdItem('workbench.action.nextEditor', 'Next Editor'), cmdItem('workbench.action.previousEditor', 'Previous Editor'), '-',
    cmdItem('editor.action.marker.next', 'Next Problem'), cmdItem('editor.action.marker.prev', 'Previous Problem'),
  ]],
  ['Run', () => [
    cmdItem('ide.run.file', 'Run Active File'), cmdItem('ide.run.fileOn', 'Run Active File On…'), '-',
    cmdItem('ide.selectHost', 'Select Host…'), cmdItem('workbench.view.run', 'Run and Hosts'),
  ]],
  ['Terminal', () => [
    cmdItem('workbench.action.terminal.new', 'New Terminal'), cmdItem('workbench.action.terminal.newOn', 'New Terminal On…'), '-',
    cmdItem('ide.run.file', 'Run Active File'), cmdItem('workbench.action.terminal.runSelectedText', 'Run Selected Text'), '-',
    cmdItem('workbench.action.terminal.clear', 'Clear Terminal'), cmdItem('workbench.action.terminal.rename', 'Rename Terminal…'),
    cmdItem('workbench.action.terminal.kill', 'Kill Terminal'),
  ]],
  ['Help', () => [
    cmdItem('workbench.action.openWalkthrough', 'Welcome'), cmdItem('workbench.action.showCommands', 'Show All Commands'),
    cmdItem('workbench.action.openGlobalKeybindings', 'Keyboard Shortcuts Reference'), '-',
    cmdItem('ide.extensions.guide', 'Extension Guide'), cmdItem('ide.extensions.create', 'Create an Extension…'), '-',
    cmdItem('workbench.action.showOutput', 'Show Log'), cmdItem('ide.about', 'About'),
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
  v.acts = [btn('', 'more', 'More Actions…', (e) => menu(e.currentTarget, [
    cmdItem('workbench.action.files.openFolder', 'Open Folder…'),
    cmdItem('workbench.files.action.refreshFilesExplorer', 'Refresh Explorer'),
    cmdItem('workbench.files.action.collapseExplorerFolders', 'Collapse Folders in Explorer'),
    '-',
    { label: 'Show Open Editors', checked: open.open(), run: () => open.node.click() },
  ]))];
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
function setRoot(dir, first = false) {
  const d = cleanPath(dir);
  if (d === null || !inScope(d)) return;
  const st = I.st;
  if (!first && d === st.root) { refreshTree(); return; }
  st.root = d;
  st.recentFolders = [d, ...st.recentFolders.filter((x) => x !== d)].slice(0, 12);
  I.tree.clear();
  I.expanded = new Set((st.expanded[d] || []).filter((p) => under(p, d)));
  I.expanded.add(d);
  I.sel = '';
  I.index = null;
  I.ex.treeHead.title.textContent = baseName(d).toUpperCase();
  I.ex.treeHead.title.title = d;
  I.ccText.textContent = baseName(d);
  I.w.head.querySelector('.tab-label').textContent = `${baseName(d)} — ide`;
  for (const p of I.expanded) loadDir(p);
  paintTree();
  saveState();
}

const sortEntries = (list) => [...list].sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

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
  const pr = filesCall(HOME, 'list', undefined, { path: dir }).then((b) => {
    const list = sortEntries(b.entries || []);
    if (I && I.st.root === root) I.tree.set(dir, list);
    if (dir === root && I) I.ex.error = '';
    return list;
  }).catch((err) => {
    if (I && I.st.root === root) {
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
  I.st.expanded[I.st.root] = [...I.expanded].filter((p) => p !== I.st.root);
  saveState();
}

function treeRow(e, p, depth) {
  const row = el('div', `ide-row${e.dir ? ' ide-dir' : ''}${e.stale ? ' stale' : ''}`);
  row.id = `ide-r-${(I.seq += 1)}`;
  row.dataset.path = p;
  row.dataset.dir = e.dir ? '1' : '0';
  if (!e.dir && e.live?.length === 1) row.dataset.host = e.live[0];
  row.draggable = true;
  row.style.setProperty('--depth', depth);
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-level', String(depth + 1));
  if (e.dir) row.setAttribute('aria-expanded', String(I.expanded.has(p)));
  const holders = e.live?.length ? e.live : e.hosts || [];
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
    runnable && { label: `Run on ${runHost() || 'a host'}`, run: () => runFile(p) },
    runnable && { label: 'Run On…', run: () => runFileOn(p) },
    { label: 'Reveal in Files', run: () => filesWin({ loc: HOME, dir: dir ? p : filesParent(p) }) },
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
  const host = homePick(p);
  const home = dkHomeOn(host);
  const text = abs ? (home ? `${home}/${p}` : p) : (under(p, I.st.root) ? p.slice(I.st.root.length + 1) || '.' : p);
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
      await filesCall(HOME, 'mkdir', jsonPost({ path: at })).catch(() => {});
      I.expanded.add(at);
    }
    const rel = filesJoin(at, leaf);
    if (kind === 'folder') {
      await filesCall(HOME, 'mkdir', jsonPost({ path: rel }));
      I.expanded.add(rel);
    } else {
      await putFile(homeAt(homePick(at)), rel, new Blob([]));
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
  const moving = I.tabs.filter((t) => t.rel && under(t.rel, from));
  await Promise.all(moving.filter((t) => t.ed?.dirty()).map((t) => saveTab(t)));
  try {
    await filesCall(HOME, 'rename', jsonPost({ from, to }));
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
      detail: `It goes from every host holding it${e?.hosts?.length ? ` (${e.hosts.join(', ')})` : ''}. This action is irreversible: phosphorus keeps no trash.`,
      buttons: [{ label: 'Delete', primary: true, danger: true, value: 'y' }, { label: 'Cancel', value: '' }],
      check: { label: 'Do not ask me again', key: 'explorer.confirmDelete' },
    });
    if (ok !== 'y') return;
  }
  try {
    await filesCall(HOME, 'delete', jsonPost({ path: p }));
  } catch (err) {
    notify('error', `Unable to delete '${baseName(p)}': ${err.message}`);
    return;
  }
  if (!I) return;
  for (const t of I.tabs.filter((x) => x.rel && under(x.rel, p))) closeTab(t, true);
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
  const host = homePick(dir);
  const note = notify('info', `Uploading ${list.length === 1 ? list[0].name : `${list.length} files`} to ${host}…`, { progress: true, sticky: true });
  let n = 0;
  for (const f of list) {
    try {
      await putFile(homeAt(host), filesJoin(dir, f.name), f, (sent) => note.progress?.((n + (f.size ? sent / f.size : 1)) / list.length));
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

// o: preview, focus, host, line, col, select [from, to], index, quiet
function openFile(rel, o = {}) {
  const p = cleanPath(rel);
  if (!p || !inScope(p)) { if (!o.quiet) notify('warning', `${rel} is outside your space`); return null; }
  let t = I.tabs.find((x) => x.rel === p);
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
  const known = o.host && homeOnline().includes(o.host) ? o.host : '';
  t = addTab({ kind, rel: p, host: known || homePick(p), title: baseName(p), preview }, index);
  // the session opened on a host holding the file: one named, else the folder
  // listed first, so a file only elsewhere never opens empty here
  if (known) mountKind(t);
  else {
    t.view.append(el('div', 'ide-loading', 'opening…'));
    holdersOf(p).then((hs) => {
      if (!I || !I.tabs.includes(t)) return;
      t.host = hs.includes(selfHost) ? selfHost : hs[0] || homePick(p);
      t.view.replaceChildren();
      mountKind(t);
      paintEditors();
      if (t === I.active) { t.ed?.show(); if (t.wantFocus) focusTab(t); }
    });
  }
  t.wantFocus = o.focus !== false;
  placeCaret(t, o);
  emit('open', { path: p });
  I.st.recent = [p, ...I.st.recent.filter((r) => r !== p)].slice(0, 30);
  I.closed = I.closed.filter((r) => r !== p);
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
  const file = { host: t.host, share: 'home', path: t.rel, label: `${t.host}/home/${t.rel}` };
  t.edId = `ide-code-${(edSeq += 1)}`;
  t.ed = codeEditor(t.view, file, null, t.edId, { bare: true, onState: (info) => tabState(t, info) });
  editors.set(t.edId, t.ed);
  codeTabs.set(codeKey(file), t.edId);
  t.dispose = () => t.ed.close();
}

function mountImage(t) {
  const box = el('div', 'ide-image');
  const img = Object.assign(el('img'), { alt: t.title, src: filesApi(homeAt(t.host), 'download', { path: t.rel, inline: '' }) });
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
    openFile(t.rel, { preview: false, index: i, anyway: true, host: t.host });
  });
  const dl = Object.assign(el('a', 'ide-link', 'Download'), { href: filesApi(homeAt(t.host), 'download', { path: t.rel }) });
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
  if (info.ready && !was?.ready) applyPending(t);
  if (info.dirty && t.preview) pin(t);
  if (!was || was.dirty !== info.dirty) { t.tabEl.classList.toggle('dirty', info.dirty); paintOpenEditorsSoon(); }
  if (!was || was.errors.length !== info.errors.length) { paintProblemsSoon(); paintTreeSoon(); }
  if (t === I.active) paintStatus();
  if (I.find?.open && t === I.active && was && was.length !== info.length) findSoon();
  // the user's settings and keys read again once their file's saved
  if (was?.dirty && !info.dirty) {
    emit('save', { path: t.rel });
    if (t.rel === SETTINGS_PATH() || t.rel === KEYS_PATH()) loadUserFiles();
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
  I.mru = [t, ...I.mru.filter((x) => x !== t)];
  for (const x of I.tabs) {
    x.view.hidden = x !== t;
    x.tabEl.classList.toggle('on', x === t);
    x.tabEl.setAttribute('aria-selected', String(x === t));
  }
  // painted first: an editor in a hidden view takes no focus
  paintEditors();
  t.ed?.show();
  if (focus) { drawersAway(); focusTab(t); }
  if (t !== was) {
    if (I.find?.open) { if (t.ed) findSoon(); else closeFind(false); }
    if (was?.ed) was.ed.setFinds([]);
    if (t.rel && setting('explorer.autoReveal') && under(t.rel, I.st.root)) revealPath(t.rel);
  }
  t.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  saveState();
  emit('activeEditor');
}

function focusTab(t) {
  if (t.ed) t.ed.focus(); else t.view.focus({ preventScroll: true });
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
  if (head) head.textContent = `${t ? `${t.title} — ` : ''}${baseName(I.st.root)} — ide`;
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
  if (t?.ed && runnerFor(t.rel)) acts.push(btn('ide-run-btn', 'run', `Run ${t.title} on ${runHost() || 'a host'} (${keyLabel(keyFor('ide.run.file'))})`, () => run('ide.run.file')));
  if (t?.ed?.preview) acts.push(btn(t.ed.previewing() ? 'on' : '', 'preview', `${t.ed.previewing() ? 'Show Source' : 'Open Preview'} (${keyLabel(keyFor('markdown.showPreview'))})`, () => run('markdown.showPreview')));
  if (t) acts.push(btn('', 'more', 'More Actions…', (e) => menu(e.currentTarget, [
    cmdItem('actions.find', 'Find'),
    cmdItem('workbench.action.gotoLine', 'Go to Line/Column…'),
    '-',
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
    ['Run Active File', 'ide.run.file'], ['Open Chat', 'workbench.action.chat.open'], ['Open Folder', 'workbench.action.files.openFolder']]) {
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
    const b = await filesCall(homeAt(t.host), 'read', undefined, { path: t.rel });
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
  C('copyFilePath', 'Copy Path of Active File', () => I.active?.rel && copyPath(I.active.rel, true), { key: 'shift+alt+c', category: 'File' });
  C('copyRelativeFilePath', 'Copy Relative Path of Active File', () => I.active?.rel && copyPath(I.active.rel, false), { key: 'ctrl+k ctrl+shift+alt+c', category: 'File' });
  C('ide.closeWindow', 'Close Window', () => I.w.node.querySelector('.dk-close')?.click(), { category: 'View' });
  // views and layout
  C('workbench.view.explorer', 'Show Explorer', () => showSide('explorer', true, true), { key: 'ctrl+shift+e', category: 'View', shell: true });
  C('workbench.view.search', 'Show Search', () => showSide('search', true, true), { category: 'View' });
  C('workbench.action.findInFiles', 'Search: Find in Files', () => findInFiles(), { key: 'ctrl+shift+f', category: 'Search', shell: true });
  C('workbench.view.run', 'Show Run and Hosts', () => showSide('run', true, true), { key: 'ctrl+shift+d', category: 'View', shell: true });
  C('workbench.view.extensions', 'Show Extensions', () => showSide('extensions', true, true), { key: 'ctrl+shift+x', category: 'View', shell: true });
  C('workbench.action.toggleSidebarVisibility', 'Toggle Primary Side Bar Visibility', () => showSide(I.st.side.view, I.st.side.hidden), { key: 'ctrl+b', category: 'View', shell: true });
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
  C('editor.action.nextMatchFindAction', 'Find Next', () => findStep(1), { key: 'f3', when: hasEd, category: 'Editor' });
  C('editor.action.previousMatchFindAction', 'Find Previous', () => findStep(-1), { key: 'shift+f3', when: hasEd, category: 'Editor' });
  C('closeFindWidget', 'Close Find Widget', () => closeFind(true), { key: 'escape', when: () => !!I.find?.open && I.active?.view.contains(document.activeElement), hidden: true });
  C('undo', 'Undo', () => { I.active?.ed?.focus(); document.execCommand('undo'); }, { when: hasEd, category: 'Edit', hidden: true });
  C('redo', 'Redo', () => { I.active?.ed?.focus(); document.execCommand('redo'); }, { when: hasEd, category: 'Edit', hidden: true });
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
  C('ide.run.file', 'Run Active File', () => (I.active?.rel ? runFile(I.active.rel) : notify('info', 'Open a file to run it.')), { key: 'f5', alt: ['ctrl+f5'], category: 'Run', shell: true });
  C('ide.run.fileOn', 'Run Active File On…', () => I.active?.rel && runFileOn(I.active.rel), { when: hasEd, category: 'Run' });
  C('ide.selectHost', 'Select Host for Terminals and Runs…', () => pickHost('Select the host terminals and runs use').then((h) => h && setRunHost(h)), { category: 'Phosphorus' });
  // preferences and help
  C('workbench.action.openSettings', 'Open Settings (UI)', () => openSettings(), { key: 'ctrl+,', category: 'Preferences', shell: true });
  C('workbench.action.openSettingsJson', 'Open User Settings (JSON)', () => openUserFile(SETTINGS_PATH(), '{\n  // your ide settings, VS Code’s names: see Preferences: Open Settings (UI)\n}\n'), { category: 'Preferences' });
  C('workbench.action.openGlobalKeybindings', 'Open Keyboard Shortcuts', () => openKeysPage(), { key: 'ctrl+k ctrl+s', category: 'Preferences' });
  C('workbench.action.openGlobalKeybindingsFile', 'Open Keyboard Shortcuts (JSON)', () => openUserFile(KEYS_PATH(), '// your keys, each {"key": "ctrl+alt+r", "command": "ide.run.file"}; a "-command" removes a default\n[\n]\n'), { category: 'Preferences' });
  C('workbench.action.openWalkthrough', 'Welcome', () => openWelcome(), { category: 'Help' });
  C('ide.about', 'About', () => ask({ title: 'phosphorus ide', detail: `A VS Code-shaped workbench over your phosphorus home.\nUser: ${acct.user}\nServed by: ${selfHost}\nHosts online: ${homeOnline().join(', ')}\nTerminals on: ${dkLiveHosts().join(', ') || 'none logged into'}`, buttons: [{ label: 'OK', primary: true, value: 'ok' }] }), { category: 'Help' });
  // extensions
  C('ide.extensions.guide', 'Open the Extension Guide', () => openGuide(), { category: 'Extensions' });
  C('ide.extensions.create', 'Create New Extension…', () => createExtension(), { category: 'Extensions' });
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
  const root = I.st.root;
  if (I.index && I.index.root === root && Date.now() - I.index.at < INDEX_TTL) return I.index;
  if (I.indexing?.root === root) return I.indexing.pr;
  const pr = Promise.all(homeOnline().map((h) => filesCall(homeAt(h), 'tree', undefined, { path: root, depth: 8 }).then((b) => ({ h, b }), () => null))).then((got) => {
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
    const items = I.st.recent.filter((p) => inScope(p)).slice(0, 30).map((p, i) => ({ label: baseName(p), description: filesParent(rel(p)), ic: p, sep: i === 0 ? 'recently opened' : '', accept: go(p) }));
    return { items, empty: 'Type to search the workspace’s files' };
  }
  if (!I.index || I.index.root !== I.st.root) {
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
        return { items: hits.map(({ x, m }) => ({ ...x, hl: m?.hl, accept: () => resolve(x.value !== undefined ? x.value : x) })), empty: 'No matching results' };
      },
      onCancel: () => resolve(undefined),
    });
  });
}

// one line typed, as an extension's showInputBox asks; validate returns a refusal or ''
function inputBox(o = {}) {
  return new Promise((resolve) => {
    quick({
      value: o.value || '', placeholder: o.placeholder || '', title: o.title, select: o.select,
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
  const input = Object.assign(el('input', 'ide-input ide-quick-input'), { value: o.value || '', placeholder: o.placeholder || '', spellcheck: false, autocomplete: 'off' });
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

// a folder of the user's own or shared space, walked down to in the quick input
async function pickFolder(start) {
  let dir = start ?? I.st.root;
  for (;;) {
    let entries = [];
    if (dir) {
      try { entries = (await filesCall(HOME, 'list', undefined, { path: dir })).entries || []; } catch (err) { notify('error', err.message); dir = ''; continue; }
    }
    if (!I) return;
    const skip = excluded();
    const subs = dir ? sortEntries(entries).filter((e) => e.dir && !skip(e.name)) : [{ name: acct.user, dir: true }, { name: 'shared', dir: true }];
    const items = [
      ...(dir ? [{ label: 'Open this folder', description: dir, ic: 'check', value: '.' }] : []),
      ...(dir ? [{ label: '..', description: 'up a folder', ic: 'up', value: '..' }] : []),
      ...subs.map((e) => ({ label: e.name, ic: 'folder', value: filesJoin(dir, e.name) })),
    ];
    const v = await pick(items, { title: `Open Folder${dir ? `: ${dir}` : ''}`, placeholder: 'Type to filter, Enter to step into a folder' });
    if (v === undefined || !I) return;
    if (v === '.') { setRoot(dir); return; }
    dir = v === '..' ? (dir.includes('/') ? filesParent(dir) : '') : v;
  }
}

function recentItems() {
  const folders = (I.st.recentFolders || []).filter(inScope).map((d) => ({ label: baseName(d), description: d, ic: 'folder', run: () => setRoot(d) }));
  const files = (I.st.recent || []).filter(inScope).slice(0, 10).map((p) => ({ label: baseName(p), description: filesParent(p), ic: p, run: () => openFile(p, { preview: false }) }));
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
      row.append(mark, el('span', 'ide-mi-label', x.label));
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
    '-', { label: 'Select Default Host…', run: () => run('ide.selectHost') },
  ]));
  tv.acts = [plus, pickOn, btn('', 'trash', 'Kill Terminal', () => run('workbench.action.terminal.kill'))];
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
  const files = I.tabs.filter((t) => t.info?.errors?.length);
  const total = files.reduce((n, t) => n + t.info.errors.length, 0);
  pv.badge.hidden = !total;
  pv.badge.textContent = String(total);
  paintStatus();
  if (pv.body.hidden) return;
  I.probShut ||= new Set();
  if (!files.length) {
    pv.list.replaceChildren(el('div', 'ide-empty-note', 'No problems have been detected in the open files.'));
    return;
  }
  const rows = [];
  for (const t of files) {
    const open = !I.probShut.has(t.rel);
    const head = el('div', 'ide-prob-file');
    head.setAttribute('role', 'treeitem');
    head.setAttribute('aria-expanded', String(open));
    head.append(icon(open ? 'down' : 'right', 'ide-chev-ic'), fileIcon(t.rel), el('span', 'ide-prob-name', t.title), el('span', 'ide-prob-dir', filesParent(t.rel)), el('span', 'ide-badge', String(t.info.errors.length)));
    head.addEventListener('click', () => { if (open) I.probShut.add(t.rel); else I.probShut.delete(t.rel); paintProblems(); });
    rows.push(head);
    if (!open) continue;
    for (const x of t.info.errors) {
      const r = el('div', 'ide-prob');
      r.setAttribute('role', 'treeitem');
      r.append(icon('error', 'ide-prob-ic'), el('span', 'ide-prob-what', x.what), el('span', 'ide-prob-src', 'syntax'), el('span', 'ide-prob-at', `[Ln ${x.line}, Col ${x.col}]`));
      r.addEventListener('click', () => { activate(t); t.ed.select(x.from, Math.max(x.to, x.from + 1)); });
      rows.push(r);
    }
  }
  pv.list.replaceChildren(...rows);
}

// --- output: the workbench's own log, and a channel per extension that asks -------------

function log(text, ch = 'Phosphorus IDE') {
  if (!I) return;
  let c = I.output.get(ch);
  if (!c) { c = { lines: [] }; I.output.set(ch, c); paintOutputChannels(); }
  const d = new Date();
  const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  for (const line of String(text).split('\n')) c.lines.push(ch === 'Phosphorus IDE' ? `${ts} ${line}` : line);
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
  return [selfHost, ...live.sort()].find((h) => live.includes(h) && dkHomeOn(h)) || live[0] || '';
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
    description: [h === selfHost && 'this desktop’s host', h === runHost() && 'default', !live.has(h) && 'not logged in', live.has(h) && !dkHomeOn(h) && 'no runs (not a POSIX home)'].filter(Boolean).join(' · '),
  }));
  return pick(items, { title, placeholder: 'Select a host', matchDescription: true }).then((h) => {
    if (h && !live.has(h)) { notify('warning', `Log into ${h} first: its lock in the desktop's task bar takes its login.`); return undefined; }
    return h;
  });
}

// o: host, cwd (a home path), run (typed once logged in), name, kind (shell or run), focus
function newTerminal(o = {}) {
  const host = o.host || runHost();
  const tv = I.panelViews.get('terminal');
  if (!host) {
    showPanel('terminal', true);
    notify('warning', 'There is no host to open a terminal on: log into one from its lock in the desktop’s task bar.');
    return null;
  }
  const creds = dk.creds.get(host);
  if (!creds) { notify('warning', `Not logged into ${host}.`); return null; }
  const home = dkHomeOn(host);
  const cwd = o.cwd ?? I.st.root;
  const kind = o.kind || 'shell';
  const cd = home && cwd ? `cd ${shQuote(`${home}/${cwd}`)}` : '';
  const line = kind === 'shell' ? (cd ? `${cd} && clear` : '') : [cd, o.run].filter(Boolean).join(' && ');
  const same = I.terms.filter((x) => x.base === (o.name || host)).length;
  const t = { id: `t${(I.termSeq += 1)}`, host, base: o.name || host, name: same ? `${o.name || host} (${same + 1})` : (o.name || host), kind, ended: false };
  t.view = el('div', 'ide-term-view');
  t.view.hidden = true;
  tv.views.append(t.view);
  t.h = startTerminal(t.view, host, newSid(), false, false, { ...creds, run: line }, {
    fontSize: setting('terminal.integrated.fontSize'),
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
  tv.wrap.classList.toggle('many', many);
  tv.wrap.hidden = !I.terms.length;
  tv.empty.hidden = !!I.terms.length;
  if (!I.terms.length) {
    tv.empty.replaceChildren();
    if (dkLiveHosts().length) {
      const b = Object.assign(el('button', 'ide-button', `New Terminal on ${runHost()}`), { type: 'button' });
      b.addEventListener('click', () => newTerminal());
      tv.empty.append(b);
    } else tv.empty.append(el('p', '', 'No host to open a terminal on. Log into one from its lock in the desktop’s task bar, then come back.'));
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
function runSelection() {
  const t = I.active;
  if (!t?.ed) return;
  const text = t.ed.text();
  let [s, e] = t.ed.selection();
  if (s === e) [s, e] = lineSpan(text, s, s);
  const chunk = text.slice(s, e).replace(/\n+$/, '');
  if (!chunk) return;
  const term = I.term && !I.term.ended ? I.term : newTerminal({ focus: false });
  if (!term) return;
  if (!term.h.send(`${chunk.replace(/\r?\n/g, '\r')}\r`)) notify('warning', 'The terminal is still connecting: try again in a moment.');
  showPanel('terminal', true);
}

// --- running a file: its runner, on the host it's on, in that host's run terminal -------

function runnerFor(rel) {
  if (!rel) return '';
  const x = extOf(rel);
  const mine = setting('ide.runners');
  if (mine && typeof mine === 'object' && typeof mine[x] === 'string') return mine[x];
  return I.runners.get(x)?.cmd || '';
}

async function holdersOf(rel) {
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
      { label: 'Add One in Settings', run: () => openUserFile(SETTINGS_PATH(), '{\n  "ide.runners": {\n  }\n}\n') },
      { label: 'Extension Guide', run: () => openGuide() },
    ] });
    return;
  }
  let host = hostArg || runHost();
  if (!host) { notify('warning', 'Log into a host to run code: its lock in the desktop’s task bar takes its login.'); return; }
  if (!dkHomeOn(host)) {
    const other = dkLiveHosts().find((h) => dkHomeOn(h));
    notify('warning', `${host} can't run files from the home: it isn't a POSIX host.`, other ? { actions: [{ label: `Run on ${other}`, run: () => runFile(rel, other) }] } : {});
    return;
  }
  const t = I.tabs.find((x) => x.rel === rel);
  if (t?.ed?.dirty() && !(await saveTab(t))) return;
  const holders = await holdersOf(rel);
  if (!I) return;
  if (!holders.includes(host)) {
    if (!holders.length) { notify('error', `${rel} isn't on any host that's online.`); return; }
    const there = holders.find((h) => dkLiveHosts().includes(h) && dkHomeOn(h));
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
  const cmd = `f=${shQuote(`${dkHomeOn(host)}/${rel}`)}; o="$(mktemp -d)"/${shQuote(stem)}; cd "$(dirname "$f")" && ${runner}`;
  log(`run ${rel} on ${host}: ${runner}`);
  emit('run', { path: rel, host });
  const term = I.terms.find((x) => x.kind === 'run' && x.host === host && !x.ended);
  if (term && term.h.send(`${cmd}\r`)) { selectTerm(term, false); showPanel('terminal', true); return; }
  newTerminal({ host, kind: 'run', name: `run: ${host}`, run: cmd, cwd: '', focus: false });
}

// --- the status bar --------------------------------------------------------------------------

function sbItem(cls, title, onClick) {
  const b = Object.assign(el('button', `ide-sb ${cls}`), { type: 'button', title });
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

function buildStatus() {
  const S = {};
  S.remote = sbItem('ide-sb-remote', 'Select the host terminals and runs use', () => run('ide.selectHost'));
  S.problems = sbItem('ide-sb-problems', 'No Problems', () => run('workbench.actions.view.problems'));
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
  S.host = sbItem('ide-sb-host', 'The host the file’s session is on', () => I.active?.rel && filesWin({ loc: HOME, dir: filesParent(I.active.rel) }));
  S.state = el('span', 'ide-sb ide-sb-state');
  S.extR = el('span', 'ide-sb-ext');
  S.bell = sbItem('ide-sb-bell', 'Notifications', (e) => notesPopup(e.currentTarget));
  I.statusL.append(S.remote, S.problems, S.people, S.agent, S.extL, S.flash, S.chord);
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
  const errs = I.tabs.reduce((n, t) => n + (t.info?.errors?.length || 0), 0);
  S.problems.replaceChildren(icon('error'), el('span', '', String(errs)), icon('warning'), el('span', '', '0'));
  S.problems.title = errs ? `${errs} error${errs === 1 ? '' : 's'} in the open files` : 'No Problems';
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
    const r = await fetch('/api/model/v1/models', { cache: 'no-store' });
    const b = await r.json().catch(() => ({}));
    if (!I) return;
    if (r.ok) I.roles = (b.data || []).filter((m) => m && m.id).map((m) => ({ id: m.id, ready: !!m.ready }));
  } catch {}
  if (I) paintChat();
}

// every agent on offer: the mesh's roles, then the extensions'
function agentList() {
  const roles = I.roles?.length ? I.roles : [{ id: 'chimp' }];
  const mesh = roles.map((m) => ({ id: `mesh:${m.id}`, label: m.id, sub: ROLE_SUB[m.id] || 'mesh model', up: m.ready !== false, kind: 'mesh', role: m.id }));
  const ext = [...I.providers.values()].map((p) => ({ id: p.key, label: p.label, sub: p.ext, up: true, kind: 'ext', p }));
  return [...mesh, ...ext];
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

// the agent picked, as one shape for both kinds
function currentAgent() {
  if (!I) return null;
  const list = agentList();
  const a = list.find((x) => x.id === I.st.aux.agent) || list[0];
  if (!a) return null;
  const c = chatOf(a.id);
  if (a.kind === 'mesh') {
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
  return {
    ...a,
    turns: () => c.turns,
    busy: () => c.busy,
    ready: () => true,
    send: (text) => providerAsk(a.p, c, text),
    stop: () => { c.busy = false; c.req = null; c.turns.push({ role: 'notice', text: 'stopped', at: Date.now() }); paintChat(); },
    clear: () => { c.turns = []; c.busy = false; c.req = null; paintChat(); },
    sees: true,
  };
}

function buildAux() {
  const head = el('div', 'ide-aux-head');
  const title = el('span', 'ide-side-title', 'CHAT');
  const who = Object.assign(el('button', 'ide-chat-who'), { type: 'button', title: 'Pick the agent' });
  who.addEventListener('click', () => menu(who, agentList().map((a) => ({
    label: `${a.label}${a.sub ? ` — ${a.sub}` : ''}${a.kind === 'mesh' && !a.up ? ' (offline)' : ''}`,
    checked: a.id === currentAgent()?.id ? true : undefined, ic: a.kind === 'mesh' ? 'spark' : 'ext',
    run: () => { I.st.aux.agent = a.id; saveState(); paintChat(true); },
  }))));
  const acts = el('span', 'ide-actions');
  acts.append(btn('', 'plus', 'New Chat', () => run('workbench.action.chat.newChat')), btn('', 'close', 'Hide Secondary Side Bar', () => showAux(false)));
  head.append(title, who, acts);
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
  const send = btn('ide-chat-send', 'send', 'Send (Enter)', () => sendChat());
  const stop = btn('ide-chat-stop', 'stop', 'Stop', () => currentAgent()?.stop());
  box.append(ta, send, stop);
  foot.append(ctx, box);
  I.aux.append(head, banner, log, foot);
  I.chat = { who, banner, log, ta, send, stop, ctx, sig: '' };
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
  c.who.replaceChildren(icon(a?.kind === 'ext' ? 'ext' : 'spark'), el('span', '', a ? a.label : 'no agent'), icon('down'));
  c.ta.placeholder = a ? `Ask ${a.label}…` : 'No agent';
  c.ta.title = 'Enter to send, Shift+Enter for a new line';
  paintChatCtx();
  paintChatButtons();
  paintStatus();
  // the banner: why an ask may not land
  let why = '';
  if (!a) why = 'No model is set up on the mesh. The status app’s model card picks one.';
  else if (a.kind === 'mesh' && !a.up) why = `${a.label} has no model answering right now. The status app’s model card shows why.`;
  c.banner.textContent = why;
  c.banner.hidden = !why;
  if (I.st.aux.hidden && !force) return;
  const turns = a ? a.turns() : [];
  const busy = !!a?.busy();
  const sig = `${a?.id}\n${turns.length}\n${turns.at(-1)?.at}\n${busy}\n${I.chats.get(a?.id)?.live?.length || 0}`;
  if (sig === c.sig && !force) return;
  c.sig = sig;
  const nearEnd = c.log.scrollTop + c.log.clientHeight >= c.log.scrollHeight - 40;
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
  w.append(el('p', '', a?.kind === 'mesh'
    ? `${a.label} is the mesh’s ${a.sub} model, asked straight through its gateway. It sees the file you have open here; put its code at your caret or run it in a terminal from the buttons on each block.`
    : 'Pick an agent above.'));
  const tries = ['Explain this file', 'Find the bugs in this file', 'Write tests for this file', 'How do I build and run this?'];
  const row = el('div', 'ide-chat-tries');
  for (const t of tries) {
    const b = Object.assign(el('button', 'ide-chip', t), { type: 'button' });
    b.addEventListener('click', () => { I.chat.ta.value = t; I.chat.grow(); sendChat(); });
    row.append(b);
  }
  if (a) w.append(row);
  return w;
}

function chatTurn(a, t) {
  const row = el('div', `ide-msg ${t.role}`);
  const head = el('div', 'ide-msg-head');
  if (t.role === 'user') head.append(el('span', 'ide-msg-av', (name || acct.user || '?')[0].toUpperCase()), el('span', 'ide-msg-name', name || acct.user));
  else if (t.role === 'assistant') head.append(icon('spark', 'ide-msg-av agent'), el('span', 'ide-msg-name agent', t.by || a.label));
  if (t.role !== 'notice') row.append(head);
  const body = el('div', 'ide-msg-body');
  if (t.role === 'user') body.textContent = t.text;
  else if (t.role === 'notice') body.textContent = t.text;
  else if (t.pending) body.append(el('span', 'ide-dots', ''));
  else {
    renderMd(body, t.text, true, t.html || null);
    decorateCode(body);
  }
  row.append(body);
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
        btn('', 'terminal', 'Run in Terminal', () => {
          const term = I.term && !I.term.ended ? I.term : newTerminal({ focus: false });
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
function meshSystem(a) {
  const t = I.active;
  const parts = [
    `You are ${a.label}, the phosphorus mesh's own assistant, answering ${name || acct.user} in the phosphorus ide, a code editor over their files on the mesh's hosts. `
    + 'Answer plainly and exactly. Put code in fenced blocks with their language: the ide puts a block at the caret or runs it in a terminal.',
    `Today is ${new Date().toDateString()}. The workspace is ${I.st.root} in the user's phosphorus home; terminals and runs go to ${runHost() || 'no host yet'}.`,
  ];
  if (t?.ed && t.info?.ready && setting('chat.includeActiveFile')) {
    const text = t.ed.text();
    const [s, e] = t.ed.selection();
    const l1 = text.slice(0, s).split('\n').length;
    const l2 = text.slice(0, e).split('\n').length;
    const cut = text.length > SEEN_MAX ? `, its first ${SEEN_MAX} characters` : '';
    parts.push(`They have ${t.rel} open (${LANG_NAMES[t.info.lang] || t.info.lang}, on ${t.host})${s !== e ? `, lines ${l1}-${l2} selected` : `, the caret on line ${l1}`}. `
      + 'When they say "this file", "this" or "here" without naming another, they mean it. '
      + `Its text as they see it now${cut}:\n<file path="${t.rel}">\n${text.slice(0, SEEN_MAX)}\n</file>`);
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
    const r = await fetch('/api/model/v1/messages', {
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
    c.turns.push({ role: 'assistant', text: out.trim() || '(no answer)', at: Date.now(), by: a.label });
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
    btn('', 'refresh', 'Refresh', () => runSearch()),
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
    const got = await Promise.all(homeOnline().map((h) => filesCall(homeAt(h), 'search', undefined, { path: root, query, content: 'true', ...(glob ? { glob } : {}) })
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
  v.acts = [btn('', 'refresh', 'Refresh', () => paintRunView())];
  v.focus = () => v.body.querySelector('button')?.focus();
}

function paintRunView() {
  const v = I.sideViews.get('run');
  if (!v || v.body.hidden) return;
  const live = new Set(dkLiveHosts());
  const def = runHost();
  const t = I.active;
  const runner = t?.rel ? runnerFor(t.rel) : '';
  const body = v.body;
  body.replaceChildren();
  const runBox = el('div', 'ide-run-box');
  const go = Object.assign(el('button', 'ide-button ide-run-go'), { type: 'button', disabled: !runner || !def });
  go.append(icon('run'), el('span', '', runner ? `Run ${t.title}` : 'Run Active File'));
  go.addEventListener('click', () => run('ide.run.file'));
  const on = Object.assign(el('button', 'ide-button secondary'), { type: 'button', disabled: !runner, title: 'Run on another host' });
  on.append(icon('more'));
  on.addEventListener('click', () => run('ide.run.fileOn'));
  const row = el('div', 'ide-run-row');
  row.append(go, on);
  runBox.append(row, el('p', 'ide-run-note', !t?.rel ? 'Open a file to run it.' : runner ? `on ${def || 'no host'}: ${runner}` : `No runner for .${extOf(t.rel)} files: add one in your settings (ide.runners) or with an extension.`));
  body.append(sectionTitle('Run'), runBox);
  body.append(sectionTitle('Hosts'));
  const hosts = [...new Set([...homeOnline(), ...live])].sort((a, b) => (b === selfHost) - (a === selfHost) || a.localeCompare(b));
  const list = el('div', 'ide-host-list');
  for (const h of hosts) {
    const r = el('div', `ide-host${h === def ? ' on' : ''}${live.has(h) ? '' : ' locked'}`);
    const info = hostsInfo[h.toLowerCase()];
    const os = info?.platform || info?.os || '';
    r.append(icon(live.has(h) ? 'host' : 'lock'), el('span', 'ide-host-name', h));
    const tags = [h === selfHost && 'this host', h === def && 'default', os, !live.has(h) && 'not logged in', live.has(h) && !dkHomeOn(h) && 'no runs'].filter(Boolean);
    r.append(el('span', 'ide-host-tags', tags.join(' · ')));
    const acts = el('span', 'ide-actions');
    if (live.has(h)) {
      acts.append(btn('', 'terminal', `New Terminal on ${h}`, () => newTerminal({ host: h })));
      if (h !== def) acts.append(btn('', 'check', `Use ${h} for Terminals and Runs`, () => setRunHost(h)));
    }
    r.append(acts);
    r.title = live.has(h) ? `${h}: logged in` : `${h}: log in from its lock in the desktop's task bar`;
    list.append(r);
  }
  body.append(list);
  body.append(sectionTitle('Runners'));
  const tbl = el('div', 'ide-runners');
  const mine = setting('ide.runners') || {};
  const all = new Map([...I.runners].map(([x, r]) => [x, { cmd: r.cmd, by: r.by || 'built in' }]));
  for (const [x, cmd] of Object.entries(mine)) if (typeof cmd === 'string') all.set(x, { cmd, by: 'settings' });
  for (const [x, r] of [...all].sort((a, b) => a[0].localeCompare(b[0]))) {
    const line = el('div', 'ide-runner');
    line.append(el('span', 'ide-runner-ext', `.${x}`), el('code', 'ide-runner-cmd', r.cmd), el('span', 'ide-runner-by', r.by));
    tbl.append(line);
  }
  const edit = Object.assign(el('button', 'ide-link', 'Edit in settings.json'), { type: 'button' });
  edit.addEventListener('click', () => openUserFile(SETTINGS_PATH(), '{\n  "ide.runners": {\n  }\n}\n'));
  body.append(tbl, edit);
}

const sectionTitle = (t) => el('div', 'ide-sec-head static', t.toUpperCase());

// --- settings and keys: the user's own files, VS Code's way ----------------------------------

async function readUser(path) {
  try {
    await filesCall(HOME, 'list', undefined, { path: filesParent(path) });
    const b = await filesCall(HOME, 'read', undefined, { path });
    return typeof b.text === 'string' ? b.text : null;
  } catch { return null; }
}

async function loadUserFiles() {
  // the folder listed once, so only files that are there are read
  let names = [];
  try { names = ((await filesCall(HOME, 'list', undefined, { path: CONF_DIR() })).entries || []).map((e) => e.name); } catch {}
  const read = (p) => (names.includes(baseName(p)) ? filesCall(HOME, 'read', undefined, { path: p }).then((b) => (typeof b.text === 'string' ? b.text : null), () => null) : null);
  const [s, k] = await Promise.all([read(SETTINGS_PATH()), read(KEYS_PATH())]);
  if (!I) return;
  if (s !== null) {
    try {
      const v = parseJsonc(s);
      if (v && typeof v === 'object' && !Array.isArray(v)) { I.settings = v; cacheSettings(); applySettings(); }
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

function applySettings() {
  const r = I.root;
  r.style.setProperty('--ide-code-font', `${setting('editor.fontSize')}px`);
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
    const hero = el('div', 'ide-welcome-hero');
    hero.append(el('h1', '', 'phosphorus ide'), el('p', '', `Your home on the mesh, its hosts’ shells and its agents, in one workbench. Signed in as ${acct.user}.`));
    const cols = el('div', 'ide-welcome-cols');
    const start = el('div', 'ide-welcome-col');
    start.append(el('h2', '', 'Start'));
    for (const [label, cmd, ic] of [['New File…', 'explorer.newFile', 'newFile'], ['Open Folder…', 'workbench.action.files.openFolder', 'folder'],
      ['New Terminal', 'workbench.action.terminal.new', 'terminal'], ['Ask the Agent', 'workbench.action.chat.open', 'spark'], ['Run Active File', 'ide.run.file', 'run']]) {
      const b = Object.assign(el('button', 'ide-welcome-link'), { type: 'button' });
      b.append(icon(ic), el('span', '', label));
      b.addEventListener('click', () => run(cmd));
      start.append(b);
    }
    const recent = el('div', 'ide-welcome-col');
    recent.append(el('h2', '', 'Recent'));
    const folders = (I.st.recentFolders || []).filter(inScope).slice(0, 6);
    if (!folders.length) recent.append(el('p', 'ide-empty-note', 'No recent folders'));
    for (const d of folders) {
      const b = Object.assign(el('button', 'ide-welcome-link'), { type: 'button' });
      b.append(el('span', '', baseName(d)), el('span', 'ide-welcome-dim', filesParent(d)));
      b.addEventListener('click', () => setRoot(d));
      recent.append(b);
    }
    const learn = el('div', 'ide-welcome-col');
    learn.append(el('h2', '', 'Learn'));
    for (const [label, cmd, ic] of [['Extension Guide', 'ide.extensions.guide', 'book'], ['Create an Extension', 'ide.extensions.create', 'ext'],
      ['Keyboard Shortcuts', 'workbench.action.openGlobalKeybindings', 'keyboard'], ['Settings', 'workbench.action.openSettings', 'gear']]) {
      const b = Object.assign(el('button', 'ide-welcome-link'), { type: 'button' });
      b.append(icon(ic), el('span', '', label));
      b.addEventListener('click', () => run(cmd));
      learn.append(b);
    }
    cols.append(start, recent, learn);
    w.append(hero, cols);
    t.view.append(w);
  });
}

function openGuide() {
  openPage('guide', 'Extension Guide', 'book', (t) => {
    const bar = el('div', 'ide-page-head');
    const make = Object.assign(el('button', 'ide-button'), { type: 'button' });
    make.append(icon('plus'), el('span', '', 'Create New Extension'));
    make.addEventListener('click', () => run('ide.extensions.create'));
    bar.append(make);
    const doc = el('div', 'ide-md');
    renderMd(doc, guideText, false);
    t.view.append(bar, doc);
  });
}

// --- extensions ---------------------------------------------------------------------------
// each one a folder in ~/.ide/extensions with a package.json and its main module,
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
  const q = Object.assign(el('input', 'ide-input ide-ext-search'), { placeholder: 'Search Extensions in ~/.ide/extensions', spellcheck: false });
  const head = sectionHead('installed', 'Installed', []);
  const list = el('div', 'ide-ext-list');
  list.setAttribute('role', 'list');
  const note = el('div', 'ide-tree-note');
  v.body.append(el('div', 'ide-search-form', ''), head.node, list, note);
  v.body.firstChild.append(q);
  head.node.addEventListener('ide-section', () => { list.hidden = !head.open(); });
  head.paint();
  q.addEventListener('input', () => paintExtView());
  v.focus = () => q.focus();
  v.acts = [
    btn('', 'plus', 'Create New Extension…', () => run('ide.extensions.create')),
    btn('', 'refresh', 'Reload Extensions', () => run('workbench.extensions.action.refreshExtension')),
    btn('', 'book', 'Extension Guide', () => run('ide.extensions.guide')),
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
    E.note.append(el('p', '', 'No extensions yet. An extension is a folder in ~/.ide/extensions: a package.json and a module that exports activate(api).'));
    const make = Object.assign(el('button', 'ide-button', 'Create New Extension'), { type: 'button' });
    make.addEventListener('click', () => run('ide.extensions.create'));
    const read = Object.assign(el('button', 'ide-link', 'Read the Extension Guide'), { type: 'button' });
    read.addEventListener('click', () => run('ide.extensions.guide'));
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
      detail: 'It runs sandboxed, away from this page and your login, but through the ide it can read and write the files in your space, type commands into terminals on the hosts you’re logged into, and answer as an agent. Enable only what you wrote or trust.',
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
  if (code === null) { extFailed(x, `its main module ${x.manifest.main || 'extension.js'} wasn't found, or is over 512KB`); return; }
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
  const c = cleanPath(s.startsWith('/') ? s : filesJoin(I.st.root, s));
  if (c === null || !inScope(c)) throw new Error(`${s} is outside your space`);
  return c;
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
    const path = extPath(p);
    const t = I.tabs.find((y) => y.rel === path && y.info?.ready);
    if (t) return t.ed.text();
    const text = await readUser(path);
    if (text === null) throw new Error(`${p}: not found, not text, or over 512KB`);
    return text;
  },
  'workspace.write': async (x, p, text) => {
    const path = extPath(p);
    await writeText(path, text, `${extName(x)} (extension)`);
    loadDir(filesParent(path), true);
    I.index = null;
    return true;
  },
  'workspace.list': async (x, p) => {
    const path = extPath(p);
    const b = await filesCall(HOME, 'list', undefined, { path });
    return (b.entries || []).map((e) => ({ name: e.name, dir: !!e.dir, size: e.size, mtime: e.mtime, hosts: e.live || e.hosts || [] }));
  },
  'workspace.open': (x, p, o) => { const t = openFile(extPath(p), { preview: false, line: Number(o?.line) || undefined, col: Number(o?.col) || undefined }); return !!t; },
  'editor.active': () => {
    const t = I.active;
    if (!t?.ed || !t.info?.ready) return null;
    const [s, e] = t.ed.selection();
    return { path: t.rel, language: t.info.lang, text: t.ed.text(), selection: [s, e], line: t.info.line, col: t.info.col, host: t.host };
  },
  'editor.insert': (x, text) => { const t = I.active; if (!t?.ed) return false; const [s, e] = t.ed.selection(); return t.ed.edit(s, e, text); },
  'editor.select': (x, from, to) => { const t = I.active; if (!t?.ed) return false; const n = t.ed.text().length; t.ed.select(Math.max(0, Math.min(n, from)), Math.max(0, Math.min(n, to))); return true; },
  'terminal.hosts': () => dkLiveHosts(),
  'terminal.run': (x, cmd, o) => {
    const host = o?.host || runHost();
    if (!dkLiveHosts().includes(host)) throw new Error(`not logged into ${host || 'any host'}`);
    const nm = o?.name ? String(o.name) : `${extName(x)}: ${host}`;
    const term = I.terms.find((t) => t.base === nm && t.host === host && !t.ended);
    if (term && term.h.send(`${cmd}\r`)) { selectTerm(term, false); showPanel('terminal', true); return true; }
    return !!newTerminal({ host, kind: 'run', name: nm, run: cmd, cwd: o?.cwd !== undefined ? extPath(o.cwd) : I.st.root, focus: false });
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
    prompt: 'Name the extension (its folder in ~/.ide/extensions)', placeholder: 'e.g. word-count',
    validate: (v) => (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(v) ? 'Lowercase letters, digits and dashes, starting with a letter or digit.' : I.exts.has(v) ? `An extension named ${v} already exists.` : ''),
  });
  if (!id || !I) return;
  const dir = filesJoin(EXT_DIR(), id);
  const files = {
    'package.json': `${JSON.stringify({
      name: id, displayName: id, version: '0.0.1', description: 'A phosphorus ide extension.', main: 'extension.js',
      contributes: {
        commands: [
          { command: `${id}.hello`, title: 'Say Hello', category: id },
          { command: `${id}.wordCount`, title: 'Count Words in the Active File', category: id },
        ],
        keybindings: [{ command: `${id}.wordCount`, key: 'ctrl+alt+w' }],
      },
    }, null, 2)}\n`,
    'extension.js': EXT_SAMPLE.replaceAll('NAME', id),
    'README.md': `# ${id}\n\nA phosphorus ide extension. **Help: Extension Guide** in the ide says how it works.\n\n- \`${id}: Say Hello\` greets you.\n- \`${id}: Count Words in the Active File\` (ctrl+alt+w), its count kept in the status bar.\n`,
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

const EXT_SAMPLE = `// NAME: a phosphorus ide extension. It runs in a sandboxed frame of its own and
// reaches the ide only through the api handed to activate; Help: Extension Guide
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
