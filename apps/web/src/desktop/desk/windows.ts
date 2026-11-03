// the mesh's own apps: each view moved into a window, back to the stash on close

import type { UiAction } from '@phosphorus/wire';
import { appCall } from '../../apps/index.ts';
import { agentArm, agentOwn, agentStep, agentViewOn } from '../../features/agent.ts';
import { filesWin } from '../../features/home/home.ts';
import { phosphorusHosts, switchHost } from '../../features/mesh/mesh.ts';
import { noteAdd, noteSeen, notifyOs } from '../../features/notes.ts';
import { stash } from '../../lib/dom.ts';
import { deskApps, dk, st } from '../../lib/state.ts';
import { dkSettings, type SettingsAt, settingsShows } from '../../settings/settings.ts';
import { dkCode } from '../deskfiles.ts';
import { dkFocus, dkSize, dkWin } from '../windows.ts';
import { dkTermFor } from './terminal.ts';
import { dkWebApp, dkWebApps } from './webapps.ts';

export const DK_APPS: Record<string, { title: string; view: string; w: number; h: number }> = {
  apps: { title: 'service wizard', view: 'view-apps', w: 860, h: 720 },
};

export function dkOpenApp(id: string): void {
  if (!dk.desk) return;
  const app = DK_APPS[id];
  const w = app && dkWin(`app:${id}`, app.title, '', `app dk-app-${id}`);
  if (!w) return;
  const view = document.getElementById(app.view)!;
  view.classList.add('active');
  w.body.appendChild(view);
  dkSize(w, app.w, app.h);
  w.onClose = () => {
    view.classList.remove('active');
    stash.appendChild(view);
  };
  dkFocus(w);
}

// which apps are up, each view's watcher told of a change
export function dkAppsChanged(): void {
  const was = new Set(deskApps);
  deskApps.clear();
  for (const id of Object.keys(DK_APPS)) {
    const w = dk.wins.get(`app:${id}`);
    if (w && !w.node.hidden && !w.leaving) deskApps.add(id);
  }
  // settings' hosts and agents, their views' own watchers
  for (const id of settingsShows()) deskApps.add(id);
  const up = (id: string) => deskApps.has(id) && !was.has(id);
  if (up('status')) appCall('status', true, (m) => m.statusWatch(st.lastState));
  if (deskApps.has('apps') !== was.has('apps'))
    appCall('store', deskApps.has('apps'), (m) => m.storeWatch(deskApps.has('apps')));
  if (up('apps')) noteSeen('apps');
}

// a shell from an app or phosphorus, on a host this desktop is logged into: its tab
// brought forward, else a new one; one asked for by phosphorus shared with it, the
// window its own only if it opened it
export function dkOpenTerminal(host: string, shared = false): void {
  if (!dk.desk || !dk.creds.has(host)) return;
  const t = dkTermFor(host, shared);
  if (t && shared && agentViewOn()) {
    if (t.fresh) agentOwn(t.w);
    agentArm();
  }
}

// phosphorus's presses, each the app it names, or the settings section
export const DK_VIEWS: Record<string, string> = {
  apps: 'apps',
  store: 'apps',
};
const SET_VIEWS: Record<string, SettingsAt> = {
  settings: 'profile',
  profile: 'profile',
  appearance: 'appearance',
  users: 'users',
  agents: 'agents',
  models: 'agents',
  status: 'hosts',
  hosts: 'hosts',
  mesh: 'hosts',
  update: 'update',
  about: 'about',
};
export function dkPressed(a: UiAction): void {
  if (a.kind === 'terminal') dkOpenTerminal(a.host!, a.share === true);
  else if (a.kind === 'host' && phosphorusHosts().includes(a.host!)) switchHost(a.host!);
  else if (a.kind === 'code' && a.host && a.path) {
    if (dk.desk) dkCode({ host: a.host, share: a.share as string | undefined, path: a.path });
  } else if (a.kind === 'view') {
    if (DK_VIEWS[a.view!]) dkOpenApp(DK_VIEWS[a.view!]!);
    else if (SET_VIEWS[a.view!]) dkSettings(SET_VIEWS[a.view!]);
    // an installed app's own, by its id
    else if (dkWebApps().some((x) => x.id === a.view)) dkWebApp(a.view!);
    else if (a.view === 'files' && dk.desk) filesWin();
  } else if (a.kind === 'notify') {
    // one naming a view kept in the bell until that view is seen
    noteAdd(a.title!, a.body!, null, a.view ? { view: a.view, keep: true } : null);
    notifyOs(String(a.title || ''), String(a.body || ''));
  } else if (a.kind === 'agent') agentStep(a);
}
