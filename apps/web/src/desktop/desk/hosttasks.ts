// a Windows host's own task bar on its desktop: the windows up on the host (its afterglow's
// process list, as the viewer's login), each a button before phosphorus's own windows. A press
// shows the app here, streamed where it already runs; its right click closes it or ends it.
// A desk icon's file goes to the host's Recycle Bin the same way

import { acctCall } from '../../lib/api.ts';
import { DK_GLYPHS, dkGlyph, el } from '../../lib/dom.ts';
import { dk } from '../../lib/state.ts';
import { hostFiles, onSpace } from '../spaces.ts';
import { api, hostInfo, hostLoad, type Item } from './hosts.ts';
import { onStreams, streamedOn, streamWin } from './hoststream.ts';
import { dkIcons } from './icons.ts';
import { barTasks, label, type Task, titled } from './tasklist.ts';
import { osOf } from './terminal.ts';
import { dkMenu, dkSay, dkWallPaint, type MenuItem } from './wallpaper.ts';

type Known = { features: Set<string>; list: Task[]; error?: string };
const known = new Map<string, Known>();

// whether a host's afterglow can be asked this: "processes", "attach", "delete"
export const hostCan = (h: string, f: string) => !!known.get(h)?.features.has(f);

// a host whose desktop afterglow serves: a Windows one
const winHost = (h: string) => /win/i.test(osOf(h) || hostInfo(h).desk?.os || '');

// the host asked again for its windows; undefined when it couldn't say
export async function hostTasks(h: string): Promise<Known | undefined> {
  const r = await acctCall<{ features?: string[]; list?: Task[] }>(api(h, 'tasks'));
  const k: Known = r.ok
    ? { features: new Set(r.features ?? []), list: Array.isArray(r.list) ? r.list : [] }
    : { features: known.get(h)?.features ?? new Set(), list: [], error: r.error || `${h} didn't answer` };
  known.set(h, k);
  return r.ok ? k : undefined;
}

// --- the buttons ----------------------------------------------------------------------------

let group: HTMLElement | undefined;
// what the buttons last drew, so a poll that finds the same leaves them (and a hover) be
let drawn = '';

function paint() {
  const tasks = dk.desk?.tasks;
  if (!tasks) return;
  if (!group || !tasks.contains(group)) {
    group = el('span', 'dk-htasks');
    group.setAttribute('role', 'group');
    // first, so each window phosphorus opens comes after the host's own
    tasks.prepend(group);
    drawn = '';
  }
  const h = dk.space;
  const k = h ? known.get(h) : undefined;
  if (!h || !k || !winHost(h)) {
    drawn = '';
    return void group.replaceChildren();
  }
  group.setAttribute('aria-label', `${h}'s windows`);
  // an app shown here already has its phosphorus window's button
  const list = barTasks(k.list, streamedOn(h));
  const sig = JSON.stringify([h, [...k.features], list.map((t) => [t.pid, t.started, label(t), titled(t).length])]);
  if (sig === drawn) return;
  drawn = sig;
  group.replaceChildren(...list.map((t) => button(h, t)));
}

function button(h: string, t: Task): HTMLButtonElement {
  const name = label(t);
  const n = titled(t).length;
  const b = Object.assign(el('button', 'dk-task dk-htask'), {
    type: 'button',
    title: `${name}: ${t.name} on ${h}${n > 1 ? `, ${n} windows` : ''}`,
  });
  b.append(dkGlyph(DK_GLYPHS[t.shell ? 'files' : 'app']!, 'dk-task-ic'), el('span', 'dk-task-t', name));
  b.addEventListener('click', () => void show(h, t));
  b.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    dkMenu(e.clientX, e.clientY, menu(h, t), undefined, name);
  });
  b.addEventListener('auxclick', (e) => {
    if (e.button === 1) void end(h, t, false);
  });
  return b;
}

function menu(h: string, t: Task): MenuItem[] {
  if (t.shell)
    return [
      ['files', () => hostFiles(h), true],
      null,
      ['end explorer…', () => void end(h, t, false), hostCan(h, 'processes')],
    ];
  return [
    [`show here`, () => void show(h, t), hostCan(h, 'attach')],
    null,
    ['close', () => void end(h, t, false), hostCan(h, 'processes')],
    ['end task', () => void end(h, t, true), hostCan(h, 'processes')],
  ];
}

// the task as the host has it now: the list read again first, so a pid that's gone or
// taken by another process is never acted on
async function fresh(h: string, t: Task): Promise<Task | undefined> {
  const k = await hostTasks(h);
  paint();
  if (!k) return void dkSay(`${h}: ${known.get(h)?.error ?? "its windows couldn't be read"}`);
  const now = k.list.find((x) => x.pid === t.pid && x.started === t.started);
  if (!now) dkSay(`${label(t)} has closed on ${h}`);
  return now;
}

// a press: the shell's windows are phosphorus's own files; any other app streamed here,
// taken up where it runs
async function show(h: string, t: Task) {
  if (t.shell) return void hostFiles(h);
  if (!hostCan(h, 'attach')) return dkSay(`${h}'s afterglow can't show a running app here yet: update afterglow`);
  const now = await fresh(h, t);
  if (now) streamWin(h, { pid: now.pid, started: now.started, name: label(now) });
}

// closed as its close button would, or killed; the shell only once the viewer says so
async function end(h: string, t: Task, kill: boolean) {
  const name = label(t);
  if (
    t.shell &&
    !confirm(`End explorer on ${h}? Its task bar, desktop and folder windows go until explorer is started again.`)
  )
    return;
  const now = await fresh(h, t);
  if (!now) return;
  const r = await acctCall<{ how?: string; gone?: boolean }>(api(h, 'end'), {
    pid: now.pid,
    started: now.started,
    kill,
    shell: now.shell,
    name: now.name,
  });
  if (!r.ok) return dkSay(`${name}: ${r.error || `${h} didn't end it`}`);
  if (!r.gone)
    dkSay(
      kill
        ? `${name} hasn't gone yet on ${h}`
        : `${name} is still open on ${h}: it may be asking to save. Its right click ends it`,
    );
  void tick();
}

// --- a desk icon's file to the bin -----------------------------------------------------------

// the file the icon is, a shortcut rather than what it names
export const deskFile = (it: Item) => it.file ?? it.path ?? '';

export async function recycleIcon(h: string, it: Item) {
  const path = deskFile(it);
  if (!path) return;
  const r = await acctCall<{ recycled?: boolean }>(api(h, 'recycle'), { path });
  if (!r.ok) return dkSay(`${it.name}: ${r.error || `${h} didn't delete it`}`);
  dkSay(r.recycled ? `${it.name} moved to ${h}'s Recycle Bin` : `${it.name} deleted on ${h}`);
  void hostLoad(h, () => {
    if (dk.space !== h) return;
    dkWallPaint();
    dkIcons();
  });
}

// --- kept fresh while its desktop is the one shown ---------------------------------------------

const everyMs = 4000;
const slowMs = 30_000;
let timer: ReturnType<typeof setTimeout> | undefined;
// the latest tick alone schedules the next
let gen = 0;

async function tick() {
  const my = ++gen;
  clearTimeout(timer);
  timer = undefined;
  const h = dk.space;
  if (!h || !dk.desk || !winHost(h) || document.hidden) return paint();
  await hostTasks(h);
  if (my !== gen) return;
  paint();
  const k = known.get(h);
  // a host that can't list them (no afterglow, someone else at its console) asked less often
  timer = setTimeout(() => void tick(), k?.error || !k?.features.has('processes') ? slowMs : everyMs);
}

onSpace(() => {
  paint();
  void tick();
});
onStreams(() => {
  paint();
  void tick();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !timer) void tick();
});
