// --- the agent tray beside the bell: the mcp's url copied for any agent's connector,
// its calls on this host as they happen
import { agentViewOn, agentViewSet } from './agent.ts';
import { acctCall } from './api.ts';
import { DK_GLYPHS, dkGlyph, el, pageAsk, svgEl } from './dom.ts';
import { noteAdd } from './notes.ts';
import { dk } from './state.ts';
import type { McpCall, McpStatus } from './types.ts';
import { copyText } from './util.ts';
import { dkAnchor, dkPopsClose, type Pop } from './desktop/taskbar.ts';
import { updateModal } from './update.ts';

// the user's key and calls from the mesh, and its url once fetched
export const mcpStat: { configured: boolean; seen: number; at: number; now: number; got: number; client: string; calls: McpCall[]; recent: McpCall[]; url: string } =
  { configured: false, seen: 0, at: 0, now: 0, got: 0, client: '', calls: [], recent: [], url: '' };
const MCP_ACTIVE_MS = 12000;
// a connector heard from this recently counted connected
const MCP_SEEN_MS = 15 * 60000;

// active, online (an agent connected), idle (a key, nothing heard) or off; a failed
// call shown in the log, never the tray
function mcpState(): 'off' | 'active' | 'online' | 'idle' {
  const c = mcpStat;
  if (!c.configured) return 'off';
  const now = mcpNow();
  if (c.calls.length || (c.at && now - c.at < MCP_ACTIVE_MS)) return 'active';
  return c.seen && now - c.seen < MCP_SEEN_MS ? 'online' : 'idle';
}

const mcpAgo = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};
const mcpMs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

// the star with its own moving purple to orange, painted by css while an agent runs
function mcpGlyph(): SVGSVGElement {
  const svg = dkGlyph(DK_GLYPHS.spark!);
  const g = svgEl('linearGradient', { id: 'mcp-grad', gradientUnits: 'userSpaceOnUse', x1: '0', y1: '0', x2: '16', y2: '16', spreadMethod: 'reflect' });
  g.append(svgEl('stop', { offset: '0', class: 'phosphorus-grad-p' }), svgEl('stop', { offset: '1', class: 'phosphorus-grad-o' }),
    svgEl('animateTransform', { attributeName: 'gradientTransform', type: 'translate', values: '-16 -16; 16 16; -16 -16', dur: '6s', repeatCount: 'indefinite' }));
  const defs = svgEl('defs', {});
  defs.append(g);
  svg.prepend(defs);
  return svg;
}

export function dkMcpTray(): HTMLElement {
  const wrap = el('div', 'dk-tray-wrap dk-mcp');
  const b = Object.assign(el('button', 'dk-tray dk-mcp-btn'), { type: 'button', title: 'agent', ariaLabel: 'agent' });
  b.setAttribute('aria-expanded', 'false');
  b.append(mcpGlyph());
  const pop = Object.assign(el('div', 'dk-mcp-pop dk-pop'), { hidden: true }) as Pop;
  wrap.append(b, pop);
  dkAnchor(pop, b, { fill: 300 });
  const row = (label: string, value: string, tone = '') => {
    const r = el('div', 'dk-cl-row');
    r.append(el('span', 'dk-cl-k', label), el('span', `dk-cl-v ${tone}`, value));
    return r;
  };
  // a call as a coding agent's log shows one: a bullet, the tool and its argument, its outcome under it
  const callRow = (c: McpCall, live: boolean) => {
    const li = el('li', `dk-cl-call ${live ? 'live' : c.ok ? 'ok' : 'bad'}`);
    const top = el('div', 'dk-cl-ln');
    top.append(el('span', 'dk-cl-pip'));
    if (c.host) top.append(el('span', 'dk-cl-host', c.host));
    top.append(el('span', 'dk-cl-tool', c.tool));
    if (c.detail) top.append(el('span', 'dk-cl-arg', `(${c.detail})`));
    const out = live ? `running · ${mcpMs(Math.max(0, mcpNow() - c.since!))}`
      : `${c.ok ? 'done' : c.error || 'failed'} · ${mcpMs(c.ms!)} · ${mcpAgo(mcpNow() - c.at!)} ago`;
    li.append(top, el('div', 'dk-cl-out', out));
    if (c.detail) li.title = c.host ? `${c.host}: ${c.detail}` : c.detail;
    return li;
  };
  let list: HTMLElement | null = null;
  const head = el('div', 'dk-cl-head');
  const stateLine = el('span', 'dk-cl-state');
  const bar = el('div', 'dk-cl-bar');
  // the url itself, only when the clipboard refused it
  const hint = el('div', 'dk-cl-hint');
  const body = el('div', 'dk-cl-body');
  // the agent's moves shown on this desk, or kept off it
  const view = el('label', 'dk-cl-check');
  const box = Object.assign(el('input'), { type: 'checkbox', checked: agentViewOn() });
  box.addEventListener('change', () => agentViewSet(box.checked));
  view.append(box, el('span', '', 'show agent on screen'));
  view.title = 'open the files, editor, consoles and views the agent works in, as it works';
  pop.append(bar, hint, view, head, body);
  head.append(el('span', 'dk-cl-title', 'agent'), stateLine);
  const flash = (x: HTMLElement, text: string) => {
    const was = x.dataset.label!;
    x.textContent = text;
    setTimeout(() => { x.textContent = was; }, 1800);
  };
  const button = (label: string, cls: string, act: (x: HTMLButtonElement) => void) => {
    const x = Object.assign(el('button', `dk-cl-key ${cls}`, label), { type: 'button' });
    x.dataset.label = label;
    x.addEventListener('click', () => act(x));
    return x;
  };
  const showUrl = (url: string, copied: boolean) => {
    if (copied) { hint.replaceChildren(); return; }
    const f = Object.assign(el('input', 'dk-cl-url'), { readOnly: true, value: url, spellcheck: false, title: 'copy, then paste into your agent as a custom mcp connector' });
    f.addEventListener('focus', () => f.select());
    hint.replaceChildren(f);
    f.focus();
  };
  // the bar drawn again only when set up flips: connect, else copy and refresh
  let drawn: boolean | null = null;
  const drawBar = () => {
    const done = mcpStat.configured;
    if (drawn === done) return;
    drawn = done;
    // the claude skill, no key: the connector does the calling
    const skill = button('claude skill', 'quiet', async (x) => {
      x.disabled = true;
      const ok = await mcpSkill();
      x.disabled = false;
      if (ok) flash(x, 'downloaded');
    });
    skill.title = 'the mesh skill: upload it in claude.ai, Settings, Capabilities, Skills; works through the connector';
    if (!done) {
      bar.replaceChildren(button('connect agent', 'wide', async () => {
        const r = await mcpKey('/api/me/mcp-url');
        if (r) showUrl(r.url, r.copied);
      }), skill);
      hint.replaceChildren();
      return;
    }
    hint.replaceChildren();
    const copy = button('copy mcp url', 'quiet wide', async (x) => {
      const r = await mcpKey('/api/me/mcp-url', mcpStat.url);
      if (!r) return;
      flash(x, r.copied ? 'copied' : 'copy it below');
      showUrl(r.url, r.copied);
    });
    copy.title = 'paste into your agent as a custom mcp connector';
    const refresh = button('refresh key', 'quiet', async () => {
      show(false);
      if (!await pageAsk({ title: 'refresh key?', message: 'old url dies', action: 'refresh', danger: true })) return;
      const r = await mcpKey('/api/me/mcp-key');
      if (r) { show(true); showUrl(r.url, r.copied); }
    });
    bar.replaceChildren(copy, refresh, skill);
  };
  const paint = () => {
    const st = mcpState();
    b.dataset.state = st;
    b.title = { off: 'agent, not connected', idle: 'agent, nothing heard lately', online: 'agent, connected', active: 'agent, working' }[st];
    if (pop.hidden) return;
    drawBar();
    const c = mcpStat;
    stateLine.textContent = { off: 'not connected', idle: 'idle', online: 'connected', active: 'working' }[st];
    stateLine.dataset.state = st;
    if (!c.configured) { body.replaceChildren(); list = null; return; }
    const now = mcpNow();
    const rows = [row('last heard', c.seen ? `${mcpAgo(now - c.seen)} ago` : 'not yet', c.seen && now - c.seen < MCP_SEEN_MS ? 'good' : '')];
    if (c.client) rows.push(row('client', c.client));
    const calls = el('div', 'dk-cl-sec');
    calls.append(el('div', 'dk-cl-sec-t', 'calls'));
    // kept across redraws so a scroll back holds, followed when at the end
    const stick = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 8;
    const keep = list?.scrollTop || 0;
    list = list || el('ul', 'dk-cl-calls');
    list.replaceChildren(...[...c.recent].reverse().map((x) => callRow(x, false)), ...c.calls.map((x) => callRow(x, true)));
    if (!list.children.length) list.append(el('li', 'dk-cl-none', 'no calls yet'));
    calls.append(list);
    rows.push(calls);
    body.replaceChildren(...rows);
    // about five calls tall, the rest a scroll away
    const last = [...list.children].slice(-5) as HTMLElement[];
    list.style.maxHeight = list.children.length > 5 ? `${last.reduce((h, x) => h + x.offsetHeight, 0) + 4}px` : '';
    list.scrollTop = stick ? list.scrollHeight : keep;
  };
  const show = (on: boolean) => {
    if (!on && pop.hidden) return;
    if (on) dkPopsClose('mcp');
    pop.hidden = !on;
    b.setAttribute('aria-expanded', String(on));
    if (on) {
      box.checked = agentViewOn();
      drawn = null;
      list = null;
      paint();
      if (mcpStat.configured) hint.replaceChildren();
      // the url ready before a tap, so copying it is the tap's own
      if (mcpStat.configured) acctCall('/api/me/mcp-url', {}).then((r) => { if (r.ok) mcpStat.url = r.url; });
    }
  };
  b.addEventListener('click', () => show(pop.hidden as boolean));
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !wrap.contains(e.target as Node) && !updateModal.contains(e.target as Node)) show(false); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) show(false); });
  const me = { show, paint };
  dk.mcp = me;
  dk.mcpStop?.();
  // one socket while the page is visible, the server pushing on a change; ended by a
  // logout or a newer tray, a dropped one retried and read once over fetch meanwhile
  let sock: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let retryMs = 1000;
  const open = () => {
    if (dk.mcp !== me || document.hidden || sock) return;
    const s = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/me/mcp`);
    sock = s;
    s.onmessage = (ev) => {
      retryMs = 1000;
      try { mcpApply(JSON.parse(ev.data)); } catch { return; }
      me.paint();
    };
    s.onclose = () => {
      if (sock === s) sock = null;
      if (dk.mcp !== me || document.hidden) return;
      pollMcp();
      retry = setTimeout(open, retryMs);
      retryMs = Math.min(retryMs * 2, 15000);
    };
    s.onerror = () => s.close();
  };
  const seen = () => {
    if (dk.mcp !== me) return;
    if (document.hidden) { clearTimeout(retry!); sock?.close(); return; }
    open();
  };
  document.addEventListener('visibilitychange', seen);
  dk.mcpStop = () => {
    document.removeEventListener('visibilitychange', seen);
    clearTimeout(retry!);
    const s = sock;
    sock = null;
    s?.close();
  };
  open();
  return wrap;
}

// the user's key and calls from the mesh, read once: after a key change, a dropped socket
async function pollMcp() {
  let s: McpStatus & { ok: boolean } = { ok: false };
  try {
    const r = await fetch('/api/me/mcp', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
    s = { ok: r.ok, ...(await r.json().catch(() => ({}))) };
  } catch {}
  if (s.ok) mcpApply(s);
  dk.mcp?.paint();
}

function mcpApply(s: McpStatus) {
  Object.assign(mcpStat, { configured: !!s.configured, seen: +s.seen! || 0, at: +s.at! || 0, client: s.client || '',
    now: +s.now! || Date.now(), got: Date.now(), calls: s.calls || [], recent: s.recent || [] });
}

// the mesh's now, carried forward from the last answer so durations keep running
const mcpNow = () => (mcpStat.now || Date.now()) + (mcpStat.got ? Date.now() - mcpStat.got : 0);

// the key's url from the mesh, copied: the one in use, or a fresh one voiding it.
// a url already in hand copied in the tap itself, else once it lands
async function mcpKey(path: string, have = ''): Promise<{ url: string; copied: boolean } | null> {
  let copied = false;
  if (have) { try { await copyText(have); copied = true; } catch {} }
  const r: { ok: boolean; url?: string; error?: string } = have ? { ok: true, url: have } : await acctCall<{ url: string }>(path, {});
  if (!r.ok) { mcpFailed(r.error); return null; }
  if (!copied) { try { await copyText(r.url!); copied = true; } catch {} }
  mcpStat.url = r.url!;
  if (!mcpStat.configured || path.endsWith('mcp-key')) {
    mcpStat.configured = true;
    noteAdd('agent connected', copied ? 'url copied' : 'copy the url');
  }
  pollMcp();
  return { ...r, url: r.url!, copied };
}

// the skill's zip from the mesh, saved for claude.ai's skill upload
async function mcpSkill(): Promise<boolean> {
  let res: Response;
  try { res = await fetch('/api/me/mcp-skill', { method: 'POST' }); } catch (err) { mcpFailed((err as Error).message); return false; }
  if (!res.ok) { mcpFailed((await res.json().catch(() => ({}))).error || `http ${res.status}`); return false; }
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: 'phosphorus-skill.zip' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}

// a failure in two words, its why in the notes
function mcpFailed(why: string | undefined) {
  if (why) noteAdd('agent failed', String(why));
  pageAsk({ title: 'agent', message: 'agent failed', cancel: false });
}
