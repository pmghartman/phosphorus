// a new session: as the desktop app starts one, a prompt box with its

import type { CodeHarness, CodeHarnesses, CodeLs, CodeSession } from '@phosphorus/wire';
import { dkTerminal } from '../../desktop/desk.ts';
import { el, noFill } from '../../lib/dom.ts';
import { dk } from '../../lib/state.ts';
import { esc } from '../../lib/util.ts';
import { paintAcct } from './account.ts';
import { main, root } from './frame.ts';
import { go, loadList, loadOpts } from './list.ts';
import { modelSelect, sessionVars, sideBtn } from './session.ts';
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
  PERMS,
  parent,
  provOf,
  qs,
  RECENT_LS,
  svg,
  tilde,
} from './state.ts';

// choices in a row of chips under it ---

// a select dressed as a chip, its glyph before it
export function chip(glyph: string, sel: HTMLSelectElement, title: string): HTMLElement {
  const c = el('label', 'cd-chip');
  c.title = title;
  const g = el('span', 'cd-chip-ic');
  g.innerHTML = svg(GL[glyph]!);
  sel.classList.add('cd-chip-sel');
  c.append(g, sel);
  return c;
}

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
  const form = el('form', 'cd-newform');
  main.replaceChildren(form);
  form.append(el('div', 'st-wait', 'loading'));
  const opts = await loadOpts(true);
  if (cd.pick !== 'new' || !form.isConnected) return;
  const top = el('div', 'cd-head-top');
  top.append(sideBtn(), el('span', 'cd-title', 'new session'));
  // no login of the user's own on any computer: nowhere to run
  if (opts.blocked) {
    const box = el('div', 'cd-empty');
    const again = Object.assign(el('button', 'cd-mini primary', 'check again'), { type: 'button' });
    again.addEventListener('click', () => paintNew());
    box.append(
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
    form.replaceChildren(top, box);
    return;
  }
  const hosts = opts.hosts || [];
  const dirs = lsGet<Record<string, string>>(DIR_LS, {});
  const lastHost = lsGet(`${DIR_LS}-host`, '');
  const host = el('select');
  host.innerHTML =
    hosts.map((h) => `<option value="${esc(h)}"${h === lastHost ? ' selected' : ''}>${esc(h)}</option>`).join('') ||
    '<option value="">no hosts</option>';
  let dir = dirs[host.value] || '';
  const dirBtn = Object.assign(el('button', 'cd-chip cd-chip-dir'), { type: 'button' });
  const picker = el('div', 'cd-picker');
  picker.hidden = true;
  const paintDir = () => {
    dirBtn.innerHTML = `<span class="cd-chip-ic">${svg(GL.folder!)}</span>`;
    dirBtn.append(
      el('span', `cd-chip-t${dir ? '' : ' cd-chip-want'}`, dir ? base(tilde(dir)) || dir : 'pick a folder'),
    );
    dirBtn.title = dir ? `${host.value}:${dir}` : 'the folder the agent works in';
  };
  // the harnesses the code service offers, the last one used picked
  const harnesses: CodeHarness[] = opts.harnesses || [];
  const lastHarness = lsGet(`${DIR_LS}-harness`, '');
  const harness = el('select');
  harness.innerHTML =
    harnesses
      .map(
        (h) =>
          `<option value="${esc(h.id)}"${h.id === lastHarness ? ' selected' : ''}>${esc(h.label.toLowerCase())}</option>`,
      )
      .join('') || '<option value="">no harnesses</option>';
  const hxOf = () => harnesses.find((h) => h.id === harness.value) || null;
  // each host's harnesses as the code service found them
  const found = new Map<string, CodeHarnesses>();
  const ready = (opts.models || []).filter((m) => m.ready !== false);
  const lastModel = lsGet(`${DIR_LS}-model`, '');
  let model = modelSelect(opts, (ready.find((m) => m.id === lastModel) || ready[0])?.id || '');
  const perm = el('select');
  perm.innerHTML = PERMS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
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
  const login = loginPanel(
    () => host.value,
    () => {
      // the subscription's models in the list now, sonnet picked
      loadOpts(true).then((o) => {
        swapModel(modelSelect(o, 'sonnet'));
        valid();
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
  const modelChip = chip('model', model, 'model');
  const bar = el('div', 'cd-bar');
  bar.append(
    chip('host', host, 'the computer the agent runs on, as your login there'),
    dirBtn,
    el('span', 'cd-bar-gap'),
    chip('term', harness, 'the harness that runs the session'),
    modelChip,
    chip('shield', perm, 'what the agent may do without asking'),
    goBtn,
  );
  const box = el('div', 'cd-box');
  box.append(prompt, picker, bar);
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
  wrap.append(el('div', 'cd-hello', 'What are we working on?'), install, login, box, foot);
  if (opts.error) wrap.prepend(el('p', 'cd-intro cd-bad', `couldn't load options: ${opts.error}`));
  form.replaceChildren(top, wrap);

  // a sign in offered as the last model, the choice put back once it's open
  function swapModel(next: HTMLSelectElement) {
    let was = next.value;
    if (!opts.anthropic && !cd.opts?.anthropic) {
      next.insertAdjacentHTML(
        'beforeend',
        '<optgroup label="claude subscription"><option value="__login">Sign in for Opus, Sonnet, Haiku…</option></optgroup>',
      );
    }
    next.addEventListener('change', () => {
      if (next.value === '__login') {
        next.value = was;
        openLogin();
        return;
      }
      was = next.value;
      valid();
    });
    next.classList.add('cd-chip-sel');
    model.replaceWith(next);
    model = next;
  }
  swapModel(model);

  const why = () => {
    if (!host.value) return 'no computer to run on';
    const hx = hxOf();
    if (!hx) return 'no harness to run';
    if (install.dataset.missing === '1')
      return `${hx.label.toLowerCase()} isn't on ${host.value}: install it or pick another harness`;
    if (!dir) return 'pick a folder';
    if (!model.value || model.value === '__login') return 'pick a model';
    if (hx.meshOnly && provOf(model.value) === 'anthropic')
      return `${hx.label.toLowerCase()} runs on the mesh's models`;
    return '';
  };
  const valid = () => {
    const w = why();
    goBtn.disabled = !!w || !prompt.value.trim();
    // the folder chip says it already
    if (!msg.dataset.busy) msg.textContent = dir ? w : '';
  };
  form.addEventListener('input', valid);
  // the harness picked looked for on the host; a warning and an optional install when it's not there
  const check = async (fresh = false) => {
    const h = host.value;
    const hx = hxOf();
    install.hidden = true;
    install.dataset.missing = '';
    if (!h || !hx) {
      valid();
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
    if (host.value !== h || hxOf() !== hx) return;
    const on = (r!.harnesses || []).find((x) => x.id === hx.id);
    for (const o of harness.options) {
      const x = (r!.harnesses || []).find((y) => y.id === o.value);
      const label = harnesses.find((y) => y.id === o.value)?.label.toLowerCase() || o.value;
      o.textContent = x && !x.installed ? `${label} · not on ${h}` : label;
    }
    if (r!.error) {
      host.parentElement!.title = `couldn't look for harnesses on ${h}: ${r!.error}`;
      valid();
      return;
    }
    if (on?.installed) {
      harness.parentElement!.title = on.version ? `${hx.label.toLowerCase()} ${on.version} on ${h}` : h;
      valid();
      return;
    }
    install.hidden = false;
    install.dataset.missing = '1';
    if (r!.why) {
      install.replaceChildren(el('span', '', r!.why));
      valid();
      return;
    }
    const b = Object.assign(el('button', 'cd-mini primary', `install ${hx.label.toLowerCase()}`), { type: 'button' });
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
    const others = (r!.harnesses || []).filter((x) => x.installed).map((x) => x.label.toLowerCase());
    install.replaceChildren(
      el(
        'span',
        '',
        `${hx.label.toLowerCase()} isn't installed on ${h}${others.length ? `; it has ${others.join(', ')}` : ''}. installing it is optional, from ${hx.site}.`,
      ),
      b,
      out,
    );
    valid();
  };
  const pick = (p: string) => {
    dir = p;
    picker.hidden = true;
    paintDir();
    valid();
    prompt.focus();
  };
  // the folder: typed, a recent one, or browsed to
  const openPicker = () => {
    const h = host.value;
    const path = noFill(
      Object.assign(el('input', 'cd-path'), { placeholder: '~/src/project', spellcheck: false, value: dir }),
    );
    path.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        if (path.value.trim()) pick(path.value.trim());
      }
      if (e.key === 'Escape') {
        picker.hidden = true;
        prompt.focus();
      }
    });
    const rows: HTMLElement[] = [path];
    const recent = lsGet<{ host: string; dir: string }[]>(RECENT_LS, [])
      .filter((x) => x.host === h)
      .slice(0, 6);
    if (recent.length) {
      const ul = el('div', 'cd-recent');
      ul.append(el('div', 'cd-recent-t', 'recent'));
      for (const x of recent) {
        const b = Object.assign(el('button', 'cd-picker-row', tilde(x.dir)), { type: 'button', title: x.dir });
        b.addEventListener('click', () => pick(x.dir));
        ul.append(b);
      }
      rows.push(ul);
    }
    const browser = el('div', 'cd-browser');
    rows.push(browser);
    picker.replaceChildren(...rows);
    picker.hidden = false;
    browseAt(browser, h, dir, pick);
    path.focus();
  };
  dirBtn.addEventListener('click', () => {
    if (picker.hidden) openPicker();
    else picker.hidden = true;
  });
  host.addEventListener('change', () => {
    dir = dirs[host.value] || '';
    picker.hidden = true;
    paintDir();
    check();
  });
  harness.addEventListener('change', () => {
    check();
    valid();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (goBtn.disabled) {
      if (!dir) openPicker();
      return;
    }
    goBtn.disabled = true;
    msg.dataset.busy = '1';
    msg.textContent = 'starting';
    dirs[host.value] = dir;
    lsSet(DIR_LS, dirs);
    lsSet(`${DIR_LS}-host`, host.value);
    lsSet(`${DIR_LS}-model`, model.value);
    lsSet(`${DIR_LS}-harness`, harness.value);
    lsSet(
      RECENT_LS,
      [
        { host: host.value, dir },
        ...lsGet<{ host: string; dir: string }[]>(RECENT_LS, []).filter((x) => x.host !== host.value || x.dir !== dir),
      ].slice(0, 30),
    );
    call('/api/code/sessions', 'POST', {
      host: host.value,
      dir,
      harness: harness.value,
      model: model.value,
      perm: perm.value,
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
  paintDir();
  valid();
  check();
  if (cd.login) {
    cd.login = false;
    openLogin();
  } else prompt.focus({ preventScroll: true });
}

// a folder picker over the user's login on the host, from its home down
export async function browseAt(
  box: HTMLElement & { seq?: number },
  host: string,
  dir: string,
  pick: (p: string) => void,
) {
  const seq = (box.seq = (box.seq || 0) + 1);
  const head = el('div', 'cd-picker-head');
  const listing = el('ul', 'cd-picker-list');
  box.replaceChildren(head, listing);
  head.append(el('span', 'cd-picker-path', dir || '~'));
  listing.append(el('li', 'st-wait', 'loading'));
  let r: CodeLs;
  try {
    r = await call(`/api/code/ls?${qs({ host, dir })}`);
  } catch (e) {
    if (box.seq !== seq) return;
    const home = Object.assign(el('button', 'cd-mini', '~'), { type: 'button', title: 'home' });
    home.addEventListener('click', () => browseAt(box, host, '', pick));
    head.prepend(home);
    listing.replaceChildren(el('li', 'cd-bad', (e as Error).message));
    return;
  }
  if (box.seq !== seq) return;
  const up = Object.assign(el('button', 'cd-mini', '..'), { type: 'button', title: 'up', disabled: r.dir === '/' });
  up.addEventListener('click', () => browseAt(box, host, parent(r.dir), pick));
  const use = Object.assign(el('button', 'cd-mini primary', 'use this folder'), { type: 'button' });
  use.addEventListener('click', () => pick(r.dir));
  head.replaceChildren(up, el('span', 'cd-picker-path', r.dir), use);
  const dirs = (r.entries || []).filter((e) => e.dir && !e.name.startsWith('.'));
  listing.replaceChildren(
    ...dirs.map((e) => {
      const b = Object.assign(el('button', 'cd-picker-row', `${e.name}/`), { type: 'button' });
      b.addEventListener('click', () => browseAt(box, host, `${r.dir.replace(/\/$/, '')}/${e.name}`, pick));
      return b;
    }),
  );
  if (!dirs.length) listing.append(el('li', 'st-dim', 'no folders'));
  if (r.more) listing.append(el('li', 'st-dim', 'more not shown'));
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
    const up = Object.assign(el('button', 'cd-mini', '..'), { type: 'button', title: 'up', disabled: r.dir === '/' });
    up.addEventListener('click', () => nav(parent(r.dir)));
    const hid = Object.assign(el('button', `cd-mini${dots ? ' primary' : ''}`, 'hidden'), {
      type: 'button',
      title: 'show hidden files',
    });
    hid.addEventListener('click', () => {
      dots = !dots;
      nav(r.dir);
    });
    const path = el('span', 'cd-picker-path', r.dir);
    path.title = `${host}:${r.dir}`;
    head.replaceChildren(up, el('span', 'cd-host', host), path, hid, shut);
    const ents = (r.entries || []).filter((e) => dots || !e.name.startsWith('.'));
    listing.replaceChildren(
      ...ents.map((e) => {
        const row: HTMLElement = e.dir
          ? Object.assign(el('button', 'cd-browse-row dir'), { type: 'button' })
          : el('div', 'cd-browse-row');
        row.append(
          el('span', 'cd-browse-name', e.dir ? `${e.name}/` : e.name),
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
