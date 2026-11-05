// a Windows host's windows as its task bar shows them, from the server's task list: what
// gets a button and what it's called, apart from the DOM (hosttasks.ts draws them)

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
