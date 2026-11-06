// this host as an edge: the domain's DNS served, 443 split with the ingress over
// TLS behind it, public ports opened, and on the first edge up the certificate
// ordered from the CA and renewed, proven over that same DNS
import { promises as resolver } from "node:dns";
import { Client, LetsEncrypt, newAccountKey } from "@phosphorus/acme";
import * as dns from "@phosphorus/dns";
import * as peers from "@phosphorus/peers";
import { type Forwarded, forwardPorts, listenTLS, type PortSpec, type Split, split } from "@phosphorus/proxy";
import {
  acmeRel,
  acmeState,
  acmeStateRel,
  challenge,
  challengeRel,
  type Domain,
  domain,
  ports,
  tls,
  tlsCovers,
  tlsRel,
} from "@phosphorus/services";
import * as store from "@phosphorus/store";
import * as users from "@phosphorus/users";
import { ControlBehindPort, env, errText, marshal, Notes, now, obj, publicIPv4, tailnetIP } from "@phosphorus/util";
import type { WSData } from "@phosphorus/wsock";
import type { Server } from "bun";
import { baseDomain, getPlatform, selfHost } from "./config.ts";
import { str } from "./js.ts";
import { appHandler } from "./routes.ts";
import { hostsInfo } from "./server.ts";

const notes = new Notes("edge");
const directory = env("ACME_DIRECTORY", LetsEncrypt);
const dnsPort = Number(env("DNS_PORT", "53"));
const httpsPort = Number(env("HTTPS_PORT", "443"));

// --- what every host sees -----------------------------------------------------

// an edge host's own word on what it serves, in its info.json
export type EdgeInfo = { dns: string; tls: string; ports: Record<string, string> };

export type EdgeStatus = {
  domain: string;
  edges: { host: string; ip: string; up: boolean; info?: EdgeInfo }[];
  // Linux hosts with a public address, the ones that can be edges
  candidates: { host: string; ip: string }[];
  nameservers: { name: string; ip: string }[];
  delegation: { ok: boolean; why: string };
  tls: {
    state: "none" | "ordering" | "valid" | "expiring";
    notAfter?: number;
    names?: string[];
    error?: string;
    by: string;
  };
  ports: (ReturnType<typeof ports>[number] & { open: string })[];
};

// Linux hosts with a public IPv4 of their own: the ones every device can reach
export function publicHosts(): { host: string; ip: string }[] {
  return Object.entries(hostsInfo())
    .map(([host, i]) => ({ host, platform: str(obj(i)?.platform), ip: str(obj(i)?.publicIPv4) }))
    .filter((h) => h.platform === "linux" && h.ip)
    .map(({ host, ip }) => ({ host, ip }))
    .sort((a, b) => a.host.localeCompare(b.host));
}

const upSet = () => new Set([selfHost, ...peers.upPeers()]);

const edgeIPs = (d: Domain, up?: Set<string>) => {
  const pub = new Map(publicHosts().map((h) => [h.host, h.ip]));
  return d.edges.filter((h) => pub.has(h) && (!up || up.has(h))).map((h) => pub.get(h)!);
};

// the edge among those up that orders the certificate
const leader = (d: Domain) => {
  const up = upSet();
  return d.edges.filter((h) => up.has(h)).sort()[0] ?? "";
};

// --- the zone -------------------------------------------------------------------

let zone: dns.Zone | undefined;
let zoneSig = "";

function zoneSpec(d: Domain): dns.ZoneSpec {
  const all = edgeIPs(d);
  const up = edgeIPs(d, upSet());
  const hosts: Record<string, string[]> = {};
  const c = peers.control.control();
  if (c) {
    const name = new URL(c.url).hostname;
    const ip = publicHosts().find((h) => h.host === c.host)?.ip;
    if (ip && name.endsWith(`.${d.name}`)) hosts[name.slice(0, -(d.name.length + 1))] = [ip];
  }
  const srv: dns.Srv[] = [];
  for (const p of ports())
    if (p.srv) srv.push({ name: p.name, service: p.srv, proto: p.proto, port: p.pub, target: `${p.name}.${d.name}` });
  return { domain: d.name, edges: up.length ? up : all, hosts, txt: challenge(), srv, serial: 0 };
}

function refreshZone(d: Domain) {
  const spec = zoneSpec(d);
  const sig = marshal(spec);
  if (sig === zoneSig) return;
  zoneSig = sig;
  spec.serial = Math.floor(now() / 1000);
  zone = dns.build(spec);
}

// --- serving here ------------------------------------------------------------------

let served: dns.Served | undefined;
let servedAddrs = "";
let dnsState = "off";
let splitter: Split | undefined;
let tlsServer: Server<WSData> | undefined;
let tlsSig = "";
let tlsState = "off";
let forwarded: Forwarded | undefined;
let busy = false;

async function serveDNS(on: boolean) {
  const ip = publicIPv4();
  const tail = await tailnetIP(selfHost);
  const addrs = on ? [ip, tail].filter(Boolean) : [];
  const key = addrs.join(",");
  if (key === servedAddrs && (served || !on)) return;
  served?.close();
  served = undefined;
  servedAddrs = key;
  if (!addrs.length) {
    dnsState = "off";
    return;
  }
  try {
    served = await dns.serve({ addrs, port: dnsPort, zone: () => zone, log: (m) => notes.note("dns", m) });
    dnsState = "serving";
    notes.note("dns:on", `dns for ${baseDomain} on ${addrs.join(", ")}`);
  } catch (e) {
    dnsState = `can't serve on port ${dnsPort}: ${errText(e)}`;
    notes.note("dns:on", dnsState);
  }
}

function serveTLS(on: boolean) {
  if (!on) {
    splitter?.stop();
    splitter = undefined;
    tlsServer?.stop(true);
    tlsServer = undefined;
    tlsSig = "";
    tlsState = "off";
    return;
  }
  if (!splitter) {
    try {
      splitter = split(httpsPort);
      notes.note("443", `443 split on this edge`);
      // a fresh splitter: the certificate's state worked out again below
      tlsSig = "\0";
    } catch (e) {
      tlsState = `can't listen on ${httpsPort}: ${errText(e)}`;
      notes.note("443", tlsState);
      return;
    }
  }
  const c = peers.control.control();
  if (c && c.host === selfHost) splitter.setControl(new URL(c.url).hostname, ControlBehindPort);
  else splitter.setControl("", 0);
  const t = tls();
  const sig = t ? `${t.at}:${t.notAfter}` : "";
  if (sig === tlsSig) return;
  tlsSig = sig;
  const old = tlsServer;
  tlsServer = t
    ? listenTLS({ cert: t.cert, key: t.key }, appHandler, { pass: users.Pass, issuers: users.Issuers })
    : undefined;
  splitter.setIngress(tlsServer?.port ?? 0);
  tlsState = tlsServer ? "serving" : t ? "the certificate didn't load" : "no certificate yet";
  notes.note("tls", tlsServer ? `https served with the certificate of ${new Date(t!.at).toISOString()}` : tlsState);
  // the last server's connections finish on their own
  if (old) setTimeout(() => old.stop(false), 30_000);
}

async function servePorts(on: boolean) {
  if (!on) {
    forwarded?.stop();
    forwarded = undefined;
    return;
  }
  const ips = peers.peerIPs();
  const self = await tailnetIP(selfHost);
  const specs: PortSpec[] = [];
  for (const p of ports()) {
    const ip = p.host === selfHost ? self : ips[p.host];
    if (ip) specs.push({ name: p.name, proto: p.proto, pub: p.pub, ip, port: p.port });
  }
  forwarded = await forwardPorts(specs, forwarded);
}

// --- the certificate ----------------------------------------------------------------

let delegation = { ok: false, why: "not checked yet", at: 0 };
let ordering = false;
let acmeError = "";
let acmeNext = 0;
let acmeBackoff = 0;
let publishedAcme = "";

// the ordering edge's progress into the store, when it changed
function publishAcme() {
  const s = { by: selfHost, delegation: { ok: delegation.ok, why: delegation.why }, ordering, error: acmeError };
  const sig = marshal(s);
  if (sig === publishedAcme) return;
  publishedAcme = sig;
  store.write(acmeStateRel, { ...s, at: now() });
}

// the registrar's delegation as the world's resolvers see it: asked every five
// minutes once it's there, every minute until then
async function checkDelegation(d: Domain) {
  if (now() - delegation.at < (delegation.ok ? 5 * 60_000 : 60_000)) return;
  delegation.at = now();
  const want = zone?.nameservers ?? [];
  const where = want.length
    ? `set its nameservers to ${want.join(" and ")} at the registrar`
    : "pick an edge host first";
  try {
    const ns = (await resolver.resolveNs(d.name)).map((n) => n.toLowerCase().replace(/\.$/, ""));
    if (ns.some((n) => want.includes(n))) delegation = { ok: true, why: "", at: now() };
    else
      delegation = { ok: false, why: `${d.name} points at ${ns.join(", ") || "no nameservers"}: ${where}`, at: now() };
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    delegation = { ok: false, why: `${d.name} isn't delegated yet (${code || errText(e)}): ${where}`, at: now() };
  }
}

// every edge asked over the internet until each serves the texts, a minute and a half at most
async function untilServed(txt: Record<string, string[]>, ips: string[]) {
  const deadline = now() + 90_000;
  while (now() < deadline) {
    let all = true;
    for (const ip of ips)
      for (const [name, values] of Object.entries(txt)) {
        try {
          const r = await dns.query({ server: ip, port: dnsPort, name, type: dns.Type.TXT, timeoutMs: 3000 });
          const got = r.answer.flatMap((a) => (a.data.type === dns.Type.TXT ? a.data.texts : []));
          if (!values.every((v) => got.includes(v))) all = false;
        } catch {
          all = false;
        }
      }
    if (all) {
      await new Promise((r) => setTimeout(r, 2000));
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`the edges never served the challenge: ${ips.join(", ")} on port ${dnsPort}`);
}

async function order(d: Domain) {
  ordering = true;
  publishAcme();
  try {
    let acct = obj(store.read(acmeRel)) as { key: Record<string, string>; kid: string } | undefined;
    if (!acct?.key || !acct.kid) {
      const c = new Client(directory, { key: newAccountKey() });
      acct = await c.register();
      store.write(acmeRel, acct, true);
      notes.log(`registered with ${directory}`);
    }
    const client = new Client(directory, acct);
    const issued = await client.order([d.name, `*.${d.name}`], {
      present: async (txt) => {
        store.write(challengeRel, txt, true);
        await untilServed(txt, edgeIPs(d, upSet()));
      },
      cleanup: () => store.remove(challengeRel),
      log: (m) => notes.log(m),
    });
    store.write(tlsRel, { ...issued, at: now() }, true);
    acmeError = "";
    acmeBackoff = 0;
    notes.log(`certificate for ${d.name} and *.${d.name} until ${new Date(issued.notAfter).toISOString()}`);
  } catch (e) {
    acmeError = errText(e);
    acmeBackoff = Math.min(Math.max(acmeBackoff * 2, 10 * 60_000), 24 * 3600_000);
    acmeNext = now() + acmeBackoff;
    notes.note("acme", `couldn't get the certificate, again in ${Math.round(acmeBackoff / 60_000)} min: ${acmeError}`);
  } finally {
    ordering = false;
    publishAcme();
  }
}

async function renew(d: Domain) {
  if (ordering || leader(d) !== selfHost || tlsCovers(tls(), d.name) || now() < acmeNext) return;
  await checkDelegation(d);
  publishAcme();
  if (!delegation.ok) {
    acmeNext = now() + 60_000;
    return;
  }
  await order(d);
}

// --- the tick ------------------------------------------------------------------------

// an edge: named in the domain's edges, Linux with a public address, the domain the
// one this frontend was started with (a changed one restarts it)
const isEdge = (d: Domain | undefined): d is Domain =>
  !!d && d.name === baseDomain && d.edges.includes(selfHost) && getPlatform() === "linux" && !!publicIPv4();

export async function edgeTick() {
  if (busy) return;
  busy = true;
  try {
    const d = domain();
    const mine = isEdge(d);
    if (mine) refreshZone(d);
    else {
      zone = undefined;
      zoneSig = "";
    }
    await serveDNS(mine);
    serveTLS(mine);
    await servePorts(mine);
    if (mine) await renew(d);
    notes.clear("tick");
  } catch (e) {
    notes.note("tick", `edge tick failed, still retrying: ${errText(e)}`);
  } finally {
    busy = false;
  }
}

export function startEdge() {
  void edgeTick();
  setInterval(() => void edgeTick(), 5000);
}

export function stopEdge() {
  served?.close();
  splitter?.stop();
  tlsServer?.stop(true);
  forwarded?.stop();
}

// this host's part, for its info.json
export const edgeInfo = (): EdgeInfo | undefined =>
  isEdge(domain()) ? { dns: dnsState, tls: tlsState, ports: forwarded?.status() ?? {} } : undefined;

// the mesh's domain as settings › network shows it
export function edgeStatus(): EdgeStatus {
  const d = domain();
  const infos = hostsInfo();
  const pub = new Map(publicHosts().map((h) => [h.host, h.ip]));
  const up = upSet();
  const edges = (d?.edges ?? []).map((host) => ({
    host,
    ip: pub.get(host) ?? "",
    up: up.has(host),
    info: (obj(infos[host])?.edge as EdgeInfo | undefined) ?? undefined,
  }));
  const ips = edges.filter((e) => e.ip).map((e) => e.ip);
  const names =
    d && ips.length ? Array.from({ length: Math.max(2, ips.length) }, (_, i) => `ns${i + 1}.${d.name}`) : [];
  const t = tls();
  const a = acmeState();
  const tlsOut: EdgeStatus["tls"] = { state: "none", by: d ? leader(d) : "" };
  if (t && d && t.names.includes(d.name)) {
    tlsOut.state = tlsCovers(t, d.name) ? "valid" : "expiring";
    tlsOut.notAfter = t.notAfter;
    tlsOut.names = t.names;
  }
  if (a?.ordering) tlsOut.state = "ordering";
  if (a?.error) tlsOut.error = a.error;
  const open: Record<string, string> = {};
  for (const e of edges) for (const [k, v] of Object.entries(e.info?.ports ?? {})) open[k] = v;
  return {
    domain: d?.name ?? "",
    edges,
    candidates: publicHosts(),
    nameservers: names.map((name, i) => ({ name, ip: ips[i % ips.length]! })),
    delegation: d && a ? a.delegation : { ok: false, why: d ? "not checked yet" : "" },
    tls: tlsOut,
    ports: ports().map((p) => ({ ...p, open: open[`${p.proto}:${p.pub}`] ?? "" })),
  };
}
