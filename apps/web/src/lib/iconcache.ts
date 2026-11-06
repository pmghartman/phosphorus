// a host's icons kept in this page as blob urls, many fetched in one answer ahead of the desk
// and the apps menu asking, so a tile never wears a glyph first; kept in the Cache API too, so
// a reload paints them before the server is asked; misses asked again, 2s doubling to a minute

import { acctCall } from './api.ts';
import { dk } from './state.ts';

type Want = { icon?: string; iv?: string };

const key = (host: string, it: Want) => `${host}\n${it.icon}\n${it.iv ?? ''}`;
const urls = new Map<string, string>();
const inflight = new Set<string>();
// a miss's next wait, by key
const nextTry = new Map<string, number>();
const watchers = new Set<(host: string) => void>();
const STORE = 'phosphorus-host-icons';
const CHUNK = 48;

// the blob url of an icon already here, else nothing
export const iconUrl = (host: string, it: Want): string | undefined => (it.icon ? urls.get(key(host, it)) : undefined);

// told with the host whenever some of its icons land
export const onIcons = (f: (host: string) => void) => void watchers.add(f);
const tell = (host: string) => {
  for (const f of watchers) f(host);
};

const store = async () => {
  try {
    return 'caches' in window ? await caches.open(STORE) : undefined;
  } catch {
    return undefined;
  }
};
const stored = (k: string) => `/phosphorus-icon/${encodeURIComponent(k)}`;

function keep(k: string, b: Blob) {
  urls.set(k, URL.createObjectURL(b));
}

const dataBlob = (data: string): Blob | undefined => {
  const m = /^data:([^;,]+);base64,(.*)$/.exec(data);
  if (!m) return;
  try {
    const bin = atob(m[2]!);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1] });
  } catch {
    return;
  }
};

// the items' icons fetched unless here already: this browser's store first, then the host in
// chunks, each painted as it lands; slow: a start menu's, kept out of the desk's way
export async function iconsWarm(host: string, items: Want[], slow = false): Promise<void> {
  const want = new Map<string, Want>();
  for (const it of items) {
    if (!it.icon) continue;
    const k = key(host, it);
    if (urls.has(k) || inflight.has(k) || want.has(k)) continue;
    want.set(k, { icon: it.icon, iv: it.iv ?? '' });
  }
  if (!want.size) return;
  for (const k of want.keys()) inflight.add(k);
  try {
    const c = await store();
    if (c) {
      let got = false;
      await Promise.all(
        [...want.keys()].map(async (k) => {
          const r = await c.match(stored(k)).catch(() => undefined);
          if (!r) return;
          keep(k, await r.blob());
          want.delete(k);
          got = true;
        }),
      );
      if (got) tell(host);
    }
    const rest = [...want.entries()];
    for (let i = 0; i < rest.length; i += CHUNK) await ask(host, rest.slice(i, i + CHUNK), slow, c);
  } finally {
    for (const k of want.keys()) inflight.delete(k);
  }
}

async function ask(host: string, want: [string, Want][], slow: boolean, c: Cache | undefined) {
  const r = await acctCall<{ icons: Record<string, string> }>(`/api/hostdesk/${encodeURIComponent(host)}/icons`, {
    items: want.map(([, it]) => it),
    slow,
    wait: slow ? 20000 : 6000,
  });
  let got = false;
  if (r.ok && r.icons)
    for (const [ik, data] of Object.entries(r.icons)) {
      const [icon = '', iv = ''] = ik.split('\n');
      const k = key(host, { icon, iv });
      const b = dataBlob(data);
      if (!b || urls.has(k)) continue;
      keep(k, b);
      nextTry.delete(k);
      got = true;
      void c?.put(stored(k), new Response(b)).catch(() => {});
    }
  if (got) tell(host);
  const miss = want.filter(([k]) => !urls.has(k));
  if (!miss.length || !dk.creds.has(host)) return;
  let wait = 0;
  for (const [k] of miss) {
    const d = nextTry.get(k) ?? 2000;
    nextTry.set(k, Math.min(60000, d * 2));
    wait = Math.max(wait, d);
  }
  setTimeout(() => {
    if (dk.creds.has(host))
      void iconsWarm(
        host,
        miss.map(([, it]) => it),
        slow,
      );
  }, wait);
}

// the store trimmed to a host's current icons, once its whole app list is known
export async function iconsPrune(host: string, keepItems: Want[]) {
  const c = await store();
  if (!c) return;
  const live = new Set(keepItems.filter((it) => it.icon).map((it) => stored(key(host, it))));
  const head = stored(`${host}\n`);
  for (const req of await c.keys().catch(() => [] as readonly Request[])) {
    const path = new URL(req.url).pathname;
    if (path.startsWith(head) && !live.has(path)) void c.delete(req).catch(() => {});
  }
}
