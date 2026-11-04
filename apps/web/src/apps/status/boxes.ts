// one host's page: its facts, headlines, graphs, and a panel for each part of it
import { esc, humanSize, plural } from '../../lib/util.ts';
import { dotJoin, kvRow, meterRow, pack, pageFrame, panelHead, setHtml, stat, usedOf, usedPct } from './cards.ts';
import { bar, dotGraph, heat, heatVar, netScale, pct, rate } from './glyphs.ts';
import { drawModel, facts, modelOf } from './model.ts';
import { calmOf, type Page, type StHost } from './state.ts';

export const hostPage = (name: string): Page => {
  const p = pageFrame([
    ['model', 'model'],
    ['cpus', 'cores'],
    ['mem', 'mem'],
    ['disk', 'disk'],
    ['gpu', 'gpu'],
    ['ctr', 'phosphorus'],
    ['proc', 'processes'],
  ]);
  p.node.dataset.host = name;
  return p;
};

export function drawHost(p: Page, name: string, h: StHost) {
  setHtml(p.facts, facts(name, h));
  const s = h.s!;
  const { cpu, mem, disk, gpus } = s;
  const c = calmOf(h);
  const { rx, tx } = c;
  const load = c.gpus.filter((u): u is number => u !== null);
  const gpuLoad = load.reduce((a, u) => a + u, 0) / Math.max(1, load.length) / 100;
  // the gpus reading both, used never set against a total it's no part of
  const vram = gpus.filter((g) => g.memTotal && g.memUsed != null);
  const vramU = vram.reduce((a, g) => a + g.memUsed!, 0);
  const vramT = vram.reduce((a, g) => a + g.memTotal!, 0);
  setHtml(
    p.stats,
    [
      stat(
        'cpu',
        'cpu',
        pct(c.cpu / 100),
        dotJoin([plural(cpu.cores.length, 'core'), cpu.load[0] != null && `load ${cpu.load[0].toFixed(2)}`]),
        c.cpu / 100,
      ),
      stat('mem', 'mem', pct(mem.used / mem.total), usedOf(mem.used, mem.total), mem.used / mem.total),
      stat('disk', 'disk', pct(disk.used / disk.total), usedOf(disk.used, disk.total), disk.used / disk.total),
      // kept once a load was read, a sample without one no reflow
      h.gpu &&
        stat(
          'gpu',
          'gpu',
          load.length ? pct(gpuLoad) : '–',
          vramT ? `vram ${usedOf(vramU, vramT)}` : plural(gpus.length, 'gpu'),
          gpuLoad,
        ),
      stat('net', 'net', `<span class="st-rx">▼</span> ${rate(rx)}`, `<span class="st-tx">▲</span> ${rate(tx)}`),
    ]
      .filter(Boolean)
      .join(''),
  );
  drawCpu(p, h);
  drawNet(p, h);
  drawModel(p.box.model!, modelOf(name));
  drawMem(p, h);
  drawDisk(p, h);
  p.box.gpu!.box.hidden = !gpus.length;
  if (gpus.length) drawGpu(p, h);
  drawCtr(p, h);
  drawProc(p, h);
  pack(
    p.panels,
    Object.values(p.box).map((b) => b.box),
  );
}

function drawCpu(p: Page, h: StHost) {
  const { cpu } = h.s!;
  const c = calmOf(h);
  panelHead(p.cpu, 'cpu', esc(cpu.model.replace(/\s+/g, ' ').toLowerCase()));
  dotGraph(p.cpu.graph, h.hist.cpu!, 100, heatVar);
  // Windows has no load average: its hosts' sent as nulls, the line without one
  setHtml(
    p.cpu.line,
    `<span class="${heat(c.cpu / 100)}">${c.cpu.toFixed(1)}%</span>` +
      (cpu.load[0] == null
        ? ''
        : `<span class="st-dim">  load </span>${cpu.load.map((l) => (l ?? 0).toFixed(2)).join(' ')}`),
  );
  const b = p.box.cpus!;
  panelHead(b, 'cores', String(cpu.cores.length));
  setHtml(
    b.body,
    `<div class="st-cores">${c.cores
      .map(
        (c, i) =>
          `<div class="st-core"><span class="st-dim">${i}</span>${bar(c / 100)}<span class="${heat(c / 100)}">${Math.round(c)}%</span></div>`,
      )
      .join('')}</div>`,
  );
}

function drawNet(p: Page, h: StHost) {
  const { rx, tx } = calmOf(h);
  const busy = h.s!.net.filter((n) => n.rx || n.tx);
  panelHead(p.net, 'net', esc((busy.length ? busy : h.s!.net).map((n) => n.name).join(' ')));
  const max = netScale(h);
  dotGraph(p.net.rx, h.hist.rx!, max, () => '--accent');
  dotGraph(p.net.tx, h.hist.tx!, max, () => '--teal', true);
  setHtml(
    p.net.rates,
    `<span class="st-rx">▼ ${rate(rx)}</span>  <span class="st-tx">▲ ${rate(tx)}</span><span class="st-dim">  top ${rate(max)}</span>`,
  );
  // a day, or as much of one as has been counted
  const d = h.s!.netDay;
  const ms = h.s!.at - d.since;
  const span = ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))}m` : `${Math.min(24, Math.round(ms / 3600000))}h`;
  setHtml(
    p.net.day,
    `<span class="st-dim">${span}  </span><span class="st-rx">▼ ${humanSize(d.rx)}</span>  <span class="st-tx">▲ ${humanSize(d.tx)}</span>`,
  );
}

function drawMem(p: Page, h: StHost) {
  const m = h.s!.mem;
  const b = p.box.mem!;
  panelHead(b, 'mem', humanSize(m.total));
  setHtml(
    b.body,
    [
      meterRow('used', m.used / m.total, usedPct(m.used, m.total)),
      meterRow('avail', m.avail / m.total, usedPct(m.avail, m.total, 'st-lo'), 'st-lo'),
      meterRow('cached', m.cached / m.total, usedPct(m.cached, m.total, 'st-cache'), 'st-cache'),
      m.swapTotal && meterRow('swap', m.swapUsed / m.swapTotal, usedPct(m.swapUsed, m.swapTotal)),
    ]
      .filter(Boolean)
      .join(''),
  );
}

// the host's own disks, summed
function drawDisk(p: Page, h: StHost) {
  const { disk, io } = h.s!;
  const b = p.box.disk!;
  panelHead(b, 'disk', dotJoin([`${humanSize(disk.total)} capacity`, disk.count > 1 && `${disk.count} filesystems`]));
  const free = disk.total - disk.used;
  setHtml(
    b.body,
    meterRow('used', disk.used / disk.total, usedPct(disk.used, disk.total)) +
      meterRow('free', free / disk.total, usedPct(free, disk.total, 'st-lo'), 'st-lo') +
      kvRow('io', `<span class="st-rx">r ${rate(io.r)}</span>  <span class="st-tx">w ${rate(io.w)}</span>`),
  );
}

function drawGpu(p: Page, h: StHost) {
  const list = h.s!.gpus;
  const calm = calmOf(h).gpus;
  const b = p.box.gpu!;
  panelHead(b, 'gpu', esc(list.map((g) => g.name).join(', ')));
  setHtml(
    b.body,
    list
      .map((g, i) => {
        const rows: string[] = [];
        const util = calm[i] ?? g.util;
        if (list.length > 1) rows.push(`<div class="st-sub">${esc(g.name)}</div>`);
        if (util !== null) rows.push(meterRow('load', util / 100, pct(util / 100)));
        else if (g.mhz && g.mhzMax) rows.push(meterRow('clock', g.mhz / g.mhzMax, `${g.mhz}mhz`));
        if (g.memTotal && g.memUsed != null)
          rows.push(meterRow('vram', g.memUsed / g.memTotal, usedPct(g.memUsed, g.memTotal)));
        else if (g.memTotal) rows.push(kvRow('vram', humanSize(g.memTotal)));
        if (g.temp !== null) rows.push(kvRow('temp', `<span class="${heat((g.temp - 40) / 50)}">${g.temp}°c</span>`));
        return rows.join('') || '<div class="st-dim">no readings</div>';
      })
      .join(''),
  );
}

// a process's memory in its heat as a share of the host's
const memCell = (mem: number | null, total: number) =>
  mem == null ? '<span>–</span>' : `<span class="${heat(total ? mem / total : 0)}">${humanSize(mem)}</span>`;

// one row of the phosphorus panel; a figure left out shown as a dash
const ctrRow = (name: string, cpu: number, mem: number | null, pids: number | null, memT: number, cls = '', tip = '') =>
  `<div class="st-table st-ctr-row${cls}"${tip ? ` title="${esc(tip)}"` : ''}><span class="st-cut">${esc(name)}</span>` +
  `<span class="${heat(cpu / 100)}">${cpu.toFixed(1)}%</span>${memCell(mem, memT)}` +
  `<span class="st-dim">${pids ?? '–'}</span></div>`;

// phosphorus's own processes, all of them summed first, then by role
function drawCtr(p: Page, h: StHost) {
  const { parts: list, own } = h.s!;
  const memT = h.s!.mem.total;
  const b = p.box.ctr!;
  panelHead(b, 'phosphorus', list ? String(list.length) : '');
  setHtml(
    b.body,
    list
      ? '<div class="st-table st-ctr-row st-dim"><span>name</span><span>cpu</span><span>mem</span><span>pids</span></div>' +
          (own ? ctrRow('total', own.cpu, own.mem, own.pids, memT, ' st-ctr-total') : '') +
          list.map((c) => ctrRow(c.name, c.cpu, c.mem, c.pids, memT)).join('') +
          (own?.exited
            ? ctrRow(
                'short-lived',
                own.exited,
                null,
                null,
                memT,
                ' st-dim',
                'processes that started and ended between two samples',
              )
            : '')
      : '<div class="st-dim">no process list</div>',
  );
}

function drawProc(p: Page, h: StHost) {
  const pr = h.s!.procs;
  const b = p.box.proc!;
  panelHead(b, 'processes', pr ? String(pr.count) : '');
  setHtml(
    b.body,
    pr
      ? '<div class="st-table st-proc-row st-dim"><span>name</span><span>pid</span><span>cpu</span><span>mem</span></div>' +
          pr.top
            .map(
              (x) =>
                `<div class="st-table st-proc-row"${x.cmd ? ` title="${esc(x.cmd)}"` : ''}>` +
                `<span class="st-cut">${esc(x.name)}${x.role ? ` <span class="st-dim">${esc(x.role)}</span>` : ''}</span><span class="st-dim">${x.pid}</span>` +
                `<span class="${heat(x.cpu / 100)}">${x.cpu.toFixed(1)}%</span>${memCell(x.mem, h.s!.mem.total)}</div>`,
            )
            .join('')
      : '<div class="st-dim">no process list</div>',
  );
}
