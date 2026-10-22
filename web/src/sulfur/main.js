// Sulfur on its own: its desktop app's page, or /sulfur/ on a Phosphorus server.
// No desktop around it, only its window: the workbench filling it, its title
// bar the window's own, as VS Code's is. It opens ready to work offline on this
// computer's files; a mesh is connected to from it, and remembered
import { standalone, sidecarInfo, bootLocal, bootMesh, meshMe, el, dkGlyph } from './host.js';
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
// the app closed for its update to install, nothing asked
standalone.quit = () => appWin?.destroy();

// --- the workbench, offline at once or on the mesh last chosen ---------------------------

function workbench(open) {
  const w = frame('Sulfur');
  w.node.classList.add('sx-wb');
  ide = ideStart(w, open);
  window.addEventListener('focus', () => ide?.focus());
}

async function start() {
  const info = await sidecarInfo();
  const q = new URLSearchParams(location.search);
  history.replaceState(null, '', location.pathname);
  // a mesh server's own page: its login is its own, as the desktop's
  if (!info) {
    const me = await bootMesh('');
    if (me) workbench(null); else location.replace('/?next=' + encodeURIComponent(location.href));
    return;
  }
  // Always start on this computer; the remembered mesh contributes its hosts.
  bootLocal({ ...info, mode: 'local' });
  workbench(q.has('welcome') ? { welcome: true } : null);
  // An unreachable mesh must never delay this computer's editor.
  meshMe().catch(() => null).finally(() => standalone.onMesh?.());
}

start().catch((err) => {
  root.textContent = `Sulfur couldn't start: ${err.message}`;
});
