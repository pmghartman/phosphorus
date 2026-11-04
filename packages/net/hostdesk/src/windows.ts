// a Windows host's desktop from its probe's JSON, in the shape every OS shares

import type { BinItem, Desk, Item, Kind } from "./model.ts";
import { baseName } from "./paths.ts";
import { parseInfo } from "./recycle.ts";

const kinds = new Set<Kind>(["file", "folder", "cli", "web", "gui", "bin"]);
const s = (v: unknown) => (typeof v === "string" ? v : "");

// one item as the probe described it, what it runs worked out for the terminal
export function winItem(o: Record<string, any>, psShell: boolean): Item {
  const kind: Kind = kinds.has(o.kind) ? o.kind : "file";
  const it: Item = { name: s(o.name) || baseName(s(o.path)), kind };
  if (s(o.path)) it.path = s(o.path);
  if (s(o.icon)) it.icon = s(o.icon);
  if (s(o.iv)) it.iv = s(o.iv);
  if (s(o.group)) it.group = s(o.group);
  if (s(o.id)) it.id = s(o.id);
  if (kind === "web") it.url = s(o.url);
  if (kind === "cli") it.run = winRun(s(o.target) || s(o.path), s(o.args), psShell);
  if (kind === "file" && s(o.target)) it.path = s(o.target);
  return it;
}

// a console program as the shell types it: shells by name, the rest by path
export function winRun(target: string, args: string, psShell: boolean): string {
  const exe = baseName(target).toLowerCase();
  const tail = args ? ` ${args}` : "";
  if (/^(powershell|pwsh|cmd)(\.exe)?$/.test(exe)) return exe.replace(/\.exe$/, "") + tail;
  if (psShell) return `& '${target.replace(/'/g, "''")}'${tail}`;
  return `"${target}"${tail}`;
}

// accent dwords are 0xAABBGGRR
export function abgrHex(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "";
  const n = v >>> 0;
  return `#${[n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

const rgb = (v: string) => {
  const m = /^(\d+)\s+(\d+)\s+(\d+)$/.exec(v.trim());
  return m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : "";
};

// WallpaperStyle: 0 centre or tile, 2 stretch, 6 fit, 10 fill, 22 span
const fit = (style: string, tile: string) =>
  tile === "1"
    ? "tile"
    : ({ "0": "center", "2": "fill", "6": "contain", "10": "cover", "22": "cover" }[style] ?? "cover");

export function winDesk(o: Record<string, any>, psShell: boolean): Desk {
  const shell = o.sshShell ? s(o.sshShell) : "cmd";
  const ps = psShell || /powershell|pwsh/i.test(shell);
  const icons = (Array.isArray(o.icons) ? o.icons : []).map((x: any) => winItem(x, ps));
  if (o.bin !== false)
    icons.unshift({ name: "recycle bin", kind: "bin", icon: "b:", iv: o.binFull ? "full" : "empty" });
  return {
    os: "windows",
    shell: Number(o.build) >= 22000 ? "win11" : "win10",
    user: s(o.user),
    home: s(o.home),
    wallpaper: { path: s(o.wallpaper), fit: fit(s(o.style), s(o.tile)), color: rgb(s(o.bg)), iv: s(o.wpv) },
    dark: Number(o.appsLight) === 0 || Number(o.light) === 0,
    accent: abgrHex(o.accent) || "#0078d4",
    align: Number(o.align) === 0 ? "left" : "center",
    icons,
    pins: (Array.isArray(o.pins) ? o.pins : []).map((x: any) => winItem(x, ps)),
    binFull: o.binFull === true,
    can: { wallpaper: true, dark: true, accent: true, pins: false },
    accents: [],
    sshShell: ps ? "powershell" : "cmd",
  };
}

// the recycle bin's rows, each $I file read
export function winTrash(rows: unknown): BinItem[] {
  const out: BinItem[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const bin = s(r?.bin);
    const i = s(r?.i);
    const info = parseInfo(Buffer.from(s(r?.data), "base64"));
    if (!bin || !i || !info) continue;
    out.push({
      id: `${bin}|${i}`,
      name: baseName(info.path),
      from: info.path,
      deleted: info.deleted,
      size: info.size,
      dir: r.dir === true,
    });
  }
  return out.sort((a, b) => b.deleted - a.deleted);
}
