// --- settings: one window, its sections down a rail in three groups (you: profile, appearance;
// the mesh: hosts, agents, users; phosphorus: update, about), each under a header saying what it
// holds, drawn on a press and its borrowed views given back to the stash on leaving

import { dkAppsChanged } from '../desktop/desk.ts';
import { dkFocus, dkSize, dkTouch, dkWin } from '../desktop/windows.ts';
import { updateModal, updateOpen } from '../features/update.ts';
import { DK_GLYPHS, dkGlyph, el, stash } from '../lib/dom.ts';
import { dk, st } from '../lib/state.ts';
import { agentsSection } from './agents.ts';
import { type ApSub, appearanceSection } from './appearance.ts';
import { hostsSection } from './hosts.ts';
import { profileSection } from './profile.ts';
import { usersSection } from './users.ts';

export type SettingsAt = 'profile' | 'appearance' | 'users' | 'agents' | 'hosts' | 'update' | 'about';
export type { ApSub };

// a section: drawn into the body, handing back what it borrowed when left
interface Section {
  id: SettingsAt;
  label: string;
  glyph: () => string;
  group: Group;
  // a line under the section's title
  blurb: string;
  admin?: boolean;
  draw: (body: HTMLElement, sub?: string) => (() => void) | void;
}

type Group = 'you' | 'mesh' | 'phosphorus';
const GROUPS: Group[] = ['you', 'mesh', 'phosphorus'];

// a stashed view borrowed whole, back in the stash on leaving
const borrow = (body: HTMLElement, view: HTMLElement) => {
  body.appendChild(view);
  return () => {
    stash.appendChild(view);
  };
};

const SECTIONS: Section[] = [
  {
    id: 'profile',
    label: 'profile',
    glyph: () => DK_GLYPHS.user!,
    group: 'you',
    blurb: 'the hosts you log into, the page logins kept for you, and your password',
    draw: profileSection,
  },
  {
    id: 'appearance',
    label: 'appearance',
    glyph: () => DK_GLYPHS.palette!,
    group: 'you',
    blurb: 'theme, colours, fonts and where the bars sit',
    draw: (body, sub) => appearanceSection(body, sub as ApSub | undefined),
  },
  {
    id: 'hosts',
    label: 'hosts',
    glyph: () => DK_GLYPHS.mesh!,
    group: 'mesh',
    blurb: 'every host on the mesh, how it is doing, and what each one shares and runs',
    draw: (body, sub) => hostsSection(body, sub),
  },
  {
    id: 'agents',
    label: 'agents',
    glyph: () => DK_GLYPHS.agents!,
    group: 'mesh',
    blurb: 'connect Claude and other agents, and pick the model each one asks',
    draw: agentsSection,
  },
  {
    id: 'users',
    label: 'users',
    glyph: () => DK_GLYPHS.users!,
    group: 'mesh',
    blurb: 'who can log in, and who is an admin',
    admin: true,
    draw: usersSection,
  },
  {
    id: 'update',
    label: 'update',
    glyph: () => DK_GLYPHS.update!,
    group: 'phosphorus',
    blurb: 'the release each host runs, and updating the whole mesh at once',
    admin: true,
    draw: (body) => {
      updateModal.hidden = false;
      const back = borrow(body, updateModal);
      updateOpen();
      return back;
    },
  },
  {
    id: 'about',
    label: 'about',
    glyph: () => DK_GLYPHS.about!,
    group: 'phosphorus',
    blurb: 'this release and the software it is built on',
    draw: (body) => {
      const view = document.getElementById('view-about')!;
      view.classList.add('active');
      const back = borrow(body, view);
      return () => {
        view.classList.remove('active');
        back();
      };
    },
  },
];

const shown = (s: Section) => !s.admin || !!st.acct?.admin;

let at: SettingsAt = 'profile';
// the open window's way to another section, null while none is open
let live: ((s: SettingsAt, sub?: string) => void) | null = null;

// the section an open window shows, its views' watchers told (desk/windows.ts)
export function settingsShows(): string[] {
  const w = dk.wins.get('app:settings');
  if (!w || w.node.hidden || w.leaving) return [];
  return at === 'hosts' ? ['status'] : at === 'agents' ? ['agents'] : [];
}
export const settingsAt = (): SettingsAt => at;

// the window, opened or raised, at a section (and the appearance's own part) when named
export function dkSettings(s?: SettingsAt, sub?: string): void {
  if (!dk.desk || !st.acct || st.acct.boot) return;
  const pick = SECTIONS.find((x) => x.id === s && shown(x));
  if (pick) at = pick.id;
  if (!SECTIONS.some((x) => x.id === at && shown(x))) at = 'profile';
  const w = dkWin('app:settings', 'settings', '', 'app dk-app-settings');
  if (!w) {
    live?.(at, sub);
    return;
  }
  const pane = el('div', 'dk-ap-pane set-pane');
  const nav = el('nav', 'dk-ap-nav set-nav');
  nav.ariaLabel = 'settings';
  const main = el('div', 'set-main');
  const head = el('header', 'set-head');
  const body = el('div', 'dk-ap-body set-body');
  main.append(head, body);
  pane.append(nav, main);
  w.body.appendChild(pane);
  dkSize(w, 900, 640);

  let leave: (() => void) | void;
  const go = (s: SettingsAt, sub?: string) => {
    const same = s === at && body.dataset.at === s;
    at = s;
    for (const b of nav.querySelectorAll<HTMLElement>('.dk-ap-tab')) {
      const on = b.dataset.at === s;
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    // the same section asked again: only its part moved to, nothing redrawn
    if (same && !sub) return;
    leave?.();
    leave = undefined;
    body.replaceChildren();
    body.dataset.at = s;
    body.scrollTop = 0;
    const sec = SECTIONS.find((x) => x.id === s)!;
    const text = el('div', 'set-head-t');
    text.append(el('h2', 'set-title', sec.label), el('p', 'set-blurb', sec.blurb));
    head.replaceChildren(dkGlyph(sec.glyph(), 'set-head-ic'), text);
    leave = sec.draw(body, sub);
    dkAppsChanged();
    dkTouch();
  };
  nav.replaceChildren(
    ...GROUPS.flatMap((g) => {
      const secs = SECTIONS.filter((s) => s.group === g && shown(s));
      if (!secs.length) return [];
      return [
        el('div', 'set-group', g),
        ...secs.map((s) => {
          const b = Object.assign(el('button', 'dk-ap-tab'), { type: 'button', title: s.blurb });
          b.dataset.at = s.id;
          b.append(dkGlyph(s.glyph()), s.label);
          b.addEventListener('click', () => go(s.id));
          return b;
        }),
      ];
    }),
  );
  live = (s, sub) => go(s, sub);
  w.onClose = () => {
    leave?.();
    leave = undefined;
    live = null;
  };
  go(at, sub);
  dkFocus(w);
}
