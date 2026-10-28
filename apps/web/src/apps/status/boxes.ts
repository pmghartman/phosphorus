// the boxes of an open card
import { esc, humanSize } from '../../lib/util.ts';
import { dotGraph, heat, heatVar, meter, meterCells, netScale, pct, rate } from './glyphs.ts';
import { type Parts, type StHost } from './state.ts';

export function drawCpu(p: Parts, h: StHost) {
  const { cpu } = h.s!;
  p.cpuHead.innerHTML = `cpu <span class="st-dim">${esc(cpu.model.replace(/\s+/g, ' ').toLowerCase())}</span>`;
  if (!p.cpuGraph) {
    p.cpu.innerHTML =
      '<div class="st-cpu-left"><canvas class="st-graph st-graph-cpu"></canvas><div class="st-row"></div></div><div class="st-cores"></div>';
    [p.cpuGraph, p.cpuLine] = p.cpu.firstElementChild.children;
    p.cores = p.cpu.lastElementChild;
  }
  dotGraph(p.cpuGraph, h.hist.cpu!, 100, heatVar);
  // Windows has no load average: its hosts' sent as nulls, the line without one
  p.cpuLine.innerHTML =
    `<span class="${heat(cpu.total / 100)}">${cpu.total.toFixed(1)}%</span>` +
    (cpu.load[0] == null
      ? ''
      : `<span class="st-dim"> load </span>${cpu.load.map((l) => (l ?? 0).toFixed(2)).join(' ')}`);
  p.cores.innerHTML = cpu.cores
    .map(
      (c, i) =>
        `<div><span class="st-dim">${String(i).padStart(2)}</span> ` +
        `${meter(c / 100, 4)} ${String(Math.round(c)).padStart(3)}%</div>`,
    )
    .join('');
}

// label, value, bar to the box's width, percent
export const barRow = (k: string, text: string, frac: number, cells: number, cls?: string) =>
  `<div class="st-row"><span class="st-key">${esc(k)}</span>` +
  `${text.padStart(6)} ${meter(frac, cells, cls)} ${pct(frac).padStart(4)}</div>`;

export function barRows(el: HTMLElement, rows: [string, number, number, string?][]) {
  const cells = meterCells(el, 20);
  el.innerHTML = rows.map(([k, v, of, cls]) => barRow(k, humanSize(v), v / of, cells, cls)).join('');
}

export function drawMem(p: Parts, h: StHost) {
  const m = h.s!.mem;
  p.memHead.innerHTML = `mem <span class="st-dim">${humanSize(m.total)}</span>`;
  barRows(
    p.mem,
    (
      [
        ['used', m.used, m.total],
        ['avail', m.avail, m.total, 'st-lo'],
        ['cached', m.cached, m.total, 'st-cache'],
        m.swapTotal && ['swap', m.swapUsed, m.swapTotal],
      ] as (0 | false | [string, number, number, string?])[]
    ).filter(Boolean) as [string, number, number, string?][],
  );
}

// the host's own disks, summed
export function drawDisk(p: Parts, h: StHost) {
  const { disk, io } = h.s!;
  const n = disk.count > 1 ? ` · ${disk.count} filesystems` : '';
  p.diskHead.innerHTML = `disk <span class="st-dim">${humanSize(disk.total)} capacity${n}</span>`;
  barRows(p.disk, [
    ['used', disk.used, disk.total],
    ['free', disk.total - disk.used, disk.total, 'st-lo'],
  ]);
  p.disk.insertAdjacentHTML(
    'beforeend',
    `<div class="st-row"><span class="st-key">io</span>` +
      `<span class="st-rx">r ${rate(io.r)}</span>  <span class="st-tx">w ${rate(io.w)}</span></div>`,
  );
}

export function drawNet(p: Parts, h: StHost) {
  const rx = h.hist.rx!.at(-1) || 0;
  const tx = h.hist.tx!.at(-1) || 0;
  const busy = h.s!.net.filter((n) => n.rx || n.tx);
  p.netHead.innerHTML = `net <span class="st-dim">${esc((busy.length ? busy : h.s!.net).map((n) => n.name).join(' '))}</span>`;
  if (!p.rxGraph) {
    p.net.innerHTML =
      '<canvas class="st-graph"></canvas><div class="st-row"></div><canvas class="st-graph"></canvas><div class="st-row"></div>';
    [p.rxGraph, p.rates, p.txGraph, p.day] = p.net.children;
  }
  const max = netScale(h);
  dotGraph(p.rxGraph, h.hist.rx!, max, () => '--accent');
  dotGraph(p.txGraph, h.hist.tx!, max, () => '--teal', true);
  p.rates.innerHTML =
    `<span class="st-rx">▼ ${rate(rx)}</span>  <span class="st-tx">▲ ${rate(tx)}</span>` +
    `<span class="st-dim">  top ${rate(max)}</span>`;
  // a day, or as much of one as has been counted
  const d = h.s!.netDay;
  const ms = h.s!.at - d.since;
  const span = ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))}m` : `${Math.min(24, Math.round(ms / 3600000))}h`;
  p.day.innerHTML =
    `<span class="st-key">${span}</span><span class="st-rx">▼ ${humanSize(d.rx)}</span>` +
    `  <span class="st-tx">▲ ${humanSize(d.tx)}</span>`;
}

export function drawGpu(p: Parts, h: StHost) {
  const list = h.s!.gpus;
  p.gpuHead.innerHTML = `gpu <span class="st-dim">${esc(list.map((g) => g.name).join(', '))}</span>`;
  const cells = meterCells(p.gpu, 20);
  p.gpu.innerHTML = list
    .map((g) => {
      const rows: string[] = [];
      if (list.length > 1) rows.push(`<div class="st-row st-dim">${esc(g.name)}</div>`);
      if (g.util !== null) rows.push(barRow('load', `${g.util}%`, g.util / 100, cells));
      else if (g.mhz && g.mhzMax) rows.push(barRow('clock', `${g.mhz}mhz`, g.mhz / g.mhzMax, cells));
      if (g.memTotal) rows.push(barRow('vram', humanSize(g.memUsed), g.memUsed! / g.memTotal, cells));
      if (g.temp !== null) {
        rows.push(
          `<div class="st-row"><span class="st-key">temp</span><span class="${heat((g.temp - 40) / 50)}">${g.temp}°c</span></div>`,
        );
      }
      return rows.join('') || '<div class="st-dim">no readings</div>';
    })
    .join('');
}

export function drawCtr(p: Parts, h: StHost) {
  // phosphorus's own processes, by role
  const list = h.s!.parts;
  p.ctrHead.innerHTML = `phosphorus <span class="st-dim">${list ? list.length : ''}</span>`;
  if (!list) {
    p.ctr.innerHTML = '<div class="st-dim">no process list</div>';
    return;
  }
  p.ctr.innerHTML =
    '<div class="st-ctr-row st-dim"><span>name</span><span>cpu</span><span>mem</span><span>pids</span></div>' +
    list
      .map(
        (c) =>
          `<div class="st-ctr-row"><span class="st-ctr-name">${esc(c.name)}</span>` +
          `<span class="${heat(c.cpu / 100)}">${c.cpu.toFixed(1)}%</span><span>${humanSize(c.mem)}</span>` +
          `<span class="st-dim">${c.pids}</span></div>`,
      )
      .join('');
}

export function drawProc(p: Parts, h: StHost) {
  const pr = h.s!.procs;
  p.procHead.innerHTML = `processes <span class="st-dim">${pr ? pr.count : ''}</span>`;
  if (!pr) {
    p.proc.innerHTML = '<div class="st-dim">no process list</div>';
    return;
  }
  p.proc.innerHTML =
    '<div class="st-proc-row st-dim"><span>name</span><span>pid</span><span>cpu</span><span>mem</span></div>' +
    pr.top
      .map(
        (x) =>
          `<div class="st-proc-row"${x.cmd ? ` title="${esc(x.cmd)}"` : ''}>` +
          `<span class="st-ctr-name">${esc(x.name)}${x.role ? ` <span class="st-dim">${esc(x.role)}</span>` : ''}</span><span class="st-dim">${x.pid}</span>` +
          `<span class="${heat(x.cpu / 100)}">${x.cpu.toFixed(1)}%</span><span>${humanSize(x.mem)}</span></div>`,
      )
      .join('');
}
