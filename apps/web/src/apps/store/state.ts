// apps: a store for the mesh's optional extras, each a web build installed onto every host,

import type { AppStatus, AppWant, Route, State } from '@phosphorus/wire';
import { dkOpenApp } from '../../desktop/desk.ts';
import { jsonPost } from '../../lib/api.ts';
import { pollState } from '../../lib/sync.ts';
import { draw } from './services.ts';

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

// a service's step on one host, run there as a unit of the login's own; asked from the host
// from, finished by the host itself (packages/webapps services)
export type SvcOp = 'install' | 'update' | 'remove';
export interface SvcJob {
  id: string;
  host: string;
  op: SvcOp;
  by: string;
  login: string;
  from: string;
  keep: boolean;
  at: number;
  done: number;
  ok?: boolean;
  error: string;
  log: string;
  exit?: number;
}
export interface SvcHost {
  published: boolean;
  route?: Route;
  version: string;
  record?: { login: string; by: string; at: number; commit: string };
  job?: SvcJob;
  behind: number | null;
}

// one service as /api/apps lists it
export interface StoreService {
  id: string;
  name: string;
  tagline: string;
  about: string;
  features: string[];
  category: string;
  by: string;
  repo: string;
  icon: string;
  port: number;
  mode: string;
  os: string[];
  needs: string;
  agents: string[];
  data: string[];
  checkout: string;
  kept: string;
  hosts: Record<string, SvcHost>;
}

export let apps: StoreApp[] | null = null;
export let services: StoreService[] = [];
export let readError = '';

// the module's variables other modules set
export const stateVars = {
  busyId: '',
  sig: '',
  actError: '',
  // the app or service open as its own page, '' for the front
  openId: '',
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
    services = (got.services || []) as StoreService[];
    readError = '';
  } catch (e) {
    readError = (e as Error).message;
  }
  stateVars.sig = '';
  draw();
  // a service's step under way: read again soon, its log and outcome shown as they come
  if (fast) {
    clearTimeout(fast);
    fast = null;
  }
  if (watching && services.some((s) => Object.values(s.hosts).some((h) => h.job && !h.job.done)))
    fast = setTimeout(() => read(), 3000);
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
  timer = setInterval(() => read(), 60000);
}

// an app's or service's page shown, the window opened for it when needed
export function storeShow(id: string): void {
  stateVars.openId = id;
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
