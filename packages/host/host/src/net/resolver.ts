// the mesh's names asked of the hub: the mesh zone alone routed to its DNS,
// every other name left to the machine's own resolvers
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "@phosphorus/util";

const sh = (argv: string[]) => run(argv, { timeoutMs: 20_000 });
const macDir = "/etc/resolver";
const mark = "# phosphorus mesh";

// zone's queries to server on the tunnel named dev; true once set
export async function routeZone(dev: string, zone: string, server: string): Promise<boolean> {
  if (process.platform === "linux") {
    const a = await sh(["resolvectl", "dns", dev, server]);
    const b = await sh(["resolvectl", "domain", dev, `~${zone}`]);
    return a.ok && b.ok;
  }
  if (process.platform === "win32") {
    const ns = `.${zone}`;
    const ps = [
      `Get-DnsClientNrptRule | Where-Object { $_.Comment -eq 'phosphorus' } | Remove-DnsClientNrptRule -Force`,
      `Add-DnsClientNrptRule -Namespace '${ns}' -NameServers '${server}' -Comment 'phosphorus'`,
    ].join("; ");
    return (await sh(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps])).ok;
  }
  if (process.platform === "darwin") {
    try {
      mkdirSync(macDir, { recursive: true });
      for (const f of readdirSync(macDir))
        if (f !== zone && readFileSync(join(macDir, f), "utf8").startsWith(mark)) rmSync(join(macDir, f));
      writeFileSync(join(macDir, zone), `${mark}\nnameserver ${server}\n`);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
