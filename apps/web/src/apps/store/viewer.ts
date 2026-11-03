// an installable app's page, the repo viewer: its readme, files and compose file, where it
// comes from and under what licence, the install check, and the install itself: the env
// form, the host and its backups; once installed, its hosts, their logs and an admin's steps

import type { AppDef, AppPage, CheckResult, HostFit, StackView } from '@phosphorus/wire';
import { DK_UI, dkGlyph, el, noFill, pageAsk } from '../../lib/dom.ts';
import { renderMd } from '../../lib/md.ts';
import { st } from '../../lib/state.ts';
import { humanSize } from '../../lib/util.ts';
import { iconTile } from './apps.ts';
import {
  agoText,
  dockerBusy,
  dockerError,
  fitting,
  formOf,
  hostUp,
  install,
  installedAs,
  type Loaded,
  loadPage,
  opWords,
  pages,
  recheck,
  SOURCE_NAMES,
  sourceOf,
  splitKey,
  stackAct,
  stackFacts,
  statusOn,
} from './catalog.ts';
import { draw } from './draw.ts';
import { legacyPending } from './legacy.ts';
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
    const go = Object.assign(el('button', danger ? 'danger' : 'primary', action), { type: 'submit' });
    const no = Object.assign(el('button', '', 'cancel'), { type: 'button' });
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

// a list of hosts to tick or pick one of, each with a note, or why it can't be; returns the picked
function hostChoice(
  hosts: { host: string; note?: string; why?: string; on?: boolean }[],
  type: 'radio' | 'checkbox',
  onChange?: (picked: string[]) => void,
): { el: HTMLElement; picked: () => string[] } {
  const list = el('ul', 'store-pick-list');
  const name = `h${Math.random().toString(36).slice(2)}`;
  const boxes: [string, HTMLInputElement][] = [];
  for (const h of hosts) {
    const li = el('li', `store-pick-row${h.why ? ' off' : ''}`);
    const cb = Object.assign(el('input'), { type, name, checked: !!h.on && !h.why, disabled: !!h.why });
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
const BACKUP_WORDS =
  'A backup host keeps a copy of the app’s data, synced from the active host, and takes over by itself if the active host goes down.';

// --- the header -------------------------------------------------------------------------

function badge(def: Pick<AppDef, 'source' | 'repo' | 'licence'>): HTMLElement {
  const src = sourceOf(def.source);
  const href = def.source === 'github' ? def.repo : src?.repo || def.repo;
  const a = Object.assign(el('a', 'store-badge'), {
    href,
    target: '_blank',
    rel: 'noopener',
    title: def.source === 'github' ? 'the repo, under its own licence' : `the ${SOURCE_NAMES[def.source]} catalogue`,
  });
  a.append(
    el('span', 'store-badge-src', SOURCE_NAMES[def.source]),
    el('span', 'store-badge-lic', def.licence || 'no licence'),
  );
  return a;
}

function hero(
  name: string,
  tagline: string,
  icon: string,
  def: Pick<AppDef, 'source' | 'repo' | 'licence' | 'category'>,
  sub?: [string, string],
): HTMLElement {
  const box = el('div', 'store-hero');
  const text = el('div', 'store-hero-text');
  const meta = el('div', 'store-hero-meta');
  meta.append(badge(def));
  if (def.category && def.source !== 'github') meta.append(el('span', '', def.category));
  if (def.repo && def.source !== 'github')
    meta.append(
      Object.assign(el('a', 'store-hero-link', def.repo.replace(/^https?:\/\/(www\.)?/, '')), {
        href: def.repo,
        target: '_blank',
        rel: 'noopener',
        title: 'the app’s own project',
      }),
    );
  text.append(el('h1', '', name), el('p', 'store-hero-tag', tagline), meta);
  box.append(iconTile(name, [icon], 'lg'), text);
  if (sub) {
    const acts = el('div', 'store-hero-acts');
    acts.append(el('span', `store-hero-sub ${sub[0]}`, sub[1]));
    box.append(acts);
  }
  return box;
}

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
    if (!page.def.compose.trim())
      sec.append(
        el(
          'div',
          'store-empty bad',
          'No compose file here. Phosphorus looks for compose.yml or docker-compose.yml at the repo’s root, in docker/ and in deploy/.',
        ),
      );
    else
      sec.append(
        el(
          'p',
          'store-pick-note',
          'Read only, as phosphorus renders it: each data volume becomes a folder under its data/.',
        ),
        el('pre', 'store-code', page.def.compose),
      );
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

function info(def: AppDef, v?: StackView): HTMLElement {
  const dl = el('dl', 'store-info');
  const row = (k: string, val: string | HTMLElement, cls = '') => {
    dl.append(el('dt', '', k));
    const dd = el('dd', cls);
    dd.append(val);
    dl.append(dd);
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
  row('licence', def.licence || 'none given', def.licence ? '' : 'dim');
  if (def.source !== 'github' && def.repo) row('project', link(def.repo.replace(/^https?:\/\/(www\.)?/, ''), def.repo));
  const m = def.manifest;
  const web = v?.web ?? m.web;
  if (web)
    row(
      'published as',
      st.meshDomain ? `${def.id}.${st.meshDomain}, from ${web.service}:${web.port}` : `${web.service}:${web.port}`,
    );
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
  const ul = el('ul', 'store-check');
  for (const i of check.items) ul.append(el('li', i.level, i.text));
  sec.append(h, el('div', `store-verdict ${cls}`, text));
  if (check.items.length) sec.append(ul);
  return sec;
}

// a field still wanting a value: required, no default, not one generated
const wanting = (def: AppDef, env: Record<string, string>) =>
  def.env.filter((x) => x.required && !x.secret && !x.default && !env[x.name]?.trim()).map((x) => x.name);

function envSec(key: string, def: AppDef): HTMLElement | null {
  if (!def.env.length) return null;
  const f = formOf(key);
  const sec = el('section', 'store-sec');
  sec.append(el('h2', '', 'settings'));
  const form = el('div', 'store-env');
  for (const x of def.env) {
    const lab = el('label', 'store-env-row');
    const head = el('span', 'store-env-label', x.label || x.name);
    if (x.required && !x.secret && !x.default) head.append(el('span', 'store-env-req', ' required'));
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
    lab.append(head, input, el('span', 'store-env-name', x.name));
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
  if (!fit.length)
    sec.append(el('div', 'store-verdict bad', 'No host can run it'), el('p', 'store-pick-note', 'Each host and why:'));
  const pick = hostChoice(
    [
      ...fit.map((h) => ({ host: h.host, on: h.host === f.active, note: note(h) })),
      ...check.hosts.filter((h) => !h.ok).map((h) => ({ host: h.host, why: h.why || 'doesn’t fit' })),
    ],
    'radio',
    ([h]) => {
      f.active = h ?? '';
      redraw();
    },
  );
  sec.append(pick.el);
  return sec;
}

function backupSec(key: string, page: AppPage, check: CheckResult): HTMLElement | null {
  const f = formOf(key);
  if (!f.active) return null;
  const rest = fitting(page, check).filter((h) => h.host !== f.active);
  const sec = el('section', 'store-sec');
  const h = el('h2', '', 'backups');
  h.append(el('span', 'store-count', f.standbys.length ? `${f.standbys.length}` : 'none'));
  sec.append(h, el('p', 'store-pick-note', BACKUP_WORDS));
  if (!rest.length) {
    sec.append(el('p', 'store-pick-note warn', 'No other host can run it, so it can’t have a backup.'));
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

// the hosts picked, less the one the old data is on, as the server places the move
const backupsOf = (from: string, picked: string[]) => [...new Set(picked.filter((h) => h && h !== from))].join(', ');

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
  // the old built-in git's data goes with it, onto the newest copy's host
  const old = legacyPending(page.def.source, page.def.ref);
  const go = Object.assign(
    el(
      'button',
      `store-pill big store-install${f.busy ? ' wait' : ''}`,
      f.busy ? 'installing' : old.length ? 'install with your git data' : 'install',
    ),
    {
      type: 'button',
      disabled: !canInstall(key, page.def, check),
    },
  );
  go.addEventListener('click', () => install(key, { also: old.slice(0, 1) }));
  sec.append(go);
  // the data moved by hand (the README's Git), or not wanted
  if (old.length && !f.busy) {
    const empty = Object.assign(el('button', 'store-pill', 'install it empty instead'), {
      type: 'button',
      disabled: go.disabled,
    });
    empty.addEventListener('click', () => install(key, { fresh: true }));
    sec.append(empty);
  }
  const missing = wanting(page.def, f.env);
  const why = !st.acct?.admin
    ? 'An admin installs apps.'
    : check.verdict === 'blocked'
      ? 'The check above says why it can’t.'
      : !f.active
        ? 'No host to install it on.'
        : missing.length
          ? `Fill in ${missing.join(', ')} first.`
          : old.length
            ? `Your old git data on ${old[0]} moves into it there, with ${backupsOf(old[0]!, [f.active, ...f.standbys]) || 'no'} backup.`
            : `Onto ${f.active}${f.standbys.length ? `, with ${f.standbys.join(', ')} as backup` : ''}.`;
  sec.append(el('p', 'store-pick-note', why));
  if (f.error) sec.append(el('p', 'store-repo-err', f.error));
  out.push(sec);
  return out;
}

// --- an installed app ------------------------------------------------------------------------

function hostRow(v: StackView, h: string): HTMLElement {
  const id = v.summary.id;
  const s = statusOn(h, id);
  const role = h === v.active ? 'active' : 'backup';
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
              : s.lastSync
                ? `copy synced ${agoText(s.lastSync)}`
                : 'no copy yet';
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

async function changeBackups(v: StackView, page: AppPage | undefined) {
  const rest = fitHosts(page).filter((h) => h !== v.active);
  const pick = hostChoice(
    rest.map((h) => ({ host: h, on: v.standbys.includes(h) })),
    'checkbox',
  );
  const body: (HTMLElement | string)[] = [BACKUP_WORDS];
  body.push(rest.length ? pick.el : el('p', 'store-pick-note warn', 'No other host can run it.'));
  if (await ask(`backups for ${v.summary.name}`, body, 'save'))
    stackAct(v.summary.id, 'standbys', { standbys: pick.picked() });
}

async function moveTo(v: StackView, page: AppPage | undefined) {
  // the backups first: they hold a copy already
  const rest = fitHosts(page)
    .filter((h) => h !== v.active)
    .sort((a, b) => Number(v.standbys.includes(b)) - Number(v.standbys.includes(a)));
  const pick = hostChoice(
    rest.map((h, i) => ({ host: h, on: i === 0, note: v.standbys.includes(h) ? 'a backup, its copy ready' : '' })),
    'radio',
  );
  const body: (HTMLElement | string)[] = [
    `${v.summary.name} stops on ${v.active}, its data is copied over a last time, and it starts on the host you pick. It’s offline for that moment.`,
    rest.length ? pick.el : el('p', 'store-pick-note warn', 'No other host can run it.'),
  ];
  if ((await ask(`move ${v.summary.name} to…`, body, 'move')) && pick.picked()[0])
    stackAct(v.summary.id, 'move', { to: pick.picked()[0] });
}

async function remove(v: StackView) {
  const keep = Object.assign(el('input'), { type: 'checkbox', checked: true });
  const lab = el('label', 'store-pick-label');
  lab.append(keep, el('span', '', `keep its data on ${[v.active, ...v.standbys].join(', ')}`));
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

function installedSec(v: StackView, page: AppPage | undefined): HTMLElement[] {
  const f = stackFacts(v);
  const id = v.summary.id;
  const busy = stateVars.busyId === `stack:${id}` || f.busy.length > 0;
  const sec = el('section', 'store-sec');
  const h = el('h2', '', 'on the mesh');
  h.append(el('span', 'store-count', `gen ${v.gen}`));
  const list = el('ul', 'store-hosts');
  for (const x of f.hosts) list.append(hostRow(v, x));
  sec.append(h);
  if (f.event) sec.append(el('div', `store-verdict ${f.event[0]}`, f.event[1]));
  sec.append(list);
  sec.append(
    el(
      'p',
      'store-pick-note',
      `installed by ${v.by || 'an admin'}, ${agoText(v.at)}${v.standbys.length ? '' : '; no backups'}`,
    ),
  );
  const out = [sec];
  const web = v.web ?? page?.def.manifest.web;
  const acts = el('section', 'store-sec store-go');
  const row = el('div', 'store-acts');
  if (web && st.meshDomain && f.active?.running)
    row.append(
      Object.assign(el('a', 'store-pill open', 'open'), {
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
          message: `Its images are pulled again and it restarts on ${v.active}; its backups pull them too.`,
          action: 'update',
        })
      )
        stackAct(id, 'update');
    });
    btn('backups…', 'pick the hosts that take over', () => changeBackups(v, page));
    btn('move to host…', 'a planned handoff to another host', () => moveTo(v, page));
    btn('remove…', 'take it off the mesh', () => remove(v), 'danger');
  } else row.append(el('span', 'store-pick-note', 'An admin updates, moves or removes it.'));
  acts.append(row);
  out.push(acts);
  return out;
}

// --- the page ----------------------------------------------------------------------------------

export function stackPage(key: string): HTMLElement {
  const wrap = el('div', 'store-page');
  const back = Object.assign(el('button', 'store-back'), { type: 'button' });
  back.append(dkGlyph(DK_UI.back!, 'store-back-ic'), 'services');
  back.addEventListener('click', () => storeShow(''));
  wrap.append(back);
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
      wrap.append(el('h1', '', ref), box, again);
    } else wrap.append(el('div', 'store-empty', `reading ${ref}`));
    return wrap;
  }
  const def = page?.def;
  const sum = v?.summary;
  wrap.append(
    hero(
      def?.name ?? sum!.name,
      def?.tagline ?? sum!.tagline,
      def?.icon ?? sum!.icon,
      def ?? { source: sum!.source, repo: '', licence: sum!.licence, category: sum!.category },
      v ? stackFacts(v).sub : page ? verdict(formOf(key).check ?? page.check) : undefined,
    ),
  );
  const cols = el('div', 'store-cols');
  const main = el('div', 'store-main');
  const side = el('aside', 'store-side');
  if (page) {
    // a catalogue's app has its description for a readme: said once
    const about = page.def.description.trim();
    if (about && about !== page.def.tagline && about !== page.readme.trim())
      main.append(el('p', 'store-about', page.def.description));
    main.append(viewer(key, page));
  } else if (loaded?.error) main.append(el('div', 'store-empty bad', loaded.error));
  else main.append(el('div', 'store-empty', 'reading its page'));
  const f = formOf(key);
  if (v) side.append(...installedSec(v, page));
  else if (page && f.busy) side.append(el('div', 'store-verdict wait', `installing onto ${f.active}`));
  else if (page) side.append(...installSec(key, page));
  if (def) {
    const sec = el('section', 'store-sec');
    sec.append(el('h2', '', 'information'), info(def, v));
    side.append(sec);
  }
  cols.append(main, side);
  wrap.append(cols);
  return wrap;
}
