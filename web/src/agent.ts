// --- the agent on screen: each keyed call's start and end, the window it works in
// brought up and lit, its shell work in a console per host; off by the tray's box
import { app } from './apps.ts';
import { openConv } from './chat.ts';
import { filesParent, filesWin, HOME, type Fm, type Loc } from './shares.ts';
import { dk, PREF_LS, st } from './state.ts';
import type { UiAction } from './types.ts';
import { openUpdateModal, updateModal } from './update.ts';
import { dkOpenApp } from './desktop/desk.ts';
import { dkCode } from './desktop/deskfiles.ts';
import { dkClose, dkFocus, dkWin, type DkWin } from './desktop/windows.ts';

const AGENT_VIEW_LS = PREF_LS.agentview!;
export const agentViewOn = () => { try { return localStorage.getItem(AGENT_VIEW_LS) !== '0'; } catch { return true; } };
export function agentViewSet(on: boolean): void {
  try { if (on) localStorage.removeItem(AGENT_VIEW_LS); else localStorage.setItem(AGENT_VIEW_LS, '0'); } catch {}
  if (!on) agentCalls.clear();
}

// calls begun, by id, their arguments for the end and when they began
const agentCalls = new Map<string, UiAction & { t: number }>();
// a call whose end never came given up on after this, so its windows still close
const AGENT_STALE_MS = 11 * 60000;
// tools printed in a host's console: the command or the call, then what came back
const AGENT_CONSOLE = new Set(['terminal_run', 'host_logs', 'service_request', 'forgejo',
  'host_config', 'service_edit', 'config_set', 'host_power', 'game_power']);
const AGENT_STATUS = new Set(['mesh_hosts', 'host_stats', 'services', 'models', 'set_agent_model']);
const AGENT_CHAT = new Set(['send_message', 'chat_history', 'chat_edit']);
const AGENT_LIT_MS = 2400;
// the windows the agent opened itself, closed this long after it goes quiet
const AGENT_CLOSE_MS = 5000;
const agentOwned = new Set<DkWin>();
// windows it opened that a person took over: kept, still ringed until it goes quiet
const agentRinged = new Set<DkWin>();
let agentCloseT: ReturnType<typeof setTimeout> | 0 = 0;

export function agentStep(a: UiAction): void {
  if (!a.id) return;
  const begun = agentCalls.get(a.id);
  agentCalls.delete(a.id);
  if (!agentViewOn() || !dk.desk) return;
  agentArm();
  if (a.phase === 'start') {
    agentCalls.set(a.id, { ...a, t: Date.now() });
    agentAct(a, a.args || {}, false);
    return;
  }
  agentAct(a, begun?.args || {}, true);
}

export function agentArm(): void {
  clearTimeout(agentCloseT);
  agentCloseT = setTimeout(agentTidy, AGENT_CLOSE_MS);
}

// the agent's own windows put away once it stops; one a person touched is theirs
function agentTidy() {
  const now = Date.now();
  for (const [id, c] of agentCalls) if (now - c.t > AGENT_STALE_MS) agentCalls.delete(id);
  if (agentCalls.size) { agentArm(); return; }
  for (const w of [...agentOwned]) {
    agentOwned.delete(w);
    if (w.node.isConnected) dkClose(w);
  }
  for (const w of agentRinged) if (!w.agentLit) w.node.classList.remove('dk-agent');
  agentRinged.clear();
}

// a window just opened by the agent, its own until a person clicks or types in it
export function agentOwn(w: DkWin | null | undefined): void {
  if (!w || agentOwned.has(w)) return;
  agentOwned.add(w);
  w.node.classList.add('dk-agent');
  const mine = () => {
    if (agentOwned.delete(w)) agentRinged.add(w);
  };
  w.node.addEventListener('pointerdown', mine, { once: true });
  w.node.addEventListener('keydown', mine, { once: true });
}

// a window by its key brought up: opened by the agent when it wasn't there, then lit
async function agentOpen(key: string, open: () => unknown) {
  const had = dk.wins.has(key);
  await open();
  const w = dk.wins.get(key);
  if (!had) agentOwn(w);
  agentLit(w);
}

// a window the agent touched, lit for a moment and brought forward
function agentLit(w: DkWin | null | undefined) {
  if (!w) return;
  dkFocus(w);
  w.node.classList.add('dk-agent');
  clearTimeout(w.agentLit);
  w.agentLit = setTimeout(() => {
    w.agentLit = 0;
    if (!agentOwned.has(w) && !agentRinged.has(w)) w.node.classList.remove('dk-agent');
  }, AGENT_LIT_MS);
}
const agentWin = (pred: (w: DkWin) => boolean) => [...dk.wins.values()].find(pred);

function agentAct(a: UiAction, args: Record<string, any>, done: boolean) {
  const t = a.tool!;
  const tab = t === 'terminal_run' && args.mode === 'tab';
  if (AGENT_CONSOLE.has(t) && !tab) { agentPrint(a, args, done); return; }
  if (tab || t === 'terminal_screen') {
    agentLit(agentWin((w) => w.kind === 'term' && w.host === args.host));
    return;
  }
  const code = () => agentOpen(`view:edit
${args.host}
${args.share ?? ''}
${args.path}`, () => dkCode({ host: args.host, share: args.share, path: args.path }));
  if (t === 'files_read' && !done && args.host && args.path) { code(); return; }
  if (t === 'files_write' && done && a.ok && args.host && args.path) {
    if (!args.open) code();
    return;
  }
  if ((t === 'files_list' || t === 'files_search') && !done && args.host && args.share) { agentFiles(args.host, args.share, args.path || ''); return; }
  if (t === 'files_change' && done) {
    const p = args.steps?.[0]?.path ?? args.path ?? '';
    if (args.host && args.share) agentFiles(args.host, args.share, filesParent(String(p)));
    return;
  }
  if (t === 'files_copy' && done && args.to?.host) { agentFiles(args.to.host, args.to.share, filesParent(String(args.to.path || ''))); return; }
  if (done) return;
  if (AGENT_STATUS.has(t)) agentOpen('app:status', () => dkOpenApp('status'));
  else if (t === 'git' || t === 'make_git_master') agentOpen('app:git', () => dkOpenApp('git'));
  else if (AGENT_CHAT.has(t)) {
    const c = args.to ? `dm:${String(args.to).replace(/^@/, '')}` : !args.channel || args.channel === 'mesh' ? 'mesh' : /^dm:/.test(args.channel) ? args.channel : `ch:${args.channel}`;
    agentOpen('app:chat', () => openConv(c));
  } else if (t === 'update_control' && st.acct?.admin && updateModal.hidden) openUpdateModal();
}


// one files window the agent browses in, opened or moved to the place
let agentFm: Fm | null | undefined = null;
async function agentFiles(host: string, share: string, dir: string) {
  const info = st.hostsInfo[String(host).toLowerCase()]?.files?.shares?.find((x) => x.id === share);
  const loc: Loc = share === 'home' ? HOME : { host, share, root: info?.label || share, perms: info?.perms || '' };
  if (agentFm?.w.node.isConnected) {
    (await app('files')).fmGo(agentFm, loc, dir);
    agentLit(agentFm.w);
    return;
  }
  agentFm = await filesWin({ loc, dir });
  agentOwn(agentFm?.w);
  agentLit(agentFm?.w);
}

// a host's console: the agent's command in the accent, its output, its outcome dimmed
const agentCons = new Map<string, { w: DkWin; con: { write: (t: string) => void; close: () => unknown } }>();
async function agentPrint(a: UiAction, args: Record<string, any>, done: boolean) {
  const host = args.host || (a.tool === 'forgejo' ? 'git' : 'mesh');
  let c = agentCons.get(host);
  if (!c || !c.w.node.isConnected) {
    const w = dkWin(`agent:${host}`, 'terminal', host, 'term dk-agent-con');
    if (!w) return;
    const con = (await app('terminal')).agentConsole(w.body);
    c = { w, con };
    w.onClose = () => { con.close(); agentCons.delete(host); };
    agentCons.set(host, c);
    agentOwn(w);
  }
  agentLit(c.w);
  const dim = (x: string) => `\x1b[2m${x}\x1b[0m`;
  if (!done) {
    const line = a.tool === 'terminal_run' ? `\x1b[35m$\x1b[0m ${args.command || ''}`
      : `\x1b[35m›\x1b[0m ${a.tool}${agentArgLine(args)}`;
    c.con.write(`${line}\n`);
    return;
  }
  if (a.out) c.con.write(a.out.endsWith('\n') ? a.out : `${a.out}\n`);
  const how = !a.ok ? `\x1b[31m✗ ${a.error || 'failed'}\x1b[0m` : a.timedOut ? '\x1b[33m⏱ timed out\x1b[0m'
    : a.exit != null && a.exit !== 0 ? `\x1b[31m✗ exit ${a.exit}\x1b[0m` : '\x1b[32m✓\x1b[0m';
  c.con.write(`${how} ${dim(a.tool!)}\n\n`);
}

// a call's arguments as flags, the host and long text left out
function agentArgLine(args: Record<string, any>): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (k === 'host' || v == null || v === '' || typeof v === 'object') continue;
    const s = String(v).replace(/\s+/g, ' ');
    out.push(`${k}=${s.length > 60 ? `${s.slice(0, 60)}…` : s}`);
  }
  return out.length ? ` ${out.join(' ')}` : '';
}
