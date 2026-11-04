// an installable app's page, the repo viewer: its readme, files and compose file, where it
// comes from and under what licence, the install check, and the install itself: the env
// form, the host and its backups; once installed, its hosts, their logs and an admin's steps

import type { AppDef, AppPage, CheckResult, EnvField, HostFit, StackView } from '@phosphorus/wire';
import { el, noFill, pageAsk } from '../../lib/dom.ts';
import { renderMd } from '../../lib/md.ts';
import { dk, st } from '../../lib/state.ts';
import { humanSize } from '../../lib/util.ts';
import { crumb, iconTile } from './apps.ts';
import {
  agoText,
  copyWords,
  dockerBusy,
  dockerError,
  fitting,
  formOf,
  given,
  hostUp,
  install,
  installedAs,
  keyOf,
  type Loaded,
  liveHost,
  loadPage,
  opWords,
  pages,
  pickSource,
  recheck,
  SOURCE_NAMES,
  sourceOf,
  splitKey,
  stackAct,
  stackFacts,
  statusOn,
  twins,
} from './catalog.ts';
import { draw } from './draw.ts';
import { logsOpen, stateVars, storeShow } from './state.ts';

const redraw = () => {
  stateVars.sig = '';
  draw();
};

// the viewer's pane, by page: the readme, the compose file or the files
const panes = new Map<string, 'readme' | 'compose' | 'files'>();

// a box over the page with fields of its own: true for its action
function ask(title: string, body: (HTMLElement | string)[], action: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const veil = el('div', 'fm-veil page-veil');
    const box = el('form', 'fm-ask store-pick');
    const end = (v: boolean) => {
      veil.remove();
      resolve(v);
    };
    const go = Object.assign(el('button', danger ? 'btn danger' : 'btn primary', action), { type: 'submit' });
    const no = Object.assign(el('button', 'btn', 'cancel'), { type: 'button' });
    no.addEventListener('click', () => end(false));
    const acts = el('div', 'update-actions');
    acts.append(no, go);
    box.append(
      el('div', 'fm-ask-title', title),
      ...body.map((b) => (typeof b === 'string' ? el('p', '', b) : b)),
      acts,
    );
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

// a list of hosts to tick or pick one of, each with a note, or why it can't be; a locked one
// shown ticked, never changed nor returned; returns the picked
function hostChoice(
  hosts: { host: string; note?: string; why?: string; on?: boolean; lock?: boolean }[],
  type: 'radio' | 'checkbox',
  onChange?: (picked: string[]) => void,
): { el: HTMLElement; picked: () => string[] } {
  const list = el('ul', 'store-pick-list');
  const name = `h${Math.random().toString(36).slice(2)}`;
  const boxes: [string, HTMLInputElement][] = [];
  for (const h of hosts) {
    const li = el('li', `store-pick-row${h.why ? ' off' : ''}`);
    const cb = Object.assign(el('input'), {
      type,
      name,
      checked: !!h.lock || (!!h.on && !h.why),
      disabled: !!h.why || !!h.lock,
    });
    const lab = el('label', 'store-pick-label');
    lab.append(cb, el('span', 'store-pick-host', h.host));
    li.append(lab);
    if (h.why || h.note) li.append(el('span', 'store-pick-why', h.why || h.note!));
    if (!cb.disabled) boxes.push([h.host, cb]);
    cb.addEventListener('change', () => onChange?.(boxes.filter(([, b]) => b.checked).map(([x]) => x)));
    list.append(li);
  }
  return { el: list, picked: () => boxes.filter(([, b]) => b.checked).map(([x]) => x) };
}

// the words on backups, said once wherever they're picked
const BACKUP_WORDS = 'A backup keeps a synced copy and takes over if the active host goes down.';

// --- the viewer: readme, compose, files -----------------------------------------------

function viewer(key: string, page: AppPage): HTMLElement {
  const sec = el('section', 'store-sec store-viewer');
  const pane = panes.get(key) ?? (page.readme.trim() ? 'readme' : 'compose');
  const bar = Object.assign(el('div', 'store-panes'), { role: 'tablist' });
  for (const [id, label] of [
    ['readme', 'readme'],
    ['compose', 'compose file'],
    ['files', `files${page.tree.length ? ` · ${page.tree.length}` : ''}`],
  ] as const) {
    const b = Object.assign(el('button', `store-pane${pane === id ? ' on' : ''}`, label), {
      type: 'button',
      role: 'tab',
      ariaSelected: String(pane === id),
    });
    b.addEventListener('click', () => {
      panes.set(key, id);
      redraw();
    });
    bar.append(b);
  }
  sec.append(bar);
  if (pane === 'readme') {
    if (!page.readme.trim()) sec.append(el('div', 'store-empty', 'no readme'));
    else {
      const md = el('div', 'store-readme');
      renderMd(md, page.readme, false);
      sec.append(md);
    }
  } else if (pane === 'compose') {
    if (!page.def.compose.trim()) sec.append(el('div', 'store-empty bad', 'no compose file found'));
    else sec.append(el('pre', 'store-code', page.def.compose));
  } else sec.append(tree(page));
  return sec;
}

const COMPOSE = /(^|\/)(docker-)?compose\.ya?ml$|(^|\/)phos\.ya?ml$/;

function tree(page: AppPage): HTMLElement {
  if (!page.tree.length) return el('div', 'store-empty', 'no files listed');
  const ul = el('ul', 'store-tree');
  const gh = page.def.source === 'github' ? page.def.repo.replace(/\/$/, '') : '';
  const sorted = [...page.tree].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    const depth = f.path.split('/').length - 1;
    const name = f.path.split('/').pop()!;
    const li = el('li', `store-tree-row ${f.type}${COMPOSE.test(f.path) ? ' compose' : ''}`);
    li.style.paddingLeft = `${0.6 + depth * 1.1}rem`;
    const label = f.type === 'dir' ? `${name}/` : name;
    li.append(
      gh
        ? Object.assign(el('a', 'store-tree-name', label), {
            href: `${gh}/${f.type === 'dir' ? 'tree' : 'blob'}/HEAD/${f.path.split('/').map(encodeURIComponent).join('/')}`,
            target: '_blank',
            rel: 'noopener',
          })
        : el('span', 'store-tree-name', label),
    );
    if (f.type === 'file' && f.size != null) li.append(el('span', 'store-tree-size', humanSize(f.size)));
    ul.append(li);
  }
  return ul;
}

// --- information --------------------------------------------------------------------------

// a compose service's host port for a container port, its ${VAR:-default} filled from env; 0 if unmapped
function composePort(compose: string, service: string, target: number, env: Record<string, string>): number {
  const esc = service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^\\s+["']?${esc}["']?:\\s*$`);
  let indent = -1;
  for (const line of compose.split('\n')) {
    const lead = line.search(/\S/);
    if (lead < 0) continue;
    if (indent < 0) {
      if (head.test(line)) indent = lead;
      continue;
    }
    if (lead <= indent) break;
    const m = line.match(/^\s*-\s*["']?([^"'#\s]+)["']?/);
    if (!m) continue;
    const parts = m[1]!.replace(/\$\{(\w+)(?::?-([^}]*))?\}/g, (_, k, d) => env[k] || d || '').split(':');
    if (parts.length >= 2 && parts.at(-1)!.split('/')[0] === String(target)) return Number(parts.at(-2)) || 0;
  }
  return 0;
}

// the port its host publishes the web page on: the route once installed, else the compose
// file's mapping as the form fills it
function hostPort(key: string, def: AppDef, v?: StackView): number {
  const web = v?.web ?? def.manifest.web;
  if (!web) return 0;
  const route = v && dk.services.find((r) => r.name === v.summary.id && r.host === liveHost(v));
  if (route?.port) return route.port;
  const env = { ...Object.fromEntries(def.env.map((x) => [x.name, x.default ?? ''])), ...given(formOf(key)) };
  return composePort(def.compose, web.service, web.port, env) || web.port;
}

// the facts at a glance, over the readme: a grid of label over value
function info(key: string, def: AppDef, v?: StackView): HTMLElement {
  const dl = el('dl', 'store-facts');
  const row = (k: string, val: string | HTMLElement, cls = '') => {
    const cell = el('div', 'store-fact');
    const dd = el('dd', cls);
    dd.append(val);
    cell.append(el('dt', '', k), dd);
    dl.append(cell);
    return dd;
  };
  const link = (text: string, href: string) =>
    Object.assign(el('a', '', text), { href, target: '_blank', rel: 'noopener' });
  const src = sourceOf(def.source);
  row(
    'from',
    def.source === 'github'
      ? link(def.ref, def.repo)
      : link(src?.name ?? SOURCE_NAMES[def.source], src?.repo ?? def.repo),
  );
  row('license', def.licence || 'none given', def.licence ? '' : 'dim');
  if (def.source !== 'github' && def.repo) row('project', link(def.repo.replace(/^https?:\/\/(www\.)?/, ''), def.repo));
  const m = def.manifest;
  const web = v?.web ?? m.web;
  if (web) {
    const port = hostPort(key, def, v);
    const dd = row('published as', st.meshDomain ? `${def.id}.${st.meshDomain}, from :${port}` : `:${port}`);
    dd.title = `port ${port} on its host, ${web.service}:${web.port} in its container`;
  }
  const data = m.volumes.filter((x) => x.kind === 'data');
  row(
    'data copied',
    data.length ? data.map((x) => `${x.service}:${x.target}`).join(', ') : 'none',
    data.length ? 'mono' : 'dim',
  );
  if (m.health) row('health', `${m.health.service} ${m.health.path ?? `port ${m.health.port ?? ''}`}`, 'mono');
  const hooks = [...(m.backup?.pre ?? []), ...(m.backup?.post ?? [])];
  // in words, the commands themselves on hover
  if (hooks.length) {
    const what = el('span', '', hookWords(hooks));
    what.title = hooks.map((h) => `${h.service}: ${h.run.join(' ')}`).join('\n');
    row('before a copy', what);
  }
  if (def.archs.length) row('runs on', def.archs.join(', '), 'mono');
  row('category', def.category);
  return dl;
}

// a copy's hooks said plainly: the databases dumped, else the services a step runs in
function hookWords(hooks: { service: string; run: string[] }[]): string {
  const said = new Set<string>();
  for (const h of hooks) {
    const cmd = h.run.join(' ');
    const kind = /pg_dump/.test(cmd)
      ? 'a PostgreSQL dump'
      : /mysqldump|mariadb-dump/.test(cmd)
        ? 'a MySQL dump'
        : /sqlite3/.test(cmd)
          ? 'a SQLite backup'
          : 'a step';
    said.add(`${kind} in ${h.service}`);
  }
  return [...said].join(', ');
}

// --- the check and the install ---------------------------------------------------------------

const VERDICTS: Record<CheckResult['verdict'], [string, string]> = {
  installable: ['on', 'ready to install'],
  'needs-input': ['wait', 'needs a few values'],
  blocked: ['bad', 'can’t install'],
};
// the verdict as said: no host fitting blocks it, whatever the rest
const verdict = (check: CheckResult): [string, string] =>
  check.verdict !== 'blocked' && !check.hosts.some((h) => h.ok)
    ? ['bad', 'no host can run it']
    : VERDICTS[check.verdict];

function checkSec(check: CheckResult, checking: boolean): HTMLElement {
  const sec = el('section', 'store-sec');
  const h = el('h2', '', 'install check');
  if (checking) h.append(el('span', 'store-count wait', 'checking'));
  const [cls, text] = verdict(check);
  sec.append(h, el('div', `store-verdict ${cls}`, text));
  // what's wrong in full, what passed folded into one line
  const flagged = check.items.filter((i) => i.level !== 'ok');
  const passed = check.items.filter((i) => i.level === 'ok');
  if (flagged.length) {
    const ul = el('ul', 'store-check');
    for (const i of flagged) ul.append(el('li', i.level, i.text));
    sec.append(ul);
  }
  if (passed.length)
    sec.append(
      fold(
        `${passed.length} passed`,
        passed.map((i) => el('li', 'ok', i.text)),
        'store-check',
      ),
    );
  return sec;
}

// a list folded under one line, opened on a press
function fold(label: string, items: HTMLElement[], cls: string): HTMLElement {
  const d = el('details', 'store-fold');
  const ul = el('ul', cls);
  ul.append(...items);
  d.append(el('summary', '', label), ul);
  return d;
}

// a field still wanting a value: required, no default, not one generated
const wanting = (def: AppDef, env: Record<string, string>) =>
  def.env.filter((x) => x.required && !x.secret && !x.default && !env[x.name]?.trim()).map((x) => x.name);

function envSec(key: string, def: AppDef): HTMLElement | null {
  if (!def.env.length) return null;
  const f = formOf(key);
  const sec = el('section', 'store-sec');
  sec.append(el('h2', '', 'configuration'));
  const form = el('div', 'store-env');
  for (const x of def.env) {
    const lab = el('label', 'store-env-row');
    // its label and variable on one line, the field under them
    const head = el('span', 'store-env-head');
    const name = el('span', 'store-env-label', x.label || x.name);
    if (x.required && !x.secret && !x.default) name.append(el('span', 'store-env-req', ' required'));
    head.append(name);
    if (x.label && x.label !== x.name) head.append(el('span', 'store-env-name', x.name));
    let input: HTMLInputElement | HTMLSelectElement;
    if (x.options?.length) {
      input = el('select', 'store-env-input');
      for (const o of x.options) input.append(Object.assign(el('option', '', o), { value: o }));
      input.value = f.env[x.name] ?? x.default ?? x.options[0]!;
    } else {
      input = el('input', 'store-env-input');
      noFill(input, x.secret);
      Object.assign(input, {
        value: f.env[x.name] ?? '',
        placeholder: x.secret ? 'generated unless given' : (x.default ?? ''),
        spellcheck: false,
      });
    }
    input.dataset.keep = `env:${x.name}`;
    input.addEventListener(x.options?.length ? 'change' : 'input', () => {
      f.env[x.name] = input.value;
      recheck(key);
      // the install button follows the fields at once, the check a moment after
      const go = document.querySelector<HTMLButtonElement>('.store-install');
      if (go) go.disabled = !canInstall(key, def, f.check);
    });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    lab.append(head, input);
    form.append(lab);
  }
  sec.append(form);
  return sec;
}

function canInstall(key: string, def: AppDef, check: CheckResult | undefined): boolean {
  const f = formOf(key);
  return !!st.acct?.admin && !f.busy && !!f.active && check?.verdict !== 'blocked' && !wanting(def, f.env).length;
}

// where: the fitting hosts, the preferred first; the rest greyed with their reason
function hostSec(key: string, page: AppPage, check: CheckResult): HTMLElement {
  const f = formOf(key);
  const fit = fitting(page, check);
  if (!fit.some((h) => h.host === f.active)) f.active = fit[0]?.host ?? '';
  f.standbys = f.standbys.filter((h) => h !== f.active && fit.some((x) => x.host === h));
  const sec = el('section', 'store-sec');
  sec.append(el('h2', '', 'host'));
  const pref = page.def.manifest.preferredHost;
  const note = (h: HostFit) =>
    [
      h.host === pref ? 'preferred' : '',
      dockerBusy(h.host)
        ? 'installing Docker'
        : dockerError(h.host)
          ? `Docker: ${dockerError(h.host)}`
          : h.docker === 'installable'
            ? 'Docker installed first'
            : '',
      h.arch,
    ]
      .filter(Boolean)
      .join(' · ');
  const unfit = check.hosts.filter((h) => !h.ok);
  const why = (h: HostFit) => {
    const li = el('li', 'store-pick-row off');
    li.append(el('span', 'store-pick-host', h.host), el('span', 'store-pick-why', h.why || 'doesn’t fit'));
    return li;
  };
  if (!fit.length) {
    sec.append(el('div', 'store-verdict bad', 'no host can run it'), el('p', 'store-pick-note', 'each host and why'));
    const ul = el('ul', 'store-pick-list');
    ul.append(...unfit.map(why));
    sec.append(ul);
    return sec;
  }
  const pick = hostChoice(
    fit.map((h) => ({ host: h.host, on: h.host === f.active, note: note(h) })),
    'radio',
    ([h]) => {
      f.active = h ?? '';
      redraw();
    },
  );
  sec.append(pick.el);
  // the hosts that can't, out of the way with their reasons
  if (unfit.length) sec.append(fold(`${unfit.length} can’t run it`, unfit.map(why), 'store-pick-list'));
  return sec;
}

function backupSec(key: string, page: AppPage, check: CheckResult): HTMLElement | null {
  const f = formOf(key);
  if (!f.active) return null;
  const rest = fitting(page, check).filter((h) => h.host !== f.active);
  const sec = el('section', 'store-sec');
  const h = el('h2', '', 'backups');
  h.append(el('span', 'store-count', f.standbys.length ? `${f.standbys.length}` : 'none'));
  h.title = BACKUP_WORDS;
  sec.append(h);
  if (!rest.length) {
    sec.append(el('p', 'store-pick-note', 'no other host can run it'));
    return sec;
  }
  const pick = hostChoice(
    rest.map((x) => ({ host: x.host, on: f.standbys.includes(x.host) })),
    'checkbox',
    (picked) => {
      f.standbys = picked;
      redraw();
    },
  );
  sec.append(pick.el);
  if (!f.standbys.length)
    sec.append(el('p', 'store-pick-note warn', `None: if ${f.active} goes down, ${page.def.name} is down with it.`));
  return sec;
}

function installSec(key: string, page: AppPage): HTMLElement[] {
  const f = formOf(key);
  const check = f.check ?? page.check;
  const out: HTMLElement[] = [checkSec(check, f.checking)];
  const env = envSec(key, page.def);
  if (env) out.push(env);
  out.push(hostSec(key, page, check));
  const backups = backupSec(key, page, check);
  if (backups) out.push(backups);
  const sec = el('section', 'store-sec store-go');
  const go = Object.assign(
    el('button', `btn primary store-pill big store-install${f.busy ? ' wait' : ''}`, f.busy ? 'installing' : 'install'),
    {
      type: 'button',
      disabled: !canInstall(key, page.def, check),
    },
  );
  go.addEventListener('click', () => install(key));
  sec.append(go);
  const missing = wanting(page.def, f.env);
  const why = !st.acct?.admin
    ? 'an admin installs apps'
    : check.verdict === 'blocked'
      ? 'the check above says why'
      : !f.active
        ? 'no host to install it on'
        : missing.length
          ? `fill in ${missing.join(', ')} first`
          : `onto ${f.active}${f.standbys.length ? `, with ${f.standbys.join(', ')} as backup` : ''}`;
  sec.append(el('p', 'store-pick-note', why));
  if (f.error) sec.append(el('p', 'store-repo-err', f.error));
  out.push(sec);
  return out;
}

// --- an installed app ------------------------------------------------------------------------

function hostRow(v: StackView, h: string): HTMLElement {
  const id = v.summary.id;
  const s = statusOn(h, id);
  const role = h === liveHost(v) ? 'active' : 'backup';
  const job = s?.job;
  const running = !!job && !job.done;
  const failed = !!job && job.done && job.ok === false;
  const up = hostUp(h);
  const cls = running
    ? 'mid'
    : failed || s?.error || (role === 'active' && s && (!s.running || s.healthy === false))
      ? 'fail'
      : !up || !s
        ? 'off'
        : 'ok';
  const text = running
    ? (opWords[job.op] ?? job.op)
    : failed
      ? `${job.op} failed`
      : s?.error
        ? s.error
        : !up
          ? 'not answering'
          : !s
            ? 'waiting for it'
            : role === 'active'
              ? !s.running
                ? 'stopped'
                : s.healthy === false
                  ? 'running, unhealthy'
                  : s.healthy
                    ? 'running, healthy'
                    : 'running'
              : copyWords(s)[1];
  const li = el('li', `store-host svc ${cls}`);
  const top = el('div', 'store-host-top');
  top.append(
    el('i', 'store-dot'),
    el('span', `store-host-name${h === st.selfHost ? ' is-self' : ''}`, h),
    el('span', `store-role ${role}`, role),
  );
  const logKey = `stack:${id}/${h}`;
  if (job && job.done && job.ok !== false) {
    const b = Object.assign(el('button', 'store-host-btn', logsOpen.has(logKey) ? 'hide log' : 'log'), {
      type: 'button',
      title: `the last ${job.op}’s output`,
    });
    b.addEventListener('click', () => {
      if (logsOpen.has(logKey)) logsOpen.delete(logKey);
      else logsOpen.add(logKey);
      redraw();
    });
    const acts = el('span', 'store-host-acts');
    acts.append(b);
    top.append(acts);
  }
  // how it is on its own line, the side column being narrow
  li.append(top, el('div', 'store-host-state', text));
  if (job && (running || failed || logsOpen.has(logKey))) {
    li.append(
      el(
        'div',
        'store-log-who',
        `${job.op} on ${h}${running ? ' · runs on the host itself, this page may close' : ''}`,
      ),
    );
    const log = el('pre', `store-log${logsOpen.has(logKey) ? ' full' : ''}`, job.log || (running ? 'starting…' : ''));
    li.append(log);
    requestAnimationFrame(() => {
      log.scrollTop = log.scrollHeight;
    });
  }
  return li;
}

// the hosts an installed app may move to or be backed by: those the check found fitting,
// else every phosphorus host
function fitHosts(page: AppPage | undefined): string[] {
  if (page) return fitting(page, page.check).map((h) => h.host);
  const names = (st.lastState?.tailnet ?? []).filter((d) => d.phosphorus).map((d) => d.name);
  if (st.selfHost && !names.includes(st.selfHost)) names.push(st.selfHost);
  return names.sort();
}

// the hosts it's on: the one serving it kept, every other one ticked to keep a copy or
// unticked to take it off there, its data there kept for a later install
async function changeHosts(v: StackView, page: AppPage | undefined) {
  const live = liveHost(v);
  const named = [v.active, ...v.standbys];
  const rest = [...new Set([...named, ...fitHosts(page)])].filter((h) => h !== live).sort();
  const pick = hostChoice(
    [
      { host: live, lock: true, note: 'serving it; move it to take it off' },
      ...rest.map((h) => ({ host: h, on: named.includes(h), note: named.includes(h) ? 'a backup' : '' })),
    ],
    'checkbox',
  );
  const body: (HTMLElement | string)[] = [
    BACKUP_WORDS,
    pick.el,
    el('p', 'store-pick-note', 'unticked hosts stop it, its data kept'),
  ];
  if (await ask(`hosts for ${v.summary.name}`, body, 'save'))
    stackAct(v.summary.id, 'standbys', { active: live, standbys: pick.picked() });
}

// a handoff goes to a backup, the one holding a copy
async function moveTo(v: StackView) {
  const live = liveHost(v);
  const rest = [v.active, ...v.standbys].filter((h) => h !== live);
  const pick = hostChoice(
    rest.map((h, i) => ({ host: h, on: i === 0, note: 'a backup, its copy ready' })),
    'radio',
  );
  const body: (HTMLElement | string)[] = [
    `${v.summary.name} is briefly offline while it moves from ${live}.`,
    rest.length ? pick.el : el('p', 'store-pick-note warn', 'no backup to move to: add one under hosts…'),
  ];
  if ((await ask(`move ${v.summary.name} to…`, body, 'move')) && pick.picked()[0])
    stackAct(v.summary.id, 'move', { to: pick.picked()[0] });
}

async function remove(v: StackView) {
  const keep = Object.assign(el('input'), { type: 'checkbox', checked: true });
  const lab = el('label', 'store-pick-label');
  lab.append(keep, el('span', '', `keep its data on ${stackFacts(v).hosts.join(', ')}`));
  const note = el('p', 'store-pick-note', 'put back by a later install of it');
  keep.addEventListener('change', () => {
    note.textContent = keep.checked
      ? 'put back by a later install of it'
      : 'its data is deleted with it, on every host';
    note.classList.toggle('warn', !keep.checked);
  });
  if (
    await ask(
      `remove ${v.summary.name}`,
      [`It’s stopped and taken down on every host, and its address leaves the mesh.`, lab, note],
      'remove',
      true,
    )
  )
    stackAct(v.summary.id, 'remove', { keepData: keep.checked });
}

// its values to change, secrets aside: a choice its options, the rest typed; saved, it's updated
// with them and comes up again
async function settings(v: StackView, page: AppPage | undefined) {
  const fields: EnvField[] =
    page?.def.env.filter((x) => !x.secret) ?? Object.keys(v.values ?? {}).map((name) => ({ name, label: name }));
  const now = v.values ?? {};
  const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const form = el('div', 'store-env');
  for (const x of fields) {
    const lab = el('label', 'store-env-row');
    const head = el('span', 'store-env-head');
    head.append(el('span', 'store-env-label', x.label || x.name));
    if (x.label && x.label !== x.name) head.append(el('span', 'store-env-name', x.name));
    let input: HTMLInputElement | HTMLSelectElement;
    if (x.options?.length) {
      input = el('select', 'store-env-input');
      for (const o of x.options) input.append(Object.assign(el('option', '', o), { value: o }));
      input.value = now[x.name] || x.default || x.options[0]!;
    } else {
      input = Object.assign(el('input', 'store-env-input'), { value: now[x.name] ?? '', spellcheck: false });
    }
    lab.append(head, input);
    form.append(lab);
    inputs.set(x.name, input);
  }
  if (!inputs.size) form.append(el('p', 'store-pick-note', 'nothing to set but its secrets'));
  const body = [form, el('p', 'store-pick-note', `saving restarts it on ${liveHost(v)}; its backups follow`)];
  if (!(await ask(`${v.summary.name} settings`, body, 'save')) || !inputs.size) return;
  const env: Record<string, string> = {};
  for (const [k, input] of inputs) if (input.value !== (now[k] ?? '')) env[k] = input.value;
  if (Object.keys(env).length) stackAct(v.summary.id, 'update', { env });
}

function installedSec(v: StackView, page: AppPage | undefined): HTMLElement[] {
  const f = stackFacts(v);
  const id = v.summary.id;
  const busy = stateVars.busyId === `stack:${id}` || f.busy.length > 0;
  const sec = el('section', 'store-sec');
  const h = el('h2', '', 'on the mesh');
  h.append(el('span', 'store-count', `gen ${v.gen}`));
  const list = el('ul', 'store-hosts');
  for (const x of f.hosts) list.append(hostRow(v, x));
  sec.append(h, el('div', `store-verdict ${f.sub[0]}`, f.sub[1]));
  if (f.event) sec.append(el('div', `store-verdict ${f.event[0]}`, f.event[1]));
  sec.append(list);
  sec.append(
    el(
      'p',
      'store-pick-note',
      `installed by ${v.by || 'an admin'}, ${agoText(v.at)}${f.hosts.length > 1 ? '' : '; no backups'}`,
    ),
  );
  const out = [sec];
  const web = v.web ?? page?.def.manifest.web;
  const acts = el('section', 'store-sec store-go');
  const row = el('div', 'store-acts');
  if (web && st.meshDomain && f.active?.running)
    row.append(
      Object.assign(el('a', 'btn primary store-pill', 'open'), {
        href: `https://${id}.${st.meshDomain}/`,
        target: '_blank',
        rel: 'noopener',
      }),
    );
  if (st.acct?.admin) {
    const btn = (label: string, title: string, go: () => void, cls = '') => {
      const b = Object.assign(el('button', `store-host-btn ${cls}`.trim(), label), {
        type: 'button',
        title,
        disabled: busy,
      });
      b.addEventListener('click', go);
      row.append(b);
    };
    btn('update', 'pull its images again and restart it', async () => {
      if (
        await pageAsk({
          title: `update ${v.summary.name}`,
          message: `its images pulled again, it restarts on ${f.live}; its backups pull them too`,
          action: 'update',
        })
      )
        stackAct(id, 'update');
    });
    btn('settings…', 'its values: extras like a runner, ports', () => settings(v, page));
    btn('hosts…', 'its backup hosts', () => changeHosts(v, page));
    btn('move to host…', 'a planned handoff to a backup', () => moveTo(v));
    btn('remove…', 'take it off the mesh', () => remove(v), 'danger');
  }
  acts.append(row);
  out.push(acts);
  return out;
}

// --- the catalogue it's from -----------------------------------------------------------------

// the same service in other catalogues: the one to install from picked, its own page shown
function sourceSec(key: string): HTMLElement | null {
  const { source, ref } = splitKey(key);
  const list = twins(source, ref);
  if (list.length < 2) return null;
  const sec = el('div', 'store-listed');
  sec.title = `${list.length} catalogues list it, each with its own compose file and licence; this page is ${SOURCE_NAMES[source]}’s`;
  sec.append(el('span', 'store-listed-k', 'install from'));
  const row = el('div', 'store-chips');
  for (const a of list) {
    const on = a.source === source;
    const here = !!installedAs(a.source, a.ref);
    const b = Object.assign(
      el('button', `store-chip${on ? ' on' : ''}`, `${SOURCE_NAMES[a.source]}${here ? ' · installed' : ''}`),
      { type: 'button', ariaPressed: String(on), title: `${SOURCE_NAMES[a.source]}’s listing, ${a.licence}` },
    );
    b.addEventListener('click', () => {
      if (on) return;
      pickSource(a);
      storeShow(`stack:${keyOf(a.source, a.ref)}`);
    });
    row.append(b);
  }
  sec.append(row);
  return sec;
}

// --- the page ----------------------------------------------------------------------------------

export function stackPage(key: string): HTMLElement {
  const wrap = el('div', 'store-page');
  const { source, ref } = splitKey(key);
  const loaded: Loaded | undefined = pages.get(key);
  if (!loaded) loadPage(key);
  const page = loaded?.page;
  const v = installedAs(source, ref);
  if (!page && !v) {
    if (loaded?.error) {
      const box = el('div', 'store-empty bad', loaded.error);
      const again = Object.assign(el('button', 'store-link', 'try again'), { type: 'button' });
      again.addEventListener('click', () => {
        pages.delete(key);
        loadPage(key);
      });
      wrap.append(crumb('services', ref), box, again);
    } else wrap.append(crumb('services', ref), el('div', 'store-empty', `reading ${ref}`));
    return wrap;
  }
  const def = page?.def;
  const sum = v?.summary;
  const name = def?.name ?? sum!.name;
  const others = twins(source, ref);
  wrap.append(
    crumb('services', name, iconTile(name, [def?.icon ?? sum?.icon ?? '', ...others.map((a) => a.icon)], 'sm')),
  );
  const cols = el('div', 'store-cols');
  const main = el('div', 'store-main');
  const side = el('aside', 'store-side');
  main.append(el('p', 'store-tag', def?.tagline ?? sum!.tagline));
  // the page's facts and catalogues over its readme, the side column the install alone
  const from = sourceSec(key);
  if (from) main.append(from);
  if (def) main.append(info(key, def, v));
  if (page) {
    // a catalogue's app has its description for a readme: said once
    const about = page.def.description.trim();
    if (about && about !== page.def.tagline && about !== page.readme.trim())
      main.append(el('p', 'store-about', page.def.description));
    main.append(viewer(key, page));
  } else if (loaded?.error) main.append(el('div', 'store-empty bad', loaded.error));
  else main.append(el('div', 'store-empty', 'reading its page'));
  const f = formOf(key);
  // the same service installed from another catalogue: that one's page, not a second install
  const twin = v ? undefined : others.map((a) => installedAs(a.source, a.ref)).find(Boolean);
  if (v) side.append(...installedSec(v, page));
  else if (twin) {
    const go = Object.assign(el('button', 'store-link', 'its page'), { type: 'button' });
    go.addEventListener('click', () => storeShow(`stack:${keyOf(twin.summary.source, twin.summary.ref)}`));
    const note = el('p', 'store-pick-note', `already on the mesh from ${SOURCE_NAMES[twin.summary.source]}: `);
    note.append(go);
    side.append(note);
  } else if (page && f.busy) side.append(el('div', 'store-verdict wait', `installing onto ${f.active}`));
  else if (page) side.append(...installSec(key, page));
  cols.append(main, side);
  wrap.append(cols);
  return wrap;
}
