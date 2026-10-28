// one update request: on Linux the update agent, phosphorus-update.service on
// state/update-request.json, apt to the feed's newest, else this release
// re-applied; on Windows the one the service hands on with its id, the app's
// own update run without the app (upgradeApp)
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { at, capture, fail, fileExists, home, isWindows, lastLine, output, readTrim, say, selfArgv } from "./base.ts";
import { os, type Reporter } from "./os.ts";

const aptList = "/etc/apt/sources.list.d/phosphorus.list";

// agentReport an update's word in state/update-agent.json, what the
// frontend and `phos update` wait on
export function agentReport(id: string): Reporter {
  return (state, current, version, why) => {
    why = why.replaceAll("\n", " ").slice(0, 400);
    const out = at("state", "update-agent.json");
    try {
      writeFileSync(out + ".tmp", JSON.stringify({ id, state, current, version, error: why, at: Date.now() }), {
        mode: 0o644,
      });
      renameSync(out + ".tmp", out);
    } catch {}
  };
}

export async function upgrade(id: string) {
  if (!id) {
    const req = at("state", "update-request.json");
    try {
      id = String(JSON.parse(readTrim(req))?.id ?? "");
    } catch {}
    // consumed first, or the path unit fires again
    rmSync(req, { force: true });
  }
  const report = agentReport(id);
  report("running", false, "", "");
  if (isWindows) return os.upgradeApp(report);
  if (!fileExists(aptList)) {
    report("failed", false, "", "no update feed (" + aptList + " missing), reinstall from the latest release");
    throw fail("no update feed");
  }
  // the feed's Origin and Label free to change
  const apt = (tee: boolean, ...args: string[]) =>
    capture(
      [
        "apt-get",
        "-q",
        "-o",
        "Dir::Etc::sourcelist=sources.list.d/phosphorus.list",
        "-o",
        "Dir::Etc::sourceparts=-",
        "-o",
        "Acquire::AllowReleaseInfoChange::Origin=true",
        "-o",
        "Acquire::AllowReleaseInfoChange::Label=true",
        ...args,
      ],
      tee,
      { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
    );
  const up = await apt(false, "update", "-o", "APT::Get::List-Cleanup=0");
  if (up.code !== 0) {
    report("failed", false, "", "apt-get update failed: " + lastLine(up.out));
    throw fail("apt-get update failed");
  }
  const policy = await output("apt-cache", "policy", "phosphorus");
  const have = field(policy, "Installed:"),
    cand = field(policy, "Candidate:");
  if (cand && cand !== "(none)" && cand !== have) {
    say(`${have} -> ${cand}`);
    // postinst installs the release and rebuilds
    const r = await apt(true, "install", "-y", "-o", "Dpkg::Options::=--force-confold", "--only-upgrade", "phosphorus");
    if (r.code !== 0) {
      report("failed", false, "", lastLine(r.out, /ERROR|E:/));
      throw fail("apt-get install failed");
    }
    report("ok", false, cand, "");
    return;
  }
  // newest already: this release's images and config re-applied
  say(`${have} is the newest`);
  const r = await capture([...selfArgv(), "install", "--update", "--home", home], true);
  if (r.code !== 0) {
    report("failed", false, "", lastLine(r.out, /ERROR/));
    throw fail("install failed");
  }
  report("ok", r.out.includes("already up to date"), have, "");
}

// the second word of the line starting with key
export function field(text: string, key: string): string {
  for (const l of text.split("\n")) {
    const f = l.trim().split(/\s+/);
    if (f.length >= 2 && f[0] === key) return f[1]!;
  }
  return "";
}
