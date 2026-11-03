// apps: a store for the mesh's optional extras, each a web build installed onto every host,

import type { AppStatus, AppWant, Route, State } from '@phosphorus/wire';
import { dkOpenApp } from '../../desktop/desk.ts';
import { jsonPost } from '../../lib/api.ts';
import { pollState } from '../../lib/sync.ts';
import { loadPage, readCatalog } from './catalog.ts';
import { draw } from './draw.ts';

// or a service run on the hosts a person picks --
// the front a grid of tiles, one open at a time as its own page: what it is, what's known of
// its release, every host's copy and its options. The catalogue and the feeds from /api/apps,
// each host's copy from the state push; an admin's get, update or remove one POST, every
// host following on its own. A service is a git checkout per host, run there as the person's
// own login: anyone logged into a host on the desktop installs, updates or removes it there

export const view = document.getElementById('view-apps')!;

// one app as /api/apps lists it
export interface StoreApp {
  id: string;
  name: string;
  tagline: string;
  about: string;
  features: string[];
  category: string;
  by: string;
  repo: string;
  mount: string;
  icon: string;
  // off the repository, until a host serves the app's own
  repoIcon: string;
  agents: string[];
  want: AppWant | null;
  latest: string;
  feedError: string;
  checkedAt: number;
  local: AppStatus;
  signed: boolean;
}

export let apps: StoreApp[] | null = null;
export let readError = '';

// the module's variables other modules set
export const stateVars = {
  busyId: '',
  sig: '',
  actError: '',
  // the page open, '' for the front: an app's or service's id, stack:<source>/<ref> for
  // an installable app, sources for the catalogues and their licences
  openId: '',
  // the front's search, over names, taglines and categories
  filter: '',
  // the services tab's source and category picked, '' for all
  source: '',
  category: '',
  // every match shown, not the first few dozen
  all: false,
  // the front's tab: self-hosted services, apps for the desktop, or what the mesh runs
  tab: 'services' as 'services' | 'apps' | 'running',
};
// a service's log shown in full, by host
export const logsOpen = new Set<string>();
export let watching = false;
export let timer: ReturnType<typeof setInterval> | null = null;
export let fast: ReturnType<typeof setTimeout> | null = null;

// the feed read on opening, held ten minutes on the server; fresh on the refresh button
export async function read(fresh = false) {
  try {
    const r = await fetch(`/api/apps${fresh ? '?fresh=1' : ''}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const got = await r.json();
    apps = got.apps as StoreApp[];
    readError = '';
  } catch (e) {
    readError = (e as Error).message;
  }
  stateVars.sig = '';
  draw();
}

export function storeState(_state: State | null): void {
  draw();
}

export function storeWatch(on: boolean): void {
  watching = on;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (fast) {
    clearTimeout(fast);
    fast = null;
  }
  if (!on) return;
  read();
  readCatalog();
  timer = setInterval(() => read(), 60000);
}

// an app's or service's page shown, the window opened for it when needed
export function storeShow(id: string): void {
  stateVars.openId = id;
  // the way back lands on the tab the page belongs to, or on running when opened from there
  const keep = stateVars.tab === 'running' && !!id && id !== 'sources';
  if (!keep && (id.startsWith('stack:') || id === 'sources')) stateVars.tab = 'services';
  if (id.startsWith('stack:')) loadPage(id.slice(6));
  else if (!keep && apps?.some((a) => a.id === id)) stateVars.tab = 'apps';
  stateVars.sig = '';
  if (!watching) dkOpenApp('apps');
  draw();
}

export async function act(path: string, id: string) {
  stateVars.busyId = id;
  stateVars.sig = '';
  draw();
  try {
    const r = await fetch(path, jsonPost({ id }));
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `status ${r.status}`);
    stateVars.actError = '';
  } catch (e) {
    stateVars.actError = (e as Error).message;
  }
  stateVars.busyId = '';
  pollState();
  read();
}
