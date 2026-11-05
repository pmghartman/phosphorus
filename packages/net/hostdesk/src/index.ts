// a host's own desktop over ssh: read from its filesystem and settings, drawn by
// the page in that OS's style; nothing installed on the host. Window apps alone come
// as pixels, streamed over the same connection by @phosphorus/appstream

export { cacheJSON, cachePut } from "./cache.ts";
export {
  apps,
  type Blob,
  copyFile,
  ctxOf,
  desktop,
  icon,
  ls,
  mkdir,
  open,
  prefetch,
  readAll,
  readStream,
  remove,
  rename,
  roots,
  statOf,
  wallpaper,
  writeAt,
  writeText,
} from "./desk.ts";
export { parseEntry } from "./linux.ts";
export type { Desk, Entry, Item, Kind, Look, Root, Shell } from "./model.ts";
export { norm } from "./paths.ts";
export { dropSession, Refused, reap, Session, sessionCount, sessionFor, sessionOf, type Target } from "./session.ts";
