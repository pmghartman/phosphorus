// Sulfur on its own: its desktop app's page, or /sulfur/ on a Phosphorus server.
// No desktop around it, only its window: a start pane to pick offline or a
// mesh, a login for a mesh, then the workbench filling the window, its title
// bar the window's own, as VS Code's is
import { standalone, sidecarInfo, bootLocal, bootMesh, logIn, el, dkGlyph } from './host.js';
import { ideStart } from '../apps/sulfur.js';

const tauri = window.__TAURI__;
const appWin = tauri?.window?.getCurrentWindow?.() || null;
standalone.app = !!appWin;
const root = document.getElementById('sulfur');
document.documentElement.classList.toggle('sx-mac', standalone.mac && standalone.app);
document.documentElement.classList.toggle('sx-app', standalone.app);

// the window's buttons, as VS Code draws them on Windows and Linux; a Mac's are its own
const UI = { min: 'M4 8.5h8', max: 'M4 4h8v8H4z', restore: 'M5.5 3.5h7v7M3.5 5.5h7v7h-7z', close: 'M4 4l8 8M12 4l-8 8' };

// the window: its head the title bar, dragged by any bare part of it
function frame(title) {
  const node = el('div', 'dk-win ide-win sx-win');
  const head = el('div', 'dk-head');
  const name = el('span', 'dk-title');
  name.append(el('span', 'tab-label', title));
  const btns = el('span', 'dk-btns');
  const b = (cls, d, label, fn) => {
    const x = Object.assign(el('button', cls), { type: 'button', title: label, ariaLabel: label });
    x.append(dkGlyph(d));
    x.addEventListener('click', fn);
    return x;
  };
  const max = b('dk-max', UI.max, 'Maximize', () => appWin?.toggleMaximize());
  btns.append(b('dk-min', UI.min, 'Minimize', () => appWin?.minimize()), max, b('dk-close', UI.close, 'Close', () => closeWindow()));
  btns.hidden = !appWin || standalone.mac;
  head.append(name, btns);
  const body = el('div', 'dk-body');
  node.append(head, body);
  root.replaceChildren(node);
  if (appWin) {
    const bare = (t) => !t.closest('button, input, select, textarea, a, [role="menuitem"], [role="menubar"] > *, .ide-cc');
    head.addEventListener('mousedown', (e) => { if (e.button === 0 && e.detail === 1 && bare(e.target)) appWin.startDragging(); });
    head.addEventListener('dblclick', (e) => { if (bare(e.target)) appWin.toggleMaximize(); });
    const paintMax = async () => {
      const on = await appWin.isMaximized().catch(() => false);
      max.replaceChildren(dkGlyph(on ? UI.restore : UI.max));
      max.title = on ? 'Restore' : 'Maximize';
      document.documentElement.classList.toggle('sx-max', on);
    };
    appWin.onResized?.(paintMax);
    paintMax();
  }
  // the title the window's, so the task bar and the dock say what's open
  new MutationObserver(() => {
    const t = name.textContent || 'Sulfur';
    document.title = t;
    appWin?.setTitle(t).catch(() => {});
  }).observe(name, { subtree: true, characterData: true, childList: true });
  document.title = title;
  return { key: 'app:sulfur', node, head, body, task: el('button') };
}

let ide = null;
function closeWindow() {
  if (ide?.holdClose(() => appWin.destroy())) return;
  appWin?.destroy();
}
// Alt+F4, the task bar's close: unsaved files asked about first
appWin?.onCloseRequested?.((e) => {
  if (ide?.holdClose(() => appWin.destroy())) e.preventDefault();
});

// --- the start pane: offline, or a mesh -------------------------------------------------

const IC = {
  local: 'M2 3h12v8H2zM5.5 13.5h5M8 11v2.5',
  remote: 'M1.5 5.5L5 9 1.5 12.5M14.5 3.5L11 7l3.5 3.5',
  mesh: 'M8 2.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM3 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM13 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM7.2 5.2L3.8 10.2M8.8 5.2l3.4 5M4.5 11.5h7',
  build: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  folder: 'M1.5 3.5h4l1.2 1.5h7.8v8h-13z',
  agent: 'M8 1.5l1.4 5.1 5.1 1.4-5.1 1.4L8 14.5l-1.4-5.1L1.5 8l5.1-1.4z',
  close: 'M4 4l8 8M12 4l-8 8',
};
const ic = (k, cls = '') => dkGlyph(IC[k], `sx-ic ${cls}`);
const hostOf = (s) => String(s || '').replace(/^https?:\/\//, '');

// the app's mark, as its icon draws it
function mark(cls) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 1024 1024');
  s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = MARK;
  return s;
}
const MARK = `<defs><linearGradient id="sxg" x1=".15" y1="0" x2=".85" y2="1"><stop offset="0" stop-color="#fff07a"/><stop offset=".45" stop-color="#ffc22e"/><stop offset="1" stop-color="#ff7417"/></linearGradient>
<linearGradient id="sxs" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".5"/><stop offset=".42" stop-color="#fff" stop-opacity=".06"/><stop offset=".43" stop-color="#fff" stop-opacity="0"/></linearGradient>
<clipPath id="sxc"><rect x="100" y="100" width="824" height="824" rx="186"/></clipPath></defs>
<rect x="100" y="100" width="824" height="824" rx="186" fill="url(#sxg)"/>
<ellipse cx="512" cy="150" rx="560" ry="420" fill="url(#sxs)" clip-path="url(#sxc)"/>
<g fill="none" stroke="#3a1c05" stroke-linecap="round" stroke-linejoin="round" stroke-width="66"><path d="M512 238 L690 536 L334 536 Z"/><path d="M512 536 V796 M402 676 H622"/></g>`;

function startPane(info, why = '') {
  const w = frame('Sulfur');
  const page = el('div', 'ide sx-start');
  const col = el('div', 'sx-start-col');
  const head = el('div', 'sx-hero');
  head.append(mark('sx-hero-mark'));
  const words = el('div');
  words.append(el('h1', '', 'Sulfur'), el('p', 'sx-sub', 'Your code, on this computer or across your machines'));
  head.append(words);

  const left = el('div', 'sx-col');
  left.append(el('h2', '', 'Start'));
  const msg = el('p', 'sx-msg');
  msg.setAttribute('role', 'status');
  const say = (t, bad = false) => { msg.textContent = t; msg.classList.toggle('bad', bad); };
  const choose = async (body, busy) => {
    for (const b of page.querySelectorAll('button')) b.disabled = true;
    say(busy);
    const r = await fetch('/api/sidecar/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch((e) => ({ ok: false, json: async () => ({ error: e.message }) }));
    const b = await r.json().catch(() => ({}));
    if (!r.ok) {
      for (const x of page.querySelectorAll('button')) x.disabled = false;
      say(b.error || 'That didn’t work.', true);
      return;
    }
    location.replace('/sulfur/');
  };
  const link = (k, label, detail, fn) => {
    const a = Object.assign(el('button', 'sx-link'), { type: 'button' });
    a.append(ic(k), el('span', 'sx-link-label', label));
    if (detail) a.append(el('span', 'sx-link-detail', detail));
    a.addEventListener('click', fn);
    return a;
  };
  const offline = link('local', 'Start Offline', `Open folders on ${info.host}, with its own terminals and compilers`, () => choose({ mode: 'local' }, 'Starting…'));
  const form = Object.assign(el('form', 'sx-connect'), { hidden: true });
  const input = Object.assign(el('input', 'ide-input'), { placeholder: 'A host of your mesh, like d6 or 100.64.0.7', spellcheck: false, autocomplete: 'off' });
  input.setAttribute('aria-label', 'Phosphorus server');
  const go = Object.assign(el('button', 'ide-button'), { type: 'submit', textContent: 'Connect' });
  form.append(input, go);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!input.value.trim()) { input.focus(); return; }
    choose({ mode: 'mesh', server: input.value.trim() }, `Connecting to ${input.value.trim()}…`);
  });
  const connect = link('mesh', 'Connect to a Phosphorus Mesh…', 'Your machines, their homes and the mesh’s agents', () => {
    form.hidden = false;
    input.value = hostOf(info.server || info.servers?.[0] || '');
    input.focus();
    input.select();
  });
  left.append(offline, connect, form, msg);

  left.append(el('h2', '', 'Recent'));
  const recent = el('div', 'sx-recent');
  const row = (k, label, detail, fn, forget) => {
    const r = Object.assign(el('div', 'sx-recent-row'), { tabIndex: 0 });
    r.append(ic(k), el('span', 'sx-link-label', label), el('span', 'sx-link-detail', detail));
    if (forget) {
      const x = Object.assign(el('button', 'sx-forget'), { type: 'button', title: 'Remove from Recent' });
      x.append(ic('close'));
      x.addEventListener('click', (e) => { e.stopPropagation(); forget(r); });
      r.append(x);
    }
    r.addEventListener('click', fn);
    r.addEventListener('keydown', (e) => { if (e.key === 'Enter') fn(); });
    return r;
  };
  recent.append(row('local', info.host, 'this computer, offline', () => choose({ mode: 'local' }, 'Starting…')));
  for (const s of info.servers || []) {
    recent.append(row('remote', hostOf(s), 'Phosphorus mesh', () => choose({ mode: 'mesh', server: s }, `Connecting to ${hostOf(s)}…`), (r) => {
      fetch('/api/sidecar/forget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ server: s }) }).catch(() => {});
      r.remove();
    }));
  }
  left.append(recent);

  // what's in it, as VS Code's walkthroughs sit beside its start
  const right = el('div', 'sx-col');
  right.append(el('h2', '', 'What’s Here'));
  const card = (k, t, d) => {
    const c = el('div', 'sx-card');
    c.append(ic(k, 'sx-card-ic'));
    const x = el('div');
    x.append(el('div', 'sx-card-title', t), el('div', 'sx-card-detail', d));
    c.append(x);
    return c;
  };
  right.append(
    card('build', 'Builds on your own compilers', 'Ctrl+B finds MSVC, .NET, CMake, gcc, Cargo, Go and more on the machine that has the project, and builds there.'),
    card('folder', 'Projects anywhere', 'Start one from a template, open any folder, and copy or move projects between machines.'),
    card('agent', 'Agents in the editor', 'Connected to a mesh, its models, Claude Code and opencode edit your code where you can watch.'),
  );
  const cols = el('div', 'sx-cols');
  cols.append(left, right);
  col.append(head, cols);
  if (why) say(why, true);
  page.append(col);
  const foot = el('div', 'sx-foot', `Sulfur ${info.version}`);
  page.append(foot);
  w.body.append(page);
  offline.focus();
}

// --- a mesh's login -----------------------------------------------------------------

function loginPane(server) {
  const w = frame('Sulfur');
  const page = el('div', 'ide sx-start sx-login');
  const box = Object.assign(el('form', 'sx-login-box'), { method: 'post' });
  box.append(mark('sx-login-mark'), el('h1', '', 'Log in'), el('p', 'sx-sub', `to ${hostOf(server) || location.host}, your Phosphorus mesh`));
  const user = Object.assign(el('input', 'ide-input'), { placeholder: 'User', autocomplete: 'username', spellcheck: false });
  const pass = Object.assign(el('input', 'ide-input'), { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
  const go = Object.assign(el('button', 'ide-button'), { type: 'submit', textContent: 'Log In' });
  const msg = el('p', 'sx-msg bad');
  box.append(user, pass, go, msg);
  if (standalone.app || server) {
    const other = Object.assign(el('button', 'ide-link'), { type: 'button', textContent: 'Work offline or pick another server' });
    other.addEventListener('click', () => location.replace('/sulfur/?start'));
    box.append(other);
  }
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    go.disabled = true;
    msg.textContent = '';
    const r = await logIn(user.value.trim(), pass.value);
    go.disabled = false;
    if (!r.ok) { msg.textContent = r.error || 'No answer.'; pass.value = ''; pass.focus(); return; }
    location.replace('/sulfur/');
  });
  page.append(box);
  w.body.append(page);
  user.focus();
}

// --- the workbench ---------------------------------------------------------------------

function workbench() {
  const w = frame('Sulfur');
  w.node.classList.add('sx-wb');
  ide = ideStart(w, null);
  window.addEventListener('focus', () => ide?.focus());
}

async function start() {
  const info = await sidecarInfo();
  const ask = new URLSearchParams(location.search).has('start');
  if (info && (!info.mode || ask)) { startPane(info); return; }
  if (info?.mode === 'local') { bootLocal(info); workbench(); return; }
  // a mesh: through the app's own server, or this page a mesh server's own
  const me = await bootMesh(info?.server || '');
  if (!me) { loginPane(info?.server || ''); return; }
  workbench();
}

start().catch((err) => {
  root.textContent = `Sulfur couldn't start: ${err.message}`;
});
