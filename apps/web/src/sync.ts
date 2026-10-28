// /api/state: everything the page knows of the mesh, pushed over its socket, one read right
// after the user's own action; each push applied to the mesh graph, the games, the desktop,
// the update pane and the apps
import { acctCheck } from './account.ts';
import { appCall } from './apps.ts';
import { renderGames } from './games.ts';
import { GIT_SERVICE, meshModelsFrom, pruneConnections, renderMesh, renderMeshGit, settleHost } from './mesh.ts';
import { st } from './state.ts';
import type { Route, State, TailnetDevice } from '@phosphorus/wire';
import { updateState } from './update.ts';
import { dkHostsGone, dkRoutes } from './desktop/desk.ts';
import { dkDeskStamps } from './desktop/deskfiles.ts';

const aboutVersion = document.getElementById('about-version')!;

function renderRoutes(routes: Route[], tailnet: TailnetDevice[]) {
  st.terminalHosts = tailnet.filter((d) => d.phosphorus).map((d) => d.name);
  const services = routes.filter((r) => r.type !== 'game' && r.name !== GIT_SERVICE);
  renderGames(routes.filter((r) => r.type === 'game'));
  st.gitRoute = routes.find((r) => r.name === GIT_SERVICE) || null;
  renderMesh(routes, tailnet);
  dkRoutes(services);
  dkHostsGone();
}

function applyState(state: State) {
  st.selfHost = settleHost(state.self.host || '');
  st.hostsInfo = state.hosts && typeof state.hosts === 'object' ? state.hosts : {};
  dkDeskStamps();
  st.meshDomain = state.domain || '';
  if (state.domain) st.baseDomain = state.domain;
  if (state.self.version) {
    aboutVersion.textContent = `v${state.self.version}`;
  }

  const next = state.gitHosts;
  const gitChanged = JSON.stringify(next.map((h) => [h.host, h.reachable, h.role, h.eligible]))
    !== JSON.stringify(st.gitHostsList.map((h) => [h.host, h.reachable, h.role, h.eligible]));
  st.gitHostsList = next;
  renderMeshGit();

  renderRoutes(state.routes, state.tailnet);
  st.lastState = state;
  appCall('status', false, (m) => m.statusState(state));
  appCall('agents', false, (m) => m.agentsState(state));
  appCall('store', false, (m) => m.storeState(state));
  meshModelsFrom(state, gitChanged);
  updateState(state);
}

// cap on one read, so a hung fetch can't stall a caller for good
const POLL_GIVEUP_MS = 5000;

// one read, right after the user's own action, the socket carrying the rest
export async function pollState(): Promise<void> {
  try {
    applyState(await fetch('/api/state', { signal: AbortSignal.timeout(POLL_GIVEUP_MS) }).then((r) => r.json()));
  } catch {
    // left to the next push
  }
}

// the server's push, each change as it lands, reopened after a drop, at once
// for a host switch or a tab coming back
let stateWs: WebSocket | null = null;
let stateRetry: ReturnType<typeof setTimeout> | null = null;
let stateRetryMs = 300;

export function connectState(): void {
  clearTimeout(stateRetry!);
  const old = stateWs;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(`${proto}//${location.host}/api/state`);
  stateWs = sock;
  old?.close();
  sock.onopen = () => { stateRetryMs = 300; };
  sock.onmessage = (ev) => {
    let state: State;
    try { state = JSON.parse(ev.data); } catch { return; }
    applyState(state);
  };
  sock.onclose = () => {
    if (stateWs !== sock) return;
    acctCheck();
    stateRetry = setTimeout(connectState, stateRetryMs);
    stateRetryMs = Math.min(stateRetryMs * 1.5, 5000);
  };
  sock.onerror = () => sock.close();
}

// the push ended for a login screen: its retry dropped, its socket closed, nothing reopened
export function stateStop(): void {
  clearTimeout(stateRetry!);
  const sock = stateWs;
  stateWs = null;
  sock?.close();
}
// whether the push's socket exists at all
export const stateUp = () => !!stateWs;
// whether it closed and is waiting on its retry
export const stateClosed = () => stateWs?.readyState === WebSocket.CLOSED;

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && st.acct && !st.acct.boot && stateClosed()) connectState();
});
setInterval(pruneConnections, 1000);
