// uninstall everything this host added, its home last: the service, the admin
// setup behind its own prompt, PATH, the play/stop key; Linux's the package purged
import { rmSync } from "node:fs";
import { at, envPath, fail, fileExists, home, isLinux, run, say } from "./base.ts";
import { unauthorizeGame } from "./game.ts";
import { os } from "./os.ts";

export async function uninstall(opts: string[]) {
  for (const o of opts) {
    if (o === "--admin") {
      if (!(await os.isAdmin())) throw fail("uninstall --admin needs root or an elevated shell");
      return os.uninstallAdmin();
    }
  }
  if (isLinux) return purgeLinux();
  if (!fileExists(at(".phosphorus-installed")) && !fileExists(envPath())) throw fail(`${home} isn't a phosphorus home`);
  say("stopping phosphorus...");
  try {
    await os.svcStop();
  } catch {}
  os.svcRemove();
  unauthorizeGame();
  await os.unpath();
  if (await os.isAdmin()) {
    try {
      await os.uninstallAdmin();
    } catch {}
  } else await os.elevateUninstall();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch (e) {
    throw fail(`couldn't remove ${home}: ${e instanceof Error ? e.message : e}`);
  }
  say(`removed ${home}`);
}

// purgeLinux the package's own scripts: units stopped, links, git account and
// /var/lib/phosphorus gone; in a unit of its own, outliving phosphorus's terminals
async function purgeLinux() {
  say("purging the phosphorus package...");
  const ok = fileExists("/run/systemd/system")
    ? await run(
        "systemd-run",
        "--quiet",
        "--collect",
        "--wait",
        "--unit",
        "phosphorus-uninstall",
        "apt-get",
        "purge",
        "-y",
        "phosphorus",
      )
    : await run("apt-get", "purge", "-y", "phosphorus");
  if (!ok) throw fail("apt-get purge failed");
}
