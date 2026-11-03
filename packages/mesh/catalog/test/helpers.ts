import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pack } from "../src/tar.ts";

export const fixtures = join(import.meta.dir, "fixtures");

// a fixture catalogue's files, by path under it
export function files(source: string): Record<string, string> {
  const root = join(fixtures, source);
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const n of readdirSync(join(root, rel))) {
      const r = rel ? `${rel}/${n}` : n;
      if (statSync(join(root, r)).isDirectory()) walk(r);
      else out[r] = readFileSync(join(root, r), "utf8");
    }
  };
  walk("");
  return out;
}

// a fixture catalogue as codeload would send it
export const tarball = (source: string) => pack(files(source));

export const stream = (b: Uint8Array<ArrayBuffer>) => new Blob([b]).stream();

export const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json", ...headers } });
