// Sulfur's host when it runs on its own: in its desktop app, or at /sulfur/ on a
// Phosphorus server. What app.js gives Sulfur inside the desktop, from this
// computer offline (the app's own server, one host, its home and drives) or
// from a mesh (its hosts, merged home and logins, through the same API)

// the page's vendor files, hashed by the build
export const ASSETS = __ASSETS__;

// how Sulfur's running: mode 'local' (offline, this computer) or 'mesh'; app
// says whether its desktop app's window is around it; null inside the desktop
export const standalone = { mode: '', app: false, server: '', info: null, mac: /Mac/.test(navigator.platform || navigator.userAgent), logIn: null };

export let acct = null;
export let name = '';
export const color = '';
export let selfHost = '';
export let hostsInfo = {};
export const dk = { creds: new Map() };
let meshHosts = [];
// offline, the remembered mesh's machines, while its login holds
let linkHosts = [];

// --- small helpers, as app.js's ------------------------------------------------------

export const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});
export const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
export const isMobile = () => false;
export const newSid = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
export const shQuote = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
export const jsonPost = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export function humanSize(n) {
  if (n === null || n === undefined) return '';
  const u = ['b', 'k', 'm', 'g', 't'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i ? v.toFixed(1) : v}${u[i]}`;
}
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return; } catch {}
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copy failed');
}
const svgEl = (tag, attrs) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
export function dkGlyph(d, cls = '') {
  const svg = svgEl('svg', { viewBox: '0 0 16 16', class: `ic ${cls}`, 'aria-hidden': 'true' });
  svg.appendChild(svgEl('path', { d }));
  return svg;
}

const NAME_COLORS = ['#9f81cf', '#ce8755', '#6fb3a8', '#93ad7d', '#7fa0c9', '#c98ba0', '#c4ab78'];
export function colorFor(n) {
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length];
}

// --- the editor's file kinds and open tabs ------------------------------------------

const CODE_EXT = {
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
  txt: ['plaintext', '', ''], log: ['plaintext', '', ''], csv: ['plaintext', '', ''], csproj: ['xml', 'xml', ''], sln: ['plaintext', '', ''],
  bat: ['dos', '', 'REM'], cmd: ['dos', '', 'REM'],
};
const CODE_NAMES = { dockerfile: ['dockerfile', '', '#'], makefile: ['makefile', '', '#'], 'cmakelists.txt': ['cmake', '', '#'] };
export function codeLang(p) {
  const base = String(p || '').split('/').pop().toLowerCase();
  const hit = CODE_NAMES[base] || (base.includes('.') && CODE_EXT[base.split('.').pop()]);
  return hit ? { hl: hit[0], check: hit[1], comment: hit[2] } : null;
}
export const editors = new Map();
export const codeTabs = new Map();
export const codeKey = (f) => `${f.host}\n${f.share}\n${f.path}`;
export const codeName = (f) => f.path.split('/').pop() || f.path;
export const lines = new Map();
// sharing a file with a mesh's people is the desktop's; here, nobody to share with
export function shareMenu(anchor, f, done) { done('sharing is in the Phosphorus desktop'); }

// a file run by extension when no settings say otherwise: $f the file, $o an output
export const DK_RUNNERS = {
  c: 'cc "$f" -o "$o" && "$o"', cpp: 'c++ "$f" -o "$o" && "$o"', cc: 'c++ "$f" -o "$o" && "$o"', cxx: 'c++ "$f" -o "$o" && "$o"',
  rs: 'rustc "$f" -o "$o" && "$o"', go: 'go run "$f"', zig: 'zig run "$f"', java: 'java "$f"', swift: 'swift "$f"',
  py: 'python3 "$f"', js: 'node "$f"', mjs: 'node "$f"', ts: 'npx --yes tsx "$f"', sh: 'bash "$f"', bash: 'bash "$f"',
  rb: 'ruby "$f"', pl: 'perl "$f"', php: 'php "$f"', lua: 'lua "$f"', hs: 'runghc "$f"', r: 'Rscript "$f"',
};

// --- hosts: this computer alone offline, the mesh's phosphorus hosts connected -----------

export const homeOnline = () => [...new Set([selfHost, ...meshHosts].filter(Boolean))];
// this computer on a mesh's page, unless it's one of the mesh's own machines
const localExtra = () => (standalone.mode === 'mesh' && standalone.localHost && !meshHosts.includes(standalone.localHost) ? [standalone.localHost] : []);
// the machines Sulfur reaches beside the home's: this computer, and offline a remembered mesh's
export const otherHosts = () => [...localExtra(), ...(standalone.mode === 'local' ? linkHosts : [])];
export function dkLiveHosts() {
  const up = new Set([...homeOnline(), ...otherHosts()]);
  return [...dk.creds.keys()].filter((h) => up.has(h));
}
// a host's API path as this page reaches it: this computer through the app's own
// server under /api/local/ on a mesh's page, a mesh's machine under /api/mesh/ offline
export function hostUrl(host, path) {
  if (localExtra().includes(host)) return `/api/local${path}`;
  if (standalone.mode === 'local' && host !== selfHost && linkHosts.includes(host)) return `/api/mesh${path}`;
  return path;
}
export function dkHomeOn(host) {
  const home = hostsInfo[String(host).toLowerCase()]?.files?.shares?.find((x) => x.home)?.label || '';
  return home.startsWith('/') ? home : '';
}

// --- files: a host's share by its API, the home merged over every host holding it --------

export const HOME = { host: '*', share: 'home', root: 'home', perms: 'rwd' };
export const homeAt = (host) => ({ host, share: 'home', root: 'home', perms: 'rwd' });
const homeWhere = new Map();
export function homePick(rel) {
  const on = homeOnline();
  const has = [...(homeWhere.get(rel) || [])].filter((h) => on.includes(h));
  return has.includes(selfHost) ? selfHost : has[0] || selfHost;
}
const homeHolders = (rel) => {
  const on = homeOnline();
  const has = [...(homeWhere.get(rel) || [])].filter((h) => on.includes(h));
  return has.length ? has : [selfHost];
};
export const filesJoin = (a, b) => (a ? `${a}/${b}` : b);
export const filesParent = (p) => p.split('/').slice(0, -1).join('/');
export const filesApi = (loc, op, params) => {
  const q = new URLSearchParams({ share: loc.share || '0', ...(params || {}) });
  const host = loc.host === '*' ? homePick(params?.path || '') : loc.host;
  return hostUrl(host, `/api/files/${encodeURIComponent(host)}/${op}?${q}`);
};
export async function filesCall(loc, op, init, params) {
  if (loc.host === '*') return homeCall(op, init, params);
  const res = await fetch(filesApi(loc, op, params), init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `status ${res.status}`);
  return body;
}
async function homeList(dir) {
  const got = await Promise.all(homeOnline().map(async (h) => {
    try { return { h, entries: (await filesCall(homeAt(h), 'list', undefined, { path: dir })).entries }; } catch { return { h, entries: [], stale: true }; }
  }));
  const by = new Map();
  for (const { h, entries, stale } of got) {
    for (const e of entries) {
      const m = by.get(e.name) || { ...e, hosts: [], live: [] };
      m.hosts.push(h);
      if (!stale) m.live.push(h);
      m.mtime = Math.max(m.mtime || 0, e.mtime || 0);
      m.dir ||= e.dir;
      by.set(e.name, m);
    }
  }
  const entries = [...by.values()].map((m) => ({ ...m, stale: !m.live.length }));
  for (const e of entries) homeWhere.set(filesJoin(dir, e.name), new Set(e.live.length ? e.live : e.hosts));
  if (!got.some((g) => !g.stale)) throw new Error('no host answered');
  return { path: dir, entries };
}
async function homeCall(op, init, params) {
  if (op === 'list') return homeList(params?.path || '');
  const body = init?.body ? JSON.parse(init.body) : {};
  const rel = op === 'rename' ? body.from : body.path ?? params?.path ?? '';
  const hosts = op === 'mkdir' ? homeOnline() : ['delete', 'rename'].includes(op) ? homeHolders(rel) : [homePick(rel)];
  const out = await Promise.allSettled(hosts.map((h) => filesCall(homeAt(h), op, init, params)));
  const ok = out.find((r) => r.status === 'fulfilled');
  if (!ok) throw out[0].reason;
  if (op === 'delete') homeWhere.delete(rel);
  return ok.value;
}

// uploads in chunks, as the desktop's
const CHUNK = 4 * 1024 * 1024;
export async function putFile(loc, path, body, onSent) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join('');
  const total = body.size;
  let offset = 0;
  let last = {};
  do {
    const end = Math.min(offset + CHUNK, total);
    const res = await fetch(filesApi(loc, 'upload', { path, id, offset, total }), { method: 'POST', body: body.slice(offset, end) });
    last = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(last.error || `status ${res.status}`);
    offset = end;
    onSent?.(offset);
  } while (offset < total);
  return last;
}
export async function copyFile(from, fromPath, to, toPath, tick = () => {}) {
  const res = await fetch(filesApi(from, 'download', { path: fromPath }));
  if (!res.ok) throw new Error(`couldn't read ${fromPath}`);
  const blob = await res.blob();
  tick(0.5);
  await putFile(to, toPath, blob, (sent) => tick(0.5 + (blob.size ? (sent / blob.size) * 0.5 : 0.5)));
}

// a folder shown in the system's own file manager: offline only
export let filesWin = null;

// --- starting: which mode, who's logged in, the hosts' info ---------------------------

async function getJSON(url, init) {
  const r = await fetch(url, { cache: 'no-store', ...init });
  const b = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, ...b };
}

// the app's own server's say, null when the page is a mesh server's own
export async function sidecarInfo() {
  const r = await getJSON('/api/sidecar/info').catch(() => null);
  return r?.ok && r.app === 'sulfur' ? r : null;
}

// offline: this computer as the only host, its user the account
export function bootLocal(info) {
  standalone.mode = 'local';
  standalone.info = info;
  standalone.server = info.server || '';
  standalone.servers = info.servers || [];
  standalone.localHost = info.host;
  acct = { user: info.user, admin: true, boot: false, local: true };
  name = info.user;
  selfHost = info.host;
  hostsInfo = { [info.host]: info.info };
  meshHosts = [];
  dk.creds = new Map([[info.host, { user: info.user, pass: '' }]]);
  filesWin = ({ loc, dir }) => {
    const sh = hostsInfo[selfHost]?.files?.shares?.find((x) => x.id === String(loc.share));
    if (!sh) return;
    const sep = /^[A-Za-z]:/.test(sh.label) ? '\\' : '/';
    const abs = [sh.label.replace(/[\\/]+$/, ''), ...String(dir || '').split('/').filter(Boolean)].join(sep);
    fetch('/api/sidecar/reveal', jsonPost({ path: abs || sh.label })).catch(() => {});
  };
}

// a mesh: its login, then its hosts as the state socket tells them; resolves
// once the first state's in, null while nobody's logged in
export async function bootMesh(server, info = null) {
  standalone.mode = 'mesh';
  standalone.server = server;
  standalone.info = info;
  standalone.servers = info?.servers || [];
  const me = await getJSON('/api/me');
  if (me.status === 401 || !me.ok || me.boot) return null;
  acct = { user: me.user, admin: !!me.admin, boot: false, vault: me.vault || { hosts: {} } };
  standalone.meshUser = me.user;
  standalone.meshVault = me.vault || { hosts: {}, pages: {} };
  name = me.user;
  dk.creds = new Map(Object.entries(acct.vault.hosts || {}).map(([h, c]) => [h, { user: c.user, pass: c.pass }]));
  // this computer beside the mesh's machines, through the app's own server
  standalone.localHost = info?.host || '';
  const local = () => {
    const h = standalone.localHost;
    if (!h || meshHosts.includes(h)) return;
    hostsInfo[h] = info.info;
    if (!dk.creds.has(h)) dk.creds.set(h, { user: info.user, pass: '' });
  };
  standalone.logIn = async (host, user, pass) => {
    acct.vault.hosts = { ...(acct.vault.hosts || {}), [host]: { user, pass } };
    const r = await getJSON('/api/me/vault', jsonPost({ vault: acct.vault }));
    if (!r.ok) throw new Error(r.error || 'not saved');
    dk.creds.set(host, { user, pass });
  };
  await new Promise((resolve) => {
    let first = true;
    const connect = () => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/state`);
      ws.onmessage = (ev) => {
        let st;
        try { st = JSON.parse(ev.data); } catch { return; }
        selfHost = st.self?.host || selfHost;
        hostsInfo = st.hosts && typeof st.hosts === 'object' ? st.hosts : hostsInfo;
        meshHosts = (st.tailnet || []).filter((d) => d.phosphorus).map((d) => d.name).sort();
        local();
        if (first) { first = false; resolve(); }
      };
      ws.onclose = () => { setTimeout(connect, 2000); };
      ws.onerror = () => ws.close();
    };
    connect();
    setTimeout(resolve, 8000);
  });
  return acct;
}

export async function logIn(user, pass) {
  return getJSON('/api/login', jsonPost({ user, pass }));
}

// --- this computer's own dialogs, in Sulfur's desktop app -----------------------------

// a folder or file picked in the system's dialog, as an absolute path; null when cancelled
// or when there's no app around the page to ask
export async function nativePick({ directory = false, title = '', defaultPath = '' } = {}) {
  const t = window.__TAURI__;
  if (!t?.core?.invoke) return null;
  const options = { directory, multiple: false, title: title || undefined, defaultPath: defaultPath || undefined };
  const got = t.dialog?.open ? await t.dialog.open(options) : await t.core.invoke('plugin:dialog|open', { options });
  return typeof got === 'string' ? got : got?.path || null;
}

// an absolute path on this computer as Sulfur's place and path: the home's for the
// user's own folder, a drive's for the rest
// user's own folder, a drive's for the rest; this computer's unless another host's named
export function locate(abs, host = standalone.localHost || selfHost) {
  const shares = hostsInfo[String(host).toLowerCase()]?.files?.shares || [];
  const win = /^[A-Za-z]:/.test(abs);
  const norm = (p) => { const x = String(p).replace(/\\/g, '/').replace(/\/+$/, ''); return win ? x.toLowerCase() : x; };
  const a = norm(abs);
  const rel = (label) => String(abs).replace(/\\/g, '/').replace(/\/+$/, '').slice(norm(label).length).replace(/^\/+/, '');
  const home = shares.find((s) => s.home);
  if (home) {
    const h = norm(home.label);
    // the merged home where the host's part of it, else that host's own home folder
    const merged = homeOnline().includes(host) && (standalone.mode !== 'mesh' || host !== standalone.localHost || meshHosts.includes(host));
    const user = host === standalone.localHost ? standalone.info?.user || acct.user : standalone.meshUser || acct.user;
    // the user's folder by its own name, however the path was cased
    if (a === `${h}/${norm(user)}` || a.startsWith(`${h}/${norm(user)}/`)) return { loc: merged ? HOME : { host, share: String(home.id) }, rel: [user, ...rel(home.label).split('/').slice(1)].join('/') };
  }
  const drive = shares.filter((s) => !s.home).sort((x, y) => y.label.length - x.label.length).find((s) => { const d = norm(s.label); return a === d || a.startsWith(`${d}/`) || (d === '' && a.startsWith('/')); });
  return drive ? { loc: { host, share: String(drive.id) }, rel: rel(drive.label) } : null;
}
standalone.nativePick = nativePick;
standalone.locate = locate;

// --- a mesh remembered while offline: its API under /api/mesh/ ------------------------

// a mesh call's path: offline the remembered mesh's, through the app's own server
export const meshUrl = (path) => (standalone.mode === 'local' ? `/api/mesh${path}` : path);

// who the remembered mesh has logged in here, null if nobody (or no mesh)
export async function meshMe() {
  if (standalone.mode === 'local' && !standalone.server) return null;
  const r = await getJSON(meshUrl('/api/me')).catch(() => null);
  if (!r?.ok || r.boot) { standalone.meshUser = ''; unlinkHosts(); return null; }
  standalone.meshUser = r.user;
  standalone.meshVault = r.vault || { hosts: {}, pages: {} };
  linkMesh();
  return r;
}

// offline, the mesh's machines beside this computer's: its state's hosts, the
// user's saved logins for them, each reached through the app's own server
let linkWs = null;
function linkMesh() {
  if (standalone.mode !== 'local' || !standalone.meshUser) return;
  for (const [h, c] of Object.entries(standalone.meshVault?.hosts || {})) if (h !== selfHost && c?.user) dk.creds.set(h, { user: c.user, pass: c.pass });
  if (linkWs) return;
  const connect = () => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/mesh/api/state`);
    linkWs = ws;
    ws.onmessage = (ev) => {
      let st;
      try { st = JSON.parse(ev.data); } catch { return; }
      const hs = (st.tailnet || []).filter((d) => d.phosphorus && d.name !== selfHost).map((d) => d.name).sort();
      const was = linkHosts.join('\n');
      linkHosts = hs;
      for (const h of hs) if (st.hosts?.[h]) hostsInfo[h] = st.hosts[h];
      if (was !== hs.join('\n')) standalone.onHosts?.();
    };
    ws.onclose = () => {
      if (linkWs !== ws) return;
      linkWs = null;
      if (standalone.mode === 'local' && standalone.meshUser) setTimeout(() => { if (!linkWs && standalone.meshUser) connect(); }, 3000);
    };
    ws.onerror = () => ws.close();
  };
  connect();
}
function unlinkHosts() {
  const ws = linkWs;
  linkWs = null;
  ws?.close();
  for (const h of linkHosts) { dk.creds.delete(h); if (h !== selfHost) delete hostsInfo[h]; }
  const had = linkHosts.length;
  linkHosts = [];
  if (had) standalone.onHosts?.();
}
export async function meshLogIn(user, pass) {
  const r = await getJSON(meshUrl('/api/login'), jsonPost({ user, pass }));
  if (r.ok) await meshMe();
  return r;
}
export async function meshLogOut() {
  await getJSON(meshUrl('/api/logout'), jsonPost({})).catch(() => null);
  standalone.meshUser = '';
  unlinkHosts();
}
// the app's own server told: link (remember a mesh, stay offline), mesh (work on it), local
export async function sidecarMode(mode, server = '') {
  const r = await getJSON('/api/sidecar/mode', jsonPost({ mode, server }));
  if (r.ok && r.server !== undefined) standalone.server = r.server;
  return r;
}
standalone.meshUrl = meshUrl;
standalone.meshMe = meshMe;
standalone.meshLogIn = meshLogIn;
standalone.meshLogOut = meshLogOut;
standalone.sidecarMode = sidecarMode;
