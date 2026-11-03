// the whole mesh summed: headlines, its cpu and net graphs, its totals and models
import type { StatsSample } from '@phosphorus/wire';
import { humanSize, plural } from '../../lib/util.ts';
import { dotJoin, kvRow, meterRow, pageFrame, panel, panelHead, setHtml, stat, usedOf, usedPct } from './cards.ts';
import { cpuTop, dotGraph, pct, rate } from './glyphs.ts';
import { drawModel, stModels } from './model.ts';
import { type Panel, ST_STALE_MS, type StHost, stHosts, stNet } from './state.ts';

export const meshPage = pageFrame([['more', 'totals']]);
meshPage.node.classList.add('st-mesh-page');
const meshHist = { max: 0 };
// host -> its model's panel, in the models' order
const models = new Map<string, Panel>();

// every live host's history summed, newest aligned, each weighted by weight(h)
export function sumHist(live: StHost[], k: string, weight: (h: StHost) => number = () => 1): number[] {
  const len = Math.max(0, ...live.map((h) => h.hist[k]!.length));
  return Array.from({ length: len }, (_, i) =>
    live.reduce((a, h) => a + (h.hist[k]![h.hist[k]!.length - len + i] || 0) * weight(h), 0),
  );
}

export function drawMeshSum(names: string[]) {
  const p = meshPage;
  const live = names
    .map((n) => stHosts.get(n))
    .filter((h): h is StHost => !!h?.s?.cpu && Date.now() - h.at <= ST_STALE_MS);
  p.node.classList.toggle('waiting', !live.length);
  p.node.dataset.note = 'waiting for stats';
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
  const load = sum((s) => s.cpu.load[0]);
  const ctr = sum((s) => s.parts?.length);
  const svc = (stNet?.routes || []).length;
  const off = names.length - live.length;

  setHtml(
    p.facts,
    dotJoin([
      `<span class="st-name">${plural(names.length, 'host')}</span>`,
      `<span class="st-lo">${live.length} up</span>`,
      off && `<span class="st-mid">${off} stale or waiting</span>`,
      plural(svc, 'service'),
      stModels().length && `<span class="st-model-mark">${plural(stModels().length, 'model')}</span>`,
    ]),
  );
  setHtml(
    p.stats,
    [
      stat('cpu', 'cpu', pct(cpu), plural(cores, 'core'), cpu),
      stat('mem', 'mem', pct(memU / memT), usedOf(memU, memT), memU / memT),
      stat('disk', 'disk', pct(diskU / diskT), usedOf(diskU, diskT), diskU / diskT),
      loaded.length &&
        stat('gpu', 'gpu', pct(gpuLoad), vramT ? `vram ${usedOf(vramU, vramT)}` : plural(gpus.length, 'gpu'), gpuLoad),
      stat('net', 'net', `<span class="st-rx">▼</span> ${rate(rx)}`, `<span class="st-tx">▲</span> ${rate(tx)}`),
    ]
      .filter(Boolean)
      .join(''),
  );

  const cpus = sumHist(live, 'cpu', (h) => h.s!.cpu.cores.length / Math.max(1, cores));
  panelHead(p.cpu, 'cpu', `${plural(cores, 'core')} summed`);
  dotGraph(p.cpu.graph, cpus, cpuTop(cpus), () => '--sage');
  setHtml(
    p.cpu.line,
    `${(cpu * 100).toFixed(1)}%${load ? `<span class="st-dim">  load </span>${load.toFixed(2)}<span class="st-dim"> 1m, all hosts</span>` : ''}`,
  );
  const rxs = sumHist(live, 'rx');
  const txs = sumHist(live, 'tx');
  meshHist.max = Math.max(1024, ...rxs, ...txs, meshHist.max * 0.98);
  dotGraph(p.net.rx, rxs, meshHist.max, () => '--accent');
  dotGraph(p.net.tx, txs, meshHist.max, () => '--teal', true);
  setHtml(
    p.net.rates,
    `<span class="st-rx">▼ ${rate(rx)}</span>  <span class="st-tx">▲ ${rate(tx)}</span><span class="st-dim">  top ${rate(meshHist.max)}</span>`,
  );
  setHtml(
    p.net.day,
    `<span class="st-dim">24h  </span><span class="st-rx">▼ ${humanSize(sum((s) => s.netDay.rx))}</span>  <span class="st-tx">▲ ${humanSize(sum((s) => s.netDay.tx))}</span>`,
  );

  setHtml(
    p.box.more!.body,
    [
      swapT && meterRow('swap', swapU / swapT, usedPct(swapU, swapT)),
      vramT && meterRow('vram', vramU / vramT, usedPct(vramU, vramT)),
      kvRow(
        'io',
        `<span class="st-rx">r ${rate(sum((s) => s.io?.r))}</span>  <span class="st-tx">w ${rate(sum((s) => s.io?.w))}</span>`,
      ),
      kvRow('run', dotJoin([plural(svc, 'service'), plural(ctr, 'process', 'processes')])),
    ]
      .filter(Boolean)
      .join(''),
  );
  drawModels();
}

// a panel per model host, after the totals
function drawModels() {
  const list = stModels();
  for (const [host, m] of models)
    if (!list.some((x) => x.host === host)) {
      m.box.remove();
      models.delete(host);
    }
  let prev = meshPage.box.more!.box;
  for (const m of list) {
    let box = models.get(m.host);
    if (!box) models.set(m.host, (box = panel('model', 'model')));
    if (prev.nextElementSibling !== box.box) prev.after(box.box);
    prev = box.box;
    drawModel(box, m, true);
  }
}
