// pings: each host asked from the browser, the steady round trip kept
import { drawMesh } from './draw.ts';
import { phosphorusHosts } from './hosts.ts';
import { meshAnimFrame, meshPanel, uiVars } from './ui.ts';

// round-trip ms from this browser to that host, timed here, null until
// measured or when it didn't answer
export const hostRtt = new Map<string, number | null>();

// host -> last 20 samples, oldest first, for the stats table sparkline
export const rttHistory = new Map<string, number[]>();
export const RTT_HISTORY_LEN = 20;
export const RTT_SAMPLE_MS = 2000;
// the table's number: the median of the last few samples
export const RTT_SHOWN_OF = 5;

// every host pinged from this browser, through the tunnel and the host serving
// the page, the whole round trip timed here

export async function pingHosts(): Promise<void> {
  const hosts = phosphorusHosts();
  if (!hosts.length) return;
  await Promise.all(
    hosts.map(async (h) => {
      const t = performance.now();
      const r = await fetch(`/api/ping/${encodeURIComponent(h)}`, { cache: 'no-store' }).catch(() => null);
      const ms = r?.status === 204 ? Math.round(performance.now() - t) : null;
      hostRtt.set(h, ms);
      if (ms === null) return;
      const hist = rttHistory.get(h) || [];
      hist.push(ms);
      if (hist.length > RTT_HISTORY_LEN) hist.shift();
      rttHistory.set(h, hist);
    }),
  );
  uiVars.meshStatsDirty = true;
  if (!meshAnimFrame) drawMesh();
}
// only while the mesh graph or the status view is on screen
export const pingWanted = () =>
  !document.hidden &&
  [meshPanel, document.getElementById('view-status')].some((v) => v?.getClientRects().length && !v.closest('.stash'));
setInterval(() => {
  if (pingWanted()) pingHosts();
}, RTT_SAMPLE_MS);

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ping bucket -> CSS class, null/undefined meaning unmeasured, not offline
export function pingClass(rttMs: number | null | undefined): string {
  if (rttMs === null || rttMs === undefined) return '';
  if (rttMs <= 150) return 'good';
  if (rttMs <= 300) return 'slow';
  return 'bad';
}

export function pingText(rttMs: number | null | undefined): string {
  if (rttMs === null || rttMs === undefined) return '–';
  return `${rttMs}ms`;
}

// unmeasured kept unmeasured at once, otherwise the recent median
export function steadyRtt(name: string): number | null {
  if (typeof hostRtt.get(name) !== 'number') return null;
  const recent = (rttHistory.get(name) || []).slice(-RTT_SHOWN_OF).sort((a, b) => a - b);
  return recent.length ? recent[recent.length >> 1]! : hostRtt.get(name)!;
}

// inline trend line over the last RTT samples, '' without enough history,
// fixed 0..SPARK_MAX_MS scale so 1ms jitter stays flat
export const SPARK_MAX_MS = 300;
