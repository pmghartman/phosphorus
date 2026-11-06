// the page's state shared across its modules: what /api/state last said, the account
// and the desktop's own. Each was a module-level let of app.js read by
// several sections; here one object, read where it was read and set where it was set
import type { FileEntry, HostInfo, Route, State, Vault } from '@phosphorus/wire';
import type { DkWin } from '../desktop/windows.ts';
import type { FmView, Loc, PickedItem } from '../features/home/home.ts';

// the account: a phosphorus user over the hosts' own logins, its vault of host and page
// logins kept on the mesh, sealed with its password
export interface Account {
  user: string;
  admin: boolean;
  wallpaper: number;
  vault: Vault;
  vaultOK: boolean;
}

export const st = {
  // everything from /api/state, pushed, see connectState in sync.ts
  selfHost: '',
  // BASE_DOMAIN from /api/state, the page's own host until the first answer
  baseDomain: location.hostname,
  // the mesh's own domain, '' on the tailnet alone
  meshDomain: '',
  // hosts whose frontend answers, each one terminal tab
  terminalHosts: [] as string[],
  // each host's own info.json off sys, offline ones too
  hostsInfo: {} as Record<string, HostInfo>,
  // the newest /api/state, handed to an app as it loads
  lastState: null as State | null,
  acct: null as Account | null,
};

// the desktop's apps up and not minimized, for each view's own watchers
export const deskApps = new Set<string>();

// the page's own settings in localStorage, mirrored to the user's home (account.ts); here
// because the agent's view key is read as its module loads
export const PREF_LS: Record<string, string> = {
  icons: 'phosphorus-dk-icons',
  theme: 'phosphorus-theme',
  color: 'phosphorus-chat-color',
  agentview: 'phosphorus-agent-view',
  svctab: 'phosphorus-services-in-tabs',
  shared: 'phosphorus-shared-apps',
  spaceicons: 'phosphorus-space-icons',
  spacewalls: 'phosphorus-space-walls',
};
export const PREF_OF: Record<string, string> = Object.fromEntries(Object.entries(PREF_LS).map(([k, v]) => [v, k]));

// the desk once up: its layers and bar
export interface Desk {
  el: HTMLElement;
  icons: HTMLElement;
  wins: HTMLElement;
  tasks: HTMLElement;
  hosts: HTMLElement;
  bar: HTMLElement;
}
// a files window's picks on their way: dragged, or cut or copied
export interface FmDrag {
  v: FmView;
  loc: Loc;
  items: PickedItem[];
}
export interface FmClip {
  op: 'cut' | 'copy';
  loc: Loc;
  items: PickedItem[];
}

// the desktop's state, up here for code run at load, before the desktop section below
// creds: host -> {user, pass}, this page's memory only
export interface Dk {
  creds: Map<string, { user: string; pass: string }>;
  // the desktop shown: '' the shared one, else a logged in host's
  space: string;
  wins: Map<string, DkWin>;
  services: Route[];
  deskFiles: FileEntry[];
  z: number;
  n: number;
  desk: Desk | null;
  sig: string;
  // the icons picked
  sel: Set<string>;
  clock?: HTMLElement;
  bell?: { show: (on: boolean) => void; paint: () => void };
  ctl?: { show: (on: boolean) => void; btn: HTMLButtonElement; wrap: HTMLElement; draw: () => void };
  mcp?: { show: (on: boolean) => void; paint: () => void } | null;
  mcpStop?: () => void;
  chips?: string;
  deskKey?: string;
  deskReady?: boolean;
  // the home's digest last seen in the state
  homeSeen?: string;
  drag?: FmDrag | null;
  clip?: FmClip | null;
}
export const dk: Dk = {
  creds: new Map(),
  space: '',
  wins: new Map(),
  services: [],
  deskFiles: [],
  z: 10,
  n: 0,
  desk: null,
  sig: '',
  sel: new Set(),
};
