// mesh summary
import type { StatsSample } from '@phosphorus/wire';
import { esc, humanSize, plural } from '../../lib/util.ts';
import { dotJoin, usedOf } from './cards.ts';
import { cpuTop, dotGraph, meterCells, pct, rate } from './glyphs.ts';
import { SUM_VAL, sumRow } from './model.ts';
import { ST_STALE_MS, type StHost, stHosts, stNet } from './state.ts';

export const stTopEl = document.getElementById('st-top')!;
export const stMeshEl = document.getElementById('st-mesh')!;
// bars over the cpu graph, counts over the net graph
export const [stMeshA, stMeshB] = stMeshEl.querySelector('.st-mesh-grid')!.children as unknown as [
  HTMLElement,
  HTMLElement,
];
export const [stMeshBars, stMeshCpu] = stMeshA.children as unknown as [HTMLElement, HTMLCanvasElement];
export const stMeshText = stMeshB.firstElementChild as HTMLElement;
export const [stMeshRx, stMeshTx] = stMeshB.lastElementChild!.children as unknown as [
  HTMLCanvasElement,
  HTMLCanvasElement,
];
export const stMeshHist = { max: 0 };

// every live host's history summed, newest aligned, each weighted by weight(h)
export function sumHist(live: StHost[], k: string, weight: (h: StHost) => number = () => 1): number[] {
  const len = Math.max(0, ...live.map((h) => h.hist[k]!.length));
  return Array.from({ length: len }, (_, i) =>
    live.reduce((a, h) => a + (h.hist[k]![h.hist[k]!.length - len + i] || 0) * weight(h), 0),
  );
}

export function drawMeshSum(names: string[]) {
  const live = names
    .map((n) => stHosts.get(n))
    .filter((h): h is StHost => !!h?.s?.cpu && Date.now() - h.at <= ST_STALE_MS);
  stMeshEl.hidden = !live.length;
  if (!live.length) return;
  const sum = (f: (s: StatsSample) => number | null | undefined) => live.reduce((a, h) => a + (f(h.s!) || 0), 0);
  const cores = sum((s) => s.cpu.cores.length);
  const cpu = sum((s) => s.cpu.total * s.cpu.cores.length) / Math.max(1, cores) / 100;
  const memU = sum((s) => s.mem.used);
  const memT = sum((s) => s.mem.total);
  const diskU = sum((s) => s.disk.used);
  const diskT = sum((s) => s.disk.total);
  const rx = live.reduce((a, h) => a + (h.hist.rx!.at(-1) || 0), 0);
  const tx = live.reduce((a, h) => a + (h.hist.tx!.at(-1) || 0), 0);
  const gpus = live.flatMap((h) => h.s!.gpus);
  const swapU = sum((s) => s.mem.swapUsed);
  const swapT = sum((s) => s.mem.swapTotal);
  const loaded = gpus.filter((g) => g.util !== null);
  const gpuLoad = loaded.reduce((a, g) => a + g.util!, 0) / Math.max(1, loaded.length) / 100;
  const vramU = gpus.reduce((a, g) => a + (g.memUsed || 0), 0);
  const vramT = gpus.reduce((a, g) => a + (g.memTotal || 0), 0);
  const ioR = sum((s) => s.io?.r);
  const ioW = sum((s) => s.io?.w);
  const load = sum((s) => s.cpu.load[0]);
  const ctr = sum((s) => s.parts?.length);
  const git = (stNet?.gitHosts || []).filter((g) => g.reachable);
  const master = git.find((g) => g.role === 'master');
  const svc = (stNet?.routes || []).filter((r) => r.type !== 'game').length;
  const off = names.length - live.length;
  const rows = (
    [
      ['cpu', cpu, `${pct(cpu).padStart(4)} <span class="st-dim">${cores} cores</span>`],
      ['mem', memU / memT, usedOf(memU, memT)],
      swapT && ['swap', swapU / swapT, usedOf(swapU, swapT)],
      ['disk', diskU / diskT, usedOf(diskU, diskT)],
      loaded.length && [
        'gpu',
        gpuLoad,
        `${pct(gpuLoad).padStart(4)} <span class="st-dim">${plural(gpus.length, 'gpu')}</span>`,
      ],
      vramT && ['vram', vramU / vramT, usedOf(vramU, vramT)],
    ] as (false | 0 | [string, number, string, string?])[]
  ).filter(Boolean) as [string, number, string, string?][];
  const text = (k: string, v: string) => `<div class="st-row"><span class="st-key">${k}</span>${v}</div>`;
  const n = meterCells(stMeshBars, 8 + SUM_VAL);
  stMeshBars.innerHTML = rows.map(([k, f, v, cls]) => sumRow(k, f, n, v, cls)).join('');
  const rxs = sumHist(live, 'rx');
  const txs = sumHist(live, 'tx');
  stMeshHist.max = Math.max(1024, ...rxs, ...txs, stMeshHist.max * 0.98);
  const cpus = sumHist(live, 'cpu', (h) => h.s!.cpu.cores.length / Math.max(1, cores));
  dotGraph(stMeshCpu, cpus, cpuTop(cpus), () => '--sage');
  dotGraph(stMeshRx, rxs, stMeshHist.max, () => '--accent');
  dotGraph(stMeshTx, txs, stMeshHist.max, () => '--teal', true);
  stMeshText.innerHTML = [
    text(
      'hosts',
      `<span class="st-lo">${live.length} up</span>${off ? `<span class="st-dim"> · ${off} stale or waiting</span>` : ''}`,
    ),
    text('net', `<span class="st-rx">▼ ${rate(rx)}</span>  <span class="st-tx">▲ ${rate(tx)}</span>`),
    text(
      '24h',
      `<span class="st-rx">▼ ${humanSize(sum((s) => s.netDay.rx))}</span>  <span class="st-tx">▲ ${humanSize(sum((s) => s.netDay.tx))}</span>`,
    ),
    text('io', `<span class="st-rx">▼ ${rate(ioR)}</span>  <span class="st-tx">▲ ${rate(ioW)}</span>`),
    text('load', `${load.toFixed(2)} <span class="st-dim">1m, all hosts</span>`),
    text('run', dotJoin([plural(svc, 'service'), plural(ctr, 'process', 'processes')])),
    git.length &&
      text(
        'git',
        dotJoin([
          master ? `master ${esc(master.host)}` : '<span class="st-hi">no master</span>',
          git.length > 1 && `${git.filter((g) => g.role !== 'master' && g.eligible).length}/${git.length - 1} in sync`,
        ]),
      ),
  ]
    .filter(Boolean)
    .join('');
}
