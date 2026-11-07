// this host's WireGuard key pair in state/data/mesh, and what its join answered
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DataDir } from "@phosphorus/util";
import { b64, keyPair, unb64 } from "@phosphorus/wg";
import type { Joined } from "./plan.ts";

export const keyFile = () => join(DataDir, "mesh", "key.json");
export const joinedFile = () => join(DataDir, "mesh", "joined.json");

const write = (f: string, v: unknown) => {
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify(v) + "\n", { mode: 0o600 });
};

// the pair, made on first need; the frontend's registry reads the same file
export function meshKey(): { priv: Uint8Array; pub: string } {
  try {
    const k = JSON.parse(readFileSync(keyFile(), "utf8"));
    const priv = typeof k?.private === "string" ? unb64(k.private) : undefined;
    if (priv && typeof k.public === "string") return { priv, pub: k.public };
  } catch {}
  const k = keyPair();
  write(keyFile(), { private: b64(k.priv), public: b64(k.pub) });
  return { priv: k.priv, pub: b64(k.pub) };
}

// a pair made for a join, kept once the control host takes it
export const saveMeshKey = (k: { priv: Uint8Array; pub: Uint8Array }) =>
  write(keyFile(), { private: b64(k.priv), public: b64(k.pub) });

export function readJoined(): Joined | undefined {
  try {
    const j = JSON.parse(readFileSync(joinedFile(), "utf8"));
    if (typeof j?.ip !== "string" || typeof j?.hub?.key !== "string") return;
    return {
      name: String(j.name ?? ""),
      ip: j.ip,
      hub: {
        name: String(j.hub.name ?? ""),
        ip: String(j.hub.ip ?? ""),
        key: j.hub.key,
        endpoint: String(j.hub.endpoint ?? ""),
      },
      domain: String(j.domain ?? ""),
      token: typeof j.token === "string" ? j.token : undefined,
    };
  } catch {
    return;
  }
}

export const writeJoined = (j: Joined) => write(joinedFile(), j);
