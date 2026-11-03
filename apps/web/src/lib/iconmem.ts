// which of an icon's sources loaded last, kept per browser: a redraw or a reload
// straight to it, no blank tile or failed tries before it

const KEY = 'phosphorus-icons';
const MAX = 400;

// by the sources joined: the one that loaded, '' when none did
let mem: Map<string, string> | null = null;
let saving: ReturnType<typeof setTimeout> | null = null;

function load(): Map<string, string> {
  if (mem) return mem;
  mem = new Map();
  try {
    const v = JSON.parse(localStorage.getItem(KEY)!);
    if (v && typeof v === 'object' && !Array.isArray(v))
      for (const [k, s] of Object.entries(v)) if (typeof s === 'string') mem.set(k, s);
  } catch {}
  return mem;
}

function save() {
  saving ??= setTimeout(() => {
    saving = null;
    const m = load();
    // the oldest learnt dropped first
    for (const k of m.keys()) {
      if (m.size <= MAX) break;
      m.delete(k);
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(m)));
    } catch {}
  }, 500);
}

// the source that loaded last time, '' when none did, undefined when never tried
export function iconKnown(srcs: string[]): string | undefined {
  const s = load().get(srcs.join('\n'));
  return s === '' || (s && srcs.includes(s)) ? s : undefined;
}

export function iconLearn(srcs: string[], won: string): void {
  const m = load();
  const k = srcs.join('\n');
  if (m.get(k) === won) return;
  m.delete(k);
  m.set(k, won);
  save();
}

// the sources with the one known to load first
export function iconOrder(srcs: string[]): string[] {
  const known = iconKnown(srcs);
  return known ? [known, ...srcs.filter((s) => s !== known)] : srcs;
}
