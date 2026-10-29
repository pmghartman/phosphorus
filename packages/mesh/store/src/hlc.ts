// the store's versions: a hybrid logical clock, so a host whose wall clock runs
// slow still writes past what it has seen, and a tie between two hosts is broken
// the same way everywhere
import { createHash } from "node:crypto";

export type Ver = { t: number; h: string };

// the highest stamp seen, local or a peer's
let clockMax = 0;
// a test's skew on this host's wall clock
let skew = 0;

export const wall = () => Date.now() + skew;

// the next stamp: past the wall clock, past everything seen, past the file's own
export function tick(cur = 0): number {
  const t = Math.max(wall(), clockMax + 1, cur + 1);
  clockMax = t;
  return t;
}

// a stamp seen from a peer: nothing written here is ever stamped below it
export function seen(t: number) {
  if (t > clockMax) clockMax = t;
}

// a peer's stamp too far past this clock to take; its host's clock, or ours, is off
export const AheadMs = 60_000;
export const ahead = (t: number) => t > wall() + AheadMs;

// a's version newer than b's: the higher stamp, then the higher host name
export const newer = (a: Ver, b: Ver) => a.t > b.t || (a.t === b.t && a.h > b.h);
export const sameVer = (a: Ver, b: Ver) => a.t === b.t && a.h === b.h;

// the content's hash, blank for a tombstone
export const contentHash = (data: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(data ?? null))
    .digest("hex")
    .slice(0, 16);

// tests: the wall clock moved by ms, the logical clock starting over from it
export function setClockSkew(ms: number) {
  skew = ms;
  clockMax = 0;
}
