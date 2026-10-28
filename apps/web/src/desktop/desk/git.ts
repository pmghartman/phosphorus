// git: forgejo itself, the master host in the title
import { DK_UI, dkGlyph, el } from '../../lib/dom.ts';
import { activeConnections, drawMesh, serviceKey, serviceUrl, startPulseLoop } from '../../features/mesh/mesh.ts';
import { dk, st } from '../../lib/state.ts';
import { dkClose, dkFocus, dkNav, dkSize, dkWin, type NavFrame } from '../windows.ts';

export const gitMaster = () => st.gitHostsList.find((h) => h.role === 'master' && h.reachable)?.host || st.gitRoute?.host || '';

export function dkGit() {
  if (!st.gitRoute) return;
  const w = dkWin('app:git', 'git', gitMaster(), 'svc dk-git');
  if (!w) return;
  const pop = Object.assign(el('button', 'dk-out'), { type: 'button', title: 'open in a browser tab', ariaLabel: 'open in a browser tab' });
  pop.appendChild(dkGlyph(DK_UI.pop!));
  pop.addEventListener('click', () => { if (w.git!.url) window.open(w.git!.url, '_blank', 'noopener'); });
  w.head.querySelector('.dk-btns')!.prepend(pop);
  w.git = { url: '', master: '', conn: null };
  dkSize(w, 1040, 640);
  dkGitFrame();
  w.onClose = () => { if (w.git!.conn) w.git!.conn.win.closed = true; };
  dkFocus(w);
}

// the frame kept while its url holds, the title following the master
export function dkGitFrame() {
  const w = dk.wins.get('app:git');
  if (!w) return;
  const master = gitMaster();
  if (master !== w.git!.master) {
    w.git!.master = master;
    const title = w.head.querySelector('.dk-title')!;
    let sub = title.querySelector('.dk-sub');
    if (!sub) sub = title.appendChild(el('span', 'dk-sub'));
    sub.textContent = master ? ` ${master}` : '';
    w.task.title = master ? `git ${master}` : 'git';
  }
  const url = st.gitRoute ? serviceUrl(st.gitRoute) : '';
  if (url === w.git!.url) return;
  w.git!.url = url;
  if (w.git!.conn) w.git!.conn.win.closed = true;
  w.git!.conn = null;
  if (!url) {
    w.body.replaceChildren(el('p', 'dk-note', 'git down'));
    return;
  }
  const frame: NavFrame = Object.assign(el('iframe', 'dk-frame'), { src: url, title: 'git', allow: 'clipboard-read; clipboard-write; fullscreen' });
  w.body.replaceChildren(frame);
  dkNav(w, frame);
  // lit on the mesh graph as the service's window is
  w.git!.conn = { win: { closed: false }, host: st.gitRoute!.host, name: st.gitRoute!.name };
  activeConnections.set(serviceKey(st.gitRoute!), w.git!.conn);
  startPulseLoop();
  drawMesh();
  w.onFocus = () => frame.contentWindow?.focus();
}

// a press inside a service's frame never reaching the page, its window raised by the page's blur
addEventListener('blur', () => setTimeout(() => {
  const f = document.activeElement;
  const w = f?.classList.contains('dk-frame') && [...dk.wins.values()].find((o) => o.body.contains(f));
  if (w && !w.node.classList.contains('focused')) dkFocus(w);
}));

// shells ended with the page, not left for their grace
addEventListener('pagehide', (e) => { if (!(e as PageTransitionEvent).persisted) for (const w of [...dk.wins.values()]) if (w.kind === 'term') dkClose(w, true); });
