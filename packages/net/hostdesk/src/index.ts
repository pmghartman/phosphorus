// a host's own desktop over ssh: read from its filesystem and settings, drawn by
// the page in that OS's style; nothing installed on the host, no pixels sent

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
  prefetch,
  readAll,
  readStream,
  remove,
  restore,
  statOf,
  trash,
  wallpaper,
  writeText,
} from "./desk.ts";
export type { BinItem, Change, Desk, Entry, Item, Kind, Look, Shell } from "./model.ts";
export { norm, Scope, within } from "./paths.ts";
export { dropSession, Refused, reap, Session, sessionCount, sessionFor, sessionOf, type Target } from "./session.ts";
