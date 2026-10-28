// --- /api/files/<host>/<op>: packages/files
import type { HostShare } from "./state.ts";

// one entry of a listing; hosts, live, stale and at are the merged home's own
export interface FileEntry {
  name: string;
  dir: boolean;
  empty?: boolean;
  link?: boolean;
  size?: number | null;
  mtime?: number | null;
  // a home file kept on every host
  all?: boolean;
  // the merged home: the hosts holding it, those online, none online, the folder it sits in
  hosts?: string[];
  live?: string[];
  stale?: boolean;
  at?: string;
}
export interface FileListing {
  path: string;
  entries: FileEntry[];
  truncated?: boolean;
}
export interface FilesInfo {
  enabled?: boolean;
  shares?: HostShare[];
}
export interface FileRead {
  path: string;
  size?: number;
  text?: string;
  tooBig?: boolean;
  binary?: boolean;
}
// a sealed run link for a page, an app folder or a .wasm
export interface FileRun {
  url: string;
  kind?: string;
}
