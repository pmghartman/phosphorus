// self / routes
import { st } from '../../lib/state.ts';
import type { Route } from '@phosphorus/wire';
import { drawMesh } from './draw.ts';

export function serviceUrl(route: Route): string {
  const base = route.base_path ? `${route.base_path.replace(/^\/+|\/+$/g, '')}/` : '';
  if (route.mode === 'subdomain' && st.meshDomain) return `https://${route.name}.${st.meshDomain}/${base}`;
  return `/${route.host}/${route.name}/${base}`;
}

export const serviceKey = (route: { host: string; name: string }) => `${route.host}::${route.name}`;

// a service opened from here whose tab is still open
export interface Connection { win: { closed: boolean }; host: string; name: string }
// key -> { win, host, name } for each service opened from here whose tab is
// still open, driving the touched/purple path and the packet pulse
export const activeConnections = new Map<string, Connection>();

// a closed tab's line dropped from the graph, checked every second
export function pruneConnections(): void {
  if (!activeConnections.size) return;
  let changed = false;
  for (const [key, conn] of activeConnections) {
    if (conn.win.closed) { activeConnections.delete(key); changed = true; }
  }
  if (changed) drawMesh();
}

// a host's OS, from /api/state's tailnet (tailscale itself sees every
// host as linux)
export const hostPlatform = new Map<string, string>();

// forgejo's service name, its own app rather than a service icon
export const GIT_SERVICE = 'git';
