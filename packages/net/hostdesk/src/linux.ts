// a Linux host's desktop read from what its probe sends: desktop entries, gsettings
// values, KDE and XFCE config files, trashinfo; each parsed here, not in sh

import { type Desk, type Item, type Kind, plainLook, type Shell } from "./model.ts";
import type { Rec } from "./proto.ts";

// --- ini files: desktop entries, trashinfo, kdeglobals, appletsrc ------------------

export type Ini = Map<string, Map<string, string>>;

export function parseIni(text: string): Ini {
  const out: Ini = new Map();
  let cur: Map<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      const name = line.slice(1, -1);
      cur = out.get(name) ?? new Map();
      out.set(name, cur);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 1 || !cur) continue;
    const k = line.slice(0, eq).trim();
    if (!cur.has(k)) cur.set(k, line.slice(eq + 1).trim());
  }
  return out;
}

// an entry's value with its \s \n \t \\ escapes undone
export const unescape = (v: string) =>
  v.replace(/\\(.)/g, (_, c: string) => ({ s: " ", n: "\n", t: "\t", r: "\r", "\\": "\\" })[c] ?? c);

export type Entry = {
  name: string;
  exec: string;
  icon: string;
  type: string;
  terminal: boolean;
  hidden: boolean;
  url: string;
  categories: string[];
  only: string[];
  not: string[];
};

export function parseEntry(text: string): Entry | undefined {
  const e = parseIni(text).get("Desktop Entry");
  if (!e) return;
  const g = (k: string) => unescape(e.get(k) ?? "");
  const list = (k: string) => g(k).split(";").filter(Boolean);
  return {
    name: g("Name"),
    exec: g("Exec"),
    icon: g("Icon"),
    type: g("Type") || "Application",
    terminal: /^true$/i.test(g("Terminal")),
    hidden: /^true$/i.test(g("NoDisplay")) || /^true$/i.test(g("Hidden")),
    url: g("URL"),
    categories: list("Categories"),
    only: list("OnlyShowIn"),
    not: list("NotShowIn"),
  };
}

// the command an Exec key runs, its field codes dropped
export const stripExec = (exec: string) =>
  exec
    .replace(/%[fFuUdDnNickvm]/g, "")
    .replace(/%%/g, "%")
    .replace(/\s+/g, " ")
    .trim();

export const entryKind = (e: Entry): Kind => (e.type === "Link" ? "web" : e.terminal ? "cli" : "gui");

// a desktop entry's id: its path under applications/, slashes as dashes
export function desktopId(path: string, appsDir: string): string {
  const base = appsDir.replace(/\/+$/, "") + "/";
  const rel = path.startsWith(base) ? path.slice(base.length) : (path.split("/").pop() ?? path);
  return rel.replace(/\//g, "-");
}

const deNames: Record<string, string> = { gnome: "GNOME", kde: "KDE", xfce: "XFCE" };

// shown in this desktop's menus
export function shown(e: Entry, de: string): boolean {
  if (e.hidden || !e.name || (e.type !== "Application" && e.type !== "Link")) return false;
  const me = deNames[de] ?? "";
  if (e.only.length && !e.only.includes(me)) return false;
  return !(me && e.not.includes(me));
}

const groups: [string, string][] = [
  ["AudioVideo", "multimedia"],
  ["Audio", "multimedia"],
  ["Video", "multimedia"],
  ["Development", "development"],
  ["Education", "education"],
  ["Game", "games"],
  ["Graphics", "graphics"],
  ["Network", "internet"],
  ["Office", "office"],
  ["Science", "science"],
  ["Settings", "settings"],
  ["System", "system"],
  ["Utility", "accessories"],
];
export const groupOf = (cats: string[]) => groups.find(([c]) => cats.includes(c))?.[1] ?? "other";

// --- gsettings values ----------------------------------------------------------------

// a GVariant string, 'x' or "x", its escapes undone
export function gStr(v: string): string {
  const t = v.trim().replace(/^@\w+\s+/, "");
  const m = /^'((?:[^'\\]|\\.)*)'$|^"((?:[^"\\]|\\.)*)"$/.exec(t);
  if (!m) return t;
  return (m[1] ?? m[2] ?? "").replace(/\\(.)/g, "$1");
}

// a GVariant string array
export function gList(v: string): string[] {
  const t = v.trim().replace(/^@as\s+/, "");
  if (!t.startsWith("[")) return [];
  return [...t.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    (m[1] ?? m[2] ?? "").replace(/\\(.)/g, "$1"),
  );
}

export const gQuote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
export const gArray = (xs: string[]) => `[${xs.map(gQuote).join(", ")}]`;

// --- uris and percent encoding -------------------------------------------------------

export function uriPath(u: string): string {
  if (u.startsWith("/")) return u;
  if (!u.startsWith("file://")) return "";
  try {
    return decodeURIComponent(u.slice(7).replace(/^[^/]+/, ""));
  } catch {
    return "";
  }
}

// a path as a trashinfo or file uri holds it: unreserved and slashes kept
export const pctPath = (p: string) =>
  [...Buffer.from(p, "utf8")]
    .map((b) => {
      const c = String.fromCharCode(b);
      return /[A-Za-z0-9\-._~/]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");

export const fileUri = (p: string) => `file://${pctPath(p)}`;

// --- trash ---------------------------------------------------------------------------

export type TrashInfo = { path: string; deleted: number };

export function parseTrashInfo(text: string): TrashInfo | undefined {
  const s = parseIni(text).get("Trash Info");
  const raw = s?.get("Path");
  if (!raw) return;
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return;
  }
  if (!path.startsWith("/")) return;
  const d = Date.parse(s!.get("DeletionDate") ?? "");
  return { path, deleted: Number.isNaN(d) ? 0 : d };
}

// a DeletionDate in the host's local time, as the spec has it
export function trashDate(ms: number, offsetMin = new Date(ms).getTimezoneOffset()): string {
  const d = new Date(ms - offsetMin * 60000);
  return d.toISOString().slice(0, 19);
}

export const trashInfo = (path: string, ms: number) =>
  `[Trash Info]\nPath=${pctPath(path)}\nDeletionDate=${trashDate(ms)}\n`;

// --- xfconf xml ------------------------------------------------------------------------

// every property's full path and value, nested names joined by /
export function xfconf(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  const stack: string[] = [];
  for (const m of xml.matchAll(/<(\/?)property\b([^>]*?)(\/?)>/g)) {
    if (m[1]) {
      stack.pop();
      continue;
    }
    const attrs = m[2]!;
    const name = /\bname="([^"]*)"/.exec(attrs)?.[1] ?? "";
    const value = /\bvalue="([^"]*)"/.exec(attrs)?.[1];
    const path = [...stack, name].join("/");
    if (value !== undefined) out.set(`/${path}`, xmlText(value));
    if (!m[3]) stack.push(name);
  }
  return out;
}

const xmlText = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp|#\d+);/g, (_, e: string) =>
    e[0] === "#" ? String.fromCharCode(Number(e.slice(1))) : { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" }[e]!,
  );

// --- the desktop -----------------------------------------------------------------------

const gnomeAccents: Record<string, string> = {
  blue: "#3584e4",
  teal: "#2190a4",
  green: "#3a944a",
  yellow: "#c88800",
  orange: "#ed5b00",
  red: "#e62d42",
  pink: "#d56199",
  purple: "#9141ac",
  slate: "#6f8396",
};
export const gnomeAccentNames = Object.keys(gnomeAccents);

const fits: Record<string, string> = {
  zoom: "cover",
  spanned: "cover",
  scaled: "contain",
  stretched: "fill",
  centered: "center",
  wallpaper: "tile",
  none: "none",
};

// App one start menu entry with where it came from
export type App = Item & { id: string; entry: Entry };

// the apps listing: every shown entry, the first of each id kept
export function parseApps(recs: Rec[], de: string, theme: string): App[] {
  const seen = new Set<string>();
  const out: App[] = [];
  let dir = "";
  for (const r of recs) {
    if (r.kind === "dir") {
      dir = r.args[0] ?? "";
      continue;
    }
    if (r.kind !== "file") continue;
    const path = r.args[0] ?? "";
    const id = desktopId(path, dir);
    if (seen.has(id)) continue;
    seen.add(id);
    const e = parseEntry(r.body);
    if (!e || !shown(e, de)) continue;
    out.push(appItem(e, id, path, r.args[1] ?? "", theme));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function appItem(e: Entry, id: string, path: string, mtime: string, theme: string): App {
  const kind = entryKind(e);
  const it: App = {
    id,
    entry: e,
    name: e.name,
    kind,
    path,
    group: groupOf(e.categories),
    ...iconOf(e.icon, theme, mtime),
  };
  if (kind === "cli") it.run = stripExec(e.exec);
  if (kind === "web") it.url = e.url;
  return it;
}

// an icon spec: x:theme|names for a themed name, p:path for a file
export function iconOf(icon: string, theme: string, mtime = ""): { icon?: string; iv?: string } {
  if (!icon) return {};
  if (icon.startsWith("/")) return { icon: `p:${icon}`, iv: mtime };
  return { icon: `x:${theme}|${icon.replace(/\.(png|svg|xpm)$/, "")}`, iv: theme };
}

const fileIcons: [RegExp, string][] = [
  [/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i, "image-x-generic"],
  [/\.(mp4|mkv|webm|mov|avi|m4v)$/i, "video-x-generic"],
  [/\.(mp3|flac|ogg|wav|m4a|opus)$/i, "audio-x-generic"],
  [/\.pdf$/i, "application-pdf"],
  [/\.(zip|tar|gz|xz|bz2|7z|zst|rar)$/i, "package-x-generic"],
  [/\.(sh|py|js|ts|rb|pl)$/i, "text-x-script"],
];
export const fileIconNames = (name: string) => {
  const hit = fileIcons.find(([re]) => re.test(name));
  return hit ? [hit[1], "text-x-generic"] : ["text-x-generic"];
};

export type LinuxDesk = { desk: Desk; deskDir: string; pinIds: string[]; pinItems: Item[]; folders: string[] };

// the desktop record set built into the shape the page draws, apps for the pins
export function buildDesk(recs: Rec[], apps: App[]): LinuxDesk {
  const env = new Map<string, string>();
  const gs = new Map<string, string>();
  const files = new Map<string, Rec>();
  const lists = new Map<string, string[]>();
  const ents: Rec[] = [];
  let deskDir = "";
  for (const r of recs) {
    if (r.kind === "env")
      for (const l of r.body.split("\n")) {
        const eq = l.indexOf("=");
        if (eq > 0) env.set(l.slice(0, eq), l.slice(eq + 1));
      }
    else if (r.kind === "gs") gs.set(r.args[0] ?? "", r.body.trim());
    else if (r.kind === "file") files.set(r.args[0] ?? "", r);
    else if (r.kind === "deskdir") deskDir = r.args[0] ?? "";
    else if (r.kind === "ent") ents.push(r);
    else if (r.kind === "ls") lists.set(r.args[0] ?? "", r.body.split("\n").filter(Boolean));
  }
  const home = env.get("home") ?? "";
  const de = env.get("de") ?? "plain";
  const shell: Shell = de === "gnome" || de === "kde" || de === "xfce" ? de : "plain";
  const fileOf = (suffix: string) => [...files.entries()].find(([p]) => p.endsWith(suffix))?.[1];
  const desk: Desk = {
    os: "linux",
    shell,
    user: env.get("user") ?? "",
    home,
    wallpaper: { path: "", fit: "cover", color: "", iv: "" },
    dark: shell === "plain",
    accent: "",
    align: "center",
    icons: [],
    pins: [],
    binFull: env.get("binfull") === "1",
    can: { wallpaper: false, dark: false, accent: false, pins: false },
    accents: [],
    icontheme: "hicolor",
    look: plainLook(),
  };
  let pinIds: string[] = [];
  const pinItems: Item[] = [];
  const bus = env.get("bus") === "1";
  if (shell === "gnome") {
    const scheme = gStr(gs.get("org.gnome.desktop.interface color-scheme") ?? "");
    const gtk = gStr(gs.get("org.gnome.desktop.interface gtk-theme") ?? "");
    desk.dark = scheme === "prefer-dark" || /-dark$/i.test(gtk);
    const uri = gStr(gs.get(`org.gnome.desktop.background picture-uri${desk.dark ? "-dark" : ""}`) ?? "");
    desk.wallpaper.path = uriPath(uri) || uriPath(gStr(gs.get("org.gnome.desktop.background picture-uri") ?? ""));
    desk.wallpaper.fit = fits[gStr(gs.get("org.gnome.desktop.background picture-options") ?? "")] ?? "cover";
    desk.wallpaper.color = gStr(gs.get("org.gnome.desktop.background primary-color") ?? "");
    const acc = gStr(gs.get("org.gnome.desktop.interface accent-color") ?? "");
    desk.accent =
      gnomeAccents[acc] ?? (gs.has("org.gnome.desktop.interface accent-color") ? gnomeAccents.blue! : "#e95420");
    desk.icontheme = gStr(gs.get("org.gnome.desktop.interface icon-theme") ?? "") || "Adwaita";
    pinIds = gList(gs.get("org.gnome.shell favorite-apps") ?? "");
    const on = gList(gs.get("org.gnome.shell enabled-extensions") ?? "");
    const off = gList(gs.get("org.gnome.shell disabled-extensions") ?? "");
    const ext = (id: string) => on.includes(id) && !off.includes(id);
    desk.dock = ext("ubuntu-dock@ubuntu.com") || ext("dash-to-dock@micxgx.gmail.com") ? "left" : "";
    desk.ding = ext("ding@rastersoft.com") || ext("gtk4-ding@smedius.gitlab.com");
    desk.can = {
      wallpaper: bus,
      dark: bus,
      accent: bus && gs.has("org.gnome.desktop.interface accent-color"),
      pins: bus,
    };
    if (desk.can.accent) desk.accents = gnomeAccentNames;
    const gb = (k: string) => gs.get(k) === "true";
    desk.look.clock = {
      h24: gStr(gs.get("org.gnome.desktop.interface clock-format") ?? "") !== "12h",
      seconds: gb("org.gnome.desktop.interface clock-show-seconds"),
      weekday: gb("org.gnome.desktop.interface clock-show-weekday"),
    };
    desk.look.iconSize =
      { tiny: 36, small: 48, standard: 64, large: 96 }[
        gStr(gs.get("org.gnome.shell.extensions.ding icon-size") ?? "")
      ] ?? 64;
  } else if (shell === "kde") {
    const g = parseIni(fileOf("/kdeglobals")?.body ?? "");
    const scheme = g.get("General")?.get("ColorScheme") ?? "BreezeLight";
    desk.dark = /dark/i.test(scheme);
    desk.accent = rgbHex(g.get("General")?.get("AccentColor") ?? "") || "#3daee9";
    desk.icontheme = g.get("Icons")?.get("Theme") ?? "breeze";
    const a = kdeApplets(fileOf("plasma-org.kde.plasma.desktop-appletsrc")?.body ?? "");
    desk.wallpaper.path =
      kdeImage(a.image, lists, desk.dark) || kdeImage("/usr/share/wallpapers/Next", lists, desk.dark);
    pinIds = a.launchers;
    desk.can = { wallpaper: bus, dark: bus, accent: bus, pins: bus };
  } else if (shell === "xfce") {
    const d = xfconf(fileOf("/xfce4-desktop.xml")?.body ?? "");
    const x = xfconf(fileOf("/xsettings.xml")?.body ?? "");
    desk.wallpaper.path = [...d.entries()].find(([k]) => k.endsWith("/last-image"))?.[1] ?? "";
    const style = [...d.entries()].find(([k]) => k.endsWith("/image-style"))?.[1] ?? "5";
    desk.wallpaper.fit =
      { "0": "none", "1": "center", "2": "tile", "3": "fill", "4": "contain", "5": "cover" }[style] ?? "cover";
    const theme = x.get("/Net/ThemeName") ?? "";
    desk.dark = /dark/i.test(theme);
    desk.accent = "#2d7fd1";
    desk.icontheme = x.get("/Net/IconThemeName") || "elementary";
    for (const [p, r] of files)
      if (/\/xfce4\/panel\/launcher-\d+\/[^/]+\.desktop$/.test(p)) {
        const e = parseEntry(r.body);
        if (e) pinItems.push(appItem(e, p.split("/").pop()!, p, r.args[1] ?? "", desk.icontheme));
      }
    pinItems.sort((a, b) => launcherN(a.path!) - launcherN(b.path!));
    desk.can = { wallpaper: bus, dark: bus, accent: false, pins: false };
  } else {
    pinItems.push({ name: "terminal", kind: "cli", run: "", icon: "x:hicolor|utilities-terminal", iv: "hicolor" });
  }
  // themed names now the theme is known
  const theme = desk.icontheme ?? "hicolor";
  const byId = new Map(apps.map((a) => [a.id, a]));
  for (const id of pinIds) {
    const a = byId.get(id);
    if (a) pinItems.push(a);
  }
  desk.pins = pinItems.map(({ entry: _e, ...it }: Item & { entry?: Entry }) => it);
  const folders: string[] = [];
  const showIcons = shell !== "gnome" || desk.ding;
  if (showIcons)
    for (const r of ents) {
      const [path = "", t = "f", mtime = ""] = r.args;
      const name = path.split("/").pop() ?? path;
      const desktopFile = files.get(path);
      if (name.endsWith(".desktop") && desktopFile) {
        const e = parseEntry(desktopFile.body);
        if (e) {
          const { entry: _e, ...it } = appItem(e, name, path, mtime, theme);
          desk.icons.push(it);
          continue;
        }
      }
      if (t === "d") {
        folders.push(path);
        desk.icons.push({ name, kind: "folder", path, icon: `x:${theme}|folder`, iv: theme });
      } else
        desk.icons.push({ name, kind: "file", path, icon: `x:${theme}|${fileIconNames(name).join(",")}`, iv: theme });
    }
  desk.icons.sort((a, b) => Number(b.kind === "folder") - Number(a.kind === "folder") || a.name.localeCompare(b.name));
  desk.icons.unshift({
    name: "trash",
    kind: "bin",
    icon: `x:${theme}|${desk.binFull ? "user-trash-full," : ""}user-trash`,
    iv: `${theme}${desk.binFull ? "+" : ""}`,
  });
  return { desk, deskDir, pinIds, pinItems, folders };
}

const launcherN = (p: string) => Number(/launcher-(\d+)/.exec(p)?.[1] ?? 0);

export function rgbHex(v: string): string {
  const m = /^(\d{1,3}),(\d{1,3}),(\d{1,3})/.exec(v.trim());
  if (!m) return "";
  return `#${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("")}`;
}

// a plasma wallpaper package's picture: its biggest, the dark set when dark
export function kdeImage(image: string, lists: Map<string, string[]>, dark: boolean): string {
  const p = uriPath(image) || image;
  if (!p) return "";
  if (/\.(png|jpe?g|webp|svg|avif)$/i.test(p)) return p;
  const set = (dark && lists.get(`${p}/contents/images_dark`)) || lists.get(`${p}/contents/images`);
  if (!set?.length) return "";
  const area = (n: string) => {
    const m = /(\d+)x(\d+)/.exec(n);
    return m ? Number(m[1]) * Number(m[2]) : 0;
  };
  const best = [...set].sort((a, b) => area(b) - area(a))[0]!;
  return `${p}/contents/${dark && lists.get(`${p}/contents/images_dark`) ? "images_dark" : "images"}/${best}`;
}

export type KdeApplets = { image: string; launchers: string[]; desktops: string[]; tasks: string[] };

// the desktop's wallpaper image and the task manager's launchers out of appletsrc
export function kdeApplets(text: string): KdeApplets {
  const ini = parseIni(text);
  const out: KdeApplets = { image: "", launchers: [], desktops: [], tasks: [] };
  for (const [sec, kv] of ini) {
    const c = /^Containments\]\[(\d+)$/.exec(sec);
    if (
      c &&
      (kv.get("wallpaperplugin") ?? "org.kde.image") === "org.kde.image" &&
      /folder|desktop/.test(kv.get("plugin") ?? "")
    )
      out.desktops.push(c[1]!);
    const a = /^Containments\]\[(\d+)\]\[Applets\]\[(\d+)$/.exec(sec);
    if (a && /taskmanager|icontasks/.test(kv.get("plugin") ?? "")) out.tasks.push(`${a[1]}/${a[2]}`);
  }
  for (const d of out.desktops) {
    const img = ini.get(`Containments][${d}][Wallpaper][org.kde.image][General`)?.get("Image");
    if (img) {
      out.image = img;
      break;
    }
  }
  for (const t of out.tasks) {
    const [c, a] = t.split("/");
    const l = ini.get(`Containments][${c}][Applets][${a}][Configuration][General`)?.get("launchers");
    if (l) {
      out.launchers = l
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x.startsWith("applications:"))
        .map((x) => x.slice("applications:".length));
      break;
    }
  }
  return out;
}

// the plasma script setting the wallpaper or the task manager's launchers
export function kdeScript(c: { wallpaper?: string; pins?: string[] }): string {
  const parts: string[] = [];
  if (c.wallpaper !== undefined)
    parts.push(
      `desktops().forEach(function(d){d.wallpaperPlugin='org.kde.image';d.currentConfigGroup=['Wallpaper','org.kde.image','General'];d.writeConfig('Image',${JSON.stringify(fileUri(c.wallpaper))});});`,
    );
  if (c.pins)
    parts.push(
      `panels().forEach(function(p){p.widgets().forEach(function(w){if(/taskmanager|icontasks/.test(w.type)){w.currentConfigGroup=['General'];w.writeConfig('launchers',${JSON.stringify(c.pins.map((id) => `applications:${id}`).join(","))});}});});`,
    );
  return parts.join("");
}
