// the viewer
import { el } from '../../lib/dom.ts';
import { filesApi, fmKind, type Loc } from '../../features/home/home.ts';
import { dkFocus, dkWin } from '../../desktop/windows.ts';

// anything the browser shows itself: pictures, video, sound, pdfs, else its text

export function dkViewer(loc: Loc, rel: string): void {
  const w = dkWin(`view:${loc.host}\n${loc.share}\n${rel}`, rel.split('/').pop()!, loc.host, 'svc');
  if (!w) return;
  const src = filesApi(loc, 'download', { path: rel, inline: 1 });
  // a picture fit to the window, a click for its own size and back
  if (fmKind({ name: rel }) === 'image') {
    const box = el('div', 'dk-imgview');
    const img = Object.assign(el('img'), { src, alt: rel, draggable: false });
    box.addEventListener('click', () => box.classList.toggle('full'));
    box.appendChild(img);
    w.body.appendChild(box);
    dkFocus(w);
    return;
  }
  const frame = Object.assign(el('iframe', 'dk-frame'), { src, title: rel });
  w.body.appendChild(frame);
  w.onClose = () => { frame.src = 'about:blank'; };
  dkFocus(w);
}
