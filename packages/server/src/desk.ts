// each Desktop folder in the home by its path, a hash of its entries' names,
// sizes and times, so browsers reread one only when it changes
import { type Dirent, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Desktop, HomeRoot } from "@phosphorus/files";

const fnvOffset = 14695981039346656037n;
const fnvPrime = 1099511628211n;
const mask64 = (1n << 64n) - 1n;

export function deskStamps(): Record<string, string> {
  const out: Record<string, string> = {};
  let users: Dirent[];
  try {
    users = readdirSync(HomeRoot, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return out;
  }
  for (const u of users) {
    if (!u.isDirectory()) continue;
    const rel = u.name + "/" + Desktop;
    const dir = join(HomeRoot, u.name, Desktop);
    let ents: string[];
    try {
      ents = readdirSync(dir).sort();
    } catch {
      continue;
    }
    let h = fnvOffset;
    const feed = (s: string) => {
      for (const b of Buffer.from(s)) h = ((h ^ BigInt(b)) * fnvPrime) & mask64;
    };
    for (const name of ents) {
      try {
        const st = lstatSync(join(dir, name), { bigint: true });
        feed(`${name}\0${st.size}\0${st.mtimeNs}\0${st.isDirectory()}\0`);
      } catch {}
    }
    out[rel] = h.toString(16);
  }
  return out;
}
