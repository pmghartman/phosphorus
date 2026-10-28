// dialogs: a question, a choice

import { type Choice, type Fm } from '../../features/home/home.ts';
import { el } from '../../lib/dom.ts';

// a question inside the window: text back, true for a yes, null for no

export function dkAsk(
  fm: Fm,
  {
    title,
    message,
    value,
    action,
    danger,
  }: { title: string; message: string; value?: string; action: string; danger?: boolean },
): Promise<string | true | null> {
  return new Promise((resolve) => {
    const veil = el('div', 'fm-veil');
    const box = el('form', 'fm-ask');
    const input =
      value != null && Object.assign(el('input'), { value, spellcheck: false, autocomplete: 'off' as const });
    const no = Object.assign(el('button', '', 'cancel'), { type: 'button' });
    const go = Object.assign(el('button', danger ? 'danger' : 'primary', action), { type: 'submit' });
    const acts = el('div', 'update-actions');
    acts.append(no, go);
    box.append(el('div', 'fm-ask-title', title), el('p', '', message), ...(input ? [input] : []), acts);
    veil.appendChild(box);
    fm.w.body.appendChild(veil);
    const end = (v: string | true | null) => {
      veil.remove();
      fm.main.focus({ preventScroll: true });
      resolve(v);
    };
    no.addEventListener('click', () => end(null));
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      end(input ? input.value.trim() || null : true);
    });
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') end(null);
    });
    if (input) {
      input.focus();
      // the name picked, not its extension
      const dot = value!.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : value!.length);
    } else go.focus();
  });
}

// one of a few choices inside the window, its value back, null for none;
// [label, value, why disabled]
export function dkChoose(
  fm: Fm,
  { title, message, options }: { title: string; message: string; options: Choice[] },
): Promise<string | null> {
  return new Promise((resolve) => {
    const veil = el('div', 'fm-veil');
    const box = el('div', 'fm-ask');
    const list = el('div', 'fm-choices');
    const end = (v: string | null) => {
      veil.remove();
      fm.main.focus({ preventScroll: true });
      resolve(v);
    };
    for (const [label, value, why] of options) {
      const b = Object.assign(el('button', 'fm-choice', label), { type: 'button', disabled: !!why });
      if (why) b.append(el('span', 'fm-choice-why', why));
      b.addEventListener('click', () => end(value));
      list.appendChild(b);
    }
    const no = Object.assign(el('button', '', 'cancel'), { type: 'button' });
    no.addEventListener('click', () => end(null));
    const acts = el('div', 'update-actions');
    acts.append(no);
    box.append(el('div', 'fm-ask-title', title), el('p', '', message), list, acts);
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') end(null);
    });
    veil.appendChild(box);
    fm.w.body.appendChild(veil);
    (list.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus();
  });
}
