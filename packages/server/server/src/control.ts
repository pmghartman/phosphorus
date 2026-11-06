// settings › network: the mesh's own control server, its relay, join keys and
// device approvals asked of it
import * as peers from "@phosphorus/peers";
import * as store from "@phosphorus/store";
import { errText, now } from "@phosphorus/util";
import type { Res } from "./http.ts";
import { obj, str } from "./js.ts";
import { hostsInfo } from "./server.ts";

const ctl = peers.control;

let healthAt = 0;
let healthOf = "";
let healthLast: { ok: boolean; why?: string } = { ok: false };

// <url>/health from here, over the internet as any device would reach it
async function health(url: string): Promise<{ ok: boolean; why?: string }> {
  if (healthOf === url && now() - healthAt < 10_000) return healthLast;
  let h: { ok: boolean; why?: string };
  try {
    const r = await fetch(url + "/health", { signal: AbortSignal.timeout(5000) });
    h = r.ok ? { ok: true } : { ok: false, why: `${url}/health said ${r.status}` };
  } catch (e) {
    h = { ok: false, why: `${url} not answering: ${errText(e)}` };
  }
  healthAt = now();
  healthOf = url;
  healthLast = h;
  return h;
}

// Linux hosts with a public IPv4 of their own: the ones every device can reach
function publicHosts(): { name: string; ip: string }[] {
  return Object.entries(hostsInfo())
    .map(([name, i]) => ({ name, platform: str(obj(i)?.platform), ip: str(obj(i)?.publicIPv4) }))
    .filter((h) => h.platform === "linux" && h.ip)
    .map(({ name, ip }) => ({ name, ip }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

let devicesAt = 0;
let devicesLast: { devices?: peers.control.Node[]; error?: string } = {};

// headscale's devices from the control host, asked at most every 10s however many pages poll
async function devices(fresh = false) {
  if (!fresh && now() - devicesAt < 10_000) return devicesLast;
  const [st, b] = await ctl.controlOp("nodes");
  devicesLast =
    st === 200 && Array.isArray(b?.nodes) ? { devices: b.nodes } : { error: str(b?.error) || `status ${st}` };
  devicesAt = now();
  return devicesLast;
}

export async function controlStatus(): Promise<Res> {
  const c = ctl.control();
  if (!c) return [200, { control: null, health: null, hosts: publicHosts() }];
  const [h, d] = await Promise.all([health(c.url), devices()]);
  return [200, { control: c, health: h, hosts: [], ...d }];
}

// a device op, the list asked again after so the page shows it at once
async function deviceOp(op: string, body: Record<string, unknown>): Promise<Res> {
  const r = await ctl.controlOp(op, body);
  if (r[0] === 200) await devices(true);
  return r;
}

const nameRe = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// an admin's step: the server and relay, keys, and the devices on it
export async function controlAction(p: Record<string, unknown>): Promise<Res> {
  const c = ctl.control();
  switch (str(p.action)) {
    case "set": {
      if (c) return [409, { error: `the mesh runs on ${c.host}'s control server; it stays there` }];
      const host = str(p.host).toLowerCase();
      const name = str(p.name).toLowerCase().replace(/\.$/, "");
      if (!nameRe.test(name)) return [400, { error: "the control name must be a domain name, e.g. hs.example.com" }];
      if (!publicHosts().some((h) => h.name === host))
        return [400, { error: `${host || "that"} isn't a Linux host with a public address` }];
      store.write(ctl.controlRel, { host, url: "https://" + name, relay: false }, true);
      return [200, { ok: true }];
    }
    case "relay":
      if (!c) return [409, { error: "no control server yet" }];
      store.write(ctl.controlRel, { ...c, relay: p.on === true }, true);
      return [200, { ok: true }];
    case "join-key":
      return ctl.controlOp("join-key");
    case "device-key":
      return ctl.controlOp("device-key");
    case "approve":
      return deviceOp("approve", { authId: str(p.authId) });
    case "rename":
      return deviceOp("rename", { id: str(p.id), name: str(p.name) });
    case "remove":
      return deviceOp("remove", { id: str(p.id) });
  }
  return [400, { error: "action must be set, relay, join-key, device-key, approve, rename or remove" }];
}
