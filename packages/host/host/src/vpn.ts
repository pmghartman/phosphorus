// this host's service and VPN: status as text or JSON, Tailscale up or down
import { fail, println, run, say } from "./base.ts";
import { stop } from "./ctl.ts";
import { os } from "./os.ts";
import { vpnState } from "./tailnet.ts";

// status this host's service and VPN, as text or, with --json, for the app's tray
export async function status(args: string[]) {
  const running = await os.svcActive(),
    vpn = await vpnState();
  if (args[0] === "--json") {
    println(JSON.stringify({ running, vpn: vpn === "Running" }));
    return;
  }
  println(`phosphorus ${running ? "running" : "stopped"}, tailscale ${vpn || "not answering"}`);
}

// vpn on brings Tailscale back up on the tailnet it's signed in to; off stops
// phosphorus first, since nothing of the mesh works without it, then takes it down
export async function vpn(args: string[]) {
  if (args.length === 0) return status([]);
  switch (args[0]) {
    case "on":
      if (!(await run(os.tailscaleCLI(), "up", ...os.tailscaleUpFlags())))
        throw fail("couldn't bring Tailscale up: tailscale up failed");
      say("Tailscale up");
      return;
    case "off":
      if (await os.svcActive()) await stop();
      if (!(await run(os.tailscaleCLI(), "down"))) throw fail("couldn't take Tailscale down: tailscale down failed");
      say("Tailscale down, phosphorus stopped; Start brings both back");
      return;
  }
  throw fail("vpn on or vpn off");
}
