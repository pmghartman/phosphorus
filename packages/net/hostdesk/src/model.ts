// what a host's desktop is drawn from, the same shape for every OS

// file: the viewer; folder: a folder window; cli: a terminal tab; web: a window;
// gui: listed, not run; bin: the recycle bin
export type Kind = "file" | "folder" | "cli" | "web" | "gui" | "bin";

export type Item = {
  name: string;
  kind: Kind;
  // where it is on the host, its .lnk or .desktop for a launcher
  path?: string;
  // an icon spec the probe issued, and its version
  icon?: string;
  iv?: string;
  // what a cli item types, a web item's address
  run?: string;
  url?: string;
  // a start menu folder, an app's desktop id
  group?: string;
  id?: string;
};

export type Shell = "win11" | "win10" | "gnome" | "kde" | "xfce" | "plain";

export type Desk = {
  os: "windows" | "linux";
  shell: Shell;
  user: string;
  home: string;
  // the picture's path on the host, its fit, a plain colour under it
  wallpaper: { path: string; fit: string; color: string; iv: string };
  dark: boolean;
  accent: string;
  // win11's taskbar centred or left
  align: "center" | "left";
  icons: Item[];
  pins: Item[];
  binFull: boolean;
  // what each setting change can reach here
  can: { wallpaper: boolean; dark: boolean; accent: boolean; pins: boolean };
  // the gnome accent names, or "" for any colour
  accents: string[];
  // a Windows host's OpenSSH shell, powershell or cmd
  sshShell?: string;
  icontheme?: string;
  // gnome: its dock's side when one is on, and whether DING draws icons
  dock?: string;
  ding?: boolean;
  look: Look;
};

// Look how the host draws its own chrome, as near as its settings say
export type Look = {
  // desk icons in px
  iconSize: number;
  clock: { h24: boolean; seconds: boolean; weekday: boolean };
  transparent: boolean;
  // windows' taskbar: its search, task view and widgets buttons, small icons, its edge
  search: "" | "icon" | "box";
  taskView: boolean;
  widgets: boolean;
  small: boolean;
  edge: "bottom" | "top" | "left" | "right";
};

export const plainLook = (): Look => ({
  iconSize: 48,
  clock: { h24: false, seconds: false, weekday: false },
  transparent: true,
  search: "",
  taskView: false,
  widgets: false,
  small: false,
  edge: "bottom",
});

export type BinItem = { id: string; name: string; from: string; deleted: number; size: number; dir: boolean };

export type Entry = { name: string; path: string; dir: boolean; size: number; mtime: number };

// Change a settings change asked for: any of these
export type Change = { wallpaper?: string; dark?: boolean; accent?: string; pins?: string[] };
