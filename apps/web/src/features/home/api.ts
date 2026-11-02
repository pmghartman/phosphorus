// files
import type { FileListing, FileRead, FilesInfo } from '@phosphorus/wire';
import { jsonPost } from '../../lib/api.ts';
import { st } from '../../lib/state.ts';

// hosts at the top, their published directories beneath, every path relative
// to one of those, anything resolving outside it refused by the frontend

// a place: a host's share
export interface Loc {
  host: string;
  share?: string;
  root?: string;
  perms?: string;
}

// the home: one on every host, kept in step, so read from this one
export const homeLoc = (): Loc => ({ host: st.selfHost, share: 'home', root: 'home', perms: 'rwd' });
export const isHome = (loc: Loc | null | undefined) => !!loc && loc.share === 'home';
// the host a place is read on: the home this one, whatever host it was first shown on
export const hostOf = (loc: Loc) => (isHome(loc) ? st.selfHost || loc.host : loc.host);

// loc is any {host, share}: a pane, a share row, or the pair a transfer holds
export const filesApi = (loc: Loc, op: string, params?: Record<string, string | number>) => {
  const q = new URLSearchParams({
    share: loc.share || '0',
    ...Object.fromEntries(Object.entries(params || {}).map(([k, v]) => [k, String(v)])),
  });
  return `/api/files/${encodeURIComponent(hostOf(loc))}/${op}?${q}`;
};
export const filesJoin = (a: string, b: string) => (a ? `${a}/${b}` : b);
// host then the share path: razer/phosphorus/files/gondor.jpg
export const filesPath = (host: string, root: string, rel: string) =>
  [host, ...`${root}/${rel || ''}`.split('/')].filter(Boolean).join('/');
export const filesParent = (p: string) => p.split('/').slice(0, -1).join('/');

// JSON from every call, failures included, one place to surface them
export async function filesCall(
  loc: Loc,
  op: 'list',
  init?: RequestInit,
  params?: Record<string, string | number>,
): Promise<FileListing>;
export async function filesCall(
  loc: Loc,
  op: 'info',
  init?: RequestInit,
  params?: Record<string, string | number>,
): Promise<FilesInfo>;
export async function filesCall(
  loc: Loc,
  op: 'read',
  init?: RequestInit,
  params?: Record<string, string | number>,
): Promise<FileRead>;
export async function filesCall(
  loc: Loc,
  op: string,
  init?: RequestInit,
  params?: Record<string, string | number>,
): Promise<any>;
export async function filesCall(
  loc: Loc,
  op: string,
  init?: RequestInit,
  params?: Record<string, string | number>,
): Promise<any> {
  const res = await fetch(filesApi(loc, op, params), init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `status ${res.status}`);
  return body;
}

// a file or a folder and all in it copied, or moved, from one place to another
// on any hosts: streamed between them by the host serving this page
export const filesCopy = (from: Loc, fromPath: string, to: Loc, toPath: string, move: boolean) =>
  filesCall(
    { host: st.selfHost },
    'copy',
    jsonPost({
      from: { host: hostOf(from), share: from.share, path: fromPath },
      to: { host: hostOf(to), share: to.share, path: toPath },
      move,
    }),
  );

// r browse and download, w upload/new folder/rename, d delete
export const may = (loc: Loc, perm: string) => (loc.perms || '').includes(perm);
