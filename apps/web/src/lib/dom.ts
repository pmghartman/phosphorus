// the page's elements and glyphs: a tag made with a class and text, an svg's, the icon
// groups the stylesheet strokes, and the small boxes asked of any user
import { iconGroup } from './icons.ts';
import { copyText } from './util.ts';

export const stash = document.getElementById('dk-stash')!;

// one list for good, each matchMedia() call another for the engine to re-evaluate
export const mobileQuery = matchMedia('(max-width: 720px)');
export function isMobile(): boolean {
  return mobileQuery.matches;
}
export const modalOpen = () => !!document.querySelector('.modal:not([hidden])');

export const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string | number | null,
): HTMLElementTagNameMap[K] =>
  Object.assign(
    document.createElement(tag),
    cls ? { className: cls } : {},
    text != null ? { textContent: String(text) } : {},
  );

export const SVG_NS = 'http://www.w3.org/2000/svg';
export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  return el;
}

// --- the icon groups, read through a proxy so a set change shows on the next draw
export const ICONS = iconGroup('files');
export const DK_GLYPHS = iconGroup('glyphs');
export const DK_UI = iconGroup('ui');

export function icon(name: string): SVGSVGElement {
  const svg = svgEl('svg', { viewBox: '0 0 16 16', class: `ic ic-${name}`, 'aria-hidden': 'true' });
  svg.appendChild(svgEl('path', { d: ICONS[name]! }));
  return svg;
}

// the frontend's own stroked glyphs, a phrase of path data each
export function dkGlyph(d: string, cls = ''): SVGSVGElement {
  const svg = svgEl('svg', { viewBox: '0 0 16 16', class: `ic ${cls}`, 'aria-hidden': 'true' });
  svg.appendChild(svgEl('path', { d }));
  return svg;
}

export function gameIcon(kind: string): SVGSVGElement {
  const icon = svgEl('svg', { viewBox: '0 0 10 10', 'aria-hidden': 'true' });
  if (kind === 'play') icon.appendChild(svgEl('path', { d: 'M 2.5 1.5 L 8.5 5 L 2.5 8.5 Z' }));
  if (kind === 'pause') {
    icon.appendChild(svgEl('rect', { x: 2, y: 1.5, width: 2, height: 7 }));
    icon.appendChild(svgEl('rect', { x: 6, y: 1.5, width: 2, height: 7 }));
  }
  if (kind === 'busy') icon.appendChild(svgEl('path', { d: 'M 5 1.5 A 3.5 3.5 0 1 1 1.5 5', class: 'game-spin' }));
  if (kind === 'copy') {
    icon.appendChild(svgEl('rect', { x: 3.5, y: 3.5, width: 5, height: 5, class: 'stroke' }));
    icon.appendChild(svgEl('path', { d: 'M 1.5 6.5 V 1.5 H 6.5', class: 'stroke' }));
  }
  if (kind === 'check') icon.appendChild(svgEl('path', { d: 'M 1.5 5.5 L 4 8 L 8.5 2', class: 'stroke' }));
  return icon;
}

// inline cylinder, sized to the text beside it, stroked in currentColor
export function databaseIcon(): SVGSVGElement {
  const x = 0.5;
  const y = 0.5;
  const w = 6;
  const h = 7;
  const ry = 1.5;
  const icon = svgEl('svg', { viewBox: '0 0 7 8', class: 'db-icon', 'aria-hidden': 'true' });
  icon.appendChild(svgEl('ellipse', { cx: x + w / 2, cy: y + ry, rx: w / 2, ry }));
  icon.appendChild(
    svgEl('path', { d: `M ${x} ${y + ry} V ${y + h - ry} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + h - ry} V ${y + ry}` }),
  );
  icon.appendChild(svgEl('path', { d: `M ${x} ${y + h / 2} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + h / 2}` }));
  return icon;
}

// a copy button on each code block of a chat line, its text as written
export function codeCopies(root: HTMLElement): void {
  for (const pre of root.querySelectorAll('pre')) {
    if (pre.parentElement?.classList.contains('code-wrap')) continue;
    const wrap = el('div', 'code-wrap');
    pre.replaceWith(wrap);
    const copy = Object.assign(el('button', 'game-copy code-copy'), {
      type: 'button',
      title: 'copy',
      ariaLabel: 'copy',
    });
    copy.appendChild(gameIcon('copy'));
    copy.addEventListener('click', (e) => {
      e.stopPropagation();
      copyText(pre.innerText.replace(/\n$/, ''))
        .then(() => {
          copy.replaceChildren(gameIcon('check'));
          setTimeout(() => copy.replaceChildren(gameIcon('copy')), 1200);
        })
        .catch(() => {});
    });
    wrap.append(pre, copy);
  }
}

// a box over the whole page, any user's: true for its action, false for cancel or esc
export function pageAsk({
  title,
  message,
  action = 'ok',
  danger = false,
  cancel = true,
}: {
  title: string;
  message: string;
  action?: string;
  danger?: boolean;
  cancel?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const veil = el('div', 'fm-veil page-veil');
    const box = el('form', 'fm-ask');
    const go = Object.assign(el('button', danger ? 'danger' : 'primary', action), { type: 'submit' });
    const acts = el('div', 'update-actions');
    const end = (v: boolean) => {
      veil.remove();
      resolve(v);
    };
    if (cancel) {
      const no = Object.assign(el('button', '', 'cancel'), { type: 'button' });
      no.addEventListener('click', () => end(false));
      acts.append(no);
    }
    acts.append(go);
    box.append(el('div', 'fm-ask-title', title), el('p', '', message), acts);
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      end(true);
    });
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') end(false);
    });
    veil.addEventListener('pointerdown', (e) => {
      if (e.target === veil) end(false);
    });
    veil.appendChild(box);
    document.body.appendChild(veil);
    go.focus();
  });
}

// masked by css, never a password field, so password managers skip it
export function noFill(input: HTMLInputElement, secret?: boolean): HTMLInputElement {
  Object.assign(input, { type: 'text', autocomplete: 'off', name: `nf-${Math.random().toString(36).slice(2)}` });
  for (const [k, v] of [
    ['data-1p-ignore', ''],
    ['data-lpignore', 'true'],
    ['data-bwignore', ''],
    ['data-form-type', 'other'],
  ] as const)
    input.setAttribute(k, v);
  if (secret) input.classList.add('no-fill-secret');
  return input;
}

// masked here, not by the browser: only bullets in the field, so no password
// manager takes it for a password and offers to save it
export function maskField(
  input: HTMLInputElement,
  onEdit?: () => void,
): { get: () => string; set: (t: string, caret?: number) => void } {
  let text = '';
  const set = (t: string, caret = t.length) => {
    text = t;
    input.value = '•'.repeat(t.length);
    if (document.activeElement === input) input.setSelectionRange(caret, caret);
  };
  input.addEventListener('beforeinput', (e) => {
    // IME composition can't be cancelled, left to the input handler
    if (e.inputType === 'insertCompositionText') return;
    e.preventDefault();
    let start = input.selectionStart!;
    let end = input.selectionEnd!;
    let ins = '';
    if (e.inputType.startsWith('insert')) {
      ins = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
    } else if (start === end) {
      if (e.inputType.includes('Backward'))
        start = e.inputType === 'deleteContentBackward' ? Math.max(0, start - 1) : 0;
      else end = e.inputType === 'deleteContentForward' ? end + 1 : text.length;
    }
    ins = ins.replace(/[\r\n]/g, '');
    set(text.slice(0, start) + ins + text.slice(end), start + ins.length);
    onEdit?.();
  });
  // a composition's committed text, re-masked
  input.addEventListener('input', (e) => {
    const ie = e as InputEvent;
    if (ie.inputType !== 'insertCompositionText' || ie.isComposing) return;
    const typed = input.value.replace(/•/g, '');
    const at = input.value.indexOf(typed);
    set(text.slice(0, at) + typed + text.slice(at), at + typed.length);
  });
  return { get: () => text, set };
}
