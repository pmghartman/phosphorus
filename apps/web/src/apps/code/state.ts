// code: claude code sessions on any mesh host, as the desktop app's code tab
import type { CodeOptions, CodeSession } from '@phosphorus/wire';

// draws them: the sessions down the side, one's transcript streamed over a
// socket, a composer under it; every action a REST call

export const view = document.getElementById('view-code')!;

export const PERMS: [string, string][] = [
  ['default', 'ask first'],
  ['acceptEdits', 'accept edits'],
  ['plan', 'plan only'],
  ['bypassPermissions', 'bypass all'],
];
export const PICK_LS = 'phosphorus-code-pick';
export const DIR_LS = 'phosphorus-code-dirs';
export const RECENT_LS = 'phosphorus-code-recent';
export const SIDE_LS = 'phosphorus-code-side';
export const LIST_MS = 4000;
// an upload's bytes at most, as the server takes
export const UP_MAX = 50 * 1024 * 1024;
export const ANTH = ['opus', 'sonnet', 'haiku'];
export const provOf = (id: string | undefined) => (ANTH.includes(id!) ? 'anthropic' : 'mesh');
// a tool's output kept to this on screen, the rest counted
export const OUT_MAX = 16000;

// a tool call's card in the transcript
export interface Card {
  el: HTMLElement;
  body: HTMLElement;
  out: HTMLElement;
  sub: HTMLElement;
  name: string;
  input: Record<string, any>;
}
// a block still streaming
export interface Live {
  kind: string;
  el: HTMLElement;
  index: number;
  text: string;
  timer?: ReturnType<typeof setTimeout> | 0;
}
export interface Todo {
  status: string;
  content: string;
  activeForm?: string;
}
// why an api call failed, in words
export interface Why {
  text: string;
  auth: boolean;
}
// id -> transcript: its node, last seq, open cards, live blocks, its socket
export interface Transcript {
  id: string;
  node: HTMLElement;
  seq: number;
  cards: Map<string, Card>;
  live: Live[];
  perms: Map<string, { el: HTMLElement; done: (allow: boolean, always: boolean, cancelled?: boolean) => void }>;
  todos: Todo[];
  sock: WebSocket | null;
  retry: number;
  lastErr: string;
  closed?: boolean;
  todoEl?: HTMLElement;
  todoFold?: boolean;
  apiWhy?: Why | null;
  retryEl?: HTMLElement | null;
}

export const cd = {
  list: [] as CodeSession[],
  opts: null as CodeOptions | null,
  pick: '',
  filter: '',
  armed: '',
  renaming: '',
  listSig: '',
  // id -> transcript: its node, last seq, open cards, live blocks, its socket
  logs: new Map<string, Transcript>(),
  tick: 0 as ReturnType<typeof setInterval> | 0,
  on: false,
  drawer: false,
  err: '',
  login: false,
};

export const lsGet = <T>(k: string, d: T): T => {
  try {
    return JSON.parse(localStorage.getItem(k)!) ?? d;
  } catch {
    return d;
  }
};
export const lsSet = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};
export const shQuote = (s: unknown) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const tilde = (d: unknown) =>
  String(d || '')
    .replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, '~')
    .replace(/^\/root(?=\/|$)/, '~');
export const base = (d: unknown) =>
  String(d || '')
    .replace(/\/+$/, '')
    .split('/')
    .pop() || '/';
export const parent = (d: unknown) =>
  String(d || '')
    .replace(/\/+$/, '')
    .replace(/\/[^/]*$/, '') || '/';
export const qs = (o: Record<string, unknown>) =>
  Object.entries(o)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v ?? ''))}`)
    .join('&');
export const bytes = (n: number | undefined) =>
  n! >= 1 << 30
    ? `${(n! / (1 << 30)).toFixed(1)}G`
    : n! >= 1 << 20
      ? `${(n! / (1 << 20)).toFixed(1)}M`
      : n! >= 1024
        ? `${(n! / 1024).toFixed(1)}K`
        : `${n || 0}B`;
export const kfmt = (n: number | undefined) =>
  n! >= 1e6 ? `${(n! / 1e6).toFixed(1)}m` : n! >= 1e3 ? `${(n! / 1e3).toFixed(1)}k` : String(n || 0);
export const ago = (ms: number) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};
export const live = (r: CodeSession | null | undefined) => r && (r.status === 'working' || r.status === 'starting');
export const svg = (d: string) => `<svg viewBox="0 0 16 16" class="ic" aria-hidden="true"><path d="${d}"/></svg>`;
export const GL: Record<string, string> = {
  term: 'M2 3h12v10H2zM4.5 6.5l2 1.5-2 1.5M8 10h3.5',
  folder: 'M1.5 3.5h4l1.2 1.5h7.8v8h-13z',
  side: 'M2.5 4h11M2.5 8h11M2.5 12h11',
  attach: 'M10.5 4.5l-4.8 4.8a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4.3-4.3',
  send: 'M8 12.5V3.5M4 7.5L8 3.5l4 4',
  stop: 'M4.5 4.5h7v7h-7z',
  host: 'M2 3.5h12v7H2zM5.5 13h5M8 10.5V13',
  model: 'M8 2l1.6 4.4L14 8l-4.4 1.6L8 14l-1.6-4.4L2 8l4.4-1.6z',
  shield: 'M8 1.8l5 2v4c0 3-2.2 5.3-5 6.4-2.8-1.1-5-3.4-5-6.4v-4z',
};

export async function call(url: string, method = 'GET', body?: unknown): Promise<any> {
  const init: RequestInit = { method, cache: 'no-store' };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const r = await fetch(url, init);
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `status ${r.status}`);
  return out;
}
export const sapi = (id: string, op = '') => `/api/code/sessions/${encodeURIComponent(id)}${op ? `/${op}` : ''}`;
