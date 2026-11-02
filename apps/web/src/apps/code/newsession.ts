// a new session: as the desktop app starts one, a prompt box with its
// choices in a row of chips under it

import type { CodeHarness, CodeHarnesses, CodeLs, CodeSession } from '@phosphorus/wire';
import { dkTerminal } from '../../desktop/desk.ts';
import { el, noFill } from '../../lib/dom.ts';
import { dk } from '../../lib/state.ts';
import { paintAcct } from './account.ts';
import { main, root } from './frame.ts';
import { go, loadList, loadOpts } from './list.ts';
import { type Choice, chipBtn, choose, popClose, popOpen, popOver } from './menu.ts';
import { modelChoices, modelLabel, modelOf, sessionVars, sideBtn } from './session.ts';
import {
  ago,
  base,
  bytes,
  call,
  cd,
  DIR_LS,
  GL,
  lsGet,
  lsSet,
  PERM_SUB,
  PERMS,
  parent,
  provOf,
  qs,
  RECENT_LS,
  svg,
  tilde,
} from './state.ts';

// the Anthropic token box: plain text masked by css, so no password manager fills it
export function tokenInput(cls = ''): HTMLInputElement {
  const i = noFill(Object.assign(el('input', cls), { placeholder: 'sk-ant-oat…', spellcheck: false }), true);
  i.addEventListener('keydown', (e) => e.stopPropagation());
  return i;
}

export async function saveToken(token: string): Promise<boolean> {
  const r = await call('/api/me/anthropic', 'POST', { token });
  if (cd.opts) cd.opts.anthropic = !!r.anthropic;
  paintAcct();
  return !!r.anthropic;
}

// signing in to Claude: claude setup-token run in a terminal, its token pasted back
export function loginPanel(hostOf: () => string, done: () => void): HTMLElement & { focusIn: () => void } {
  const box = el('div', 'cd-login') as unknown as HTMLElement & { focusIn: () => void };
  const shut = Object.assign(el('button', 'cd-mini', 'close'), { type: 'button' });
  shut.addEventListener('click', () => {
    box.hidden = true;
  });
  const t = el('div', 'cd-login-t');
  t.append(el('span', '', 'Sign in to Claude'), shut);
  const how = el('ol', 'cd-login-steps');
  const s1 = el('li');
  s1.innerHTML = 'Run <code>claude setup-token</code> in a terminal and finish signing in in the browser it opens.';
  const run = Object.assign(el('button', 'cd-mini primary'), { type: 'button' });
  const paintRun = () => {
    const h = hostOf();
    const can = h && dk.creds?.has(h);
    run.textContent = can ? `run it on ${h}` : 'copy the command';
    run.title = can
      ? `opens a terminal on ${h} running claude setup-token`
      : 'log into a computer on the desktop to run it here';
  };
  run.addEventListener('click', () => {
    const h = hostOf();
    // where claude's installer puts it, a non-login shell's PATH may lack it
    if (h && dk.creds?.has(h)) dkTerminal(h, 'PATH="$HOME/.local/bin:$HOME/.claude/local:$PATH" claude setup-token');
    else
      navigator.clipboard?.writeText('claude setup-token').then(
        () => {
          run.textContent = 'copied';
        },
        () => {},
      );
  });
  s1.append(' ', run);
  const s2 = el('li', '', 'Paste the token it prints (sk-ant-oat…) here.');
  how.append(s1, s2);
  const inp = tokenInput('update-pass cd-login-in');
  const save = Object.assign(el('button', 'primary', 'save'), { type: 'button' });
  const msg = el('span', 'cd-login-msg');
  const bar = el('div', 'cd-login-bar');
  bar.append(inp, save);
  const put = async () => {
    const v = inp.value.trim();
    if (!v) {
      inp.focus();
      return;
    }
    save.disabled = true;
    msg.textContent = 'saving';
    try {
      if (!(await saveToken(v))) throw new Error('not saved');
      inp.value = '';
      msg.textContent = '';
      box.hidden = true;
      done();
    } catch (e) {
      msg.textContent = (e as Error).message;
    }
    save.disabled = false;
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      put();
    }
  });
  save.addEventListener('click', put);
  box.append(t, el('p', 'cd-login-p', 'Opus, Sonnet and Haiku run on your own Claude subscription.'), how, bar, msg);
  box.focusIn = () => {
    paintRun();
    inp.focus();
  };
  return box;
}

export async function paintNew() {
  sessionVars.head = null;
  sessionVars.composer = null;
  popClose();
  const form = el('form', 'cd-newform');
  main.replaceChildren(form);
  form.append(el('div', 'st-wait', 'loading'));
  const opts = await loadOpts(true);
  if (cd.pick !== 'new' || !form.isConnected) return;
  const top = el('div', 'cd-head-top');
  top.append(sideBtn(), el('span', 'cd-title', 'new session'));
  const hosts = opts.hosts || [];
  const offline = opts.offline || [];
  // nowhere to run: no login of the user's own on any computer, or none of those up
  if (opts.blocked || (!hosts.length && !opts.error)) {
    const box = el('div', 'cd-empty');
    const again = Object.assign(el('button', 'cd-mini primary', 'check again'), { type: 'button' });
    again.addEventListener('click', () => paintNew());
    const ic = el('div', 'cd-empty-ic');
    ic.innerHTML = svg(GL.host!);
    if (opts.blocked)
      box.append(
        ic,
        el('div', 'cd-empty-t', opts.blocked),
        el(
          'p',
          'cd-intro',
          'Code runs an agent harness on one of your computers, signed in as you over ssh, so it needs a login of yours saved for that computer.',
        ),
        el(
          'p',
          'cd-intro',
          'Open a terminal on a computer from the desktop, log in and save the login, then come back here.',
        ),
        again,
      );
    else
      box.append(
        ic,
        el('div', 'cd-empty-t', 'none of your computers is online'),
        el(
          'p',
          'cd-intro',
          `${listOf(offline)} ${offline.length === 1 ? 'is' : 'are'} offline. Code runs on a computer that's up on the mesh and that you've saved a login for.`,
        ),
        again,
      );
    form.replaceChildren(top, box);
    return;
  }
  const dirs = lsGet<Record<string, string>>(DIR_LS, {});
  const lastHost = lsGet(`${DIR_LS}-host`, '');
  // the choices: the last ones used where they still stand
  let host = hosts.includes(lastHost) ? lastHost : hosts[0] || '';
  let dir = dirs[host] || '';
  const harnesses: CodeHarness[] = opts.harnesses || [];
  const lastHarness = lsGet(`${DIR_LS}-harness`, '');
  let harness = (harnesses.find((h) => h.id === lastHarness) || harnesses[0])?.id || '';
  const hxOf = () => harnesses.find((h) => h.id === harness) || null;
  // each host's harnesses as the code service found them
  const found = new Map<string, CodeHarnesses>();
  const models = opts.models || [];
  const ready = models.filter((m) => m.ready !== false);
  const lastModel = lsGet(`${DIR_LS}-model`, '');
  let model = (ready.find((m) => m.id === lastModel) || ready[0] || models[0])?.id || '';
  const lastPerm = lsGet(`${DIR_LS}-perm`, 'default');
  let perm = PERMS.some(([v]) => v === lastPerm) ? lastPerm : 'default';

  const prompt = Object.assign(el('textarea', 'cd-first'), {
    rows: 3,
    placeholder: 'What should it do?',
    spellcheck: false,
  });
  const grow = () => {
    prompt.style.height = 'auto';
    prompt.style.height = `${Math.min(prompt.scrollHeight, 320)}px`;
  };
  prompt.addEventListener('input', grow);
  prompt.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  const install = el('div', 'cd-install');
  install.hidden = true;
  // how an update went, apart from the install prompt
  const upd = el('div', 'cd-install note');
  upd.hidden = true;
  const updating = new Set<string>();
  const login = loginPanel(
    () => host,
    () => {
      // the subscription's models in the list now, sonnet picked
      loadOpts(true).then((o) => {
        opts.models = o.models;
        opts.anthropic = o.anthropic;
        model = 'sonnet';
        paint();
        signin.hidden = !!o.anthropic;
      });
    },
  );
  login.hidden = true;
  const goBtn = Object.assign(el('button', 'chat-go cd-go'), {
    type: 'submit',
    title: 'start (enter)',
    ariaLabel: 'start',
  });
  goBtn.innerHTML = svg(GL.send!);
  const hostChip = chipBtn('host', 'the computer the agent runs on, as your login there');
  const dirChip = chipBtn('folder', 'the folder the agent works in');
  const hxChip = chipBtn('term', 'the harness that runs the session');
  const modelChip = chipBtn('model', 'model');
  const permChip = chipBtn('shield', 'what the agent may do without asking');
  const chips = el('div', 'cd-chips');
  chips.append(hostChip.node, dirChip.node, el('span', 'cd-bar-gap'), hxChip.node, modelChip.node, permChip.node);
  const bar = el('div', 'cd-bar');
  bar.append(chips, goBtn);
  const box = el('div', 'cd-prompt-box');
  box.append(prompt, bar);
  const msg = el('span', 'cd-msg');
  const signin = el('div', 'cd-signin');
  const signBtn = Object.assign(el('button', 'cd-link', 'Sign in to Claude'), { type: 'button' });
  signin.append('Using the mesh models. ', signBtn, ' to use Opus, Sonnet and Haiku.');
  signin.hidden = !!opts.anthropic;
  const openLogin = () => {
    login.hidden = false;
    login.focusIn();
  };
  signBtn.addEventListener('click', openLogin);
  const foot = el('div', 'cd-start-foot');
  foot.append(msg, signin);
  const wrap = el('div', 'cd-start');
  wrap.append(el('div', 'cd-hello', 'What are we working on?'), install, upd, login, box, foot);
  if (opts.error) wrap.prepend(el('p', 'cd-intro cd-bad', `couldn't load options: ${opts.error}`));
  form.replaceChildren(top, wrap);

  const modelNow = () => modelOf(opts, model);
  const why = () => {
    if (!host) return 'no computer to run on';
    const hx = hxOf();
    if (!hx) return 'no harness to run';
    if (install.dataset.missing === '1') return `${hx.label} isn't on ${host}: install it or pick another harness`;
    if (!dir) return 'pick a folder';
    if (!model) return 'pick a model';
    const m = modelNow();
    if (m?.ready === false)
      return `${m.label || m.id} isn't ready: ${(m.why || 'not loaded').replace(/^not loaded: /, '')}`;
    if (hx.meshOnly && provOf(model) === 'anthropic') return `${hx.label} runs on the mesh's models`;
    return '';
  };
  const valid = () => {
    const w = why();
    goBtn.disabled = !!w || !prompt.value.trim();
    // the folder chip says it already
    if (!msg.dataset.busy) msg.textContent = dir ? w : '';
  };
  // the chips as the choices stand
  const paint = () => {
    hostChip.set(host || 'no computer');
    dirChip.set(dir ? base(tilde(dir)) || dir : 'pick a folder', dir ? '' : 'want');
    dirChip.node.title = dir ? `${host}:${dir}` : 'the folder the agent works in';
    const hx = hxOf();
    const on = found.get(host)?.harnesses?.find((x) => x.id === harness);
    hxChip.set(hx?.label || 'no harness', on && !on.installed ? 'warn' : '');
    const m = modelNow();
    modelChip.set(modelLabel(opts, model), m?.ready === false ? 'warn' : '');
    modelChip.node.title = m?.ready === false ? `model: ${m.why || 'not ready'}` : 'model';
    permChip.set(PERMS.find(([v]) => v === perm)?.[1] || perm, perm === 'bypassPermissions' ? 'warn' : '');
    valid();
  };
  form.addEventListener('input', valid);

  // the harness picked looked for on the host; a warning and an optional install when it's not there
  const check = async (fresh = false) => {
    const h = host;
    const hx = hxOf();
    install.hidden = true;
    install.dataset.missing = '';
    if (!h || !hx) {
      paint();
      return;
    }
    let r = found.get(h);
    if (!r || fresh) {
      try {
        r = await call(`/api/code/harnesses?${qs({ host: h, fresh: fresh ? '1' : '' })}`);
      } catch (e) {
        r = { error: (e as Error).message };
      }
      if (!r!.error) found.set(h, r!);
    }
    if (host !== h || hxOf() !== hx) return;
    const on = (r!.harnesses || []).find((x) => x.id === hx.id);
    if (r!.error) {
      hostChip.node.title = `couldn't look for harnesses on ${h}: ${r!.error}`;
      paint();
      return;
    }
    hostChip.node.title = 'the computer the agent runs on, as your login there';
    if (on?.installed) {
      hxChip.node.title = on.version ? `${hx.label} ${on.version} on ${h}` : h;
      paint();
      return;
    }
    install.hidden = false;
    install.dataset.missing = '1';
    if (r!.why) {
      install.replaceChildren(el('span', '', r!.why));
      paint();
      return;
    }
    const b = Object.assign(el('button', 'cd-mini primary', `install ${hx.label}`), { type: 'button' });
    const out = el('pre', 'cd-install-out');
    out.hidden = true;
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = 'installing…';
      try {
        const x = await call('/api/code/install', 'POST', { host: h, harness: hx.id });
        out.hidden = !x.out;
        out.textContent = x.out || '';
        if (x.ok) {
          check(true);
          return;
        }
        b.textContent = 'install failed, retry';
      } catch (e) {
        out.hidden = false;
        out.textContent = (e as Error).message;
        b.textContent = 'retry';
      }
      b.disabled = false;
    });
    const others = (r!.harnesses || []).filter((x) => x.installed).map((x) => x.label);
    install.replaceChildren(
      el(
        'span',
        'cd-install-t',
        `${hx.label} isn't installed on ${h}${others.length ? `; it has ${others.join(', ')}` : ''}. Installing it is optional, from ${hx.site}.`,
      ),
      b,
      out,
    );
    paint();
  };

  // a harness already on the host brought up to date by its own updater
  const update = async (id: string) => {
    const h = host;
    const hx = harnesses.find((x) => x.id === id);
    if (!hx || updating.has(id)) return;
    const was = verOf(found.get(h)?.harnesses?.find((x) => x.id === id)?.version);
    updating.add(id);
    upd.classList.remove('bad');
    upd.hidden = false;
    upd.replaceChildren(el('span', 'cd-install-t', `updating ${hx.label} on ${h}…`));
    let x: { ok?: boolean; out?: string };
    try {
      x = await call('/api/code/install', 'POST', { host: h, harness: id, update: true });
    } catch (e) {
      x = { ok: false, out: (e as Error).message };
    }
    updating.delete(id);
    await check(true);
    if (!form.isConnected) return;
    const now = verOf(found.get(h)?.harnesses?.find((y) => y.id === id)?.version);
    const said = !x.ok
      ? `couldn't update ${hx.label} on ${h}`
      : now && now !== was
        ? `${hx.label} updated on ${h}: ${was || 'unknown'} → ${now}`
        : `${hx.label} on ${h} is up to date${now ? `: ${now}` : ''}`;
    const text = (x.out || '').trim();
    const out = Object.assign(el('pre', 'cd-install-out'), { textContent: text, hidden: !!x.ok });
    const more = Object.assign(el('button', 'cd-mini', x.ok ? 'details' : 'hide'), { type: 'button' });
    more.hidden = !text;
    more.addEventListener('click', () => {
      out.hidden = !out.hidden;
      more.textContent = out.hidden ? 'details' : 'hide';
    });
    const shut = Object.assign(el('button', 'cd-mini', 'close'), { type: 'button' });
    shut.addEventListener('click', () => {
      upd.hidden = true;
    });
    upd.classList.toggle('bad', !x.ok);
    upd.hidden = false;
    upd.replaceChildren(el('span', 'cd-install-t', said), more, shut, out);
  };
  hostChip.node.addEventListener('click', () =>
    choose(
      hostChip.node,
      'Computer',
      hosts.map((h) => ({ id: h, label: h, sub: dirs[h] ? tilde(dirs[h]) : '' })),
      host,
      (h) => {
        if (h === host) return;
        host = h;
        dir = dirs[h] || '';
        check();
      },
    ),
  );
  const openPicker = () =>
    folderPicker(dirChip.node, host, dir, (p) => {
      dir = p;
      paint();
      prompt.focus();
    });
  dirChip.node.addEventListener('click', () => (popOpen(dirChip.node) ? popClose() : openPicker()));
  hxChip.node.addEventListener('click', () => {
    const on = found.get(host)?.harnesses || [];
    const cs: Choice[] = harnesses.map((h) => {
      const x = on.find((y) => y.id === h.id);
      const where = x ? (x.installed ? `${x.version ? `${verOf(x.version)} ` : ''}on ${host}` : `not on ${host}`) : '';
      return {
        id: h.id,
        label: h.label,
        sub: [where, h.meshOnly ? 'mesh models only' : ''].filter(Boolean).join(' · '),
      };
    });
    // the ones on the host, each brought up to date by its own updater
    for (const h of harnesses) {
      const x = on.find((y) => y.id === h.id);
      if (!x?.installed) continue;
      cs.push({
        id: `__update:${h.id}`,
        label: `Update ${h.label}`,
        sub: updating.has(h.id) ? 'updating…' : x.version ? `${verOf(x.version)} now` : '',
        off: updating.has(h.id),
        group: `on ${host}`,
      });
    }
    choose(hxChip.node, 'Harness', cs, harness, (id) => {
      if (id.startsWith('__update:')) {
        update(id.slice('__update:'.length));
        return;
      }
      harness = id;
      check();
    });
  });
  modelChip.node.addEventListener('click', () => {
    const cs = modelChoices(opts, model);
    if (!opts.anthropic)
      cs.push({
        id: '__login',
        label: 'Sign in for Opus, Sonnet and Haiku…',
        group: 'Claude subscription',
      });
    choose(modelChip.node, 'Model', cs, model, (id) => {
      if (id === '__login') {
        openLogin();
        return;
      }
      model = id;
      paint();
    });
  });
  permChip.node.addEventListener('click', () =>
    choose(
      permChip.node,
      'Permissions',
      PERMS.map(([id, label]) => ({ id, label, sub: PERM_SUB[id], warn: id === 'bypassPermissions' })),
      perm,
      (id) => {
        perm = id;
        paint();
      },
    ),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (goBtn.disabled) {
      if (!dir) openPicker();
      return;
    }
    goBtn.disabled = true;
    msg.dataset.busy = '1';
    msg.textContent = 'starting';
    dirs[host] = dir;
    lsSet(DIR_LS, dirs);
    lsSet(`${DIR_LS}-host`, host);
    lsSet(`${DIR_LS}-model`, model);
    lsSet(`${DIR_LS}-harness`, harness);
    lsSet(`${DIR_LS}-perm`, perm);
    lsSet(
      RECENT_LS,
      [
        { host, dir },
        ...lsGet<{ host: string; dir: string }[]>(RECENT_LS, []).filter((x) => x.host !== host || x.dir !== dir),
      ].slice(0, 30),
    );
    call('/api/code/sessions', 'POST', {
      host,
      dir,
      harness,
      model,
      perm,
      prompt: prompt.value.trim(),
    }).then(
      (r: CodeSession) => {
        cd.list = [r, ...cd.list.filter((s) => s.id !== r.id)];
        go(r.id);
        loadList();
      },
      (err) => {
        delete msg.dataset.busy;
        msg.textContent = err.message;
        goBtn.disabled = false;
      },
    );
  });
  paint();
  check();
  if (cd.login) {
    cd.login = false;
    openLogin();
  } else prompt.focus({ preventScroll: true });
}

// a harness's version as it says it, less its own name after: 2.1.296 (Claude Code)
const verOf = (v: string | undefined) => (v || '').replace(/\s*\([^)]*\)\s*$/, '');

// a, b and c
const listOf = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

// listings already fetched, per host and folder, kept a little while
const lsCache = new Map<string, { at: number; r: CodeLs }>();
async function lsOf(host: string, dir: string, fresh = false): Promise<CodeLs> {
  const k = `${host}\n${dir}`;
  const c = lsCache.get(k);
  if (c && !fresh && Date.now() - c.at < 30_000) return c.r;
  const r: CodeLs = await call(`/api/code/ls?${qs({ host, dir })}`);
  const v = { at: Date.now(), r };
  lsCache.set(k, v);
  lsCache.set(`${host}\n${r.dir}`, v);
  return r;
}

// a folder's crumbs, home's as ~, each one a way back up
export function crumbs(dir: string, nav: (d: string) => void): HTMLElement {
  const box = Object.assign(el('nav', 'cd-crumbs'), { ariaLabel: 'folder' });
  const t = tilde(dir);
  const home = t === '~' || t.startsWith('~/');
  const parts = (home ? t.slice(1) : t).split('/').filter(Boolean);
  const abs = dir.replace(/\/+$/, '').split('/').filter(Boolean);
  const first = Object.assign(el('button', 'cd-crumb'), { type: 'button', title: home ? 'home' : '/' });
  if (home) first.innerHTML = svg(GL.home!);
  else first.textContent = '/';
  // home's own path, the absolute one less the parts under it
  const homeAbs = home ? `/${abs.slice(0, abs.length - parts.length).join('/')}` : '/';
  first.addEventListener('click', () => nav(home ? homeAbs : '/'));
  box.append(first);
  parts.forEach((p, i) => {
    box.append(el('span', 'cd-crumb-sep', '/'));
    const b = Object.assign(el('button', `cd-crumb${i === parts.length - 1 ? ' on' : ''}`, p), { type: 'button' });
    const to = `${homeAbs.replace(/\/$/, '')}/${parts.slice(0, i + 1).join('/')}`;
    b.addEventListener('click', () => nav(to));
    box.append(b);
  });
  return box;
}

// the folder picker over the user's login on the host: a path typed with its
// folders narrowed as it goes, crumbs back up, recent ones, the folders listed
export function folderPicker(anchor: HTMLElement, host: string, start: string, pick: (p: string) => void) {
  const fp = el('div', 'cd-fp');
  const path = noFill(
    Object.assign(el('input', 'cd-path'), {
      placeholder: '~/src/project',
      spellcheck: false,
      ariaLabel: 'folder path',
    }),
  );
  const dots = Object.assign(el('button', 'cd-icon cd-fp-dots'), {
    type: 'button',
    title: 'show hidden folders',
    ariaLabel: 'show hidden folders',
  });
  dots.innerHTML = svg(GL.eye!);
  dots.setAttribute('aria-pressed', 'false');
  const topRow = el('div', 'cd-fp-top');
  topRow.append(path, dots);
  const trail = el('div', 'cd-fp-trail');
  const list = Object.assign(el('div', 'cd-fp-list'), { role: 'listbox', ariaLabel: 'folders' });
  const here = el('span', 'cd-fp-here');
  const use = Object.assign(el('button', 'cd-mini primary cd-fp-use', 'use this folder'), { type: 'button' });
  const foot = el('div', 'cd-fp-foot');
  foot.append(here, use);
  fp.append(topRow, trail, list, foot);
  popOver(anchor, fp, 'cd-pop-fp');

  let cur = '';
  let entries: { name: string; dir: boolean }[] = [];
  let shown: string[] = [];
  let hi = -1;
  let hidden = false;
  let seq = 0;
  let typed = 0 as ReturnType<typeof setTimeout> | 0;
  let browsed = false;
  const recent = lsGet<{ host: string; dir: string }[]>(RECENT_LS, [])
    .filter((x) => x.host === host)
    .slice(0, 5);
  const join = (d: string, n: string) => `${d.replace(/\/$/, '')}/${n}`;
  const done = (p: string) => {
    popClose();
    pick(p);
  };
  // the typed path as a folder to list and a name to narrow it by
  const parse = () => {
    const v = path.value.trim();
    const i = v.lastIndexOf('/');
    let d = i >= 0 ? v.slice(0, i + 1) : '';
    if (d && !d.startsWith('/') && !d.startsWith('~')) d = join(cur, d);
    return { d: d.replace(/(.)\/+$/, '$1'), f: i >= 0 ? v.slice(i + 1) : v };
  };
  const same = (a: string, b: string) =>
    tilde(a).replace(/(.)\/+$/, '$1') === tilde(b).replace(/(.)\/+$/, '$1') && a !== '' && b !== '';
  const paintList = () => {
    const f = parse().f.toLowerCase();
    const dirs = entries.filter((e) => e.dir && (hidden || f.startsWith('.') || !e.name.startsWith('.')));
    const starts = dirs.filter((e) => e.name.toLowerCase().startsWith(f));
    const has = f ? dirs.filter((e) => !starts.includes(e) && e.name.toLowerCase().includes(f)) : [];
    shown = [...starts, ...has].map((e) => e.name);
    hi = f && shown.length ? Math.min(Math.max(hi, 0), shown.length - 1) : Math.min(hi, shown.length - 1);
    const rows: HTMLElement[] = [];
    if (!browsed && !f && recent.length) {
      rows.push(el('div', 'cd-fp-g', 'recent'));
      for (const x of recent) {
        const b = Object.assign(el('button', 'cd-fp-row recent'), { type: 'button', title: `use ${x.dir}` });
        const ic = el('span', 'cd-fp-ic');
        ic.innerHTML = svg(GL.clock!);
        b.append(ic, el('span', 'cd-fp-name', tilde(x.dir)));
        b.addEventListener('click', () => done(x.dir));
        rows.push(b);
      }
      rows.push(el('div', 'cd-fp-g', base(tilde(cur)) === '~' ? 'home' : tilde(cur)));
    }
    shown.forEach((n, i) => {
      const b = Object.assign(el('div', `cd-fp-row${i === hi ? ' hi' : ''}`), { role: 'option' });
      b.setAttribute('aria-selected', String(i === hi));
      const ic = el('span', 'cd-fp-ic');
      ic.innerHTML = svg(GL.folder!);
      const open = Object.assign(el('button', 'cd-fp-open'), { type: 'button', title: `open ${n}` });
      open.append(ic, el('span', 'cd-fp-name', n));
      open.addEventListener('click', () => nav(join(cur, n)));
      open.addEventListener('dblclick', () => done(join(cur, n)));
      const pickIt = Object.assign(el('button', 'cd-mini cd-fp-pick', 'use'), {
        type: 'button',
        title: `use ${tilde(join(cur, n))}`,
        tabIndex: -1,
      });
      pickIt.addEventListener('click', () => done(join(cur, n)));
      b.append(open, pickIt);
      rows.push(b);
    });
    if (!shown.length && cur)
      rows.push(el('div', 'cd-fp-none', f ? `no folder here starts with ${parse().f}` : 'no folders here'));
    list.replaceChildren(...rows);
    list.querySelector('.cd-fp-row.hi')?.scrollIntoView({ block: 'nearest' });
  };
  // a folder listed: its crumbs, its folders, the path box following unless typed in
  const nav = async (d: string, keep = false) => {
    const n = ++seq;
    if (cur) browsed = true;
    fp.classList.add('busy');
    let r: CodeLs;
    try {
      r = await lsOf(host, d);
    } catch (e) {
      if (n !== seq) return;
      fp.classList.remove('busy');
      if (!cur) {
        // the folder asked for gone: home instead
        if (d) {
          nav('');
          return;
        }
        list.replaceChildren(el('div', 'cd-fp-none cd-bad', (e as Error).message));
      } else if (!keep) list.replaceChildren(el('div', 'cd-fp-none cd-bad', (e as Error).message));
      return;
    }
    if (n !== seq || !fp.isConnected) return;
    fp.classList.remove('busy');
    cur = r.dir;
    entries = r.entries || [];
    hi = -1;
    trail.replaceChildren(crumbs(cur, (x) => nav(x)));
    if (r.more) trail.append(el('span', 'cd-fp-more', 'more not shown'));
    // cut from the left as it narrows, the path's own order kept
    here.replaceChildren(Object.assign(el('bdi'), { dir: 'ltr', textContent: tilde(cur) }));
    here.title = `${host}:${cur}`;
    use.title = `use ${cur}`;
    if (!keep) {
      path.value = cur === '/' ? '/' : `${tilde(cur)}/`;
      path.focus();
    }
    paintList();
  };
  path.addEventListener('input', () => {
    clearTimeout(typed);
    const { d } = parse();
    if (d && !same(d, cur)) typed = setTimeout(() => nav(d, true), 200);
    else paintList();
  });
  path.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!shown.length) return;
      hi = e.key === 'ArrowDown' ? Math.min(shown.length - 1, hi + 1) : Math.max(-1, hi - 1);
      paintList();
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey && shown.length && parse().f) {
      e.preventDefault();
      nav(join(cur, shown[Math.max(hi, 0)]!));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        done(hi >= 0 ? join(cur, shown[hi]!) : cur);
        return;
      }
      if (hi >= 0) nav(join(cur, shown[hi]!));
      else if (!parse().f && cur) done(cur);
      else if (parse().f) {
        // a name typed in full that isn't listed: the path as typed, ls deciding
        const v = path.value.trim();
        nav(v.startsWith('/') || v.startsWith('~') ? v : join(cur, v));
      }
      return;
    }
  });
  dots.addEventListener('click', () => {
    hidden = !hidden;
    dots.setAttribute('aria-pressed', String(hidden));
    dots.classList.toggle('on', hidden);
    paintList();
    path.focus();
  });
  use.addEventListener('click', () => cur && done(cur));
  nav(start);
}

// a session's folder browsed in a panel over the app, folders and files,
// hidden ones on a toggle
export function openBrowser(host: string, dir: string) {
  root.querySelector(':scope > .cd-browse')?.remove();
  const wrap = el('div', 'cd-browse');
  const panel = Object.assign(el('div', 'cd-browse-panel'), { role: 'dialog', ariaLabel: `${host} files` });
  const head = el('div', 'cd-picker-head');
  const listing = el('ul', 'cd-picker-list cd-browse-list');
  panel.append(head, listing);
  wrap.append(panel);
  root.append(wrap);
  let dots = false;
  let seq = 0;
  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', key, true);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && wrap.isConnected) {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', key, true);
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) close();
  });
  const shut = Object.assign(el('button', 'cd-mini', 'close'), { type: 'button' });
  shut.addEventListener('click', close);
  const nav = async (d: string) => {
    const n = ++seq;
    head.replaceChildren(el('span', 'cd-host', host), el('span', 'cd-picker-path', d || '~'), shut);
    listing.replaceChildren(el('li', 'st-wait', 'loading'));
    let r: CodeLs;
    try {
      r = await call(`/api/code/ls?${qs({ host, dir: d })}`);
    } catch (e) {
      if (n === seq) listing.replaceChildren(el('li', 'cd-bad', (e as Error).message));
      return;
    }
    if (n !== seq || !wrap.isConnected) return;
    const up = Object.assign(el('button', 'cd-icon'), {
      type: 'button',
      title: 'up a folder',
      ariaLabel: 'up a folder',
      disabled: r.dir === '/',
    });
    up.innerHTML = svg(GL.up!);
    up.addEventListener('click', () => nav(parent(r.dir)));
    const hid = Object.assign(el('button', `cd-icon${dots ? ' on' : ''}`), {
      type: 'button',
      title: 'show hidden files',
      ariaLabel: 'show hidden files',
    });
    hid.innerHTML = svg(GL.eye!);
    hid.setAttribute('aria-pressed', String(dots));
    hid.addEventListener('click', () => {
      dots = !dots;
      nav(r.dir);
    });
    const path = crumbs(r.dir, nav);
    path.title = `${host}:${r.dir}`;
    head.replaceChildren(up, el('span', 'cd-host', host), path, hid, shut);
    const ents = (r.entries || []).filter((e) => dots || !e.name.startsWith('.'));
    listing.replaceChildren(
      ...ents.map((e) => {
        const row: HTMLElement = e.dir
          ? Object.assign(el('button', 'cd-browse-row dir'), { type: 'button' })
          : el('div', 'cd-browse-row');
        const ic = el('span', 'cd-fp-ic');
        ic.innerHTML = svg(e.dir ? GL.folder! : GL.file!);
        const name = el('span', 'cd-browse-name');
        name.append(ic, e.name);
        row.append(
          name,
          el('span', 'cd-browse-size', e.dir ? '' : bytes(e.size)),
          el('span', 'cd-browse-at', e.mtime ? ago(e.mtime) : ''),
        );
        if (e.dir) row.addEventListener('click', () => nav(`${r.dir.replace(/\/$/, '')}/${e.name}`));
        const li = el('li');
        li.append(row);
        return li;
      }),
    );
    if (!ents.length) listing.append(el('li', 'st-dim', 'empty'));
    if (r.more) listing.append(el('li', 'st-dim', 'more not shown'));
  };
  nav(dir);
  shut.focus();
}
