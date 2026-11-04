// state/ by kind: run/ what the service writes about itself, log/ its logs, cache/
// what can be fetched again, data/ what can't; its root only what other programs
// and other versions look for there (the update's hand-off, the app's, ssh's Include)
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "./env.ts";

const stateDir = () =>
  env("STATE_DIR", join(env("PHOSPHORUS_REPO_DIR", env("PHOSPHORUS_HOME", "/var/lib/phosphorus")), "state"));

export const RunDir = join(stateDir(), "run");
export const LogDir = join(stateDir(), "log");
export const CacheDir = join(stateDir(), "cache");
export const DataDir = join(stateDir(), "data");

// each kind's folder there before anything writes into it; a login without the
// rights to state/ only reads
for (const d of [RunDir, LogDir, CacheDir, DataDir])
  try {
    mkdirSync(d, { recursive: true });
  } catch {}

// where each of 3.7's state/ entries went
export const stateMoves: [string, string][] = [
  ["native.env", "run/native.env"],
  ["native-sig", "run/native-sig"],
  ["rebuild.lock", "run/rebuild.lock"],
  ["roles.json", "run/roles.json"],
  ["platform.json", "run/platform.json"],
  ["self-host", "run/self-host"],
  ["base-domain", "run/base-domain"],
  ["wildcard", "run/wildcard"],
  ["reconfig.json", "run/reconfig.json"],
  ["config-host", "run/config-host"],
  ["tailnet-joined", "run/tailnet-joined"],
  ["update-chain.json", "run/update-chain.json"],
  ["model-claim.json", "run/model-claim.json"],
  ["model-installed.json", "run/model-installed.json"],
  ["llama-slots", "run/llama-slots"],
  ["phosphorus.log", "log/phosphorus.log"],
  ["phosphorus.log.1", "log/phosphorus.log.1"],
  ["mcp-audit.jsonl", "log/mcp-audit.jsonl"],
  ["upgrade.log", "log/upgrade.log"],
  ["catalogs", "cache/catalogs"],
  ["models", "cache/models"],
  ["apps/icons", "cache/icons"],
  ["apps", "data/apps"],
  ["appdata", "data/appdata"],
  ["ha", "data/ha"],
  ["claude-runs", "data/claude-runs"],
  ["net-day.json", "data/net-day.json"],
  ["services-removed", "data/services-removed"],
  ["update-history.json", "data/update-history.json"],
];

// 3.7's flat state/ sorted once into its kinds: renamed, else copied then removed;
// what's at the new place already kept. A phos command's log follows on its own
export function sortState(dir: string, say: (m: string) => void = () => {}) {
  for (const [from, to] of stateMoves) {
    const a = join(dir, from),
      b = join(dir, to);
    if (!existsSync(a)) continue;
    if (existsSync(b)) {
      rmSync(a, { recursive: true, force: true });
      continue;
    }
    mkdirSync(dirname(b), { recursive: true });
    try {
      renameSync(a, b);
    } catch {
      try {
        cpSync(a, b, { recursive: true });
        rmSync(a, { recursive: true, force: true });
      } catch (e) {
        say(`couldn't move state/${from} to state/${to}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}
