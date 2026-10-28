// git backups: each git host's copy and how far it trails the master
import { pageAsk } from '../../lib/dom.ts';
import { noteAdd } from '../notes.ts';
import { st } from '../../lib/state.ts';
import type { GitHost } from '@phosphorus/wire';
import { ago, esc } from '../../lib/util.ts';
import { drawMesh } from './draw.ts';
import { meshAnimFrame, uiVars } from './ui.ts';

export const meshGit = document.getElementById('mesh-git')!;
export const meshGitRows = document.getElementById('mesh-git-rows')!;
// five cells a band, each filled across its own seconds
export const GIT_LAG_CELLS = 5;
export const GIT_LAG_BANDS: [string, number, number][] = [['good', 0, 8], ['slow', 8, 15], ['stale', 15, 60]];
export let meshGitHosts = '';

export function lagMeter(sec: number): string {
  let html = '';
  let empty = 0;
  for (const [cls, from, to] of GIT_LAG_BANDS) {
    const full = Math.round(Math.max(0, Math.min(1, (sec - from) / (to - from))) * GIT_LAG_CELLS);
    if (full) html += `<span class="${cls}">${'█'.repeat(full)}</span>`;
    empty += GIT_LAG_CELLS - full;
  }
  return `${html}<span class="off">${'░'.repeat(empty)}</span>`;
}

export function gitBackupText(h: GitHost, masterGen: number | null): string {
  if (!h.reachable) return 'unreachable';
  // a live master to copy from: the first download under way
  if (h.gen == null || h.ageSec == null) return masterGen != null && h.role !== 'master' ? 'downloading' : 'no data yet';
  const parts = [h.role === 'master' ? 'master, live' : masterGen != null && h.gen < masterGen ? 'older lineage' : h.role];
  if (h.role !== 'master' && !h.eligible) parts.push('catching up');
  if (h.updating) parts.push('updating');
  return parts.join(' · ');
}

// every state push, ageSec fresh each time; the table remeasured on a new host set
export function renderMeshGit(): void {
  const gitHostsList = st.gitHostsList;
  meshGit.hidden = !gitHostsList.length;
  document.getElementById('mesh-git-n')!.textContent = String(gitHostsList.length);
  const masterGen = gitHostsList.find((h) => h.role === 'master' && h.reachable)?.gen ?? null;
  meshGitRows.innerHTML = gitHostsList.map((h) => {
    const master = h.reachable && h.role === 'master';
    const cls = master ? 'master' : !h.reachable ? 'down' : !h.eligible ? 'catching' : '';
    const text = gitBackupText(h, masterGen);
    const behind = h.reachable && !master && h.ageSec != null
      ? `<span class="git-lag" title="last matched the master's stamp, checked every 5s and copied only on change: green to 8s, yellow to 15s, red to 60s">${lagMeter(h.ageSec)}</span><span class="git-ago">${ago(h.ageSec)}</span>` : '';
    return `<div class="mesh-git-row ${cls}"><span class="mesh-stat-name"><span class="mesh-git-dot"></span>`
      + `<span class="mesh-stat-nm">${esc(h.host)}</span><span class="mesh-git-text">${text === 'downloading' ? '<span class="git-spin"></span>' : ''}${esc(text)}</span></span>`
      + `<span class="mesh-git-behind">${behind}${h.reachable && !master && st.acct?.admin
        ? `<button type="button" class="mesh-git-take" data-host="${esc(h.host)}" title="make ${esc(h.host)} the git master">master</button>` : ''}</span></div>`;
  }).join('');
  const sig = gitHostsList.map((h) => h.host).join();
  if (sig !== meshGitHosts) {
    meshGitHosts = sig;
    uiVars.meshStatsDirty = true;
    if (!meshAnimFrame) drawMesh();
  }
}

// a live master handing off, none force-promoting
export async function askGitSwitch(name: string) {
  const master = st.gitHostsList.find((h) => h.role === 'master' && h.reachable);
  const ok = await pageAsk({ title: master ? 'switch git master' : 'force-promote', message: master ? `${name} master?` : `force ${name}?`,
    action: master ? 'make master' : 'force-promote', danger: !master });
  if (!ok) return;
  let why = '';
  try {
    const r = await fetch(`/api/githosts/${encodeURIComponent(name)}/force`, { method: 'POST' });
    if (!r.ok) why = String((await r.json().catch(() => ({}))).error || r.status);
  } catch (err) { why = (err as Error).message; }
  if (why) noteAdd('git master failed', why);
  pageAsk({ title: 'git master', message: why ? 'failed' : 'switching', cancel: false });
}
meshGitRows.addEventListener('click', (e) => {
  const b = (e.target as Element).closest('.mesh-git-take') as HTMLElement | null;
  if (b) askGitSwitch(b.dataset.host!);
});

// the module's variables other modules set
export const gitVars = {
  pulseAnimFrame: null as number | ReturnType<typeof setTimeout> | null,
};
