// serving host
import { appCall } from '../../apps/index.ts';
import { st } from '../../lib/state.ts';
import { connectState } from '../../lib/sync.ts';
import { dkChips } from '../../desktop/taskbar.ts';
import { drawVars, meshRoutes, meshTailnet, renderMesh } from './draw.ts';

// the host serving this page, held by the ingress's phosphorus-host cookie

export const phosphorusHosts = () => meshTailnet.filter((d) => d.phosphorus).map((d) => d.name).sort();

// {to, from, at} of a switch awaiting the new host's first answer
export let hostSwitch: { to: string; from: string; at: number } | null = null;
// grace for a late poll from the old host
export const HOST_SWITCH_MS = 4000;
// the host a switch is waiting on, if one is
export const hostSwitchNow = () => hostSwitch;

// drawn at once as the new self, confirmed or undone by the state
export function redrawHost(host: string) {
  st.selfHost = host;
  drawVars.meshSig = '';
  renderMesh(meshRoutes, meshTailnet);
  dkChips();
}

export async function switchHost(host: string): Promise<void> {
  if (!host || host === (hostSwitch?.to || st.selfHost)) return;
  const from = hostSwitch?.from || st.selfHost;
  hostSwitch = { to: host, from, at: Date.now() };
  redrawHost(host);
  const r = await fetch(`/api/host?host=${encodeURIComponent(host)}`, { method: 'POST' }).catch(() => null);
  if (hostSwitch?.to !== host) return;
  if (!r || !r.ok) {
    hostSwitch = null;
    redrawHost(from);
    return;
  }
  // chat, state and stats reconnected through the new host
  st.ws?.close();
  connectState();
  appCall('status', false, (m) => m.statusReconnect());
}

// the served host from the state, held at the pending one until it answers
export function settleHost(served: string): string {
  const sw = hostSwitch;
  if (!sw) return served;
  // the pulse dropped on the next draw
  drawVars.meshSig = '';
  if (served === sw.to) {
    hostSwitch = null;
    return served;
  }
  if (Date.now() - sw.at < HOST_SWITCH_MS) return sw.to;
  hostSwitch = null;
  return served;
}

// a node's half-width before the depth scale
export const NODE_HALF = 3;
