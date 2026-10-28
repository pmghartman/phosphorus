// mesh status diagram
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
  // reserved by meshLayoutParams() when expanded
  lastStatsHeight: 0,
  // both ends of the tween, measured once per animation or static draw,
  // no per-frame read forcing a reflow
  meshDims: null as { collapsed: Dims; expanded: Dims } | null,
};

export interface Dims {
  width: number;
  height: number;
  widthPx: number;
  legendPx: number;
}

// expanded: fewer logical units per pixel width, a real zoom, the popup's
// height whatever the stats table leaves
export function meshLayoutParams(expanded: boolean): Dims {
  const width = expanded ? 200 : 232;
  const box = meshPanel.closest('.dk-mesh-pop');
  const bodyH = (box?.clientHeight || 240) - meshHeader.clientHeight - (expanded ? uiVars.lastStatsHeight : 0);
  const widthPx = meshGraphWrap.clientWidth || width;
  // the legend expanded only, hidden, not gone, so still measured
  const legend = meshGraphWrap.querySelector('.mesh-legend') as HTMLElement;
  const legendOn = expanded && meshPanel.classList.contains('legend-on');
  return {
    width,
    height: width * (Math.max(60, bodyH) / widthPx),
    widthPx,
    legendPx: legendOn ? legend.offsetTop + legend.offsetHeight : 0,
  };
}

// host row to the non-phosphorus devices, a frame fraction, LIFT the
// expanded host row's rise
export const OTHERS_AXIS = 0.34;
export const LIFT = 0.1;
export function meshDimsNow() {
  if (!uiVars.meshDims || !meshAnimFrame)
    uiVars.meshDims = { collapsed: meshLayoutParams(false), expanded: meshLayoutParams(true) };
  return uiVars.meshDims;
}

// meshT: 0 = base (hub | hosts | others columns, 25% height), 1 = expanded
// (hub-on-top rows, 50% height), lerped by drawMesh() each frame
export let meshT = 0;
export let meshAnimFrame: number | null = null;

function animateMeshT(target: number) {
  if (meshAnimFrame) cancelAnimationFrame(meshAnimFrame);
  uiVars.meshDims = null;
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

// the nodes and git rows folded under their heads, the legend behind a ?; kept per browser
export const MESH_UI_KEY = 'phosphorus-mesh-ui';
export const meshUi: {
  legend?: boolean;
  nodes?: boolean;
  git?: boolean;
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
  uiVars.meshDims = null;
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
  if (g && meshPanel.classList.contains('expanded')) switchHost(g.dataset.host!);
});
meshStatsRows.addEventListener('click', (e) => {
  const row = (e.target as Element).closest('.mesh-stat-row[data-host]') as HTMLElement | null;
  if (row) switchHost(row.dataset.host!);
});
