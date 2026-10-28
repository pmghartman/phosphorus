// the stats table: a sparkline and a row per host

import type { Route } from '@phosphorus/wire';
import { st } from '../../lib/state.ts';
import { pingClass, pingText, rttHistory, SPARK_MAX_MS, steadyRtt } from './ping.ts';
import { hostPlatform } from './routes.ts';
import { meshStats, meshStatsRows, uiVars } from './ui.ts';

export function sparkline(history: number[] | undefined, cls: string): string {
  if (!history || history.length < 2) return '';
  const w = 24;
  const h = 10;
  const pts = history
    .map((v, i) => {
      const x = (i / (history.length - 1)) * w;
      const y = h - (Math.min(v, SPARK_MAX_MS) / SPARK_MAX_MS) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    `<svg class="mesh-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
    `<polyline points="${pts}" class="${cls}"/></svg>`
  );
}

// CSS-hidden until .expanded, built every render anyway, cheap and always
// current the moment the panel opens
export function renderMeshStats(hosts: string[], grouped: Map<string, Route[]>) {
  meshStatsRows.innerHTML = '';
  const addRow = (name: string, os: string | undefined, rttMs: number | null, dotCls: string) => {
    const row = document.createElement('div');
    row.className = 'mesh-stat-row';
    if (name !== st.selfHost) {
      row.dataset.host = name;
      row.title = `switch host to ${name}`;
    }
    const dot = `<span class="mesh-stat-dot ${dotCls}"></span>`;
    const cls = pingClass(rttMs);
    const spark = sparkline(rttHistory.get(name), cls);
    row.innerHTML =
      `<span class="mesh-stat-name">${dot}<span class="mesh-stat-nm">${name}</span>` +
      `<span class="mesh-stat-os">${os || '?'}</span></span>` +
      `<span class="mesh-stat-ping-cell">${spark}<span class="mesh-stat-ping ${cls}">${pingText(rttMs)}</span></span>`;
    meshStatsRows.appendChild(row);
  };
  // phosphorus hosts only, other mesh devices just in the graph
  for (const m of hosts) {
    const dotCls = m === st.selfHost ? 'self' : grouped.get(m)!.length ? 'active' : 'idle';
    addRow(m, hostPlatform.get(m), steadyRtt(m), dotCls);
  }

  // everything below measuring the table, 0 under display:none, so forced
  // visible for these reads, then restored exactly as found
  const prevDisplay = meshStats.style.display;
  const prevMaxHeight = meshStats.style.maxHeight;
  meshStats.style.display = 'flex';
  meshStats.style.maxHeight = 'none';

  document.getElementById('mesh-nodes-n')!.textContent = String(hosts.length);
  // up to 8 rows tall, then a scroll, measured off a real row, not guessed
  const firstRow = meshStatsRows.firstElementChild as HTMLElement | null;
  meshStatsRows.style.maxHeight = firstRow?.offsetHeight ? `${firstRow.offsetHeight * 8}px` : '';

  // scrollHeight: the natural height, whatever max-height drawMesh() animates
  uiVars.lastStatsHeight = meshStats.scrollHeight;
  uiVars.meshDims = null;
  meshStats.style.display = prevDisplay;
  meshStats.style.maxHeight = prevMaxHeight;
}
