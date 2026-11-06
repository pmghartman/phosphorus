// --- the account: a phosphorus user over the hosts' own logins, its vault
// of host and page logins kept on the mesh, sealed with its password

import type { Me, UserRow } from '@phosphorus/wire';
import { dkDesktop, dkIcons, dkLayout, dkLogout, dkTermDrop, dkWallPaint } from '../desktop/desk.ts';
import { DK_USERS_KEY, dkProbe, dkUsers } from '../desktop/login.ts';
import { dkSpaceGone } from '../desktop/spaces.ts';
import { dkAnchor, dkBar, dkChips, dkPopsClose, type Pop } from '../desktop/taskbar.ts';
import { dkClose } from '../desktop/windows.ts';
import { acctCall } from '../lib/api.ts';
import { DK_GLYPHS, dkGlyph, el, noFill, pageAsk } from '../lib/dom.ts';
import { applyTheme, modeNow } from '../lib/scheme.ts';
import { type Account, dk, PREF_LS, PREF_OF, st } from '../lib/state.ts';
import { connectState, stateStop, stateUp } from '../lib/sync.ts';

const dkView = document.getElementById('view-desktop')!;

export async function acctStart(): Promise<void> {
  const me = await acctCall<Me & { setup?: boolean }>('/api/me');
  if (me.ok) acctIn(me as Me);
  else if (me.setup) acctSetup();
  else acctLogin();
}

// a real form, so the browser offers to save and fill it; setup: a fresh mesh's
// first visit, the admin made and logged in at once
function acctLogin(setup = false) {
  st.acct = null;
  stateStop();
  dkLogout();
  const form = Object.assign(el('form', setup ? 'dk-login acct-login acct-setup' : 'dk-login acct-login'), {
    method: 'post',
    action: setup ? '/api/setup' : '/api/login',
  });
  const user = Object.assign(el('input'), {
    name: 'username',
    placeholder: setup ? 'admin name' : 'user',
    autocomplete: 'username' as const,
    spellcheck: false,
    autocapitalize: 'off',
    required: true,
  });
  const pass = Object.assign(el('input'), {
    name: 'password',
    type: 'password',
    placeholder: 'password',
    autocomplete: (setup ? 'new-password' : 'current-password') as 'new-password' | 'current-password',
  });
  const why = el('span', 'dk-state bad');
  const go = Object.assign(el('button', 'btn primary', setup ? 'create' : 'log in'), { type: 'submit' });
  const actions = el('div', 'update-actions');
  actions.append(why, go);
  form.append(
    el('div', 'home-col-head', setup ? 'set up phosphorus' : 'phosphorus'),
    el(
      'p',
      'dk-note',
      setup
        ? 'a new mesh: name its first admin and pick a password; the domain and the rest are in settings'
        : 'log in',
    ),
    user,
    pass,
    actions,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    go.disabled = true;
    why.textContent = '';
    const me = await acctCall<Me>(setup ? '/api/setup' : '/api/login', { user: user.value.trim(), pass: pass.value });
    go.disabled = false;
    if (!me.ok) {
      why.textContent = me.error || 'no answer';
      pass.value = '';
      pass.focus();
      return;
    }
    acctIn(me as Me);
  });
  const stage = el('div', 'dk-stage');
  stage.appendChild(form);
  const desk = el('div', 'dk-desk');
  desk.append(stage, dkBar());
  dkView.replaceChildren(desk);
  user.focus();
}

function acctIn(me: Me) {
  const acct: Account = {
    user: me.user,
    admin: me.admin,
    wallpaper: me.wallpaper || 0,
    vault: me.vault || { hosts: {}, pages: {} },
    vaultOK: me.vaultOK !== false,
  };
  st.acct = acct;
  acct.vault.hosts ||= {};
  acct.vault.pages ||= {};
  acctPrefs(me.prefs || {}, me.prefsAt || 0);
  if (acctNext()) return;
  if (!stateUp()) connectState();
  dk.creds = new Map(Object.entries(acct.vault.hosts).map(([h, c]) => [h, { user: c.user, pass: c.pass }]));
  // hosts logged into later, from the terminal's device menu, a host's lock or settings
  dkDesktop();
}

export async function acctSave(): Promise<string> {
  const acct = st.acct;
  if (!acct) return '';
  // a vault the serving host couldn't read yet, the saved one merged under before saving
  if (!acct.vaultOK) {
    const me = await acctCall<Me>('/api/me');
    if (!me.ok || me.vaultOK === false) return 'vault unreachable';
    acct.vault.hosts = { ...me.vault!.hosts, ...acct.vault.hosts };
    acct.vault.pages = { ...me.vault!.pages, ...acct.vault.pages };
    acct.vaultOK = true;
    for (const [h, c] of Object.entries(acct.vault.hosts))
      if (!dk.creds.has(h)) dk.creds.set(h, { user: c.user, pass: c.pass });
  }
  const r = await acctCall('/api/me/vault', { vault: acct.vault });
  return r.ok ? '' : r.error || 'not saved';
}

// the page's own settings in localStorage, mirrored to the user's home
// light, dark or black with them, alike on every host
let prefsTimer: ReturnType<typeof setTimeout> | null = null;
let prefsQuiet = false;

// only the keys this browser changed sent, another's newer ones left be
const prefsDirty = new Set<string>();
function prefsSoon(key?: string) {
  if (prefsQuiet || !st.acct) return;
  for (const k of key ? [key] : Object.keys(PREF_LS)) prefsDirty.add(k);
  clearTimeout(prefsTimer!);
  prefsTimer = setTimeout(() => {
    const prefs: Record<string, string> = {};
    for (const k of prefsDirty) {
      try {
        prefs[k] = localStorage.getItem(PREF_LS[k]!) || '';
      } catch {}
    }
    prefsDirty.clear();
    acctCall('/api/me/prefs', { prefs }).then((r) => {
      if (r.ok) {
        prefsSeen = JSON.stringify(r.prefs);
        prefsAt = Math.max(prefsAt, r.prefsAt || 0);
      }
      prefsTimer = null;
    });
  }, 800);
}

for (const m of ['setItem', 'removeItem'] as const) {
  const own = Storage.prototype[m] as (this: Storage, k: string, ...rest: string[]) => void;
  (Storage.prototype as unknown as Record<string, unknown>)[m] = function (
    this: Storage,
    k: string,
    ...rest: string[]
  ) {
    own.call(this, k, ...rest);
    if (this === window.localStorage && PREF_OF[k]) prefsSoon(PREF_OF[k]);
  };
}

// the user's own settings over this browser's; this browser's sent up where
// the user has none only when this same user left them here
const PREF_OWNER = 'phosphorus-prefs-owner';
let prefsSeen = '';
// the newest settings stamp taken in or written, an older copy (a host not
// yet caught up) never undoing it
let prefsAt = 0;
function acctPrefs(prefs: Record<string, string>, at = 0) {
  prefsAt = Math.max(prefsAt, at);
  let seed = false;
  let mine = false;
  try {
    mine = localStorage.getItem(PREF_OWNER) === st.acct!.user;
    localStorage.setItem(PREF_OWNER, st.acct!.user);
  } catch {}
  prefsSeen = JSON.stringify(prefs);
  prefsQuiet = true;
  for (const [k, ls] of Object.entries(PREF_LS)) {
    try {
      if (prefs[k]) localStorage.setItem(ls, prefs[k]);
      else if (localStorage.getItem(ls) && mine) seed = true;
      else localStorage.removeItem(ls);
    } catch {}
  }
  prefsQuiet = false;
  if (seed) prefsSoon();
  applyTheme(modeNow());
}

// the session rechecked, backing off to 5 minutes while this host doesn't answer;
// the desktop's lists reread on their stamps instead
const ACCT_POLL_MS = 30000;
let acctPollMs = ACCT_POLL_MS;
async function acctTick() {
  const up = await acctCheck();
  acctPollMs = up === false ? Math.min(acctPollMs * 2, 300000) : ACCT_POLL_MS;
}
addEventListener('focus', acctTick);
(function acctPoll() {
  setTimeout(async () => {
    if (!document.hidden) await acctTick();
    acctPoll();
  }, acctPollMs);
})();

// a session gone (expired, password changed, user deleted): back to the login
let acctChecking = false;
export async function acctCheck(): Promise<boolean | undefined> {
  if (!st.acct || acctChecking) return undefined;
  acctChecking = true;
  const me = await acctCall<Me & { setup?: boolean }>('/api/me');
  acctChecking = false;
  if (me.status === 401 && st.acct) acctLogin(!!me.setup);
  // another browser's icon moves, theme or wallpaper, taken in
  if (!me.ok || !st.acct || me.user !== st.acct.user) return me.status !== 0;
  if ((me.prefsAt || 0) > prefsAt && JSON.stringify(me.prefs || {}) !== prefsSeen && !prefsTimer) {
    acctPrefs(me.prefs || {}, me.prefsAt);
    dkLayout();
  }
  if ((me.wallpaper || 0) !== st.acct.wallpaper) {
    st.acct.wallpaper = me.wallpaper || 0;
    dkWallPaint();
  }
  return true;
}

// a service's page sent here to log in first, back to it after
function acctNext(): boolean {
  const q = new URLSearchParams(location.search);
  const next = q.get('next');
  if (!next) return false;
  history.replaceState(null, '', '/');
  // the service still refusing: no second bounce back to it
  let last = '';
  try {
    last = sessionStorage.getItem('phosphorus-next') || '';
    sessionStorage.setItem('phosphorus-next', `${Date.now()} ${next}`);
  } catch {}
  const [at, prev] = [Number(last.split(' ')[0]), last.slice(last.indexOf(' ') + 1)];
  let u: URL;
  try {
    u = new URL(next);
  } catch {
    return false;
  }
  if (prev === next && Date.now() - at < 15000) {
    const why = q.get('why') === 'none' ? 'no cookie' : 'cookie refused';
    setTimeout(() => pageAsk({ title: u.host, message: why, cancel: false }));
    return false;
  }
  const base = st.baseDomain || location.hostname;
  const ours = u.origin === location.origin;
  if (!ours && (u.protocol !== 'https:' || !(u.hostname === base || u.hostname.endsWith(`.${base}`)))) return false;
  location.replace(u.href);
  return true;
}

export async function acctLogout(): Promise<void> {
  await acctCall('/api/logout', {});
  acctLogin();
}

// a fresh mesh's first visit: the first admin made, the login form in setup's clothes
const acctSetup = () => acctLogin(true);

// the users list and a new user's form, for admins; added told of each user made
export function acctUsers(added?: (name: string, admin: boolean) => void): HTMLElement {
  const wrap = el('div', 'acct-users');
  const list = el('ul', 'dk-rows');
  const name = noFill(
    Object.assign(el('input'), { placeholder: 'new user', spellcheck: false, autocapitalize: 'off' }),
  );
  const pass = noFill(Object.assign(el('input'), { placeholder: 'password' }), true);
  const admin = Object.assign(el('input'), { type: 'checkbox' });
  const adminLabel = el('label', 'acct-check');
  adminLabel.append(admin, ' admin');
  const add = Object.assign(el('button', 'btn primary', 'add'), { type: 'button' });
  const why = el('div', 'dk-state bad');
  const row = el('div', 'dk-row acct-new');
  row.append(name, pass, adminLabel, add);
  const draw = (r: { ok: boolean; error?: string; users?: UserRow[] }) => {
    why.textContent = r.ok ? '' : r.error || 'no answer';
    if (!r.users) return;
    list.replaceChildren(
      ...(r.users.length
        ? r.users.map((u) => {
            const li = el('li', 'dk-row acct-user');
            const box = Object.assign(el('input'), {
              type: 'checkbox',
              checked: u.admin,
              disabled: u.name === st.acct!.user,
            });
            const lab = el('label', 'acct-check');
            lab.append(box, ' admin');
            box.addEventListener('change', async () =>
              draw(await acctCall('/api/users/admin', { name: u.name, admin: box.checked })),
            );
            const del = Object.assign(el('button', 'btn danger', 'delete'), {
              type: 'button',
              disabled: u.name === st.acct!.user,
            });
            del.addEventListener('click', async () => {
              if (del.textContent !== 'sure?') {
                del.textContent = 'sure?';
                return;
              }
              draw(await acctCall('/api/users/delete', { name: u.name }));
            });
            li.append(el('span', 'dk-host', u.name), lab, del);
            return li;
          })
        : [el('li', 'empty', 'no users yet')]),
    );
  };
  add.addEventListener('click', async () => {
    const made = { name: name.value.trim(), admin: admin.checked };
    const r = await acctCall('/api/users', { name: made.name, pass: pass.value, admin: made.admin });
    if (r.ok) {
      name.value = '';
      pass.value = '';
      admin.checked = false;
    }
    draw(r);
    if (r.ok) added?.(made.name, made.admin);
  });
  for (const i of [name, pass])
    i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') add.click();
    });
  wrap.append(list, row, why);
  acctCall('/api/users').then(draw);
  return wrap;
}

// a locked host chip, remembering when its own login last closed
export type Chip = HTMLElement & { unlockClosed?: number };

// a locked host chip's own login, saved to the vault once the shell answers
export function dkUnlock(host: string, chip: Chip, then?: () => void): void {
  // a second press on its chip closing it
  if (chip.unlockClosed && Date.now() - chip.unlockClosed < 400) {
    chip.unlockClosed = 0;
    return;
  }
  dkPopsClose();
  const pop = el('form', 'acct-unlock') as HTMLFormElement & Pop;
  const user = noFill(
    Object.assign(el('input'), {
      placeholder: 'user',
      spellcheck: false,
      autocapitalize: 'off',
      value: dkUsers()[host] || '',
    }),
  );
  const pass = noFill(Object.assign(el('input'), { placeholder: 'password' }), true);
  const why = el('span', 'dk-state');
  const go = Object.assign(el('button', 'btn primary', 'log in'), { type: 'submit' });
  pop.append(el('div', 'home-col-head', host), user, pass, why, go);
  pop.classList.add('dk-pop');
  const close = () => {
    pop.remove();
    pop.dkRelease?.();
    document.removeEventListener('pointerdown', away, true);
  };
  pop.dkClose = close;
  const away = (e: PointerEvent) => {
    if (pop.contains(e.target as Node)) return;
    if (chip.contains(e.target as Node)) chip.unlockClosed = Date.now();
    close();
  };
  document.addEventListener('pointerdown', away, true);
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  pop.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!user.value.trim() || !pass.value) return;
    go.disabled = true;
    why.className = 'dk-state busy';
    why.textContent = '…';
    const bad = await dkProbe(host, user.value.trim(), pass.value);
    go.disabled = false;
    if (bad) {
      why.className = 'dk-state bad';
      why.textContent = bad;
      pass.value = '';
      pass.focus();
      return;
    }
    dkRemember(host, user.value.trim(), pass.value);
    close();
    then?.();
  });
  document.body.appendChild(pop);
  dkAnchor(pop, chip);
  (user.value ? pass : user).focus();
}

function dkRemember(host: string, user: string, pass: string) {
  dk.creds.set(host, { user, pass });
  const users = dkUsers();
  users[host] = user;
  try {
    localStorage.setItem(DK_USERS_KEY, JSON.stringify(users));
  } catch {}
  if (st.acct) {
    st.acct.vault.hosts[host] = { user, pass };
    acctSave();
  }
  dkChips();
  dkIcons();
}

export function dkForget(host: string) {
  dk.creds.delete(host);
  if (st.acct) {
    delete st.acct.vault.hosts[host];
    acctSave();
  }
  for (const w of [...dk.wins.values()]) if (w.host === host || w.space === host) dkClose(w, true);
  dkTermDrop((h) => h === host);
  dkSpaceGone();
  dkChips();
  dkIcons();
}

// the user's glyph; an admin is named as one in the control panel
export const dkUserGlyph = (): SVGSVGElement => dkGlyph(DK_GLYPHS.user!);
