// the page's state shared across its modules: what /api/state last said, the account, the
// chat's name and socket, and the desktop's own. Each was a module-level let of app.js read by
// several sections; here one object, read where it was read and set where it was set
import type { FileEntry, GitHost, HostInfo, Route, State, Vault } from './types.ts';
import type { Fm, HomeHostList, Loc, PickedItem } from './shares.ts';
import type { DkWin } from './desktop/windows.ts';
import type { LoginRow } from './desktop/login.ts';

// the account: a phosphorus user over the hosts' own logins, its vault of host and page
// logins kept on the mesh, sealed with its password
export interface Account { user: string; admin: boolean; boot: boolean; wallpaper: number; vault: Vault; vaultOK: boolean }

export const st = {
  // everything from /api/state, pushed, see connectState in sync.ts
  selfHost: '',
  // BASE_DOMAIN from /api/state, the page's own host until the first answer
  baseDomain: location.hostname,
  // the mesh's own domain, '' on the tailnet alone
  meshDomain: '',
  // hosts whose frontend answers, each one terminal tab
  terminalHosts: [] as string[],
  // the git service, and every git host's role and lag
  gitRoute: null as Route | null,
  gitHostsList: [] as GitHost[],
  // each host's own info.json off sys, offline ones too
  hostsInfo: {} as Record<string, HostInfo>,
  // the newest /api/state, handed to an app as it loads
  lastState: null as State | null,
  // unread lines, for the chat icon's and task's badges
  deskNews: 0,
  acct: null as Account | null,
  // the chat's own name and colour, kept per browser; ws its socket
  name: localStorage.getItem('phosphorus-chat-name') || '',
  color: localStorage.getItem('phosphorus-chat-color') || '',
  ws: null as WebSocket | null,
};

// the desktop's apps up and not minimized, for each view's own watchers
export const deskApps = new Set<string>();

// the page's own settings in localStorage, mirrored to the user's home (account.ts); here
// because the agent's view key is read as its module loads
export const PREF_LS: Record<string, string> = { icons: 'phosphorus-dk-icons', theme: 'phosphorus-theme', palette: 'phosphorus-palette', custom: 'phosphorus-theme-custom', recent: 'phosphorus-recent-files', color: 'phosphorus-chat-color', agentview: 'phosphorus-agent-view', editor: 'phosphorus-editor' };
export const PREF_OF: Record<string, string> = Object.fromEntries(Object.entries(PREF_LS).map(([k, v]) => [v, k]));

// the desk once up: its layers, bar and status items
export interface Desk {
  el: HTMLElement;
  icons: HTMLElement;
  wins: HTMLElement;
  tasks: HTMLElement;
  hosts: HTMLElement;
  bar: HTMLElement;
  menubar: HTMLElement;
  app: HTMLElement;
  items: Record<string, HTMLElement | null>;
}
// a files window's picks on their way: dragged, or cut or copied
export interface FmDrag { fm: Fm; loc: Loc; items: PickedItem[] }
export interface FmClip { op: 'cut' | 'copy'; loc: Loc; items: PickedItem[] }

// the desktop's state, up here because code run at load (the chat's first
// setConv) asks dk.desk long before the desktop section below
// creds: host -> {user, pass}, this page's memory only
export interface Dk {
  creds: Map<string, { user: string; pass: string }>;
  rows: Map<string, LoginRow>;
  wins: Map<string, DkWin>;
  services: Route[];
  deskFiles: FileEntry[];
  deskHosts: Map<string, { stamp: string; got: HomeHostList }>;
  z: number;
  n: number;
  desk: Desk | null;
  sig: string;
  // the icons picked
  sel: Set<string>;
  clock?: HTMLElement;
  login?: { list: HTMLElement; go: HTMLButtonElement } | null;
  bell?: { show: (on: boolean) => void; paint: () => void };
  ctl?: { show: (on: boolean) => void; btn: HTMLButtonElement; wrap: HTMLElement; draw: () => void };
  meshTray?: { show: (on: boolean) => void };
  mcp?: { show: (on: boolean) => void; paint: () => void } | null;
  mcpStop?: () => void;
  chips?: string;
  chipFold?: HTMLButtonElement;
  chipN?: number;
  deskKey?: string;
  deskReady?: boolean;
  deskStamp?: string;
  drag?: FmDrag | null;
  clip?: FmClip | null;
}
export const dk: Dk = { creds: new Map(), rows: new Map(), wins: new Map(), services: [], deskFiles: [], deskHosts: new Map(), z: 10, n: 0, desk: null, sig: '', sel: new Set() };
