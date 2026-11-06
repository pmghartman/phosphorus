// a Windows host's windows as its task bar shows them, from the server's task list: what
// gets a button and what it's called, apart from the DOM (hosttasks.ts draws them)

import type { Item } from './hosts.ts';

// one process with windows up, as the server lists it
export type Task = {
  pid: number;
  started: number;
  name: string;
  exe: string;
  windows: [number, string][];
  // the desktop shell (explorer): ended only when the viewer says so, never streamed
  shell: boolean;
};

// its windows' titles worth a button: the shell's desktop itself never one
export const titled = (t: Task) => t.windows.filter(([, s]) => s.trim() && !(t.shell && s === 'Program Manager'));

export const label = (t: Task) => (t.shell ? 'File Explorer' : titled(t)[0]?.[1] || t.name.replace(/\.exe$/i, ''));

// the tasks that get a button: a titled window up, not already shown here in a stream window
export const barTasks = (list: Task[], on: { pids: Set<number>; wids: Set<number> }) =>
  list.filter((t) => titled(t).length && !on.pids.has(t.pid) && !t.windows.some(([id]) => on.wids.has(id)));

const stem = (p = '') => (p.split(/[\\/]/).pop() ?? '').replace(/\.(lnk|exe|desktop)$/i, '').toLowerCase();

// the host's app a window belongs to, for its icon: the one whose launcher or name is its
// program's, else the one named at the end of a title, as documents are titled
export function appOf(t: Task, apps: Item[]): Item | undefined {
  const exe = stem(t.name) || stem(t.exe);
  const gui = apps.filter((a) => a.kind === 'gui');
  const byExe = exe && gui.find((a) => stem(a.path) === exe || a.name.toLowerCase() === exe);
  if (byExe) return byExe;
  const titles = titled(t).map(([, s]) => s.toLowerCase());
  return gui.find((a) => {
    const n = a.name.toLowerCase();
    return n.length > 2 && titles.some((s) => s === n || s.endsWith(` ${n}`) || s.endsWith(`-${n}`));
  });
}
