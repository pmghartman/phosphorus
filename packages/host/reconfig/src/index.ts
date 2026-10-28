// phosphorus.ini's [files], [home], [git] host and [model] host and gpu applied
// as soon as edited, a rebuild
import { join } from "node:path";
import { IdleMS } from "@phosphorus/clock";
import { env, ini, logf, marshal, now, readJSONMap, RepoDir, run, sleep, StateDir, writeJSONAtomic } from "@phosphorus/util";

const appliedFile = join(StateDir, "reconfig.json");
// the image's binary, or natively the home's, run against the install
const rebuildCmd = env("REBUILD_CMD", join(RepoDir, "bin", "phosphorus"));
const rebuildTimeoutMs = 20 * 60 * 1000;
const settleMS = 2000;

// the signature JS wrote, the same bytes
export function current(): string {
  return marshal({
    dir: ini("files", "dir"),
    priv: ini("files", "priv"),
    home: ini("home", "dir"),
    git: ini("git", "host") === "true",
    gpu: ini("model", "gpu") === "true",
    model: ini("model", "host") === "true",
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
      logf("[reconfig] phosphorus.ini [files], [home], [git] or [model] host or gpu changed, rebuilding");
      const r = await run([rebuildCmd, "rebuild", "--home", RepoDir], { timeoutMs: rebuildTimeoutMs });
      if (!r.ok) logf("[reconfig] rebuild failed: %s", last(r.stderr || r.error || `exit status ${r.code}`));
      else if (last(r.stdout)) logf("[reconfig] %s", last(r.stdout));
    }
  })();
}
