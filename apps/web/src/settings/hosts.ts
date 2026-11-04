// --- settings › hosts, in four parts down the rail. Status: a bar of the mesh's hosts over the
// mesh's stats summed, or one host's in full. Graph: the mesh graph with its pings. Desktops: every
// computer on the tailnet, opened as its own desktop. Configure: for an admin, a host they're signed
// into (its login saved in their vault) and its settings: the folders it shares, the model it runs

import { appCall } from '../apps/index.ts';
import { dkHostDesk } from '../desktop/desk/hostdesk.ts';
import { drawMesh, meshPanel, phosphorusHosts, pingHosts } from '../features/mesh/mesh.ts';
import { meshAnimFrame, uiVars } from '../features/mesh/ui.ts';
import { acctCall } from '../lib/api.ts';
import { el, noFill, stash } from '../lib/dom.ts';
import { st } from '../lib/state.ts';
import { cardify, dkSettings } from './settings.ts';

export const HOST_SUBS = ['status', 'graph', 'desktops', 'configure'] as const;
type HostSub = (typeof HOST_SUBS)[number];

// the part shown, the host status shows alone ('' for all) and the one configured; kept while
// the window lives on
let part: HostSub = 'status';
let picked = '';
let configured = '';
export const hostsSub = (): HostSub => part;

// whether this account may change a host's config: an admin with its login saved
const signedIn = (host: string) => !!st.acct?.vault.hosts[host];

// sub a part, or a host's name (the bar's host chips): that host's status
export function hostsSection(pane: HTMLElement, sub?: string): () => void {
  if (HOST_SUBS.includes(sub as HostSub)) part = sub as HostSub;
  else if (sub) {
    part = 'status';
    picked = sub;
  }
  if (part === 'configure' && !st.acct?.admin) part = 'status';
  if (part === 'graph') return graphPart(pane);
  if (part === 'desktops') return desktopsPart(pane);
  if (part === 'configure') return configurePart(pane);
  return statusPart(pane);
}

// a bar of hosts to pick one of, redrawn as the mesh changes; first an entry of its own when named
function hostBar(
  hosts: () => string[],
  now: () => string,
  pick: (h: string) => void,
  first?: string,
): { node: HTMLElement; draw: () => boolean } {
  const node = Object.assign(el('div', 'set-hostbar'), { role: 'tablist', ariaLabel: 'hosts' });
  let sig = '';
  const draw = () => {
    const list = hosts();
    const next = `${now()}|${list.join()}|${Object.keys(st.acct?.vault.hosts ?? {}).join()}`;
    if (next === sig) return false;
    sig = next;
    node.replaceChildren(
      ...[...(first !== undefined ? [''] : []), ...list].map((h) => {
        const on = h === now();
        const b = Object.assign(el('button', `set-hostchip${on ? ' on' : ''}`), {
          type: 'button',
          role: 'tab',
          ariaSelected: String(on),
          title: !h ? 'every host' : signedIn(h) ? `${h}, signed in` : `${h}, not signed in`,
        });
        if (h && h === st.selfHost) b.classList.add('self');
        if (h && signedIn(h)) b.classList.add('in');
        b.append(h || first || '');
        b.addEventListener('click', () => {
          if (now() !== h) pick(h);
        });
        return b;
      }),
    );
    return true;
  };
  return { node, draw };
}

function statusPart(pane: HTMLElement): () => void {
  const status = document.getElementById('view-status')!;
  status.classList.add('active');
  const bar = hostBar(
    phosphorusHosts,
    () => picked,
    (h) => {
      picked = h;
      show();
    },
    'all hosts',
  );
  pane.append(bar.node, status);
  const show = () => {
    if (picked && !phosphorusHosts().includes(picked)) picked = '';
    bar.draw();
    appCall('status', true, (m) => m.statusOnly(picked || null));
  };
  show();
  const t = setInterval(() => {
    if (picked && !phosphorusHosts().includes(picked)) show();
    else bar.draw();
  }, 3000);
  const fit = new ResizeObserver(() => appCall('status', false, (m) => m.statusDraw()));
  fit.observe(status);
  return () => {
    clearInterval(t);
    fit.disconnect();
    appCall('status', false, (m) => m.statusOnly(null));
    status.classList.remove('active');
    stash.append(status);
  };
}

function graphPart(pane: HTMLElement): () => void {
  const mesh = el('div', 'set-mesh set-mesh-full');
  mesh.append(meshPanel);
  pane.append(mesh);
  // measured while stashed, 0 tall: measured again now it shows
  uiVars.meshDims = null;
  uiVars.meshStatsDirty = true;
  drawMesh();
  pingHosts();
  const fit = new ResizeObserver(() => {
    uiVars.meshDims = null;
    if (!meshAnimFrame) drawMesh();
  });
  fit.observe(mesh);
  return () => {
    fit.disconnect();
    stash.prepend(meshPanel);
  };
}

// every computer the tailnet names, each opened as its own desktop; an admin's switch
// for each, the viewer's saved login named beside it
function desktopsPart(pane: HTMLElement): () => void {
  const list = el('ul', 'dk-rows set-desks');
  const note = el(
    'p',
    'dk-note',
    'a computer opens as its own desktop, signed in with your saved login for it; nothing is installed on it',
  );
  pane.append(...cardify([note, list]));
  let on: Record<string, unknown> = {};
  let sig = '';
  const draw = (force = false) => {
    const devs = new Map<string, string>();
    if (st.selfHost) devs.set(st.selfHost, st.hostsInfo[st.selfHost]?.platform || '');
    for (const d of st.lastState?.tailnet ?? []) devs.set(d.name, d.os || devs.get(d.name) || '');
    const names = [...devs.keys()].sort(
      (a, b) => Number(b === st.selfHost) - Number(a === st.selfHost) || a.localeCompare(b),
    );
    const next = JSON.stringify([names, on, Object.keys(st.acct?.vault.hosts ?? {})]);
    if (next === sig && !force) return;
    sig = next;
    list.replaceChildren(
      ...(names.length
        ? names.map((h) => {
            const os = devs.get(h) || '';
            const mac = /mac|darwin|ios/i.test(os);
            const li = el('li', 'dk-row');
            const name = el('span', `dk-host${h === st.selfHost ? ' is-self' : ''}`, h);
            const kind = el('span', 'dk-note', os.toLowerCase() || 'unknown os');
            const login = el('span', 'dk-note', signedIn(h) ? 'login saved' : 'no login saved');
            li.append(name, kind, login);
            if (st.acct?.admin) {
              const box = Object.assign(el('input'), { type: 'checkbox', checked: !!on[h], disabled: mac });
              const lab = el('label', 'dk-ap-check');
              lab.append(box, el('span', 'dk-ap-check-t', 'enabled'));
              box.addEventListener('change', async () => {
                box.disabled = true;
                const r = await acctCall('/api/hostdesk/enable', { host: h, on: box.checked });
                box.disabled = false;
                if (!r.ok) box.checked = !box.checked;
                await fetchOn();
              });
              li.append(lab);
            } else li.append(el('span', 'dk-note', on[h] ? 'enabled' : 'not enabled'));
            const open = Object.assign(el('button', 'btn primary', 'open'), {
              type: 'button',
              disabled: mac || !on[h],
            });
            open.title = mac
              ? "macos isn't drawn"
              : !on[h]
                ? 'an admin enables it first'
                : `open ${h} as its own desktop`;
            open.addEventListener('click', () => dkHostDesk(h, open));
            li.append(open);
            return li;
          })
        : [el('li', 'empty', 'no computers on the tailnet')]),
    );
  };
  const fetchOn = async () => {
    const r = await acctCall<{ hosts: Record<string, unknown> }>('/api/hostdesk');
    if (r.ok) on = r.hosts ?? {};
    draw(true);
  };
  draw();
  void fetchOn();
  const t = setInterval(() => draw(), 3000);
  return () => clearInterval(t);
}

// the hosts this admin is signed into, this page's host first; the rest named, a way to sign in
function configurePart(pane: HTMLElement): () => void {
  const mine = () => {
    const all = phosphorusHosts();
    return all
      .filter(signedIn)
      .sort((a, b) => Number(b === st.selfHost) - Number(a === st.selfHost) || a.localeCompare(b));
  };
  const cfg = el('div', 'set-host-cfg');
  const rest = el('p', 'dk-note set-host-rest');
  const bar = hostBar(
    mine,
    () => configured,
    (h) => {
      configured = h;
      show();
    },
  );
  pane.append(bar.node, cfg, rest);
  let was = '';
  const show = () => {
    const list = mine();
    if (!list.includes(configured)) configured = list[0] ?? '';
    bar.node.hidden = !list.length;
    bar.draw();
    const others = phosphorusHosts().filter((h) => !signedIn(h));
    rest.replaceChildren();
    if (others.length) {
      const go = Object.assign(el('button', 'store-link', 'sign in under profile'), { type: 'button' });
      go.addEventListener('click', () => dkSettings('profile', 'host logins'));
      rest.append(
        list.length
          ? `not signed in, so not configured from here: ${others.join(', ')}; `
          : `not signed into any host, so none is configured from here; `,
        go,
      );
    }
    if (configured === was) return;
    was = configured;
    cfg.replaceChildren(...(configured ? configFor(configured) : []));
  };
  show();
  const t = setInterval(show, 3000);
  return () => clearInterval(t);
}

// a host's forms, read when it's picked
function configFor(host: string): HTMLElement[] {
  const body = el('div', 'set-host-body acct-pane');
  body.append(el('p', 'dk-note', 'reading its config'));
  void cfgCall(host).then((r) => {
    if (!r.ok) {
      body.replaceChildren(el('p', 'dk-state bad', r.error));
      return;
    }
    body.replaceChildren(...hostForm(host, r.values as HostIni));
  });
  return [body];
}

// --- a host's config, read when it's picked -----------------------------------------------------

interface Share {
  dir: string;
  perms: string;
}
interface HostIni {
  shares: Share[];
  model: Record<string, string>;
  platform: string;
}

const PERMS: [string, string][] = [
  ['r', 'read'],
  ['rw', 'read, write'],
  ['rwd', 'read, write, delete'],
];
const RESTARTS = 'saving restarts phosphorus on that host, its terminals drop for a moment';

async function cfgCall(host: string, body?: Record<string, unknown>): Promise<Record<string, any>> {
  try {
    const r = await fetch(`/api/hosts/${encodeURIComponent(host)}/config`, {
      method: body ? 'POST' : 'GET',
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const out = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, ...out } : { ok: false, error: out.error || `status ${r.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function hostForm(host: string, ini: HostIni): HTMLElement[] {
  const say = el('div', 'dk-state');
  const send = async (b: HTMLButtonElement, body: Record<string, unknown>) => {
    b.disabled = true;
    say.className = 'dk-state busy';
    say.textContent = 'saving';
    const r = await cfgCall(host, body);
    b.disabled = false;
    say.className = `dk-state ${r.ok ? 'ok' : 'bad'}`;
    say.textContent = r.ok ? r.note || 'saved' : r.error;
  };
  const btn = (label: string, cls = '') => Object.assign(el('button', `btn ${cls}`.trim(), label), { type: 'button' });
  const head = (t: string) => el('div', 'dk-pick-head', t);

  // shares: none by default, each an admin's own opt-in
  const shares = ini.shares.map((s) => ({ ...s }));
  const list = el('ul', 'dk-rows set-shares');
  const permSel = (now: string, set: (v: string) => void) => {
    const s = el('select', 'dk-ap-in');
    for (const [v, label] of PERMS) s.append(Object.assign(el('option', '', label), { value: v, selected: now === v }));
    if (!PERMS.some(([v]) => v === now)) s.append(Object.assign(el('option', '', now), { value: now, selected: true }));
    s.addEventListener('change', () => set(s.value));
    return s;
  };
  const drawShares = () => {
    list.replaceChildren(
      ...(shares.length
        ? shares.map((s, i) => {
            const li = el('li', 'dk-row');
            const del = btn('remove', 'danger');
            del.addEventListener('click', () => {
              shares.splice(i, 1);
              drawShares();
            });
            li.append(
              Object.assign(el('span', 'dk-host', s.dir), { title: s.dir }),
              permSel(s.perms, (v) => {
                s.perms = v;
              }),
              del,
            );
            return li;
          })
        : [el('li', 'empty', 'no folders shared')]),
    );
  };
  drawShares();
  const dir = noFill(
    Object.assign(el('input'), {
      placeholder: ini.platform === 'win32' ? 'D:\\media' : '/srv/media',
      spellcheck: false,
      autocapitalize: 'off',
    }),
  );
  let perms = 'r';
  const add = btn('add');
  add.addEventListener('click', () => {
    const v = dir.value.trim();
    if (!v || shares.some((s) => s.dir === v)) return;
    shares.push({ dir: v, perms });
    dir.value = '';
    drawShares();
  });
  dir.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') add.click();
  });
  const addRow = el('div', 'dk-row acct-new');
  addRow.append(
    dir,
    permSel(perms, (v) => {
      perms = v;
    }),
    add,
  );
  const saveShares = btn('save shares', 'primary');
  saveShares.addEventListener('click', () => send(saveShares, { op: 'shares', shares }));

  // the model this host runs for the mesh
  const m = ini.model;
  const check = (label: string, on: boolean) => {
    const r = el('label', 'dk-ap-check');
    const box = Object.assign(el('input'), { type: 'checkbox', checked: on });
    r.append(box, el('span', 'dk-ap-check-t', label));
    return [r, box] as const;
  };
  const [hostRowEl, hostBox] = check('run a model here for the whole mesh', m.host === 'true');
  const [gpuRowEl, gpuBox] = check('on its gpu, the rest in memory', m.gpu === 'true');
  const field = (label: string, value: string, hint: string, ph = '') => {
    const inp = noFill(Object.assign(el('input', 'dk-ap-in'), { value, placeholder: ph, spellcheck: false }));
    const r = el('div', 'dk-ap-row');
    r.append(el('span', 'dk-ap-k', label), inp, el('span', 'dk-ap-note', hint));
    return [r, inp] as const;
  };
  const [urlRow, url] = field(
    'model',
    m.url || '',
    'a https link to one .gguf, or its hugging face page',
    'https://…/model.gguf',
  );
  const [ctxRow, ctx] = field('context', m.ctx || '', 'tokens, blank is 65536; each costs memory', '65536');
  const [slotsRow, slots] = field('slots', m.slots || '', 'asks answered at once, sharing the context', '4');
  const saveModel = btn('save model', 'primary');
  saveModel.addEventListener('click', () =>
    send(saveModel, {
      op: 'model',
      values: {
        host: String(hostBox.checked),
        gpu: String(gpuBox.checked),
        url: url.value,
        ctx: ctx.value,
        slots: slots.value,
      },
    }),
  );

  const acts = (...b: HTMLElement[]) => {
    const d = el('div', 'update-actions set-acts');
    d.append(...b);
    return d;
  };
  return cardify([
    head('shared folders'),
    el('p', 'dk-note', 'nothing is shared until you add it; each folder shows in files for the mesh’s users'),
    list,
    addRow,
    acts(saveShares),
    head('model'),
    hostRowEl,
    gpuRowEl,
    urlRow,
    ctxRow,
    slotsRow,
    acts(saveModel),
    el('p', 'dk-note', RESTARTS),
    say,
  ]);
}
