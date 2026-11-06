// settings › network: the mesh's domain and its edge hosts, public ports, its own
// control server, its relay, join keys and device approvals asked of it
import * as peers from "@phosphorus/peers";
import { porkbun } from "@phosphorus/registrar";
import { domainRe, domainRel, portError, removePort, setPort } from "@phosphorus/services";
import * as store from "@phosphorus/store";
import { errText, now } from "@phosphorus/util";
import { edgeStatus, publicHosts } from "./edge.ts";
import type { Res } from "./http.ts";
import { num, str } from "./js.ts";

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
  const edge = edgeStatus();
  if (!c) return [200, { control: null, health: null, hosts: publicHosts(), edge }];
  const [h, d] = await Promise.all([health(c.url), devices()]);
  return [200, { control: c, health: h, hosts: [], edge, ...d }];
}

// a device op, the list asked again after so the page shows it at once
async function deviceOp(op: string, body: Record<string, unknown>): Promise<Res> {
  const r = await ctl.controlOp(op, body);
  if (r[0] === 200) await devices(true);
  return r;
}

// the mesh's domain set, or cleared with a blank name; its edges the Linux hosts
// with a public address that serve it
function setDomain(p: Record<string, unknown>): Res {
  const name = str(p.name).trim().toLowerCase().replace(/\.$/, "");
  if (!name) {
    store.remove(domainRel);
    return [200, { ok: true }];
  }
  if (!domainRe.test(name)) return [400, { error: "the domain must be a name like example.com" }];
  const pub = publicHosts();
  const edges = [...new Set((Array.isArray(p.edges) ? p.edges : []).map((e) => str(e).toLowerCase()))].sort();
  const bad = edges.find((e) => !pub.some((h) => h.host === e));
  if (bad) return [400, { error: `${bad} isn't a Linux host with a public address` }];
  if (!edges.length) return [400, { error: "pick at least one edge host, a Linux host with a public address" }];
  store.write(domainRel, { name, edges }, true);
  return [200, { ok: true }];
}

// the domain pointed at the edges at its registrar: porkbun's API keys used for the
// glue records and the nameservers, then forgotten
async function delegate(p: Record<string, unknown>): Promise<Res> {
  const e = edgeStatus();
  if (!e.domain) return [409, { error: "set the domain first" }];
  if (!e.nameservers.length) return [409, { error: "no edge host with a public address yet" }];
  if (str(p.registrar) !== "porkbun") return [400, { error: "the registrar must be porkbun" }];
  const keys = { apikey: str(p.apikey).trim(), secretapikey: str(p.secretapikey).trim() };
  if (!keys.apikey || !keys.secretapikey)
    return [400, { error: "porkbun's API key and secret API key are both needed" }];
  try {
    return [200, { steps: await porkbun.delegate(keys, e.domain, e.nameservers) }];
  } catch (err) {
    return [502, { error: errText(err) }];
  }
}

// an admin's step: the domain and its edges, its delegation, a public port, the
// control server and relay, keys, and the devices on it
export async function controlAction(p: Record<string, unknown>): Promise<Res> {
  const c = ctl.control();
  switch (str(p.action)) {
    case "domain":
      return setDomain(p);
    case "delegate":
      return delegate(p);
    case "port-set": {
      const row = {
        host: str(p.host).toLowerCase(),
        name: str(p.name).trim().toLowerCase(),
        port: num(p.port),
        proto: str(p.proto) as "tcp" | "udp",
        pub: num(p.pub),
        srv: str(p.srv).trim().toLowerCase(),
      };
      const why = portError(row);
      if (why) return [400, { error: why }];
      setPort(row);
      return [200, { ok: true }];
    }
    case "port-remove":
      removePort(str(p.host).toLowerCase(), str(p.name).toLowerCase());
      return [200, { ok: true }];
    case "set": {
      if (c) return [409, { error: `the mesh runs on ${c.host}'s control server; it stays there` }];
      const host = str(p.host).toLowerCase();
      // the name given, or control.<domain> on the mesh's own DNS
      const base = edgeStatus().domain;
      const name = str(p.name).toLowerCase().replace(/\.$/, "") || (base ? `control.${base}` : "");
      if (!domainRe.test(name)) return [400, { error: "the control name must be a domain name, e.g. hs.example.com" }];
      if (!publicHosts().some((h) => h.host === host))
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
  return [
    400,
    {
      error:
        "action must be domain, delegate, port-set, port-remove, set, relay, join-key, device-key, approve, rename or remove",
    },
  ];
}
