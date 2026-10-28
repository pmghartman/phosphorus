// what's known of a service: the hosts it can run on, where it runs, who may act

import type { Route } from '@phosphorus/wire';
import { dkService } from '../../desktop/desk.ts';
import { editorPref } from '../../desktop/deskfiles.ts';
import { jsonPost } from '../../lib/api.ts';
import { DK_UI, dkGlyph, el } from '../../lib/dom.ts';
import { dk, st } from '../../lib/state.ts';
import { ago2 } from '../../lib/util.ts';
import { iconTile, page } from './apps.ts';
import { front } from './front.ts';
import {
  apps,
  logsOpen,
  read,
  readError,
  type StoreService,
  type SvcHost,
  type SvcOp,
  services,
  stateVars,
  storeShow,
  view,
  watching,
} from './state.ts';

// a host the service's scripts run on: a phosphorus host of one of its OSes, and the one
// this page is on when the tailnet hasn't it yet
export function svcEligible(s: StoreService): string[] {
  const names = (st.lastState?.tailnet || [])
    .filter((d) => d.phosphorus && (!d.os || s.os.includes(d.os)))
    .map((d) => d.name);
  if (st.selfHost && !names.includes(st.selfHost) && !(st.lastState?.tailnet || []).some((d) => d.name === st.selfHost))
    names.push(st.selfHost);
  return names.sort();
}

// the published route as the desk has it, the summary's own when the state hasn't caught up
export function svcRoute(s: StoreService, host: string): Route | undefined {
  return dk.services.find((r) => r.host === host && r.name === s.id) ?? (s.hosts[host]?.route as Route | undefined);
}

// whether this person logged into host on the desktop, so their saved login may act there
export const canAct = (host: string) => dk.creds.has(host);

export interface SvcFacts {
  // every host it can run on, and for each what's known
  rows: [string, SvcHost | undefined][];
  // hosts serving it
  on: string[];
  // hosts with a step under way
  busy: string[];
  // hosts whose last step failed
  failed: string[];
  // hosts whose checkout main has moved past
  behind: string[];
  // hosts this person may install it onto: logged in, not serving it, nothing under way
  canInstall: string[];
}

export function svcFacts(s: StoreService): SvcFacts {
  const rows = svcEligible(s).map((h): [string, SvcHost | undefined] => [h, s.hosts[h]]);
  const on = rows.filter(([h]) => !!svcRoute(s, h)).map(([h]) => h);
  const busy = rows.filter(([, x]) => x?.job && !x.job.done).map(([h]) => h);
  const failed = rows.filter(([, x]) => x?.job && x.job.done && x.job.ok === false).map(([h]) => h);
  const behind = rows.filter(([h, x]) => on.includes(h) && (x?.behind ?? 0) > 0).map(([h]) => h);
  return {
    rows,
    on,
    busy,
    failed,
    behind,
    canInstall: rows.filter(([h]) => canAct(h) && !on.includes(h) && !busy.includes(h)).map(([h]) => h),
  };
}

export const opWord: Record<SvcOp, string> = { install: 'installing', update: 'updating', remove: 'removing' };

// a service's step on a host, as the person's saved login there; keep: a remove leaving
// the checkout's data aside
export async function svcAct(op: SvcOp, s: StoreService, host: string, keep = false) {
  stateVars.busyId = s.id;
  stateVars.sig = '';
  draw();
  try {
    const r = await fetch(`/api/apps/services/${op}`, jsonPost({ id: s.id, host, keep }));
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `status ${r.status}`);
    stateVars.actError = '';
  } catch (e) {
    stateVars.actError = `${s.name} on ${host}: ${(e as Error).message}`;
  }
  stateVars.busyId = '';
  read();
}

// the service opened: the one host serving it, or its page to pick one
export function svcOpen(s: StoreService, f: SvcFacts, host?: string) {
  const h = host ?? (f.on.length === 1 ? f.on[0] : undefined);
  const r = h ? svcRoute(s, h) : undefined;
  if (r) dkService(r);
  else storeShow(s.id);
}

// where to install: the hosts it can run on, those this person logged into to pick from
export function svcPick(s: StoreService, f: SvcFacts): Promise<string[]> {
  return new Promise((resolve) => {
    const veil = el('div', 'fm-veil page-veil');
    const box = el('form', 'fm-ask store-pick');
    const end = (v: string[]) => {
      veil.remove();
      resolve(v);
    };
    const list = el('ul', 'store-pick-list');
    const boxes: [string, HTMLInputElement][] = [];
    for (const [h] of f.rows) {
      const li = el('li', 'store-pick-row');
      const cb = Object.assign(el('input'), { type: 'checkbox' });
      const lab = el('label', 'store-pick-label');
      lab.append(cb, el('span', 'store-pick-host', h));
      let why = '';
      if (f.on.includes(h)) {
        cb.checked = true;
        cb.disabled = true;
        why = 'already here';
      } else if (f.busy.includes(h)) {
        cb.disabled = true;
        why = opWord[s.hosts[h]!.job!.op];
      } else if (!canAct(h)) {
        cb.disabled = true;
        why = 'log into it on the desktop first';
      } else {
        boxes.push([h, cb]);
        cb.checked = f.canInstall.length === 1;
      }
      li.append(lab, el('span', `store-pick-why${why ? '' : ' hidden'}`, why));
      li.classList.toggle('off', cb.disabled);
      list.append(li);
    }
    const go = Object.assign(el('button', 'primary', 'install'), { type: 'submit' });
    const sync = () => {
      go.disabled = !boxes.some(([, cb]) => cb.checked);
    };
    for (const [, cb] of boxes) cb.addEventListener('change', sync);
    sync();
    const no = Object.assign(el('button', '', 'cancel'), { type: 'button' });
    no.addEventListener('click', () => end([]));
    const acts = el('div', 'update-actions');
    acts.append(no, go);
    const note = f.rows.length
      ? boxes.length
        ? `Installed as your own login on each host, in ${s.checkout}, and published on the mesh desktop.`
        : `You're logged into none of these on the desktop: log in from a host's lock in the task bar first.`
      : `${s.name} runs on ${s.os.join(', ')} hosts; the mesh has none.`;
    box.append(
      el('div', 'fm-ask-title', `install ${s.name} where?`),
      f.rows.length ? list : el('p', '', ''),
      el('p', '', note),
      acts,
    );
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      end(boxes.filter(([, cb]) => cb.checked).map(([h]) => h));
    });
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') end([]);
    });
    veil.addEventListener('pointerdown', (e) => {
      if (e.target === veil) end([]);
    });
    veil.appendChild(box);
    document.body.appendChild(veil);
    (boxes[0]?.[1] ?? go).focus();
  });
}

export async function svcInstall(s: StoreService, f: SvcFacts) {
  const hosts = await svcPick(s, f);
  for (const h of hosts) await svcAct('install', s, h);
}

// the store's one button for a service: install, open; what it does right now while it does
export function svcPill(s: StoreService, f: SvcFacts, big = false): HTMLElement {
  const b = Object.assign(el('button', `store-pill${big ? ' big' : ''}`), { type: 'button' });
  const set = (label: string, cls: string, go: (() => void) | null, title = '') => {
    b.textContent = label;
    b.className += ` ${cls}`;
    b.title = title;
    b.disabled = !go;
    if (go)
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        go();
      });
  };
  if (stateVars.busyId === s.id) set('starting', 'wait', null);
  else if (f.busy.length && !f.on.length)
    set(opWord[s.hosts[f.busy[0]!]!.job!.op], 'wait', null, `on ${f.busy.join(', ')}`);
  else if (f.on.length)
    set(
      'open',
      'open',
      () => svcOpen(s, f),
      f.on.length === 1 ? `open ${s.name} on ${f.on[0]}` : `${s.name} runs on ${f.on.length} hosts`,
    );
  else if (f.canInstall.length) set('install', 'get', () => svcInstall(s, f), `onto a host you're logged into`);
  else
    set(
      'install',
      'get',
      null,
      f.rows.length
        ? `log into a ${s.os.join(' or ')} host on the desktop first`
        : `runs on ${s.os.join(', ')} hosts; the mesh has none`,
    );
  return b;
}

// the icon the desktop shows, the running service's own, else the one off its repository
export const svcIcon = (s: StoreService, f: SvcFacts, cls: string) =>
  iconTile(
    s.name,
    [...f.on.map((h) => `/api/favicon/${encodeURIComponent(h)}/${encodeURIComponent(s.id)}`), s.icon],
    cls,
  );

// a line under a service's tile: where it runs, a step under way, or what it is
export function svcSub(s: StoreService, f: SvcFacts): [string, string] {
  if (stateVars.busyId === s.id) return ['wait', 'starting'];
  if (f.busy.length) return ['wait', `${opWord[s.hosts[f.busy[0]!]!.job!.op]} on ${f.busy.join(', ')}`];
  if (f.failed.length) return ['bad', `${s.hosts[f.failed[0]!]!.job!.op} failed on ${f.failed.join(', ')}`];
  if (f.behind.length)
    return ['new', `main moved: ${behindWords(s.hosts[f.behind[0]!]!.behind!)} past ${f.behind.join(', ')}`];
  if (f.on.length) return ['on', `on ${f.on.join(', ')}`];
  return ['dim', s.category];
}

export const behindWords = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;

// remove from a host: a service with data asks whether to keep it aside; null for no
export function svcRemoveAsk(s: StoreService, host: string): Promise<{ keep: boolean } | null> {
  return new Promise((resolve) => {
    const veil = el('div', 'fm-veil page-veil');
    const box = el('form', 'fm-ask store-pick');
    const end = (v: { keep: boolean } | null) => {
      veil.remove();
      resolve(v);
    };
    const keep = Object.assign(el('input'), { type: 'checkbox', checked: s.data.length > 0 });
    const text = el(
      'p',
      '',
      `Its unit is stopped, its entry leaves ${host}'s services.export and its checkout in ${s.checkout} is deleted.`,
    );
    const go = Object.assign(el('button', 'danger', 'remove'), { type: 'submit' });
    const no = Object.assign(el('button', '', 'cancel'), { type: 'button' });
    no.addEventListener('click', () => end(null));
    const acts = el('div', 'update-actions');
    acts.append(no, go);
    box.append(el('div', 'fm-ask-title', `remove ${s.name} from ${host}`), text);
    if (s.data.length) {
      const lab = el('label', 'store-pick-label');
      lab.append(keep, el('span', '', `keep its data (${s.data.join(', ')}) aside in ${s.kept}`));
      const note = el('p', 'store-pick-note', 'put back by the next install there');
      const sync = () => {
        note.textContent = keep.checked ? 'put back by the next install there' : 'its data goes with the checkout';
        note.classList.toggle('warn', !keep.checked);
      };
      keep.addEventListener('change', sync);
      sync();
      box.append(lab, note);
    }
    box.append(acts);
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      end({ keep: s.data.length > 0 && keep.checked });
    });
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') end(null);
    });
    veil.addEventListener('pointerdown', (e) => {
      if (e.target === veil) end(null);
    });
    veil.appendChild(box);
    document.body.appendChild(veil);
    go.focus();
  });
}

export function svcInfoRows(s: StoreService, f: SvcFacts): HTMLElement {
  const dl = el('dl', 'store-info');
  const row = (k: string, v: string | HTMLElement, cls = '') => {
    dl.append(el('dt', '', k));
    const dd = el('dd', cls);
    dd.append(v);
    dl.append(dd);
  };
  row('on the mesh', f.on.length ? f.on.join(', ') : 'not installed');
  row(
    'source',
    Object.assign(el('a', '', s.repo.replace(/^https?:\/\//, '').replace(/\.git$/, '')), {
      href: s.repo.replace(/\.git$/, ''),
      target: '_blank',
      rel: 'noopener',
    }),
  );
  row('installed from', 'the repository’s main, cloned on the host', 'dim');
  if (s.data.length)
    row('on remove', `its ${s.data.join(', ')} may be kept in ${s.kept}, back on the next install`, 'dim');
  row('runs as', `your own login, a systemd user unit in ${s.checkout}`, 'mono');
  row('published as', `port ${s.port}, ${s.mode} mode, in the host’s services.export`);
  row('runs on', `${s.os.join(', ')} hosts`);
  row('needs', s.needs, 'dim');
  if (s.agents.length) row('asks models as', s.agents.join(', '), 'mono');
  row('category', s.category);
  return dl;
}

// a small button in a host's row
export function svcBtn(label: string, title: string, go: () => void, cls = ''): HTMLButtonElement {
  const b = Object.assign(el('button', `store-host-btn ${cls}`.trim(), label), { type: 'button', title });
  b.addEventListener('click', go);
  return b;
}

export function svcHostList(s: StoreService, f: SvcFacts): HTMLElement {
  const list = el('ul', 'store-hosts');
  for (const [h, x] of f.rows) {
    const li = el('li', 'store-host svc');
    const route = svcRoute(s, h);
    const job = x?.job;
    const running = !!job && !job.done;
    const failed = !!job && job.done && job.ok === false;
    const can = canAct(h);
    const behind = route && (x?.behind ?? 0) > 0 ? x!.behind! : 0;
    const cls = running ? 'mid' : failed ? 'fail' : route ? 'ok' : x?.record ? 'old' : 'off';
    li.className += ` ${cls}`;
    const text = running
      ? opWord[job.op]
      : failed
        ? `${job.op} failed`
        : route
          ? `${x?.version ? `v${x.version}` : 'running'}${behind ? ` · ${behindWords(behind)} behind main` : ''}`
          : x?.record
            ? 'installed, not answering'
            : can
              ? 'not installed'
              : 'not installed · log in on the desktop to install';
    const top = el('div', 'store-host-top');
    top.append(
      el('i', 'store-dot'),
      el('span', `store-host-name${h === st.selfHost ? ' is-self' : ''}`, h),
      el('span', `store-host-state${behind ? ' behind' : ''}`, text),
    );
    if (failed) top.title = job.error;
    const acts = el('span', 'store-host-acts');
    if (route) acts.append(svcBtn('open', `open ${s.name} on ${h}`, () => svcOpen(s, f, h)));
    if (can && !running && stateVars.busyId !== s.id) {
      if (route || x?.record) {
        acts.append(
          svcBtn(
            'update',
            behind ? `main is ${behindWords(behind)} ahead: pull and rebuild on ${h}` : `pull main and rebuild on ${h}`,
            () => svcAct('update', s, h),
            behind ? 'new' : '',
          ),
        );
        acts.append(
          svcBtn(
            'remove',
            `stop ${s.name} on ${h} and delete its checkout`,
            async () => {
              const a = await svcRemoveAsk(s, h);
              if (a) svcAct('remove', s, h, a.keep);
            },
            'danger',
          ),
        );
      } else acts.append(svcBtn('install', `onto ${h}, as your login there`, () => svcAct('install', s, h)));
    }
    if (job && (running || failed || logsOpen.has(`${s.id}/${h}`))) {
      acts.append(
        svcBtn(logsOpen.has(`${s.id}/${h}`) ? 'hide log' : 'log', 'the step’s output', () => {
          const k = `${s.id}/${h}`;
          if (logsOpen.has(k)) logsOpen.delete(k);
          else logsOpen.add(k);
          stateVars.sig = '';
          draw();
        }),
      );
    }
    top.append(acts);
    li.append(top);
    if (job && (running || failed || logsOpen.has(`${s.id}/${h}`))) {
      const who = `${job.op} as ${job.login}${job.by ? `, for ${job.by}` : ''}${job.from && job.from !== h ? `, from ${job.from}` : ''}, ${ago2(job.at)}${job.done ? `, ${job.ok ? 'done' : 'failed'}` : ' · runs on the host itself, this page may close'}`;
      const log = el(
        'pre',
        `store-log${logsOpen.has(`${s.id}/${h}`) ? ' full' : ''}`,
        (failed && job.error ? `${job.log.trimEnd()}\n${job.error}` : job.log) || (running ? 'connecting…' : ''),
      );
      li.append(el('div', 'store-log-who', who), log);
      // the newest lines in view
      requestAnimationFrame(() => {
        log.scrollTop = log.scrollHeight;
      });
    }
    if (x?.record && !running) {
      li.append(
        el(
          'div',
          'store-host-note',
          `installed by ${x.record.by || x.record.login} as ${x.record.login}${x.record.at ? `, ${ago2(x.record.at)}` : ''}${x.record.commit ? `, at ${x.record.commit.slice(0, 7)}` : ''}`,
        ),
      );
    }
    list.append(li);
  }
  if (!list.children.length)
    list.append(el('li', 'store-empty', `${s.name} runs on ${s.os.join(', ')} hosts; the mesh has none`));
  return list;
}

export function svcPage(s: StoreService): HTMLElement {
  const f = svcFacts(s);
  const wrap = el('div', 'store-page');
  const back = Object.assign(el('button', 'store-back'), { type: 'button' });
  back.append(dkGlyph(DK_UI.back!, 'store-back-ic'), 'apps');
  back.addEventListener('click', () => storeShow(''));
  wrap.append(back);

  const hero = el('div', 'store-hero');
  const text = el('div', 'store-hero-text');
  const meta = el('div', 'store-hero-meta');
  meta.append(
    el('span', '', `by ${s.by}`),
    el('span', 'store-hero-dot', '·'),
    el('span', '', s.category),
    el('span', 'store-hero-dot', '·'),
    el('span', '', 'service'),
  );
  text.append(el('h1', '', s.name), el('p', 'store-hero-tag', s.tagline), meta);
  const acts = el('div', 'store-hero-acts');
  acts.append(svcPill(s, f, true));
  const [cls, sub] = svcSub(s, f);
  acts.append(el('span', `store-hero-sub ${cls}`, sub));
  if (f.on.length && f.canInstall.length) {
    const more = Object.assign(
      el('button', 'store-link'),
      { type: 'button' },
      { textContent: 'install on another host' },
    );
    more.addEventListener('click', () => svcInstall(s, f));
    acts.append(more);
  }
  hero.append(svcIcon(s, f, 'lg'), text, acts);
  wrap.append(hero);

  const cols = el('div', 'store-cols');
  const main = el('div', 'store-main');
  const aboutSec = el('section', 'store-sec');
  aboutSec.append(el('h2', '', 'about'), el('p', 'store-about', s.about));
  if (s.features.length) {
    const ul = el('ul', 'store-features');
    for (const x of s.features) ul.append(el('li', '', x));
    aboutSec.append(ul);
  }
  main.append(aboutSec);
  const hostsSec = el('section', 'store-sec');
  const hh = el('h2', '', 'hosts');
  if (f.on.length) hh.append(el('span', 'store-count', `on ${f.on.length} of ${f.rows.length}`));
  hostsSec.append(hh, svcHostList(s, f));
  main.append(hostsSec);
  const side = el('aside', 'store-side');
  const infoSec = el('section', 'store-sec');
  infoSec.append(el('h2', '', 'information'), svcInfoRows(s, f));
  side.append(infoSec);
  const who = el('section', 'store-sec');
  who.append(
    el('h2', '', 'who installs'),
    el(
      'p',
      'store-about dim',
      'Anyone logged into a host on this desktop installs, updates or removes it there, as that login. Admins are no different: a host you haven’t logged into is one you can’t install onto.',
    ),
  );
  side.append(who);
  cols.append(main, side);
  wrap.append(cols);
  return wrap;
}

export function draw() {
  if (!watching) return;
  const next = JSON.stringify([
    apps,
    services,
    readError,
    stateVars.actError,
    stateVars.busyId,
    stateVars.openId,
    [...logsOpen],
    st.selfHost,
    st.acct?.admin,
    st.hostsInfo,
    editorPref(),
    [...dk.creds.keys()],
    dk.services.map((r) => [r.host, r.name]),
    (st.lastState?.tailnet || []).map((d) => [d.name, d.phosphorus, d.os]),
  ]);
  if (next === stateVars.sig) return;
  stateVars.sig = next;
  // a page kept at its scroll across redraws
  const was = view.firstElementChild as HTMLElement | null;
  const scroll = was?.scrollTop || 0;
  const wrap = el('div', 'store');
  const open = stateVars.openId ? apps?.find((a) => a.id === stateVars.openId) : undefined;
  const openSvc = stateVars.openId && !open ? services.find((s) => s.id === stateVars.openId) : undefined;
  if (stateVars.openId && !open && !openSvc && apps) stateVars.openId = '';
  wrap.append(open ? page(open) : openSvc ? svcPage(openSvc) : front());
  if (stateVars.actError) wrap.append(el('div', 'store-err', stateVars.actError));
  view.replaceChildren(wrap);
  wrap.scrollTop = scroll;
}
