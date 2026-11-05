// afterglow on this machine as phosphorus finds it: the link file phosphorus's own
// setup wrote beside afterglow's config (packages/host/host/src/win/afterglow.ts),
// readable by SYSTEM and administrators only, naming the port and token

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LinkAddr } from "./link.ts";

export const linkFile = (dataDir: string) => join(dataDir, "afterglow", "link.json");

// the link's address, undefined when afterglow isn't set up here
export function linkOf(dataDir: string): LinkAddr | undefined {
  try {
    const j = JSON.parse(readFileSync(linkFile(dataDir), "utf8"));
    const port = Number(j?.port);
    const token = String(j?.token ?? "");
    if (!Number.isInteger(port) || port < 1 || port > 65535 || token.length < 16) return undefined;
    return { port, token };
  } catch {
    return undefined;
  }
}
