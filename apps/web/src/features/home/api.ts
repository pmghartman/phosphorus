// files
import type { FileListing, FileRead, FileRun, FilesInfo } from '@phosphorus/wire';
import { homeCall, homePick } from './merged.ts';

// hosts at the top, their published directories beneath, every path relative
// to one of those, anything resolving outside it refused by the frontend

// a place: a host's share, or the merged home (host *)
export interface Loc { host: string; share?: string; root?: string; perms?: string }

// loc is any {host, share}: a pane, a share row, or the pair a transfer holds;
// host * the merged home, a path's call sent to a host holding it
export const filesApi = (loc: Loc, op: string, params?: Record<string, string | number>) => {
  const q = new URLSearchParams({ share: loc.share || '0', ...Object.fromEntries(Object.entries(params || {}).map(([k, v]) => [k, String(v)])) });
  const host = loc.host === '*' ? homePick(String(params?.path || '')) : loc.host;
  return `/api/files/${encodeURIComponent(host)}/${op}?${q}`;
};
export const filesJoin = (a: string, b: string) => (a ? `${a}/${b}` : b);
// host then the share path: razer/phosphorus/files/gondor.jpg
export const filesPath = (host: string, root: string, rel: string) =>
  [host === '*' ? '' : host, ...`${root}/${rel || ''}`.split('/')].filter(Boolean).join('/');
export const filesParent = (p: string) => p.split('/').slice(0, -1).join('/');

// JSON from every call, failures included, one place to surface them
export async function filesCall(loc: Loc, op: 'list', init?: RequestInit, params?: Record<string, string | number>): Promise<FileListing>;
export async function filesCall(loc: Loc, op: 'info', init?: RequestInit, params?: Record<string, string | number>): Promise<FilesInfo>;
export async function filesCall(loc: Loc, op: 'read', init?: RequestInit, params?: Record<string, string | number>): Promise<FileRead>;
export async function filesCall(loc: Loc, op: 'run', init?: RequestInit, params?: Record<string, string | number>): Promise<FileRun>;
export async function filesCall(loc: Loc, op: string, init?: RequestInit, params?: Record<string, string | number>): Promise<any>;
export async function filesCall(loc: Loc, op: string, init?: RequestInit, params?: Record<string, string | number>): Promise<any> {
  if (loc.host === '*') return homeCall(op, init, params);
  const res = await fetch(filesApi(loc, op, params), init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `status ${res.status}`);
  return body;
}

// r browse and download, w upload/new folder/rename, d delete
export const may = (loc: Loc, perm: string) => (loc.perms || '').includes(perm);
