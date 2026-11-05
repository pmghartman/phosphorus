// a Windows host's desktop from its probe's JSON, in the shape every OS shares

import { type Desk, type Item, type Kind, type Look, plainLook } from "./model.ts";
import { baseName } from "./paths.ts";

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

const edges = ["left", "top", "right", "bottom"] as const;

// the taskbar, clock and icons as the registry has them; win10's search box is mode 2
export function winLook(o: Record<string, any>, win11: boolean): Look {
  const l = plainLook();
  const n = (k: string, d: number) =>
    Number.isFinite(Number(o[k])) && o[k] !== null && o[k] !== "" ? Number(o[k]) : d;
  const size = n("iconSize", 48);
  l.iconSize = Math.max(16, Math.min(256, size));
  const t = s(o.time) || "h:mm tt";
  l.clock = { h24: /H/.test(t), seconds: n("seconds", 0) === 1, weekday: false };
  l.transparent = n("transparent", 1) !== 0;
  const mode = n("search", 1);
  l.search = mode === 0 ? "" : mode === 1 ? "icon" : "box";
  l.taskView = n("taskView", 1) !== 0;
  l.widgets = win11 && n("widgets", 1) !== 0;
  l.small = !win11 && n("small", 0) === 1;
  l.edge = edges[n("edge", 3)] ?? "bottom";
  if (win11 && (l.edge === "left" || l.edge === "right")) l.edge = "bottom";
  return l;
}

export function winDesk(o: Record<string, any>, psShell: boolean): Desk {
  const shell = o.sshShell ? s(o.sshShell) : "cmd";
  const ps = psShell || /powershell|pwsh/i.test(shell);
  const icons = (Array.isArray(o.icons) ? o.icons : []).map((x: any) => winItem(x, ps));
  if (o.bin !== false)
    icons.unshift({ name: "recycle bin", kind: "bin", icon: "b:", iv: o.binFull ? "full" : "empty" });
  const win11 = Number(o.build) >= 22000;
  return {
    os: "windows",
    shell: win11 ? "win11" : "win10",
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
    look: winLook(o, win11),
  };
}
