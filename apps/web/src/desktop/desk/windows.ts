// the mesh's own apps: each view moved into a window, back to the stash on close

import type { UiAction } from '@phosphorus/wire';
import { appCall } from '../../apps/index.ts';
import { agentArm, agentOwn, agentStep, agentViewOn } from '../../features/agent.ts';
import { chatName, chatText, convNow, joined, openConv, setConv } from '../../features/chat/chat.ts';
import { filesWin } from '../../features/home/home.ts';
import { phosphorusHosts, pingHosts, switchHost } from '../../features/mesh/mesh.ts';
import { noteAdd, notifyOs } from '../../features/notes.ts';
import { openUpdateModal, updateModal } from '../../features/update.ts';
import { stash } from '../../lib/dom.ts';
import { deskApps, dk, st } from '../../lib/state.ts';
import { dkCode } from '../deskfiles.ts';
import { dkBadge } from '../taskbar.ts';
import { dkFocus, dkSize, dkWin } from '../windows.ts';
import { dkTerminal } from './apps.ts';
import { dkGit } from './git.ts';

export const DK_APPS: Record<string, { title: string; view: string; w: number; h: number }> = {
  chat: { title: 'chat', view: 'view-chat', w: 880, h: 560 },
  apps: { title: 'apps', view: 'view-apps', w: 820, h: 700 },
  status: { title: 'status', view: 'view-status', w: 920, h: 600 },
  about: { title: 'about', view: 'view-about', w: 700, h: 420 },
  games: { title: 'game servers', view: 'view-games', w: 460, h: 420 },
  code: { title: 'code', view: 'view-code', w: 1040, h: 660 },
  agents: { title: 'agents', view: 'view-agents', w: 860, h: 640 },
};

export function dkOpenApp(id: string): void {
  if (!dk.desk) return;
  if (id === 'git') {
    dkGit();
    return;
  }
  const app = DK_APPS[id];
  const w = app && dkWin(`app:${id}`, app.title, '', `app dk-app-${id}`);
  if (!w) return;
  const view = document.getElementById(app.view)!;
  view.classList.add('active');
  w.body.appendChild(view);
  dkSize(w, app.w, app.h);
  if (id === 'status') pingHosts();
  const fit = new ResizeObserver(() => {
    if (id === 'status') appCall('status', false, (m) => m.statusDraw());
  });
  fit.observe(w.body);
  w.onClose = () => {
    fit.disconnect();
    view.classList.remove('active');
    stash.appendChild(view);
  };
  if (id === 'chat') {
    w.task.appendChild(dkBadge());
    w.onFocus = () => {
      if (!w.body.contains(document.activeElement)) (joined() ? chatText : chatName).focus({ preventScroll: true });
    };
  }
  dkFocus(w);
}

// which apps are up, each view's watcher told of a change
export function dkAppsChanged(): void {
  const was = new Set(deskApps);
  deskApps.clear();
  for (const id of [...Object.keys(DK_APPS), 'git']) {
    const w = dk.wins.get(`app:${id}`);
    if (w && !w.node.hidden && !w.leaving) deskApps.add(id);
  }
  const up = (id: string) => deskApps.has(id) && !was.has(id);
  if (up('status')) appCall('status', true, (m) => m.statusWatch(st.lastState));
  if (up('agents'))
    appCall('agents', true, (m) => {
      m.agentsState(st.lastState);
      m.agentsWatch(true);
    });
  if (deskApps.has('apps') !== was.has('apps'))
    appCall('store', deskApps.has('apps'), (m) => m.storeWatch(deskApps.has('apps')));
  if (deskApps.has('code') !== was.has('code'))
    appCall('code', deskApps.has('code'), (m) => m.codeWatch(deskApps.has('code')));
  // the conversation's news read once it's on screen
  if (up('chat')) setConv(convNow());
}

// a shell from the chat or phosphorus, on a host this desktop is logged into
// one asked for by phosphorus: logged in with the saved login, shared with it
export function dkOpenTerminal(host: string, shared = false): void {
  if (!dk.desk || !dk.creds.has(host)) return;
  const w = dkTerminal(host, '', shared);
  if (shared && agentViewOn()) {
    agentOwn(w);
    agentArm();
  }
}

// phosphorus's presses, each the app it names
export const DK_VIEWS: Record<string, string> = {
  status: 'status',
  about: 'about',
  chat: 'chat',
  git: 'git',
  games: 'games',
  home: 'games',
  code: 'code',
  projects: 'code',
  agents: 'agents',
  models: 'agents',
  apps: 'apps',
  store: 'apps',
};
export function dkPressed(a: UiAction): void {
  if (a.kind === 'terminal') dkOpenTerminal(a.host!, a.share === true);
  else if (a.kind === 'host' && phosphorusHosts().includes(a.host!)) switchHost(a.host!);
  else if (a.kind === 'code' && a.host && a.path) {
    if (dk.desk) dkCode({ host: a.host, share: a.share as string | undefined, path: a.path });
  } else if (a.kind === 'view') {
    if (a.view === 'chat') openConv('mesh');
    else if (DK_VIEWS[a.view!]) dkOpenApp(DK_VIEWS[a.view!]!);
    else if (a.view === 'files' && dk.desk) filesWin();
    else if (a.view === 'update' && updateModal.hidden) openUpdateModal();
  } else if (a.kind === 'notify') {
    noteAdd(a.title!, a.body!);
    notifyOs(String(a.title || ''), String(a.body || ''));
  } else if (a.kind === 'agent') agentStep(a);
}
