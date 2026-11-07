// mesh status diagram

import { dkMenu } from '../../desktop/desk/wallpaper.ts';
import { dkSpace } from '../../desktop/spaces.ts';
import { drawMesh } from './draw.ts';
import { switchHost } from './hosts.ts';

export const meshSvg = document.getElementById('mesh-svg') as unknown as SVGSVGElement;
export const meshCount = document.getElementById('mesh-count')!;
export const meshPanel = document.getElementById('mesh-panel')!;
export const meshGraphWrap = document.getElementById('mesh-graph-wrap')!;
export const meshStats = document.getElementById('mesh-stats')!;
export const meshStatsRows = document.getElementById('mesh-stats-rows')!;
export const meshHeader = document.querySelector('.mesh-header') as HTMLElement;
export const stash = document.getElementById('dk-stash')!;

// the module's variables other modules set
export const uiVars = {
  // stats table DOM rebuilt only on real data changes, never per
  // expand/collapse frame
  meshStatsDirty: true,
  // the stats table's unclipped height, cached whenever renderMeshStats() runs,
  // left out of the graph's room when expanded
  lastStatsHeight: 0,
};

// meshT: 0 = base (hub | hosts | others columns, 25% height), 1 = expanded
// (hub-on-top rows, 50% height), lerped by drawMesh() each frame
export let meshT = 0;
export let meshAnimFrame: number | null = null;

function animateMeshT(target: number) {
  if (meshAnimFrame) cancelAnimationFrame(meshAnimFrame);
  // quick, and fastest at the start, so the click answers at once
  const duration = 200;
  const start = performance.now();
  const from = meshT;
  const easeOutCubic = (p: number) => 1 - (1 - p) ** 3;
  const step = (now: number) => {
    const p = Math.min(1, (now - start) / duration);
    meshT = from + (target - from) * easeOutCubic(p);
    drawMesh();
    meshAnimFrame = p < 1 ? requestAnimationFrame(step) : null;
  };
  meshAnimFrame = requestAnimationFrame(step);
}

// always expanded, its table always up
meshPanel.classList.add('expanded');
meshT = 1;

// the nodes folded under their head, the legend behind a ?; kept per browser
export const MESH_UI_KEY = 'phosphorus-mesh-ui';
export const meshUi: {
  legend?: boolean;
  nodes?: boolean;
  size?: { w: number; h: number };
  [k: string]: unknown;
} = (() => {
  try {
    return JSON.parse(localStorage.getItem(MESH_UI_KEY)!) || {};
  } catch {
    return {};
  }
})();
export const saveMeshUi = () => {
  try {
    localStorage.setItem(MESH_UI_KEY, JSON.stringify(meshUi));
  } catch {}
};
export const meshLegendBtn = document.getElementById('mesh-legend-btn')!;
export function paintMeshUi() {
  meshPanel.classList.toggle('legend-on', !!meshUi.legend);
  meshLegendBtn.setAttribute('aria-pressed', String(!!meshUi.legend));
  for (const b of meshPanel.querySelectorAll<HTMLElement>('.mesh-fold')) {
    const open = !!meshUi[b.dataset.fold!];
    b.setAttribute('aria-expanded', String(open));
    b.parentElement!.classList.toggle(`fold-${b.dataset.fold}`, !open);
  }
}
paintMeshUi();
meshLegendBtn.addEventListener('click', () => {
  meshUi.legend = !meshUi.legend;
  saveMeshUi();
  paintMeshUi();
  if (!meshAnimFrame) drawMesh();
});
for (const b of meshPanel.querySelectorAll<HTMLElement>('.mesh-fold')) {
  b.addEventListener('click', () => {
    meshUi[b.dataset.fold!] = !meshUi[b.dataset.fold!];
    saveMeshUi();
    paintMeshUi();
    uiVars.meshStatsDirty = true;
    if (!meshAnimFrame) drawMesh();
  });
}

window.addEventListener('resize', () => {
  if (!meshAnimFrame) drawMesh();
});

// the one place a host is switched: its square in the graph or its row in the stats
meshSvg.addEventListener('click', (e) => {
  const g = (e.target as Element).closest('.mesh-host') as SVGElement | null;
  if (g && meshPanel.classList.contains('expanded') && e.detail < 2) switchHost(g.dataset.host!);
});
// a double click on any computer: onto its desktop
meshSvg.addEventListener('dblclick', (e) => {
  const g = (e.target as Element).closest('.mesh-desk') as SVGElement | null;
  if (g) dkSpace(g.dataset.desk!);
});
// a right click on any computer: onto its desktop, or a switch to its phosphorus
meshSvg.addEventListener('contextmenu', (e) => {
  const g = (e.target as Element).closest('.mesh-desk') as SVGElement | null;
  if (!g) return;
  e.preventDefault();
  const h = g.dataset.desk!;
  dkMenu(
    e.clientX,
    e.clientY,
    [
      ['its desktop', () => dkSpace(h), true],
      ['switch to it', () => switchHost(h), !!g.dataset.host],
    ],
    undefined,
    h,
  );
});
meshStatsRows.addEventListener('click', (e) => {
  const row = (e.target as Element).closest('.mesh-stat-row[data-host]') as HTMLElement | null;
  if (row) switchHost(row.dataset.host!);
});
