// --- mesh update ----------------------------------------------------------

// one chain at a time, mesh-wide, its state on the host that started it,
// this pane only ever talking to its own frontend
import { el, maskField } from './dom.ts';
import { hostPlatform } from './mesh.ts';
import { noteAdd, notifyMesh, notifyOs, notifying } from './notes.ts';
import { dk, st } from './state.ts';
import { pollState } from './sync.ts';
import { dkPopsClose } from './desktop/taskbar.ts';
import type { Chain, MeshLock, State, TailnetDevice, UpdateCheck } from './types.ts';
import { newerVersion } from './util.ts';

export const topUpdate = document.getElementById('top-update') as HTMLButtonElement;

const updateBtn = document.getElementById('mesh-update') as HTMLButtonElement;
export const updateModal = document.getElementById('update-modal')!;
const updateTitle = document.getElementById('update-title')!;
const updateConfirm = document.getElementById('update-confirm')!;
const updateConfirmText = document.getElementById('update-confirm-text')!;
const updateConfirmCancel = document.getElementById('update-confirm-cancel') as HTMLButtonElement;
const updateConfirmGo = document.getElementById('update-confirm-go') as HTMLButtonElement;
const updatePass = document.getElementById('update-pass') as HTMLInputElement;
const updateFoot = document.getElementById('update-foot')!;
const updateProgress = document.getElementById('update-progress')!;
const updateProgressCells = document.getElementById('update-progress-cells')!;
const updateProgressLabel = document.getElementById('update-progress-label')!;

const updateMesh = document.getElementById('update-mesh')!;
const updateStart = document.getElementById('update-start')!;
const updateVersions = document.getElementById('update-versions')!;
const updateLatest = document.getElementById('update-latest')!;

// meshLock: whatever chain this host can see, own, or a peer's via the mesh poll
let meshLock: MeshLock | null = null;
// the walk under way, if one is
export const meshLockNow = () => meshLock;
// what the list draws from: the last poll's hosts, and a chain while one runs
let updateSeen: { tailnet: TailnetDevice[]; selfVersion: string } = { tailnet: [], selfVersion: '' };
let updateChain: Chain | null = null;
let paneOpenedFor = '';

// the initiator's own swap taking its walk offline a while, the last view held
const CHAIN_HOLD_MS = 180000;
let heldChain: { chain: Chain; at: number } | null = null;
function holdChain(chain: Chain | null | undefined): Chain | null {
  if (chain) {
    heldChain = chain.done ? null : { chain, at: Date.now() };
    return chain;
  }
  if (heldChain && Date.now() - heldChain.at < CHAIN_HOLD_MS) return heldChain.chain;
  heldChain = null;
  return null;
}

const UPDATE_LABEL: Record<string, string> = {
  pending: 'waiting', running: 'updating', ok: 'success', current: 'up to date',
  fail: 'failed', unreachable: 'unreachable', skipped: 'skipped',
};

// a running host's stage, every peer updating at once, and how far along it is
const STAGE_LABEL: Record<string, string> = { asked: 'starting', installing: 'installing', restarting: 'restarting' };
const STAGE_DONE: Record<string, number> = { asked: 0.15, installing: 0.45, restarting: 0.8 };
const stageOf = (chain: Chain | null, host: string) => (chain && chain.versions && chain.versions[host] && chain.versions[host].stage) || '';

// a failure's short cause, when the chain named one, a running host's stage
const stepLabel = (chain: Chain | null, host: string, step: string) => (!step ? ''
  : ((step === 'fail' || step === 'unreachable' || step === 'skipped') && chain!.errors && chain!.errors[host])
    || (step === 'running' && STAGE_LABEL[stageOf(chain, host)]) || UPDATE_LABEL[step] || step);

// nothing new while a chain is in flight, its own continue and cancel above
function renderUpdateButton() {
  updateBtn.disabled = !!meshLock;
  updateBtn.textContent = !meshLock ? 'update' : 'updating';
  updateBtn.title = meshLock ? `started by ${meshLock.initiator}` : 'update every host on the mesh at once';
}

// every phosphorus host and the version it answered with, ours from
// /api/state itself, while a chain runs, in its order, each with its step
function renderVersions() {
  const { tailnet, selfVersion } = updateSeen;
  // the hosts answering, a gone one left out; ours always, even before this host
  // is in its own tailnet view
  const names = tailnet.filter((d) => d.phosphorus).map((d) => d.name);
  if (st.selfHost && !names.includes(st.selfHost)) names.push(st.selfHost);
  const order = updateChain ? [...updateChain.order, ...names.filter((n) => !updateChain!.order.includes(n))] : names;
  const isQuiet = (host: string) => {
    const d = tailnet.find((x) => x.name === host);
    return host !== st.selfHost && !!d && !!d.phosphorusSeen && !d.phosphorus;
  };
  const rows = order.map((host) => {
    const d: Partial<TailnetDevice> = tailnet.find((x) => x.name === host) || {};
    const quiet = isQuiet(host);
    const version = host === st.selfHost ? selfVersion : d.version || '';
    const step = updateChain ? updateChain.results[host] || (updateChain.order.includes(host) ? 'pending' : '') : '';
    const li = document.createElement('li');
    li.className = `update-row${step ? ` ${step}` : ''}${quiet ? ' unreachable' : ''}${!updateChain && version && selfVersion && version !== selfVersion ? ' differs' : ''}`;
    const name = document.createElement('span');
    name.className = 'update-host';
    name.textContent = host;
    name.classList.toggle('is-self', host === st.selfHost);
    const os = d.os || hostPlatform.get(host);
    if (os) name.appendChild(Object.assign(document.createElement('span'), { className: 'update-os', textContent: os }));
    li.append(name,
      Object.assign(document.createElement('span'), { className: 'update-ver', textContent: version ? `v${version}` : '?' }),
      Object.assign(document.createElement('span'), { className: 'update-state', textContent: stepLabel(updateChain, host, step) || (quiet ? 'not answering' : ''), title: updateChain?.details?.[host] || '' }));
    return li;
  });
  if (!rows.length) rows.push(Object.assign(document.createElement('li'), { className: 'empty', textContent: 'no hosts in view' }));
  // column heads in the rows' own grid, so they line up with them
  const head = document.createElement('li');
  head.className = 'update-row update-head';
  const stateHead = updateChain || order.some(isQuiet) ? 'status' : '';
  for (const [cls, text] of [['update-host', 'host'], ['update-ver', 'version'], ['update-state', stateHead]]) {
    head.appendChild(Object.assign(document.createElement('span'), { className: cls, textContent: text }));
  }
  rows.unshift(head);
  const sig = rows.map((li) => `${li.className}|${li.textContent}|${li.querySelector('.is-self') ? 1 : 0}`).join('\n');
  if (sig === updateVersions.dataset.sig) return;
  updateVersions.dataset.sig = sig;
  updateVersions.replaceChildren(...rows);
}

// cells that fit the track, so the bar spans the pane at any width
function updateCells(): number {
  const probe = document.createElement('span');
  probe.textContent = '█'.repeat(10);
  updateProgressCells.replaceChildren(probe);
  return Math.max(1, Math.floor(updateProgressCells.clientWidth / (probe.getBoundingClientRect().width / 10)));
}

let progressStatus: Chain | null = null;

// every host updating at once, each weighed by its stage, so the bar moves
// as the mesh does, not in one jump per host
function renderProgress(status: Chain) {
  progressStatus = status;
  const total = status.order.length;
  if (!total) { updateProgress.hidden = true; return; }
  let done = 0;
  let finished = 0;
  for (const host of status.order) {
    const state = status.results[host] || 'pending';
    if (state === 'running') done += STAGE_DONE[stageOf(status, host)] || 0.05;
    else if (state !== 'pending') { done += 1; finished += 1; }
  }
  // block cells, as the files transfer bar
  updateProgress.hidden = false;
  const cells = updateCells();
  const full = Math.round((done / total) * cells);
  updateProgressCells.replaceChildren('█'.repeat(full), Object.assign(document.createElement('i'), { textContent: '░'.repeat(cells - full) }));
  updateProgressLabel.textContent = `${finished}/${total} hosts`;
}
new ResizeObserver(() => { if (progressStatus && !updateProgress.hidden) renderProgress(progressStatus); }).observe(updateProgressCells);

// the version list as the walk while one runs, its results kept while the
// server still has them: each host's step, and why one failed
function applyChain(status: Chain | null, mine: boolean) {
  updateChain = status || null;
  const live = status && !status.done ? status : null;
  updateProgress.hidden = !live;
  if (live) renderProgress(live);
  updateStart.hidden = !!live;
  updateFoot.hidden = !live || !mine;
  const clean = status && status.order.every((m) => ['ok', 'current'].includes(status.results[m]!));
  updateTitle.textContent = live ? 'updating the mesh'
    : status ? (clean ? 'mesh update done' : 'mesh update ended') : 'mesh update';
  renderVersions();
}

export function openUpdateModal(): void {
  if (!st.acct?.admin) return;
  updateConfirm.hidden = true;
  updateMesh.hidden = false;
  updateModal.hidden = false;
  pollState();
  checkLatest();
}

// the release feed asked on opening, a spinner until it answers; held a minute
const LATEST_HOLD_MS = 60000;
let latestAt = 0;
let latestRun = 0;
let latestFeed: UpdateCheck | null = null;
async function checkLatest() {
  if (meshLock) { updateLatest.hidden = true; return; }
  updateLatest.hidden = false;
  if (Date.now() - latestAt < LATEST_HOLD_MS) return;
  const me = ++latestRun;
  updateLatest.dataset.state = 'checking';
  updateLatest.replaceChildren(el('span', 'update-spin'), 'checking for the newest version');
  let c: UpdateCheck = {};
  try {
    const r = await fetch('/api/update/check?fresh=1', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (r.ok) c = await r.json();
  } catch {}
  if (me !== latestRun) return;
  const versions = [updateSeen.selfVersion, ...updateSeen.tailnet.filter((d) => d.phosphorus).map((d) => d.version)].filter(Boolean) as string[];
  const behind = c.latest && versions.some((v) => newerVersion(c.latest!, v));
  updateLatest.dataset.state = !c.latest ? 'bad' : behind ? 'new' : 'ok';
  updateLatest.textContent = !c.latest ? 'release feed unreachable' : behind ? `v${c.latest} is out` : `on latest · v${c.latest}`;
  latestAt = c.latest ? Date.now() : 0;
  latestFeed = c.latest ? c : null;
}

export function closeUpdateModal(): void {
  // the chain outliving the pane, nothing decided by closing it
  if (updateModal.contains(document.activeElement)) topUpdate.focus();
  updateModal.hidden = true;
}

// one/two-button prompt inside the pane itself instead of confirm()/alert(),
// those outside the page, unstyleable, and flagged by some hosts
// cancel back to the update pane only for the update's own asks
function openConfirm(message: string, { title, hideCancel, actionLabel, onAction, onCancel = closeUpdateModal, password }: { title: string; hideCancel?: boolean; actionLabel: string; onAction: () => void; onCancel?: () => void; password?: boolean }) {
  updateModal.hidden = false;
  updateTitle.textContent = title;
  updateConfirmText.textContent = message;
  updateConfirmCancel.hidden = !!hideCancel;
  updateConfirmGo.textContent = actionLabel;
  updateConfirmGo.onclick = onAction;
  updateConfirmCancel.onclick = onCancel;
  updateConfirm.hidden = false;
  updatePass.hidden = !password;
  setPass('');
  updatePass.classList.remove('bad');
  updatePass.placeholder = 'password';
  updateMesh.hidden = true;
  updateProgress.hidden = true;
  if (password) updatePass.focus();
}

// a chain start taking the mesh down a while, the password held by the
// frontend, only what was typed carried by this box
// the release feed first, the walk only with a host behind it
async function askToStart() {
  updateBtn.disabled = true;
  updateBtn.textContent = 'checking';
  // the feed as the pane just read it, else asked again
  let c: UpdateCheck = latestFeed && Date.now() - latestAt < LATEST_HOLD_MS ? latestFeed : {};
  if (!c.latest) {
    try {
      const r = await fetch('/api/update/check?fresh=1');
      c = r.ok ? await r.json() : { error: `${r.status} ${(await r.text()).slice(0, 80)}`.trim() };
    } catch (err) { c = { error: (err as Error).message }; }
  }
  renderUpdateButton();
  const versions = [updateSeen.selfVersion, ...updateSeen.tailnet.filter((d) => d.phosphorus).map((d) => d.version)]
    .filter(Boolean) as string[];
  const behind = c.latest ? versions.filter((v) => newerVersion(c.latest!, v)).length : 0;
  if (!c.latest) {
    openConfirm('feed down', {
      title: 'update', actionLabel: 'update anyway',
      onAction: () => startChain(), onCancel: openUpdateModal,
    });
    return;
  }
  if (!behind) {
    openConfirm(`v${c.latest}`, {
      title: 'up to date', hideCancel: true, actionLabel: 'ok', onAction: openUpdateModal,
    });
    return;
  }
  openConfirm(`${c.latest} is out. update?`, {
    title: 'update', actionLabel: 'update',
    onAction: () => startChain(), onCancel: openUpdateModal,
  });
}

function passwordRejected() {
  setPass('');
  updatePass.placeholder = 'wrong password';
  updatePass.classList.add('bad');
  updatePass.focus();
}

const updatePassField = maskField(updatePass, () => {
  updatePass.classList.remove('bad');
  updatePass.placeholder = 'password';
});
const setPass = updatePassField.set;

// enter, the obvious key in a password box
updatePass.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  updateConfirmGo.click();
});

function showLockedInfo(by: string) {
  openConfirm(`by ${by}`, {
    title: 'updating',
    hideCancel: true,
    actionLabel: 'ok',
    onAction: closeUpdateModal,
  });
}

// start / cancel / continue, all one endpoint on this host's own frontend
function chainAction(action: string, password?: string): Promise<Response> {
  const sent = fetch('/api/update/chain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(password === undefined ? { action } : { action, password }),
  });
  sent.then(pollState, pollState);
  return sent;
}

async function startChain(password?: string) {
  const res = await chainAction('start', password);
  if (res.status === 401) { passwordRejected(); return; }
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    showLockedInfo(body.by || 'another host');
    return;
  }
  openUpdateModal();
}

updateBtn.addEventListener('click', askToStart);
// a popup under its icon, as the theme's, a second tap to close; the side
// column never touched
const toggleUpdatePane = () => {
  if (!updateModal.hidden) { closeUpdateModal(); return; }
  dkPopsClose('update');
  openUpdateModal();
};
topUpdate.addEventListener('click', toggleUpdatePane);
document.getElementById('update-close')!.addEventListener('click', closeUpdateModal);
// closed by a click outside it, never by the one that opened it
const updateWrap = topUpdate.parentElement!;
let updateWasOpen = false;
document.addEventListener('pointerdown', () => { updateWasOpen = !updateModal.hidden; }, true);
document.addEventListener('click', (e) => {
  if (updateWasOpen && !updateModal.hidden && !updateWrap.contains(e.target as Node) && !updateModal.contains(e.target as Node) && !(e.target as Element).closest?.('.modal, .keybar, .dk-ctl-pop')) closeUpdateModal();
});

new MutationObserver(() => topUpdate.setAttribute('aria-expanded', String(!updateModal.hidden))).observe(updateModal, { attributes: true, attributeFilter: ['hidden'] });

// back to the host list, not out of the pane

document.getElementById('update-cancel')!.addEventListener('click', () => {
  chainAction('cancel').then(pollState);
});

// the update pane's part of a state push: the lock, the hosts' versions, the walk and the dot
export function updateState(state: State): void {
  meshLock = state.lock && state.lock.initiator ? state.lock : null;
  notifyMesh(state);
  renderUpdateButton();
  updateSeen = { tailnet: state.tailnet, selfVersion: state.self.version || '' };
  // ours with its buttons, else a peer's, to watch
  const chain = holdChain(state.chain);
  // a walk starting anywhere opens the pane on every host, once
  if (chain && !chain.done && chain.chainId !== paneOpenedFor && updateConfirm.hidden) {
    paneOpenedFor = chain.chainId;
    updateMesh.hidden = false;
    updateModal.hidden = false;
  }
  // the confirm prompt borrowing this same pane, its text otherwise lost
  if (updateConfirm.hidden) applyChain(chain, !!state.chainMine); else renderVersions();
  // the update icon's dot: a host on another version, or a walk under way
  const mine = state.self.version || '';
  const differs = state.tailnet.some((d) => d.phosphorus && d.version && mine && d.version !== mine);
  const news = differs || !!meshLock || !!(chain && !chain.done);
  topUpdate.toggleAttribute('data-news', news);
  topUpdate.title = `mesh update (u)${meshLock || (chain && !chain.done) ? ', under way' : differs ? ', hosts on different versions' : ''}`;
}

// --- updates waiting: the mesh's release, a blue dot and one note

export const updates: Record<string, string> = { mesh: '' };
const UPDATE_NOTED = 'phosphorus-update-noted';

function paintUpdates() {
  dk.ctl?.btn.classList.toggle('has-update', !!updates.mesh);
  dk.ctl?.draw();
  let noted: Record<string, string> = {};
  try { noted = JSON.parse(localStorage.getItem(UPDATE_NOTED)!) || {}; } catch {}
  const say = (k: string, title: string) => {
    if (!updates[k] || noted[k] === updates[k]) return;
    noted[k] = updates[k]!;
    noteAdd(title, `v${updates[k]}`, null, { view: 'update' });
    if (notifying()) notifyOs(title, `v${updates[k]}`);
  };
  say('mesh', 'mesh update');
  try { localStorage.setItem(UPDATE_NOTED, JSON.stringify(noted)); } catch {}
}

// the release feed against every host; asked, never acted on
export async function checkUpdates(): Promise<void> {
  if (st.acct?.admin) {
    try {
      const c: UpdateCheck = await (await fetch('/api/update/check')).json();
      const versions = [updateSeen.selfVersion, ...(updateSeen.tailnet || []).filter((d) => d.phosphorus).map((d) => d.version)].filter(Boolean) as string[];
      updates.mesh = c.latest && versions.some((v) => newerVersion(c.latest!, v)) ? c.latest : '';
    } catch {}
  }
  paintUpdates();
}
// a look once the desk comes up, then every few hours
setInterval(checkUpdates, 6 * 3600 * 1000);
