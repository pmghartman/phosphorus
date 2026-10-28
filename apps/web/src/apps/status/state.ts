// status: btop for the whole mesh
import { deskApps } from '../../lib/state.ts';
import type { State, StatsSample } from '@phosphorus/wire';
import { statusRender } from '../status.ts';

// one socket to the serving host, every host's samples fanned in there, open
// only while the tab is up

export const stHostsEl = document.getElementById('st-hosts')!;
// samples kept per host, one per dot column
export const ST_HIST = 400;
// a host silent this long drawn stale
export const ST_STALE_MS = 4000;

// a card's elements: the parts drawn into, by box name and a few extras
export type Parts = Record<string, any> & { head: HTMLElement; tile: HTMLElement; model: HTMLElement; modelBox: HTMLElement; modelHtml: string; sum: HTMLElement; sumCpu: HTMLCanvasElement; sumNet: HTMLElement; sumRx: HTMLCanvasElement; sumTx: HTMLCanvasElement };
// host -> {s, at, hist: {cpu, rx, tx}, card}
export interface StHost { s: StatsSample | null; at: number; hist: Record<string, number[]>; card: { card: HTMLElement; parts: Parts } | null; gpu?: boolean; netMax?: number }
export const stHosts = new Map<string, StHost>();
export let stWs: WebSocket | null = null;
export let stRetry: ReturnType<typeof setTimeout> | null = null;
export let stFrame: number | null = null;
// the last /api/state, for each header's ping, git role and services
export let stNet: State | null = null;

// the module's variables other modules set
export const stateVars = {
  // the one host shown in full, the rest as tiles
  stOpenHost: null as string | null,
};

export const stOpen = () => deskApps.has('status') && !document.hidden;

// opened on the first look and kept for the page's life: samples and history
// arriving while the tab is away, so coming back never a grey wait
export function statusWatch(state?: State | null): void {
  if (state && !stNet) statusState(state);
  if (!stOpen()) return;
  if (!stWs) statusConnect();
  statusDraw();
}

// the serving host switched: the stats socket follows it
export function statusReconnect(): void { if (stWs) statusConnect(); }

export function statusConnect() {
  clearTimeout(stRetry!);
  const old = stWs;
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/stats`);
  stWs = sock;
  stLast = Date.now();
  old?.close();
  sock.onmessage = (ev) => {
    stLast = Date.now();
    let s: StatsSample;
    try { s = JSON.parse(ev.data); } catch { return; }
    if (!s.host) return;
    const h = stHost(s.host);
    h.s = s;
    h.at = Date.now();
    if (s.cpu) {
      const push = (k: string, v: number) => { h.hist[k]!.push(v); if (h.hist[k]!.length > ST_HIST) h.hist[k]!.shift(); };
      push('cpu', s.cpu.total);
      push('rx', s.net.reduce((a, n) => a + n.rx, 0));
      push('tx', s.net.reduce((a, n) => a + n.tx, 0));
      // the gpus' mean load, 0 on a host with none reporting
      const util = (s.gpus || []).filter((g) => g.util !== null);
      if (util.length) h.gpu = true;
      push('gpu', util.length ? util.reduce((a, g) => a + g.util!, 0) / util.length : 0);
    }
    statusDraw();
  };
  sock.onclose = () => {
    if (stWs !== sock) return;
    stRetry = setTimeout(statusConnect, stLast && Date.now() - stLast < 5000 ? 300 : 2000);
  };
  sock.onerror = () => sock.close();
}

// a socket gone quiet while watched: dead without a close, so opened again
// rather than left grey; every host samples each second
export let stLast = 0;
export const ST_QUIET_MS = 5000;
export function statusAwake() {
  if (stWs && stOpen() && Date.now() - stLast > ST_QUIET_MS) statusConnect();
}
setInterval(statusAwake, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) statusAwake(); });
window.addEventListener('online', () => { if (stWs) statusConnect(); });

export function stHost(name: string): StHost {
  let h = stHosts.get(name);
  if (!h) { h = { s: null, at: 0, hist: { cpu: [], rx: [], tx: [], gpu: [] }, card: null }; stHosts.set(name, h); }
  return h;
}

// once a frame at most, and only while shown
export function statusDraw(): void {
  if (stFrame || !stOpen()) return;
  stFrame = requestAnimationFrame(() => { stFrame = null; statusRender(); });
}

export function statusState(state: State): void {
  stNet = state;
  statusDraw();
}
