// a host's afterglow: the copy its phosphorus release seeded (<home>/afterglow) and the
// ones its own afterglow updates put beside it (<home>/afterglow-update/<version>), the
// newest that speaks this phosphorus's protocol the one used

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { protoOf, protoOK } from "./proto.ts";

export const releaseDir = (home: string) => join(home, "afterglow");
export const updatesDir = (home: string) => join(home, "afterglow-update");
export const exeName = (windows: boolean) => (windows ? "afterglow.exe" : "afterglow");

export type Installed = { dir: string; version: string; proto: number; from: "release" | "update" };

const readTrim = (p: string) => {
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
};

// one copy's word on itself: VERSION as its release wrote it, PROTO as the update did
export function readInstalled(dir: string, from: Installed["from"], windows: boolean): Installed | undefined {
  const version = readTrim(join(dir, "VERSION"));
  if (!version || !existsSync(join(dir, exeName(windows)))) return;
  const p = readTrim(join(dir, "PROTO"));
  return { dir, version, proto: protoOf(p ? Number(p) : undefined), from };
}

// 0.10 after 0.9: each dotted part as a number
export function versionCmp(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// every copy on the host
export function allAfterglow(home: string, windows: boolean): Installed[] {
  const out: Installed[] = [];
  const seed = readInstalled(releaseDir(home), "release", windows);
  if (seed) out.push(seed);
  let names: string[] = [];
  try {
    names = readdirSync(updatesDir(home));
  } catch {}
  for (const n of names) {
    const u = readInstalled(join(updatesDir(home), n), "update", windows);
    if (u) out.push(u);
  }
  return out;
}

// the copy to run: the newest speaking a protocol this phosphorus does
export function pickAfterglow(home: string, windows: boolean): Installed | undefined {
  return allAfterglow(home, windows)
    .filter((i) => protoOK(i.proto))
    .sort((a, b) => versionCmp(b.version, a.version))[0];
}
