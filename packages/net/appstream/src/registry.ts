// the apps streaming from this server: each one its owner's (a phosphorus user on a
// host, as one login), found again by id after a reload, ended after a while unwatched

import { AppSession, type Runner, type Source, type Start } from "./session.ts";

// unwatched this long, an app is closed: a reload or a dropped link comes back well within
export const lingerMs = 30 * 60_000;
const perOwner = 8;

const apps = new Map<string, { owner: string; s: AppSession }>();

const newId = () => Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex");

export async function launch(owner: string, source: Source | Runner, start: Start): Promise<AppSession> {
  if (list(owner).length >= perOwner) throw new Error(`${perOwner} apps are open on this host already; close one`);
  const s = new AppSession(newId(), source, start);
  apps.set(s.id, { owner, s });
  s.onEnd = () => apps.delete(s.id);
  try {
    await s.open();
  } catch (e) {
    s.end("didn't start");
    throw e;
  }
  return s;
}

// an owner's own app by id, none for anyone else's
export function find(owner: string, id: string): AppSession | undefined {
  const a = apps.get(id);
  return a && a.owner === owner && a.s.alive ? a.s : undefined;
}

export const list = (owner: string) => [...apps.values()].filter((a) => a.owner === owner).map((a) => a.s);

// every app whose runner is gone, or unwatched past the linger, ended; from the server's tick
export function reapApps(now = Date.now()) {
  for (const { s } of [...apps.values()]) if (!s.watched && now - s.lastSeen > lingerMs) s.end("unwatched");
}

// whether any app still uses this owner's connection, to keep it open
export const busy = (owner: string) => list(owner).length > 0;

export const appCount = () => apps.size;
