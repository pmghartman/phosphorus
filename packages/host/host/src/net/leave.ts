// Tailscale's leaving, once per host: its node taken down so phosphorus's own
// tunnel holds the mesh address alone; gone the release after every host has left
import { existsSync, lstatSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DataDir, run } from "@phosphorus/util";

const doneFile = () => join(DataDir, "mesh", "left-tailscale");
const sh = (argv: string[]) => run(argv, { timeoutMs: 30_000 });

const winCLI = () => join(process.env.ProgramFiles ?? "C:\\Program Files", "Tailscale", "tailscale.exe");
const macCLI = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
];

// a Tailscale node still up here, holding the address or its port
export async function tailscaleHere(): Promise<boolean> {
  if (existsSync(doneFile())) return false;
  if (process.platform === "linux")
    return (
      (await sh(["systemctl", "is-active", "--quiet", "phosphorus-tailscaled.service"])).ok ||
      (await sh(["systemctl", "is-active", "--quiet", "tailscaled.service"])).ok
    );
  if (process.platform === "win32") return /RUNNING/.test((await sh(["sc", "query", "Tailscale"])).stdout);
  if (process.platform === "darwin") {
    const cli = macCLI.find(existsSync);
    return !!cli && (await sh([cli, "status", "--json"])).stdout.includes('"BackendState": "Running"');
  }
  return false;
}

// Tailscale down and kept down; phosphorus's own copy removed with its state
export async function leaveTailscale(libexec: string, home: string): Promise<string[]> {
  const did: string[] = [];
  if (process.platform === "linux") {
    // stopped apart from the disable: an upgrade may have taken its unit file already
    if ((await sh(["systemctl", "stop", "phosphorus-tailscaled.service"])).ok) did.push("stopped tailscaled");
    await sh(["systemctl", "disable", "phosphorus-tailscaled.service"]);
    rmSync("/usr/lib/systemd/system/phosphorus-tailscaled.service", { force: true });
    rmSync("/etc/systemd/system/phosphorus-tailscaled.service", { force: true });
    await sh(["systemctl", "daemon-reload"]);
    // the machine's own tailscaled down, left installed
    if ((await sh(["systemctl", "is-active", "--quiet", "tailscaled.service"])).ok) {
      await sh(["tailscale", "down"]);
      did.push("took the machine's tailscale down");
    }
    try {
      const l = "/usr/local/bin/tailscale";
      if (lstatSync(l).isSymbolicLink() && readlinkSync(l).startsWith(libexec)) rmSync(l, { force: true });
    } catch {}
    for (const f of ["tailscale", "tailscaled", "headscale"]) rmSync(join(libexec, f), { force: true });
    rmSync(join(home, "tailscale"), { recursive: true, force: true });
    rmSync(join(DataDir, "control"), { recursive: true, force: true });
  } else if (process.platform === "win32") {
    if (existsSync(winCLI())) await sh([winCLI(), "logout"]);
    await sh(["sc", "stop", "Tailscale"]);
    if ((await sh(["sc", "config", "Tailscale", "start=", "disabled"])).ok) did.push("stopped and disabled Tailscale");
  } else if (process.platform === "darwin") {
    const cli = macCLI.find(existsSync);
    if (cli && (await sh([cli, "logout"])).ok) did.push("signed the Tailscale app out");
  }
  try {
    writeFileSync(doneFile(), new Date().toISOString() + "\n");
  } catch {}
  return did;
}
