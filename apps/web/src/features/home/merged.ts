// the merged home: usr on every host as one, each entry carrying the

import type { FileEntry, FileListing } from '@phosphorus/wire';
import { st } from '../../lib/state.ts';
import { phosphorusHosts } from '../mesh/mesh.ts';
import { filesCall, filesJoin, type Loc } from './api.ts';
import { type Choice, type Fm, filesChoose } from './fm.ts';

// hosts that hold it, an offline host's left out

export const HOME: Loc = { host: '*', share: 'home', root: 'home', perms: 'rwd' };
export const isHome = (loc: Loc | null | undefined) => !!loc && loc.share === 'home';
export const homeAt = (host: string): Loc => ({ host, share: 'home', root: 'home', perms: 'rwd' });
// path -> hosts holding it, from the last listings
export const homeWhere = new Map<string, Set<string>>();

export const homeOnline = () => [...new Set([st.selfHost, ...phosphorusHosts()].filter(Boolean))];
// the desktop reaches every host through its own server
export const hostUrl = (host: string, path: string) => path;
export const otherHosts = (): string[] => [];

// the holder to read a path from: this host first, then any online one
export function homePick(rel: string): string {
  const on = homeOnline();
  const has = [...(homeWhere.get(rel) || [])].filter((h) => on.includes(h));
  return has.includes(st.selfHost) ? st.selfHost : has[0] || st.selfHost;
}
export const homeHolders = (rel: string) => {
  const on = homeOnline();
  const has = [...(homeWhere.get(rel) || [])].filter((h) => on.includes(h));
  return has.length ? has : [st.selfHost];
};

// one host's listing of a home folder, stale and empty when it didn't answer
export interface HomeHostList {
  h: string;
  entries: FileEntry[];
  stale?: boolean;
}
export async function homeHostList(h: string, dir: string): Promise<HomeHostList> {
  try {
    const body = await filesCall(homeAt(h), 'list', undefined, { path: dir });
    return { h, entries: body.entries };
  } catch {
    return { h, entries: [], stale: true };
  }
}

// the hosts' listings merged; `got` the listings already in hand, else every online host asked
export async function homeList(dir: string, got?: HomeHostList[]): Promise<FileListing> {
  got ||= await Promise.all(homeOnline().map((h) => homeHostList(h, dir)));
  const by = new Map<string, FileEntry & { hosts: string[]; live: string[] }>();
  for (const { h, entries, stale } of got) {
    for (const e of entries) {
      const m = by.get(e.name) || { ...e, hosts: [], live: [] };
      m.hosts.push(h);
      if (!stale) m.live.push(h);
      m.mtime = Math.max(m.mtime || 0, e.mtime || 0);
      m.all ||= !!e.all;
      m.dir ||= e.dir;
      by.set(e.name, m);
    }
  }
  const entries = [...by.values()].map((m) => ({ ...m, stale: !m.live.length }));
  for (const e of entries) homeWhere.set(filesJoin(dir, e.name), new Set(e.live.length ? e.live : e.hosts));
  if (!got.some((g) => !g.stale)) throw new Error('no host answered');
  return { path: dir, entries };
}

// one call over the merged home: listing merged, new folders made everywhere,
// deletes and renames on every holder, the rest on one
export async function homeCall(op: string, init?: RequestInit, params?: Record<string, string | number>): Promise<any> {
  if (op === 'list') return homeList(String(params?.path || ''));
  const body = init?.body ? JSON.parse(init.body as string) : {};
  const rel: string = op === 'rename' ? body.from : (body.path ?? params?.path ?? '');
  const hosts =
    op === 'mkdir' ? homeOnline() : ['delete', 'rename', 'mirror'].includes(op) ? homeHolders(rel) : [homePick(rel)];
  const out = await Promise.allSettled(hosts.map((h) => filesCall(homeAt(h), op, init, params)));
  const ok = out.find((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled');
  if (!ok) throw (out[0] as PromiseRejectedResult).reason;
  if (op === 'delete') homeWhere.delete(rel);
  return ok.value;
}

// where new bytes in the home go: one host, or every host (small files only)
export async function homeTarget(fm: Fm, bytes: number, what: string): Promise<{ host: string; all: boolean } | null> {
  const on = homeOnline();
  const opts: Choice[] = [
    ...on.map((h): Choice => [h === st.selfHost ? `${h} (this host)` : h, h]),
    ['all hosts', '*', bytes > HOME_ALL_MAX ? 'over 32MB' : ''],
  ];
  if (on.length < 2) return { host: st.selfHost, all: false };
  const pick = await filesChoose(fm, { title: 'keep it on', message: what, options: opts });
  if (!pick) return null;
  return pick === '*' ? { host: st.selfHost, all: true } : { host: pick, all: false };
}
export const HOME_ALL_MAX = 32 * 1024 * 1024;
