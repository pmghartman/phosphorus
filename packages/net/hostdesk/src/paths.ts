// paths on the host: normalized the OS's way, anywhere the login itself may reach

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
