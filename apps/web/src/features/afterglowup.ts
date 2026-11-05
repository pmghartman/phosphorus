// the update pane's afterglow section, kept up apart from phosphorus: its latest release,
// each host's copy and its own update's word, one button updating every host behind

import type { AfterglowLatest, AfterglowStatus } from '@phosphorus/wire';
import { el } from '../lib/dom.ts';
import { st } from '../lib/state.ts';
import { newerVersion } from '../lib/util.ts';
import { hostPlatform } from './mesh/mesh.ts';

export const agPane = document.getElementById('update-ag')!;
const latestEl = document.getElementById('update-ag-latest')!;
const rowsEl = document.getElementById('update-ag-versions')!;
const goBtn = document.getElementById('update-ag-go') as HTMLButtonElement;

let latest: AfterglowLatest | null = null;
let checkedAt = 0;
let checking = 0;
// the hosts just asked, held as updating until their info says so
const asked = new Map<string, number>();
const ASK_HOLD_MS = 20000;

// told when afterglow's release is ahead of a host: the update dot's
let onBehind: (v: string) => void = () => {};
export const agOnBehind = (f: (v: string) => void) => void (onBehind = f);

// every phosphorus host in view, ours first
function hosts(): string[] {
  const names = (st.lastState?.tailnet ?? []).filter((d) => d.phosphorus).map((d) => d.name);
  if (st.selfHost && !names.includes(st.selfHost)) names.unshift(st.selfHost);
  return names;
}

const statusOf = (h: string): AfterglowStatus | undefined => st.hostsInfo[h.toLowerCase()]?.afterglow;
const updating = (h: string) => statusOf(h)?.state === 'updating' || Date.now() - (asked.get(h) ?? 0) < ASK_HOLD_MS;
// a host behind the release, or whose last try failed: what the button updates
const behind = (h: string) => {
  const s = statusOf(h);
  if (!latest?.version || !latest.compatible || !s || updating(h)) return false;
  return s.state === 'failed' || !s.version || newerVersion(latest.version, s.version);
};

// the latest release asked on opening the pane, held a minute
export async function agOpen(fresh = true): Promise<void> {
  if (Date.now() - checkedAt < 60000) return agRender();
  const me = ++checking;
  latestEl.dataset.state = 'checking';
  latestEl.replaceChildren(el('span', 'update-spin'), "checking afterglow's newest release");
  let r: AfterglowLatest = {};
  try {
    const res = await fetch(`/api/afterglow/check${fresh ? '?fresh=1' : ''}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) r = await res.json();
  } catch {}
  if (me !== checking) return;
  latest = r.version ? r : null;
  checkedAt = latest ? Date.now() : 0;
  latestEl.textContent = !r.version
    ? r.error || "afterglow's releases unreachable"
    : !r.compatible
      ? r.why || `afterglow v${r.version} isn't one this phosphorus speaks`
      : hosts().some(behind)
        ? `v${r.version} is out`
        : `on latest · v${r.version}`;
  latestEl.dataset.state = !r.version || !r.compatible ? 'bad' : hosts().some(behind) ? 'new' : 'ok';
  agRender();
}

// each host's afterglow, redrawn on every state push
export function agRender(): void {
  const names = hosts();
  const anyBehind = names.some(behind);
  onBehind(anyBehind && latest?.version ? latest.version : '');
  const head = el('li', 'update-row update-head');
  head.append(el('span', 'update-host', 'host'), el('span', 'update-ver', 'version'), el('span', 'update-state', ''));
  const rows = names.map((h) => {
    const s = statusOf(h);
    const up = updating(h);
    const late = behind(h);
    const li = el('li', `update-row${up ? ' running' : s?.state === 'failed' ? ' fail' : late ? ' differs' : ''}`);
    const name = el('span', 'update-host', h);
    name.classList.toggle('is-self', h === st.selfHost);
    const os = hostPlatform.get(h);
    if (os) name.append(el('span', 'update-os', os));
    const state = el('span', 'update-state', up ? 'updating' : s?.state === 'failed' ? 'failed' : late ? 'behind' : '');
    if (s?.error) state.title = s.error;
    li.append(name, el('span', 'update-ver', s?.version ? `v${s.version}` : s ? 'none' : '?'), state);
    if (!up && s?.state === 'failed' && s.error) li.append(el('span', 'update-why', s.error));
    return li;
  });
  const sig = rows.map((r) => `${r.className}|${r.textContent}`).join('\n');
  if (sig !== rowsEl.dataset.sig) {
    rowsEl.dataset.sig = sig;
    rowsEl.replaceChildren(head, ...rows);
  }
  goBtn.disabled = !anyBehind;
  goBtn.classList.toggle('primary', anyBehind);
  goBtn.textContent = names.some(updating) ? 'updating afterglow' : 'update afterglow';
  goBtn.title = anyBehind
    ? `afterglow v${latest!.version} on ${names.filter(behind).join(', ')}`
    : 'every host is on the latest afterglow';
}

goBtn.addEventListener('click', async () => {
  const want = hosts().filter(behind);
  if (!want.length) return;
  const now = Date.now();
  for (const h of want) asked.set(h, now);
  agRender();
  try {
    const r = await fetch('/api/afterglow/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hosts: want }),
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) latestEl.textContent = b.error || `couldn't start: status ${r.status}`;
    // a host that didn't take it: not held as updating
    for (const [h, v] of Object.entries((b.hosts ?? {}) as Record<string, string>))
      if (v !== 'started') {
        asked.delete(h);
        latestEl.textContent = `${h}: ${v}`;
      }
  } catch (e) {
    for (const h of want) asked.delete(h);
    latestEl.textContent = `couldn't start: ${(e as Error).message}`;
  }
  agRender();
});
