// --- settings: one window, its sections down a rail in three groups (you: profile, appearance;
// the mesh: hosts, agents, users; phosphorus: update, about), a section with parts showing them
// under it in the rail while open; drawn on a press, its borrowed views given back on leaving

import { dkAppsChanged } from '../desktop/desk.ts';
import { dkFocus, dkSize, dkTouch, dkWin } from '../desktop/windows.ts';
import { updateModal, updateOpen } from '../features/update.ts';
import { DK_GLYPHS, dkGlyph, el, stash } from '../lib/dom.ts';
import { dk, st } from '../lib/state.ts';
import { agentsSection } from './agents.ts';
import { AP_SUBS, type ApSub, appearanceSection, appearanceSub } from './appearance.ts';
import { HOST_SUBS, hostsSection, hostsSub } from './hosts.ts';
import { PROFILE_SUBS, profileSection, profileSub } from './profile.ts';
import { usersSection } from './users.ts';

export type SettingsAt = 'profile' | 'appearance' | 'users' | 'agents' | 'hosts' | 'update' | 'about';
export type { ApSub };

// a section: drawn into the body, handing back what it borrowed when left
interface Section {
  id: SettingsAt;
  label: string;
  glyph: () => string;
  group: Group;
  // what it holds, the rail's hover
  blurb: string;
  admin?: boolean;
  // its parts, each a submenu under it in the rail, and the one shown
  subs?: () => readonly string[];
  sub?: () => string;
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
    blurb: 'host logins, page logins, password',
    subs: () => PROFILE_SUBS,
    sub: profileSub,
    draw: (body, sub) => profileSection(body, sub),
  },
  {
    id: 'appearance',
    label: 'appearance',
    glyph: () => DK_GLYPHS.palette!,
    group: 'you',
    blurb: 'theme, fonts, bars',
    subs: () => AP_SUBS,
    sub: appearanceSub,
    draw: (body, sub) => appearanceSection(body, sub as ApSub | undefined),
  },
  {
    id: 'hosts',
    label: 'hosts',
    glyph: () => DK_GLYPHS.mesh!,
    group: 'mesh',
    blurb: 'status, shares, services',
    subs: () => HOST_SUBS.filter((s) => s !== 'configure' || !!st.acct?.admin),
    sub: hostsSub,
    draw: (body, sub) => hostsSection(body, sub),
  },
  {
    id: 'agents',
    label: 'agents',
    glyph: () => DK_GLYPHS.agents!,
    group: 'mesh',
    blurb: 'connect agents, the models they ask',
    draw: agentsSection,
  },
  {
    id: 'users',
    label: 'users',
    glyph: () => DK_GLYPHS.users!,
    group: 'mesh',
    blurb: 'who logs in, who is admin',
    admin: true,
    draw: usersSection,
  },
  {
    id: 'update',
    label: 'update',
    glyph: () => DK_GLYPHS.update!,
    group: 'phosphorus',
    blurb: 'releases, mesh update',
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
    blurb: 'version, licenses',
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

// a section's controls grouped: each run of rows and checks in a card of its own, hairlines between
export function cardify(items: HTMLElement[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  let card: HTMLElement | null = null;
  for (const x of items) {
    if (!x.matches('.dk-ap-row, .dk-ap-check')) {
      card = null;
      out.push(x);
      continue;
    }
    if (!card) out.push((card = el('div', 'set-card')));
    card.append(x);
  }
  return out;
}

let at: SettingsAt = 'profile';
// the open window's way to another section, null while none is open
let live: ((s: SettingsAt, sub?: string) => void) | null = null;

// the section an open window shows, its views' watchers told (desk/windows.ts)
export function settingsShows(): string[] {
  const w = dk.wins.get('app:settings');
  if (!w || w.node.hidden || w.leaving) return [];
  return at === 'hosts' && hostsSub() === 'status' ? ['status'] : at === 'agents' ? ['agents'] : [];
}
export const settingsAt = (): SettingsAt => at;

// the window, opened or raised, at a section (and its own part, or a host) when named
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
  const body = el('div', 'dk-ap-body set-body');
  main.append(body);
  pane.append(nav, main);
  w.body.appendChild(pane);
  dkSize(w, 1000, 700);

  let leave: (() => void) | void;
  // the rail's marks: the section open, its part, and its parts shown under it alone
  const mark = () => {
    const sec = SECTIONS.find((x) => x.id === at)!;
    const part = sec.sub?.() ?? '';
    for (const b of nav.querySelectorAll<HTMLElement>('.dk-ap-tab')) {
      const here = b.dataset.at === at;
      // a section with parts: open over them, its part the one marked
      const parent = b.classList.contains('has-subs');
      const on = here && !parent && (b.dataset.sub ?? part) === part;
      b.classList.toggle('on', on);
      b.classList.toggle('open', here && parent);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    for (const g of nav.querySelectorAll<HTMLElement>('.set-subnav')) g.hidden = g.dataset.at !== at;
  };
  const go = (s: SettingsAt, sub?: string) => {
    const same = s === at && body.dataset.at === s;
    at = s;
    // the same section asked again: nothing redrawn
    if (same && !sub) {
      mark();
      return;
    }
    leave?.();
    leave = undefined;
    body.replaceChildren();
    body.dataset.at = s;
    body.scrollTop = 0;
    const sec = SECTIONS.find((x) => x.id === s)!;
    leave = sec.draw(body, sub);
    mark();
    dkAppsChanged();
    dkTouch();
  };
  nav.replaceChildren(
    ...GROUPS.flatMap((g) => {
      const secs = SECTIONS.filter((s) => s.group === g && shown(s));
      if (!secs.length) return [];
      return [
        el('div', 'set-group', g),
        ...secs.flatMap((s) => {
          const b = Object.assign(el('button', 'dk-ap-tab'), { type: 'button', title: s.blurb });
          b.dataset.at = s.id;
          b.append(dkGlyph(s.glyph()), s.label);
          b.addEventListener('click', () => go(s.id));
          const parts = s.subs?.() ?? [];
          if (!parts.length) return [b];
          b.classList.add('has-subs');
          const list = el('div', 'set-subnav');
          list.dataset.at = s.id;
          list.append(
            ...parts.map((p) => {
              const sb = Object.assign(el('button', 'dk-ap-tab set-subtab', p), { type: 'button' });
              sb.dataset.at = s.id;
              sb.dataset.sub = p;
              sb.addEventListener('click', () => go(s.id, p));
              return sb;
            }),
          );
          return [b, list];
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
