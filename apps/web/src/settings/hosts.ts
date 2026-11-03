// --- settings › hosts: the mesh graph with its pings and git copies, each host's stats, and for
// an admin each host's own phosphorus.ini: the folders it shares, the model it runs, git

import { appCall } from '../apps/index.ts';
import { drawMesh, meshPanel, phosphorusHosts, pingHosts } from '../features/mesh/mesh.ts';
import { meshAnimFrame, uiVars } from '../features/mesh/ui.ts';
import { el, noFill, stash } from '../lib/dom.ts';
import { st } from '../lib/state.ts';

export function hostsSection(pane: HTMLElement): () => void {
  const mesh = el('div', 'set-mesh');
  mesh.append(meshPanel);
  const status = document.getElementById('view-status')!;
  status.classList.add('active');
  pane.append(mesh, el('div', 'dk-ap-head', 'status'), status);
  const cfg = st.acct?.admin ? hostForms() : null;
  if (cfg) pane.append(el('div', 'dk-ap-head', 'configure'), cfg.node);
  // measured while stashed, 0 tall: measured again now it shows
  uiVars.meshDims = null;
  uiVars.meshStatsDirty = true;
  drawMesh();
  pingHosts();
  const fit = new ResizeObserver(() => {
    uiVars.meshDims = null;
    if (!meshAnimFrame) drawMesh();
    appCall('status', false, (m) => m.statusDraw());
  });
  fit.observe(mesh);
  fit.observe(status);
  return () => {
    fit.disconnect();
    cfg?.leave();
    status.classList.remove('active');
    stash.prepend(meshPanel);
    stash.append(status);
  };
}

// --- each host's config, read when its row opens ----------------------------------------------

interface Share {
  dir: string;
  perms: string;
}
interface HostIni {
  shares: Share[];
  model: Record<string, string>;
  git: boolean;
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

function hostForms(): { node: HTMLElement; leave: () => void } {
  const node = el('div', 'set-hosts');
  const opened = new Set<string>();
  let sig = '';
  const draw = () => {
    const hosts = phosphorusHosts();
    const next = hosts.join();
    if (next === sig) return;
    sig = next;
    const had = new Map([...node.querySelectorAll<HTMLElement>('.set-host')].map((d) => [d.dataset.host!, d]));
    node.replaceChildren(
      ...(hosts.length ? hosts.map((h) => had.get(h) || hostRow(h, opened)) : [el('p', 'dk-note', 'no hosts in view')]),
    );
  };
  draw();
  const t = setInterval(draw, 3000);
  return { node, leave: () => clearInterval(t) };
}

// one host: its name, opened for its forms
function hostRow(host: string, opened: Set<string>): HTMLElement {
  const d = el('details', 'set-host');
  d.dataset.host = host;
  const sum = el('summary', 'set-host-sum');
  sum.append(el('span', 'dk-host', host), el('span', 'dk-state', host === st.selfHost ? 'this page’s host' : ''));
  const body = el('div', 'set-host-body acct-pane');
  d.append(sum, body);
  const load = async () => {
    body.replaceChildren(el('p', 'dk-note', 'reading its config'));
    const r = await cfgCall(host);
    if (!r.ok || !r.ini) {
      body.replaceChildren(
        el('p', 'dk-state bad', r.ok ? `${host} runs an older phosphorus: update the mesh first` : r.error),
      );
      return;
    }
    body.replaceChildren(...hostForm(host, r.ini as HostIni));
  };
  d.addEventListener('toggle', () => {
    if (d.open) {
      opened.add(host);
      load();
    } else opened.delete(host);
  });
  if (opened.has(host)) d.open = true;
  return d;
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
  const btn = (label: string, cls = '') => Object.assign(el('button', cls, label), { type: 'button' });
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

  // git: a copy of the mesh's repositories here, linux only
  const linux = ini.platform === 'linux';
  const [gitRowEl, gitBox] = check(
    linux ? 'keep a copy of the git server here' : 'git copies run on Linux hosts only',
    ini.git,
  );
  gitBox.disabled = !linux && !ini.git;
  const saveGit = btn('save git', 'primary');
  saveGit.disabled = gitBox.disabled;
  saveGit.addEventListener('click', () => send(saveGit, { op: 'git', on: gitBox.checked }));

  const acts = (...b: HTMLElement[]) => {
    const d = el('div', 'update-actions set-acts');
    d.append(...b);
    return d;
  };
  return [
    head('shared folders'),
    el('p', 'dk-note', 'Nothing is shared until you add it: each folder shows in files for the mesh’s users.'),
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
    head('git'),
    gitRowEl,
    acts(saveGit),
    el('p', 'dk-note', RESTARTS),
    say,
  ];
}
