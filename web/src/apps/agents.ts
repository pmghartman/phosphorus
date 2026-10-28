import { jsonPost } from '../api.ts';
import { el } from '../dom.ts';
import type { ModelAgent, ModelHost, ModelSummary, State } from '../types.ts';

// --- agents: which mesh model each implementation that asks one runs on ------
// a model is assigned to any number of agents; an assignment is mesh-wide, one
// POST each, and the models themselves are installed in the phos tui

const view = document.getElementById('view-agents')!;

// the newest model summary, and the last refusal
let model: ModelSummary | null = null;
let error = '';
let sig = '';

const hostOf = (id: string | undefined) => (id || '').replace(/^phosphorus\//, '');
const fileName = (m: { file?: string }) => String(m.file || '').replace(/\\/g, '/').split('/').pop();

function agentsState(state: State | null): void {
  model = state?.model || null;
  draw();
}

function agentsWatch(on: boolean): void {
  if (on) draw();
}

// ready, loading or down, as the status tab words a model
function phase(m: ModelHost): [string, string] {
  if (m.ready) return ['on', 'loaded'];
  if (m.download?.total) return ['mid', `downloading ${Math.floor((100 * m.download.done) / m.download.total)}%`];
  if (m.loading) return ['mid', 'loading'];
  return ['off', 'not loaded'];
}

async function assign(agent: string, slot: string, value: string) {
  try {
    const r = await fetch('/api/model/agent', jsonPost({ agent, slot, model: value }));
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `status ${r.status}`);
    error = '';
    const s = model?.agents?.find((a) => a.id === agent)?.slots?.[slot];
    if (s) s.chosen = value;
  } catch (e) {
    error = (e as Error).message;
  }
  sig = '';
  draw();
}

// one model host, its agents as chips
function modelCard(m: ModelHost): HTMLElement {
  const [cls, text] = phase(m);
  const card = el('div', `ag-model ${cls}`);
  const head = el('div', 'ag-model-head');
  head.append(el('i', 'ag-dot'), el('b', '', m.host), el('span', 'ag-dim', text));
  if (m.ready && m.use?.tps) head.append(el('span', 'ag-spd', `${m.use.tps} tok/s`));
  const file = el('div', 'ag-dim ag-file', fileName(m) || 'no model yet');
  file.title = m.file || '';
  const chips = el('div', 'ag-chips');
  for (const id of m.agents || []) chips.append(el('span', 'ag-chip', id));
  if (!m.agents?.length) chips.append(el('span', 'ag-dim', 'no agents'));
  card.append(head, file, chips);
  if (!m.ready && m.why) card.append(el('div', 'ag-why', m.why));
  return card;
}

// a slot's pills: the default (the parent's, or automatic), then every model
function slotRow(a: ModelAgent, slot: string, label: string): HTMLElement {
  const s = a.slots[slot]!;
  const row = el('div', 'ag-slot');
  if (label) row.append(el('span', 'ag-slot-k', label));
  const pills = el('div', 'ag-pills');
  const pill = (value: string, text: string, title?: string) => {
    const b = Object.assign(el('button', `ag-pill${(s.chosen || '') === value ? ' on' : ''}`, text), { type: 'button', title: title || text });
    b.addEventListener('click', () => { if ((s.chosen || '') !== value) assign(a.id, slot, value); });
    return b;
  };
  const parent = a.parent ? model!.agents!.find((x) => x.id === a.parent) : null;
  pills.append(pill('', parent ? `same as ${parent.label}` : 'automatic',
    parent ? `follows whatever ${parent.label} is assigned` : 'the smallest ready model, or the biggest for the larger agents'));
  const hosts = model!.models.map((m) => m.host);
  for (const m of model!.models) pills.append(pill(`phosphorus/${m.host}`, m.host, fileName(m)));
  if (s.chosen && !hosts.includes(hostOf(s.chosen))) pills.append(pill(s.chosen, `${hostOf(s.chosen)} (gone)`));
  // what it answers with now, or why nothing does
  const line = el('div', `ag-line ${s.ready ? 'on' : 'off'}`);
  const m = model!.models.find((x) => x.host === s.host);
  line.append(el('i', 'ag-dot'));
  if (s.ready) line.append(el('span', '', 'asks '), el('b', '', s.host), el('span', '', fileName(m || {}) ? ` · ${fileName(m!)}` : ''));
  else line.append(el('span', '', s.why || 'no model answering'));
  if (s.ready && !s.chosen) line.append(el('span', '', s.inherited ? ' · inherited' : ' · automatic'));
  row.append(pills, line);
  return row;
}

function agentCard(a: ModelAgent): HTMLElement {
  const card = el('section', 'ag-card');
  const head = el('div', 'ag-card-head');
  const name = el('b', '', a.label);
  name.title = `asks the gateway as agent-${a.id}${a.fast ? ` and agent-${a.id}-fast` : ''}`;
  head.append(name, el('span', 'ag-about', a.about));
  card.append(head, slotRow(a, 'model', a.fast ? 'main model' : ''));
  if (a.fast) card.append(slotRow(a, 'fast', 'background model'));
  return card;
}

// agents by where they run
const GROUPS: [string, string[]][] = [['Code', ['code', 'claude-code', 'opencode']], ['Apps', ['tavern', 'sulfur']]];

function group(title: string, note: string, body: HTMLElement): HTMLElement {
  const g = el('section', 'ag-group');
  const head = el('div', 'ag-group-head', title);
  if (note) head.append(el('span', 'ag-dim', note));
  g.append(head, body);
  return g;
}

function draw() {
  const next = JSON.stringify([model, error]);
  if (next === sig) return;
  // never rebuilt under a hand on a pill
  if (view.contains(document.activeElement) && document.activeElement!.classList.contains('ag-pill') && sig) return;
  sig = next;
  if (!model) { view.replaceChildren(el('div', 'ag-empty', 'connecting')); return; }
  const wrap = el('div', 'ag');
  const models = el('div', 'ag-models');
  if (model.models.length) models.append(...model.models.map(modelCard));
  else models.append(el('div', 'ag-empty', 'no model host yet: turn on [model] host in the phos tui\'s model tab, and its model installs here'));
  wrap.append(group('models', `${model.models.length} on the mesh`, models));
  if (model.models.length) {
    const known = new Set(GROUPS.flatMap(([, ids]) => ids));
    const rest = (model.agents || []).filter((a) => !known.has(a.id));
    for (const [title, ids] of [...GROUPS, ['Other', rest.map((a) => a.id)] as [string, string[]]]) {
      const agents = (model.agents || []).filter((a) => ids.includes(a.id));
      if (!agents.length) continue;
      const cards = el('div', 'ag-cards');
      cards.append(...agents.map(agentCard));
      wrap.append(group(title, '', cards));
    }
  }
  if (error) wrap.append(el('div', 'ag-err', error));
  view.replaceChildren(wrap);
}

export { agentsState, agentsWatch };
