// a question over a view: a window's inside it, the desktop's over the page

import type { FmView } from '../../features/home/home.ts';
import { el } from '../../lib/dom.ts';

// text back, true for a yes, null for no
export function dkAsk(
  v: FmView,
  {
    title,
    message,
    value,
    action,
    danger,
  }: { title: string; message: string; value?: string; action: string; danger?: boolean },
): Promise<string | true | null> {
  return new Promise((resolve) => {
    const veil = el('div', `fm-veil${v.box === document.body ? ' page-veil' : ''}`);
    const box = el('form', 'fm-ask');
    const input =
      value != null && Object.assign(el('input'), { value, spellcheck: false, autocomplete: 'off' as const });
    const no = Object.assign(el('button', 'btn', 'cancel'), { type: 'button' });
    const go = Object.assign(el('button', danger ? 'btn danger' : 'btn primary', action), { type: 'submit' });
    const acts = el('div', 'update-actions');
    acts.append(no, go);
    box.append(el('div', 'fm-ask-title', title), el('p', '', message), ...(input ? [input] : []), acts);
    veil.appendChild(box);
    v.box.appendChild(veil);
    const end = (r: string | true | null) => {
      veil.remove();
      v.focus();
      resolve(r);
    };
    no.addEventListener('click', () => end(null));
    veil.addEventListener('pointerdown', (e) => e.target === veil && end(null));
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      const t = input ? input.value.trim() : '';
      if (input && /[\\/]/.test(t)) return void (input.setCustomValidity('no slashes'), input.reportValidity());
      end(input ? t || null : true);
    });
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') end(null);
    });
    if (input) {
      input.addEventListener('input', () => input.setCustomValidity(''));
      input.focus();
      // the name picked, not its extension
      const dot = value!.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : value!.length);
    } else go.focus();
  });
}
