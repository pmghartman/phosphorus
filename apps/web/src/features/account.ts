// --- the account: a phosphorus user over the hosts' own logins, its vault
// of host and page logins kept on the mesh, sealed with its password

import type { Me, UserRow } from '@phosphorus/wire';
import { appCall } from '../apps/index.ts';
import { dkArt, dkDesktop, dkIcons, dkLayout, dkLogout, dkWallPaint } from '../desktop/desk.ts';
import { EDITORS, editorPref } from '../desktop/deskfiles.ts';
import { DK_USERS_KEY, dkLogin, dkProbe, dkUsers } from '../desktop/login.ts';
import { dkAnchor, dkBar, dkChips, dkPopsClose, type Pop } from '../desktop/taskbar.ts';
import { dkClose, dkFocus, dkSize, dkWin } from '../desktop/windows.ts';
import { acctCall } from '../lib/api.ts';
import { DK_GLYPHS, dkGlyph, el, noFill, pageAsk, svgEl } from '../lib/dom.ts';
import { applyTheme, systemLight } from '../lib/scheme.ts';
import { type Account, dk, PREF_LS, PREF_OF, st } from '../lib/state.ts';
import { connectState, stateStop, stateUp } from '../lib/sync.ts';
import { themeFromStorage } from '../lib/theme.ts';
import { copyText } from '../lib/util.ts';
import { chatAs } from './chat/chat.ts';
import { serviceUrl } from './mesh/mesh.ts';

const dkView = document.getElementById('view-desktop')!;

export async function acctStart(): Promise<void> {
  const me = await acctCall<Me & { setup?: boolean }>('/api/me');
  if (me.ok) acctIn(me as Me);
  else acctLogin(!!me.setup);
}

// a real form, so the browser offers to save and fill it
function acctLogin(setup: boolean) {
  st.acct = null;
  chatAs('');
  stateStop();
  dkLogout();
  const form = Object.assign(el('form', 'dk-login acct-login'), { method: 'post', action: '/api/login' });
  const user = Object.assign(el('input'), {
    name: 'username',
    placeholder: 'user',
    autocomplete: 'username' as const,
    spellcheck: false,
    autocapitalize: 'off',
    required: true,
  });
  const pass = Object.assign(el('input'), {
    name: 'password',
    type: 'password',
    placeholder: 'password',
    autocomplete: 'current-password' as const,
  });
  const why = el('span', 'dk-state bad');
  const go = Object.assign(el('button', 'primary', 'log in'), { type: 'submit' });
  const actions = el('div', 'update-actions');
  actions.append(why, go);
  form.append(
    el('div', 'home-col-head', 'phosphorus'),
    el('p', 'dk-note', setup ? 'admin, ADMIN_PASS' : 'log in'),
    user,
    pass,
    actions,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    go.disabled = true;
    why.textContent = '';
    const me = await acctCall<Me>('/api/login', { user: user.value.trim(), pass: pass.value });
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
  desk.append(dkArt(), stage, dkBar());
  dkView.replaceChildren(desk);
  user.focus();
}

function acctIn(me: Me) {
  const acct: Account = {
    user: me.user,
    admin: me.admin,
    boot: me.boot,
    wallpaper: me.wallpaper || 0,
    vault: me.vault || { hosts: {}, pages: {} },
    vaultOK: me.vaultOK !== false,
  };
  st.acct = acct;
  acct.vault.hosts ||= {};
  acct.vault.pages ||= {};
  if (acct.boot) {
    acctSetup();
    return;
  }
  acctPrefs(me.prefs || {}, me.prefsAt || 0);
  chatAs(acct.user);
  if (acctNext()) return;
  if (!stateUp()) connectState();
  dk.creds = new Map(Object.entries(acct.vault.hosts).map(([h, c]) => [h, { user: c.user, pass: c.pass }]));
  if (dk.creds.size) dkDesktop();
  else dkLogin();
}

export async function acctSave(): Promise<string> {
  const acct = st.acct;
  if (!acct || acct.boot) return '';
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
// the theme with them: light or dark, the theme picked and a custom one, alike on every host
let prefsTimer: ReturnType<typeof setTimeout> | null = null;
let prefsQuiet = false;

// only the keys this browser changed sent, another's newer ones left be
const prefsDirty = new Set<string>();
function prefsSoon(key?: string) {
  if (prefsQuiet || !st.acct || st.acct.boot) return;
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
  let theme: string | null = null;
  try {
    theme = localStorage.getItem(PREF_LS.theme!);
    st.color = localStorage.getItem(PREF_LS.color!) || st.color;
  } catch {}
  themeFromStorage();
  applyTheme(theme || (systemLight.matches ? 'light' : 'dark'));
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
  if (!me.ok || !st.acct || st.acct.boot || me.user !== st.acct.user) return me.status !== 0;
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
  acctLogin(false);
}

// the setup admin: only the users list, then out
function acctSetup() {
  dkLogout();
  const box = el('div', 'dk-login');
  const out = Object.assign(el('button', '', 'log out'), { type: 'button' });
  out.addEventListener('click', acctLogout);
  const actions = el('div', 'update-actions');
  actions.appendChild(out);
  box.append(
    el('div', 'home-col-head', 'setup admin'),
    el('p', 'dk-note', 'make an admin user, then log out and in as them; the setup admin is off once an admin exists'),
    acctUsers(),
    actions,
  );
  const stage = el('div', 'dk-stage');
  stage.appendChild(box);
  const desk = el('div', 'dk-desk');
  desk.append(dkArt(), stage, dkBar());
  dkView.replaceChildren(desk);
}

// the users list and a new user's form, for admins
function acctUsers(): HTMLElement {
  const wrap = el('div', 'acct-users');
  const list = el('ul', 'dk-rows');
  const name = noFill(
    Object.assign(el('input'), { placeholder: 'new user', spellcheck: false, autocapitalize: 'off' }),
  );
  const pass = noFill(Object.assign(el('input'), { placeholder: 'password' }), true);
  const admin = Object.assign(el('input'), { type: 'checkbox' });
  const adminLabel = el('label', 'acct-check');
  adminLabel.append(admin, ' admin');
  const add = Object.assign(el('button', 'primary', 'add'), { type: 'button' });
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
            const del = Object.assign(el('button', 'danger', 'delete'), {
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
    const r = await acctCall('/api/users', { name: name.value.trim(), pass: pass.value, admin: admin.checked });
    if (r.ok) {
      name.value = '';
      pass.value = '';
      admin.checked = false;
    }
    draw(r);
  });
  for (const i of [name, pass])
    i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') add.click();
    });
  wrap.append(list, row, why);
  acctCall('/api/users').then(draw);
  return wrap;
}

export function dkUsersWin(): void {
  const w = dkWin('app:users', 'users', '', 'app dk-app-users');
  if (!w) return;
  const body = el('div', 'acct-pane');
  body.appendChild(acctUsers());
  w.body.appendChild(body);
  dkSize(w, 560, 420);
  dkFocus(w);
}

// a locked host chip, remembering when its own login last closed
type Chip = HTMLElement & { unlockClosed?: number };

// a locked host chip's own login, saved to the vault once the shell answers
export function dkUnlock(host: string, chip: Chip): void {
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
  const go = Object.assign(el('button', 'primary', 'log in'), { type: 'submit' });
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
  if (st.acct && !st.acct.boot) {
    st.acct.vault.hosts[host] = { user, pass };
    acctSave();
  }
  dkChips();
  dkIcons();
}

function dkForget(host: string) {
  dk.creds.delete(host);
  if (st.acct) {
    delete st.acct.vault.hosts[host];
    acctSave();
  }
  for (const w of [...dk.wins.values()]) if (w.host === host) dkClose(w, true);
  dkChips();
  dkIcons();
}

// the task bar's profile: a menu of settings, users and log out
// the user's glyph, an admin's crowned
export function dkUserGlyph(): SVGSVGElement {
  if (!st.acct?.admin) return dkGlyph(DK_GLYPHS.user!);
  // the user's head lowered, the crown on it
  const svg = dkGlyph('M8 4.6a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2zM2.5 15c.6-2.8 2.8-4.2 5.5-4.2s4.9 1.4 5.5 4.2');
  svg.appendChild(svgEl('path', { d: DK_GLYPHS.crown!, class: 'dk-crown' }));
  return svg;
}

// the profile window: saved hosts, page logins and the password
export function dkProfileWin(): void {
  const w = dkWin('app:profile', 'profile', st.acct?.user || '', 'app dk-app-profile');
  if (!w) return;
  const body = el('div', 'acct-pane');
  w.body.appendChild(body);
  const draw = () => {
    const acct = st.acct!;
    const hosts = el('ul', 'dk-rows');
    const names = [...new Set([...Object.keys(acct.vault.hosts), ...st.terminalHosts])].sort(
      (a, b) => Number(!acct.vault.hosts[a]) - Number(!acct.vault.hosts[b]) || a.localeCompare(b),
    );
    hosts.replaceChildren(
      ...(names.length
        ? names.map((h) => {
            const li = el('li', 'dk-row acct-user');
            const saved = acct.vault.hosts[h];
            const act = Object.assign(el('button', saved ? 'danger' : '', saved ? 'forget' : 'log in'), {
              type: 'button',
            });
            act.addEventListener('click', () => {
              if (saved) {
                dkForget(h);
                draw();
                return;
              }
              const chip = [...(dk.desk?.hosts.children || [])].find((c) => c.textContent === h) as Chip | undefined;
              if (chip) dkUnlock(h, chip);
            });
            li.append(
              el('span', 'dk-host', h),
              el('span', 'dk-state', saved ? saved.user : st.terminalHosts.includes(h) ? 'locked' : ''),
              act,
            );
            return li;
          })
        : [el('li', 'empty', 'no hosts')]),
    );

    const pages = el('ul', 'dk-rows');
    const keys = Object.keys(acct.vault.pages).sort();
    pages.replaceChildren(
      ...(keys.length
        ? keys.map((k) => {
            const p = acct.vault.pages[k]!;
            const li = el('li', 'dk-row acct-page');
            const cu = Object.assign(el('button', '', 'copy user'), { type: 'button' });
            const cp = Object.assign(el('button', '', 'copy pass'), { type: 'button' });
            const del = Object.assign(el('button', 'danger', 'delete'), { type: 'button' });
            cu.addEventListener('click', () => copyText(p.user));
            cp.addEventListener('click', () => copyText(p.pass));
            del.addEventListener('click', () => {
              delete acct.vault.pages[k];
              acctSave();
              draw();
            });
            const name = Object.assign(el('span', 'dk-host', k), { title: p.url || k });
            li.append(name, el('span', 'dk-state', p.user), cu, cp, del);
            return li;
          })
        : [el('li', 'empty', 'none saved')]),
    );
    const pName = noFill(Object.assign(el('input'), { placeholder: 'page', spellcheck: false }));
    pName.setAttribute('list', 'acct-page-names');
    const opts = el('datalist');
    opts.id = 'acct-page-names';
    // the mesh's services and its git (forgejo) login, each a page login's name
    const loginable = [...dk.services, ...(st.gitRoute ? [st.gitRoute] : [])];
    opts.replaceChildren(...loginable.map((r) => Object.assign(el('option'), { value: r.name })));
    const pUser = noFill(Object.assign(el('input'), { placeholder: 'user', spellcheck: false }));
    const pPass = noFill(Object.assign(el('input'), { placeholder: 'password' }), true);
    const pAdd = Object.assign(el('button', 'primary', 'save'), { type: 'button' });
    pAdd.addEventListener('click', () => {
      const k = pName.value.trim();
      if (!k || !pUser.value) return;
      const svc = loginable.find((r) => r.name === k);
      acct.vault.pages[k] = { url: svc ? serviceUrl(svc) : '', user: pUser.value, pass: pPass.value };
      acctSave();
      draw();
    });
    const pRow = el('div', 'dk-row acct-new');
    pRow.append(pName, pUser, pPass, pAdd);

    const pw = el('form', 'dk-row acct-new');
    const old = noFill(Object.assign(el('input'), { placeholder: 'current' }), true);
    const neu = noFill(Object.assign(el('input'), { placeholder: 'new' }), true);
    const pwGo = Object.assign(el('button', 'primary', 'change'), { type: 'submit' });
    const pwWhy = el('div', 'dk-state');
    pw.append(old, neu, pwGo);
    pw.addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await acctCall('/api/me/password', { old: old.value, pass: neu.value });
      pwWhy.className = `dk-state ${r.ok ? 'ok' : 'bad'}`;
      pwWhy.textContent = r.ok ? 'changed' : r.error || 'no answer';
      if (r.ok) {
        old.value = '';
        neu.value = '';
      }
    });

    // the editor files open in, picked on the apps page, which installs sulfur when it must
    const ed = el('div', 'dk-row acct-editor');
    const edGo = Object.assign(el('button', '', 'change'), { type: 'button', title: 'on the apps page' });
    edGo.addEventListener('click', () => appCall('store', true, (m) => m.storeShow('sulfur')));
    ed.append(
      el('span', 'dk-host', EDITORS.find(([id]) => id === editorPref())![1]),
      el('span', 'dk-state', editorPref() ? 'an app on the mesh' : 'the desktop’s own'),
      edGo,
    );

    body.replaceChildren(
      el('div', 'dk-pick-head', 'hosts'),
      hosts,
      el('div', 'dk-pick-head', 'page logins'),
      pages,
      pRow,
      opts,
      el('div', 'dk-pick-head', 'editor'),
      ed,
      el('div', 'dk-pick-head', 'password'),
      pw,
      pwWhy,
    );
  };
  draw();
  dkSize(w, 620, 520);
  dkFocus(w);
}
