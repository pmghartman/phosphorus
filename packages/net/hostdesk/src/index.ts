// a host's own desktop over ssh: read from its filesystem and settings, drawn by
// the page in that OS's style; nothing installed on the host. Window apps alone come
// as pixels, streamed over the same connection by @phosphorus/appstream

export { cacheJSON, cachePut } from "./cache.ts";
export {
  apps,
  type Blob,
  change,
  ctxOf,
  desktop,
  empty,
  icon,
  images,
  ls,
  open,
  readAll,
  readStream,
  remove,
  restore,
  statOf,
  trash,
  wallpaper,
  writeText,
} from "./desk.ts";
export { parseEntry } from "./linux.ts";
export type { BinItem, Change, Desk, Entry, Item, Kind, Shell } from "./model.ts";
export { norm, Scope, within } from "./paths.ts";
export { dropSession, Refused, reap, Session, sessionCount, sessionFor, sessionOf, type Target } from "./session.ts";
