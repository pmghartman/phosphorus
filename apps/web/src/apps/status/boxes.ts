// one host's page: its facts, headlines, graphs, and a panel for each part of it
import { esc, humanSize, plural } from '../../lib/util.ts';
import { dotJoin, kvRow, meterRow, pack, pageFrame, panelHead, setHtml, stat, usedOf, usedPct } from './cards.ts';
import { bar, dotGraph, heat, heatVar, netScale, pct, rate } from './glyphs.ts';
import { drawModel, facts, modelOf } from './model.ts';
import type { Page, StHost } from './state.ts';

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
  const rx = h.hist.rx!.at(-1) || 0;
  const tx = h.hist.tx!.at(-1) || 0;
  const load = gpus.filter((g) => g.util !== null);
  const gpuLoad = load.reduce((a, g) => a + g.util!, 0) / Math.max(1, load.length) / 100;
  const vramU = gpus.reduce((a, g) => a + (g.memUsed || 0), 0);
  const vramT = gpus.reduce((a, g) => a + (g.memTotal || 0), 0);
  setHtml(
    p.stats,
    [
      stat(
        'cpu',
        'cpu',
        pct(cpu.total / 100),
        dotJoin([plural(cpu.cores.length, 'core'), cpu.load[0] != null && `load ${cpu.load[0].toFixed(2)}`]),
        cpu.total / 100,
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
  panelHead(p.cpu, 'cpu', esc(cpu.model.replace(/\s+/g, ' ').toLowerCase()));
  dotGraph(p.cpu.graph, h.hist.cpu!, 100, heatVar);
  // Windows has no load average: its hosts' sent as nulls, the line without one
  setHtml(
    p.cpu.line,
    `<span class="${heat(cpu.total / 100)}">${cpu.total.toFixed(1)}%</span>` +
      (cpu.load[0] == null
        ? ''
        : `<span class="st-dim">  load </span>${cpu.load.map((l) => (l ?? 0).toFixed(2)).join(' ')}`),
  );
  const b = p.box.cpus!;
  panelHead(b, 'cores', String(cpu.cores.length));
  setHtml(
    b.body,
    `<div class="st-cores">${cpu.cores
      .map(
        (c, i) =>
          `<div class="st-core"><span class="st-dim">${i}</span>${bar(c / 100)}<span>${Math.round(c)}%</span></div>`,
      )
      .join('')}</div>`,
  );
}

function drawNet(p: Page, h: StHost) {
  const rx = h.hist.rx!.at(-1) || 0;
  const tx = h.hist.tx!.at(-1) || 0;
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
      meterRow('avail', m.avail / m.total, usedPct(m.avail, m.total), 'st-lo'),
      meterRow('cached', m.cached / m.total, usedPct(m.cached, m.total), 'st-cache'),
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
      meterRow('free', free / disk.total, usedPct(free, disk.total), 'st-lo') +
      kvRow('io', `<span class="st-rx">r ${rate(io.r)}</span>  <span class="st-tx">w ${rate(io.w)}</span>`),
  );
}

function drawGpu(p: Page, h: StHost) {
  const list = h.s!.gpus;
  const b = p.box.gpu!;
  panelHead(b, 'gpu', esc(list.map((g) => g.name).join(', ')));
  setHtml(
    b.body,
    list
      .map((g) => {
        const rows: string[] = [];
        if (list.length > 1) rows.push(`<div class="st-sub">${esc(g.name)}</div>`);
        if (g.util !== null) rows.push(meterRow('load', g.util / 100, pct(g.util / 100)));
        else if (g.mhz && g.mhzMax) rows.push(meterRow('clock', g.mhz / g.mhzMax, `${g.mhz}mhz`));
        if (g.memTotal) rows.push(meterRow('vram', g.memUsed! / g.memTotal, usedPct(g.memUsed!, g.memTotal)));
        if (g.temp !== null) rows.push(kvRow('temp', `<span class="${heat((g.temp - 40) / 50)}">${g.temp}°c</span>`));
        return rows.join('') || '<div class="st-dim">no readings</div>';
      })
      .join(''),
  );
}

// phosphorus's own processes, by role
function drawCtr(p: Page, h: StHost) {
  const list = h.s!.parts;
  const b = p.box.ctr!;
  panelHead(b, 'phosphorus', list ? String(list.length) : '');
  setHtml(
    b.body,
    list
      ? '<div class="st-table st-ctr-row st-dim"><span>name</span><span>cpu</span><span>mem</span><span>pids</span></div>' +
          list
            .map(
              (c) =>
                `<div class="st-table st-ctr-row"><span class="st-cut">${esc(c.name)}</span>` +
                `<span class="${heat(c.cpu / 100)}">${c.cpu.toFixed(1)}%</span><span>${humanSize(c.mem)}</span>` +
                `<span class="st-dim">${c.pids}</span></div>`,
            )
            .join('')
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
                `<span class="${heat(x.cpu / 100)}">${x.cpu.toFixed(1)}%</span><span>${humanSize(x.mem)}</span></div>`,
            )
            .join('')
      : '<div class="st-dim">no process list</div>',
  );
}
