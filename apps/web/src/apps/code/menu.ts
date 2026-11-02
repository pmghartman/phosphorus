// popovers over the app: a chip's choices, the folder picker; one open at a time,
// under its anchor (over it when there's no room), shut by escape or a press outside

import { el } from '../../lib/dom.ts';
import { root } from './frame.ts';
import { GL, svg } from './state.ts';

// one choice of a chip's menu: a group starts a titled section, sub a line under the label
export interface Choice {
  id: string;
  label: string;
  sub?: string;
  off?: boolean;
  group?: string;
  warn?: boolean;
}

let open: { pop: HTMLElement; anchor: HTMLElement; shut: () => void } | null = null;

export const popOpen = (anchor?: HTMLElement) => !!open && (!anchor || open.anchor === anchor);
// a popover open on an anchor inside box
export const popIn = (box: HTMLElement | null) => !!open && !!box?.contains(open.anchor);

export function popClose() {
  open?.shut();
}

// pop a box under anchor, inside the app's frame; done told when it shuts
export function popOver(anchor: HTMLElement, body: HTMLElement, cls = '', done?: () => void): HTMLElement {
  popClose();
  const pop = el('div', `cd-pop ${cls}`.trim());
  pop.append(body);
  root.append(pop);
  anchor.setAttribute('aria-expanded', 'true');
  const place = () => {
    if (!anchor.isConnected) {
      shut();
      return;
    }
    const fr = root.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    const w = Math.min(pop.offsetWidth, fr.width - 16);
    const left = Math.max(8, Math.min(a.left - fr.left, fr.width - w - 8));
    const below = fr.bottom - a.bottom - 8;
    const above = a.top - fr.top - 8;
    const h = pop.offsetHeight;
    pop.style.left = `${left}px`;
    if (h <= below || below >= above) {
      pop.style.top = `${a.bottom - fr.top + 4}px`;
      pop.style.bottom = '';
      pop.style.maxHeight = `${Math.max(120, below)}px`;
    } else {
      pop.style.top = '';
      pop.style.bottom = `${fr.bottom - a.top + 4}px`;
      pop.style.maxHeight = `${Math.max(120, above)}px`;
    }
  };
  const away = (e: PointerEvent) => {
    if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) shut();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    e.preventDefault();
    shut();
    anchor.focus();
  };
  const ro = new ResizeObserver(place);
  const shut = () => {
    if (open?.pop !== pop) return;
    open = null;
    ro.disconnect();
    pop.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', away, true);
    document.removeEventListener('keydown', key, true);
    done?.();
  };
  open = { pop, anchor, shut };
  document.addEventListener('pointerdown', away, true);
  document.addEventListener('keydown', key, true);
  ro.observe(pop);
  ro.observe(root);
  place();
  return pop;
}

// up and down over a list's enabled buttons, from the one focused
export function arrows(list: HTMLElement, e: KeyboardEvent): boolean {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return false;
  const bs = [...list.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  if (!bs.length) return false;
  e.preventDefault();
  const i = bs.indexOf(document.activeElement as HTMLButtonElement);
  const n =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? bs.length - 1
        : e.key === 'ArrowDown'
          ? Math.min(bs.length - 1, i + 1)
          : Math.max(0, i < 0 ? bs.length - 1 : i - 1);
  bs[n]!.focus();
  bs[n]!.scrollIntoView({ block: 'nearest' });
  return true;
}

// a chip's menu: the choices, cur ticked, pick told the one chosen
export function choose(anchor: HTMLElement, title: string, choices: Choice[], cur: string, pick: (id: string) => void) {
  if (popOpen(anchor)) {
    popClose();
    return;
  }
  const list = Object.assign(el('div', 'cd-menu'), { role: 'listbox', ariaLabel: title });
  list.append(el('div', 'cd-menu-t', title));
  let group = '';
  for (const c of choices) {
    if (c.group && c.group !== group) {
      group = c.group;
      list.append(el('div', 'cd-menu-g', group));
    }
    const b = Object.assign(el('button', `cd-menu-i${c.id === cur ? ' on' : ''}${c.warn ? ' warn' : ''}`), {
      type: 'button',
      role: 'option',
      disabled: !!c.off,
    });
    b.setAttribute('aria-selected', String(c.id === cur));
    const tick = el('span', 'cd-menu-tick');
    if (c.id === cur) tick.innerHTML = svg(GL.tick!);
    const text = el('span', 'cd-menu-text');
    text.append(el('span', 'cd-menu-l', c.label));
    if (c.sub) text.append(el('span', 'cd-menu-sub', c.sub));
    b.append(tick, text);
    b.addEventListener('click', () => {
      popClose();
      anchor.focus();
      pick(c.id);
    });
    list.append(b);
  }
  list.addEventListener('keydown', (e) => {
    e.stopPropagation();
    arrows(list, e);
  });
  popOver(anchor, list, 'cd-pop-menu');
  const on =
    list.querySelector<HTMLButtonElement>('.cd-menu-i.on:not(:disabled)') ||
    list.querySelector('button:not(:disabled)');
  on?.focus({ preventScroll: true });
  on?.scrollIntoView({ block: 'nearest' });
}

// a chip: a glyph, its value, a caret; a button that opens its menu
export interface Chip {
  node: HTMLButtonElement;
  set: (label: string, state?: '' | 'want' | 'warn') => void;
}
export function chipBtn(glyph: string, title: string, caret = true): Chip {
  const node = Object.assign(el('button', 'cd-chip'), { type: 'button', title });
  node.setAttribute('aria-haspopup', 'listbox');
  node.setAttribute('aria-expanded', 'false');
  const ic = el('span', 'cd-chip-ic');
  ic.innerHTML = svg(GL[glyph]!);
  const t = el('span', 'cd-chip-t');
  node.append(ic, t);
  if (caret) {
    const c = el('span', 'cd-chip-caret');
    c.innerHTML = svg(GL.caret!);
    node.append(c);
  }
  const set = (label: string, state: '' | 'want' | 'warn' = '') => {
    t.textContent = label;
    node.classList.toggle('want', state === 'want');
    node.classList.toggle('warn', state === 'warn');
  };
  return { node, set };
}
