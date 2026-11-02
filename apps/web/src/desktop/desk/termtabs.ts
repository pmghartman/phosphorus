// the terminal window's tabs, as Windows Terminal's: each a shell on a host, in the order
// they're dragged to, labelled by the host and a counter once a host has several

export interface TermTab {
  id: number;
  host: string;
  // its number among the host's tabs, the lowest free when it opened
  n: number;
}

let ids = 0;

// a new tab at the end
export function tabAdd<T extends TermTab>(tabs: T[], host: string, extra: Omit<T, keyof TermTab>): T {
  const used = new Set(tabs.filter((t) => t.host === host).map((t) => t.n));
  let n = 1;
  while (used.has(n)) n++;
  const t = { ...extra, id: ++ids, host, n } as T;
  tabs.push(t);
  return t;
}

// the host alone, or with its counter while another tab shares it
export function tabLabel(tabs: TermTab[], t: TermTab): string {
  return tabs.some((o) => o !== t && o.host === t.host) ? `${t.host} (${t.n})` : t.host;
}

// moved from one place to another, the rest closing up
export function tabMove(tabs: TermTab[], from: number, to: number): void {
  if (from === to || from < 0 || from >= tabs.length) return;
  const [t] = tabs.splice(from, 1);
  tabs.splice(Math.max(0, Math.min(to, tabs.length)), 0, t!);
}

// a tab gone; the one shown next if it was the active one: its right neighbour, else its left
export function tabClose(tabs: TermTab[], id: number, active: number): number | null {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return active;
  tabs.splice(i, 1);
  if (id !== active) return active;
  return (tabs[i] ?? tabs[i - 1])?.id ?? null;
}

// ctrl+tab's next or ctrl+shift+tab's previous, round the ends
export function tabStep(tabs: TermTab[], active: number, back: boolean): number | null {
  if (!tabs.length) return null;
  const i = tabs.findIndex((t) => t.id === active);
  const n = tabs.length;
  return tabs[((((i < 0 ? 0 : i) + (back ? -1 : 1)) % n) + n) % n]!.id;
}

// where a new tab goes when none is named: the serving host, else the last used, else any
export function tabDefaultHost(live: string[], self: string, last: string): string {
  if (live.includes(self)) return self;
  if (live.includes(last)) return last;
  return live[0] ?? '';
}
