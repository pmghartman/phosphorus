// state/ by kind: run/ what the service writes about itself, log/ its logs, cache/
// what can be fetched again, data/ what can't; its root only what other programs
// and other versions look for there (the update's hand-off, the app's, ssh's Include)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "./env.ts";

const stateDir = () =>
  env("STATE_DIR", join(env("PHOSPHORUS_REPO_DIR", env("PHOSPHORUS_HOME", "/var/lib/phosphorus")), "state"));

export const RunDir = join(stateDir(), "run");
export const LogDir = join(stateDir(), "log");
export const CacheDir = join(stateDir(), "cache");
export const DataDir = join(stateDir(), "data");

// the control server: headscale's database, keys and the config written for it
export const ControlDir = join(DataDir, "control");
// what the frontend wants the control role to serve, absent when this host isn't control
export const ControlSpecFile = join(RunDir, "control.json");
// headscale's CLI socket, root's alone
export const ControlSocket = join(RunDir, "headscale.sock");
export const HeadscaleBin = join(CacheDir, "tools", "headscale");

// the control role as the frontend asks for it; relay: the embedded DERP and STUN
export type ControlSpec = { url: string; baseDomain: string; relay: boolean; ipv4?: string; ipv6?: string };

// each kind's folder there before anything writes into it; a login without the
// rights to state/ only reads
for (const d of [RunDir, LogDir, CacheDir, DataDir])
  try {
    mkdirSync(d, { recursive: true });
  } catch {}
