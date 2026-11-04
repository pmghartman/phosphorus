// model

import type { ModelHost, StatsSample } from '@phosphorus/wire';
import { pingClass, steadyRtt } from '../../features/mesh/mesh.ts';
import { st } from '../../lib/state.ts';
import { esc, plural } from '../../lib/util.ts';
import { dotJoin, hostServices, panelHead, setHtml } from './cards.ts';
import { ctxCells, kTok } from './context.ts';
import { pct, uptime } from './glyphs.ts';
import { type Panel, ST_STALE_MS, type StHost, stNet } from './state.ts';

// the mesh's models as the status tab shows them: nothing at all until some
// host is set as the model host, and then only on the hosts that are

export const stModel = () => stNet?.model || null;
export const stModels = () => stModel()?.models || [];
export const modelOf = (host: string) => stModels().find((x) => x.host === host) || null;

// loaded, loading, downloading with its share done, else not loaded
export function modelPhase(m: ModelHost): [string, string] {
  if (m.ready) return ['st-lo', 'loaded'];
  if (m.download && m.download.total) return ['st-mid', `downloading ${pct(m.download.done / m.download.total)}`];
  if (m.loading) return ['st-mid', 'loading'];
  return ['st-hi', 'not loaded'];
}

// a host's facts: platform, release, uptime, ping, its model and services
export function facts(name: string, h: StHost): string {
  const s: Partial<StatsSample> = h.s || {};
  const dev = (stNet?.tailnet || []).find((d) => d.name === name) || ({} as { os?: string; version?: string });
  const svc = hostServices(name);
  const rtt = steadyRtt(name);
  return dotJoin([
    `<span class="st-name${name === st.selfHost ? ' self' : ''}">${esc(name)}</span>`,
    esc(s.platform || dev.os || '?'),
    (s.version || dev.version) && `v${esc(s.version || dev.version)}`,
    s.uptime && `up ${uptime(s.uptime)}`,
    typeof rtt === 'number' && `<span class="mesh-stat-ping ${pingClass(rtt)}">${rtt}ms</span>`,
    modelOf(name) && '<span class="st-model-mark">model</span>',
    svc.length && plural(svc.length, 'service'),
    h.s?.cpu && Date.now() - h.at > ST_STALE_MS && '<span class="st-mid">stale</span>',
  ]);
}

// a model host's model box: phase and speed, its file, the context window as
// its last ask left it, the agents asking it

export function modelHtml(m: ModelHost): string {
  const [cls, phase] = modelPhase(m);
  const head = dotJoin([
    `<span class="${cls}">${esc(phase)}</span>`,
    m.ready && m.use?.tps && `<b>${m.use.tps}</b> <span class="st-dim">tok/s</span>`,
  ]);
  const agents = m.agents?.length
    ? m.agents.map((a) => `<span class="st-model-a">${esc(a)}</span>`).join('')
    : '<span class="st-dim">no agents</span>';
  let ctx = '';
  if (m.ready && m.ctx) {
    const { cells, parts, used } = ctxCells(m);
    // counts by colour alone, the names on hover
    const legend = [
      `<span>${kTok(used)}/${kTok(m.ctx)} <span class="st-dim">${pct(used / m.ctx)}</span></span>`,
      ...parts.map(([k, label, n]) => `<span title="${label}"><i class="ctx-${k} full"></i>${kTok(n)}</span>`),
      `<span title="free"><i></i>${kTok(m.ctx - used)}</span>`,
    ].join(' ');
    ctx = `<div class="st-ctx"><div class="st-ctx-grid">${cells}</div><div class="st-model-key">${legend}</div></div>`;
  }
  const file = m.file
    ? `<div class="st-model-file st-dim" title="${esc(m.file)}">${esc(String(m.file).replace(/\\/g, '/').split('/').pop())}</div>`
    : '';
  // the mesh's model, an admin's to clear
  const clear =
    m.ready && st.acct?.admin
      ? `<button type="button" class="st-clear" data-host="${esc(m.host)}" title="erase ${esc(m.host)}'s context windows">clear context</button>`
      : '';
  return `<div class="st-model-head">${head}</div>${file}${ctx}<div class="st-model-foot"><div class="st-model-agents">${agents}</div>${clear}</div>`;
}

// a model panel, its head naming the host when asked
export function drawModel(p: Panel, m: ModelHost | null, named = false) {
  p.box.hidden = !m;
  if (!m) return;
  panelHead(p, 'model', named ? esc(m.host) : '');
  setHtml(p.body, modelHtml(m));
}
