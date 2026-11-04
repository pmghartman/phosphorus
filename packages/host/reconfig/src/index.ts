// this host's shares and model host and gpu settings applied
// as soon as edited, a rebuild
import { join } from "node:path";
import {
  env,
  hostConfig,
  IdleMS,
  logf,
  marshal,
  now,
  RepoDir,
  RunDir,
  readJSONMap,
  run,
  sleep,
  writeJSONAtomic,
} from "@phosphorus/util";

const appliedFile = join(RunDir, "reconfig.json");
// the image's binary, or natively the home's, run against the install
const rebuildCmd = env("REBUILD_CMD", join(RepoDir, "bin", "phosphorus"));
const rebuildTimeoutMs = 20 * 60 * 1000;
const settleMS = 2000;

// the signature JS wrote, the same bytes
export function current(): string {
  const c = hostConfig();
  return marshal({
    dir: c.shares.map((s) => s.dir).join(", "),
    priv: c.shares.map((s) => s.perms).join(", "),
    gpu: c.model.gpu,
    model: c.model.host,
  });
}

const applied = () => {
  const s = readJSONMap(appliedFile)?.sig;
  return typeof s === "string" ? s : "";
};

const last = (s: string) => s.trim().split("\n").pop()!;

// the watcher, busy an update's own rebuild under way
export function start(busy: () => boolean) {
  if (!readJSONMap(appliedFile)) writeJSONAtomic(appliedFile, { sig: current() });
  (async () => {
    let seen = "";
    let since = 0;
    for (;;) {
      await sleep(IdleMS);
      const s = current();
      if (s !== seen) {
        seen = s;
        since = now();
        continue;
      }
      if (s === applied() || now() - since < settleMS || busy()) continue;
      writeJSONAtomic(appliedFile, { sig: s });
      logf("[reconfig] shares or model host or gpu changed, rebuilding");
      const r = await run([rebuildCmd, "rebuild", "--home", RepoDir], { timeoutMs: rebuildTimeoutMs });
      if (!r.ok) logf("[reconfig] rebuild failed: %s", last(r.stderr || r.error || `exit status ${r.code}`));
      else if (last(r.stdout)) logf("[reconfig] %s", last(r.stdout));
    }
  })();
}
