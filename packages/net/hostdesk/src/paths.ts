// paths on the host: normalized the OS's way, kept to the login's profile or
// what the probe itself listed

// a path made absolute and clean, undefined when it isn't one
export function norm(p: string, win: boolean): string | undefined {
  if (!p || p.includes("\0")) return;
  if (win) {
    const s = p.replace(/\//g, "\\");
    const m = /^([A-Za-z]):\\(.*)$/.exec(s);
    if (!m) return;
    const parts = clean(m[2]!.split("\\"));
    if (!parts) return;
    return `${m[1]!.toUpperCase()}:\\${parts.join("\\")}`;
  }
  if (!p.startsWith("/")) return;
  const parts = clean(p.split("/"));
  if (!parts) return;
  return `/${parts.join("/")}`;
}

function clean(segs: string[]): string[] | undefined {
  const out: string[] = [];
  for (const s of segs) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (!out.length) return;
      out.pop();
    } else out.push(s);
  }
  return out;
}

const key = (p: string, win: boolean) => (win ? p.toLowerCase() : p);

// whether p is root or inside it
export function within(p: string, root: string, win: boolean): boolean {
  const a = key(p, win);
  const r = key(root, win).replace(/[\\/]+$/, "");
  const sep = win ? "\\" : "/";
  return a === r || a.startsWith(r + sep);
}

// Scope what one login may reach: its profile, paths and folders the probe issued
export class Scope {
  private exact = new Set<string>();
  private dirs = new Set<string>();
  constructor(
    public home: string,
    public win: boolean,
  ) {}

  issue(p: string | undefined, folder = false) {
    const n = p && norm(p, this.win);
    if (!n) return;
    this.exact.add(key(n, this.win));
    if (folder) this.dirs.add(n);
  }

  // the clean path when allowed, else undefined
  allow(p: string): string | undefined {
    const n = norm(p, this.win);
    if (!n) return;
    if (this.home && within(n, this.home, this.win)) return n;
    if (this.exact.has(key(n, this.win))) return n;
    for (const d of this.dirs) if (within(n, d, this.win)) return n;
  }

  list() {
    return { exact: [...this.exact], dirs: [...this.dirs] };
  }

  load(l: { exact?: unknown; dirs?: unknown }) {
    for (const x of Array.isArray(l.exact) ? l.exact : []) if (typeof x === "string") this.exact.add(x);
    for (const x of Array.isArray(l.dirs) ? l.dirs : []) if (typeof x === "string") this.dirs.add(x);
  }
}

// a Windows path as OpenSSH's sftp names it: /C:/Users/x
export const sftpPath = (p: string, win: boolean) => (win ? `/${p.replace(/\\/g, "/")}` : p);

export const baseName = (p: string) =>
  p
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || p;

export const parentOf = (p: string, win: boolean) => {
  const i = Math.max(p.lastIndexOf("/"), win ? p.lastIndexOf("\\") : -1);
  if (i <= 0) return win ? p.slice(0, 3) : "/";
  return win && i === 2 ? p.slice(0, 3) : p.slice(0, i);
};
