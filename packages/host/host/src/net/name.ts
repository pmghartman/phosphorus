// this host's name on the mesh, phosphorus's own, kept from its first run
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { at, readTrim } from "../base.ts";

const nameFile = () => at("state", "data", "mesh", "name");

// the name kept, blank before the first run
export const keptName = () => readTrim(nameFile());

export function keepName(name: string) {
  if (!name || name === keptName()) return;
  mkdirSync(at("state", "data", "mesh"), { recursive: true, mode: 0o700 });
  writeFileSync(nameFile(), name + "\n");
}

// a DNS name's first label as a host name
export const labelOf = (dns: string) =>
  (dns.split(".")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// the kept name, else the machine's own
export const meshName = () => keptName() || labelOf(hostname());
