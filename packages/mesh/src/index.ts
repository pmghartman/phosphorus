// the one loop on the clock, own services refreshed, every tailnet peer
// polled, both merged into the routing table
import { join } from "node:path";
import { FastMS, IdleMS, intervalMS, isHot, markHot } from "@phosphorus/clock";
import { Server as DNSServer, Zone } from "@phosphorus/gamedns";
import { pinTargets, type Row, rowError, swap } from "@phosphorus/proxy";
import { refresh } from "@phosphorus/services";
import { type Peer as SSHPeer, writeConfig } from "@phosphorus/sshrelay";
import { env, errText, flushWrites, FrontendPort, isIPv4, localeCompare, marshal, Notes, noteTailnetIPs, now, obj, requestJSON, run, SelfHost, sleep, StateDir, writeFileAtomic } from "@phosphorus/util";

const selfHost = SelfHost;
const selfHostFile = join(StateDir, "self-host");
const sshConfigFile = join(StateDir, "ssh_config");
const tsAPIKey = env("TS_API_KEY");
const notes = new Notes("mesh");
const missThreshold = Math.max(3, Math.ceil(1500 / FastMS));

const pollTimeout = 700;
// a relayed or far peer's: a few of its own round trips, a quiet one's retry the longest
const pollTimeoutMax = 3000;
// a quiet peer (a phone, a host without phosphorus) tried this often, off the tick
const quietRetryMS = 3000;
const discoverIdleMS = 5000;
const discoverHotMS = 1000;
const gitMaxAgeMS = 3000;
const modelMaxAgeMS = 5000;
const tsAPI = "https://api.tailscale.com/api/v2";
const splitDNSMS = 30000;
const guestTTLMS = 3 * 24 * 3600 * 1000;
const guestSweepMS = 10 * 60 * 1000;

// server's: chat and presence in, own platform and lock out
export type Hooks = {
  mergeChat?: (chat: any[]) => void;
  mergePresence?: (peers: Record<string, any[]>) => void;
  platform?: () => string;
  ownLock?: () => unknown;
  // a peer's rows as sysfs published them, undefined for the snapshot's own
  hostServices?: (host: string) => Row[] | undefined;
};

const hooks: Required<Hooks> = {
  mergeChat: () => {},
  mergePresence: () => {},
  platform: () => "",
  ownLock: () => null,
  hostServices: () => undefined,
};

// Go's truthy: false, nil, 0, NaN and "" are false
const truthy = (v: unknown) => (typeof v === "number" ? v !== 0 && !Number.isNaN(v) : !!v);
// as a JS template literal renders a JSON value
const jsString = (v: unknown): string =>
  v == null ? "null" : Array.isArray(v) ? v.map((e) => (e == null ? "" : jsString(e))).join(",") : typeof v === "object" ? "[object Object]" : String(v);
const str = (v: unknown) => (truthy(v) ? jsString(v) : "");

// --- discovery -------------------------------------------------------------

type Peer = { host: string; ip: string; os: string; online: boolean };
type TSNode = { DNSName?: string; TailscaleIPs?: string[] | null; Online?: boolean; OS?: string; Tags?: string[] | null };

let selfIP = "";
let hostIPs = new Map<string, string>();
const offlineSince = new Map<string, number>();
let lastDiscover = 0;
let lastPeers: Peer[] = [];
let hasPeers = false;
// tailnet address -> trusted, tag:guest devices false
let trustIPs = new Map<string, boolean>();
let trustAt = 0;

// a tailnet DNS name as supervisor.sh derives SELF_HOST
export function hostOf(dns: string): string {
  const s = dns.replace(/\.$/, "").split(".")[0]!.toLowerCase();
  return s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const v4 = (ips: string[]) => ips.find((a) => a.includes(".")) ?? "";

async function discoverPeers(): Promise<Peer[] | undefined> {
  // the live PATH, as Go's exec looked tailscale up; Bun's default is the one at startup
  const r = await run(["tailscale", "status", "--json"], { timeoutMs: 3000, env: process.env });
  let status: Record<string, any> | undefined;
  let err = r.error ?? (r.ok ? "" : r.stderr.trim() || `exit status ${r.code}`);
  if (!err) {
    try {
      status = obj(JSON.parse(r.stdout));
    } catch (e) {
      err = errText(e);
    }
  }
  if (!status) {
    notes.note("tailscale", "can't reach tailscaled to list peers: " + (err || "not an object"));
    return;
  }
  notes.clear("tailscale");
  const self: TSNode = obj(status.Self) ?? {};
  const nodes: Record<string, TSNode | null> = obj(status.Peer) ?? {};
  const trust = new Map<string, boolean>();
  for (const a of self.TailscaleIPs ?? []) trust.set(a, true);
  for (const p of Object.values(nodes)) {
    const guest = (p?.Tags ?? []).includes("tag:guest");
    for (const a of p?.TailscaleIPs ?? []) trust.set(a, !guest);
  }
  selfIP = v4(self.TailscaleIPs ?? []);
  trustIPs = trust;
  if (selfHost) {
    const renamed = hostOf(self.DNSName ?? "");
    if (renamed && renamed !== selfHost) {
      notes.log(`renamed on the tailnet to ${renamed}, restarting to follow`);
      await flushWrites();
      process.exit(1);
    }
  }
  const peers: Peer[] = [];
  for (const k of Object.keys(nodes).sort()) {
    const p = nodes[k] ?? {};
    const h = hostOf(p.DNSName ?? "");
    if (!h || h === selfHost) continue;
    peers.push({ host: h, ip: v4(p.TailscaleIPs ?? []) || h, os: p.OS ?? "", online: p.Online === true });
  }
  return peers;
}

// a tailnet address of this tailnet's own devices, tag:guest ones not;
// an unknown one looked up again, at most once a second
export async function trusted(ip: string): Promise<boolean> {
  const known = trustIPs.get(ip);
  if (known !== undefined) return known;
  if (now() - trustAt >= 1000) {
    trustAt = now();
    await discoverPeers();
  }
  return trustIPs.get(ip) ?? false;
}

// per host, only while tailscale itself still answers
export function offlineMS(): Record<string, number> {
  const out: Record<string, number> = {};
  if (now() - lastDiscover > 3 * discoverIdleMS) return out;
  for (const [h, t] of offlineSince) out[h] = now() - t;
  return out;
}

async function knownPeers(): Promise<[Peer[], boolean]> {
  const maxAge = isHot() ? discoverHotMS : discoverIdleMS;
  if (hasPeers && now() - lastDiscover < maxAge) return [lastPeers, true];
  const found = await discoverPeers();
  if (!found) return [lastPeers, hasPeers];
  lastDiscover = now();
  const online = new Set(found.filter((p) => p.online).map((p) => p.host));
  for (const h of online) offlineSince.delete(h);
  for (const p of [...found, ...lastPeers]) if (!online.has(p.host) && !offlineSince.has(p.host)) offlineSince.set(p.host, lastDiscover);
  lastPeers = found;
  hasPeers = true;
  return [found, true];
}

// --- peer polling ----------------------------------------------------------

type PeerState = {
  entries: Row[];
  presence: any[];
  lock: Record<string, any> | null;
  chain: Record<string, any> | null;
  git: Record<string, any> | null;
  model: Record<string, any> | null;
  platform: string;
  version: string;
  misses: number;
  lastSeq: number;
  chat?: any[];
  answered: boolean;
  everAnswered: boolean;
  fp: string;
  sys: string;
  answeredAt: number;
  took: number;
  nextTry: number;
  trying: boolean;
};

const peerStates = new Map<string, PeerState>();

function stateFor(h: string): PeerState {
  let s = peerStates.get(h);
  if (!s) {
    s = { entries: [], presence: [], lock: null, chain: null, git: null, model: null, platform: "", version: "", misses: 0, lastSeq: 0, answered: false, everAnswered: false, fp: "", sys: "", answeredAt: 0, took: 0, nextTry: 0, trying: false };
    peerStates.set(h, s);
  }
  return s;
}

function retire(st: PeerState) {
  st.entries = [];
  st.presence = [];
  st.lock = st.chain = st.git = st.model = null;
}

async function fetchSnapshot(host: string, path: string, wait: number): Promise<Record<string, any>> {
  const r = await requestJSON({ host, port: FrontendPort, path, timeoutMs: wait });
  const m = r.status === 200 ? obj(r.body) : undefined;
  if (!m) throw new Error(`status ${r.status}`);
  return m;
}

// an object, with key truthy when given, else null
function objOrNull(v: unknown, key: string): Record<string, any> | null {
  const m = obj(v);
  return m && (!key || truthy(m[key])) ? m : null;
}

async function pollPeer(p: Peer) {
  const st = stateFor(p.host);
  const since = st.lastSeq;
  let wait = Math.min(Math.max(pollTimeout, 4 * st.took), pollTimeoutMax);
  if (st.misses >= missThreshold) wait = pollTimeoutMax;
  const t0 = now();
  let snap: Record<string, any>;
  try {
    snap = await fetchSnapshot(p.ip, `/api/mesh/snapshot?since=${since}`, wait);
  } catch {
    st.misses++;
    st.chat = undefined;
    // hot only while a peer that answered goes quiet, until it's called gone
    if (st.answered && st.misses <= missThreshold) markHot();
    if (st.misses >= missThreshold) retire(st);
    notes.note("peer:" + p.host, `${p.host} is not answering on port ${FrontendPort}, is phosphorus running there?`);
    return;
  }
  const took = now() - t0;
  const published = hooks.hostServices(p.host);
  const entries: (Row | undefined)[] = published ?? (Array.isArray(snap.services) ? snap.services.map(obj) : []);
  let bad = "";
  for (const e of entries) if ((bad = rowError(e))) break;
  if (bad) notes.note("bad:" + p.host, `${p.host} published a bad service, keeping its last good list: ${bad}`);
  else {
    st.entries = entries as Row[];
    notes.clear("bad:" + p.host);
  }
  st.presence = Array.isArray(snap.presence) ? snap.presence : [];
  st.chat = Array.isArray(snap.chat) ? snap.chat : undefined;
  const self = obj(snap.self);
  if (typeof self?.platform === "string") st.platform = self.platform;
  if (typeof self?.version === "string") st.version = self.version;
  st.lock = objOrNull(snap.lock, "initiator");
  st.chain = objOrNull(snap.chain, "initiator");
  st.git = objOrNull(snap.git, "");
  st.model = objOrNull(snap.model, "");
  st.sys = typeof snap.sysDigest === "string" ? snap.sysDigest : "";
  st.answeredAt = now();
  st.took = took;
  const fp = marshal([st.entries, st.presence, st.lock, st.chain, st.platform, st.version, st.sys]);
  const hot = fp !== st.fp || (st.chat?.length ?? 0) > 0 || !st.answered;
  st.fp = fp;
  st.misses = 0;
  st.answered = true;
  st.everAnswered = true;
  notes.note("peer:" + p.host, p.host + " is online");
  if (hot) markHot();
}

let lastPresence = "";

const sortedHosts = () => [...peerStates.keys()].sort();

function handOn() {
  const peers: Record<string, any[]> = {};
  const arrived: PeerState[] = [];
  for (const h of sortedHosts()) {
    const st = peerStates.get(h)!;
    if (st.presence.length) peers[h] = st.presence;
    if (st.chat?.length) arrived.push(st);
  }
  if (arrived.length) {
    hooks.mergeChat(arrived.flatMap((st) => st.chat!));
    for (const st of arrived) {
      for (const x of st.chat!) {
        const s = obj(x)?.seq;
        if (typeof s === "number" && s > st.lastSeq) st.lastSeq = s;
      }
      st.chat = undefined;
    }
  }
  const j = marshal(peers);
  if (j !== lastPresence) {
    lastPresence = j;
    hooks.mergePresence(peers);
  }
}

// --- games and split DNS ---------------------------------------------------

let gameIPs = new Map<string, string>();
let gameDNS: DNSServer | undefined;

function mapGames(rows: Row[]): Map<string, string> {
  const rank = (r: Row) => (r.status === "online" ? "0:" : "1:") + (typeof r.host === "string" ? r.host : "");
  const games = rows.filter((r) => r.type === "game").sort((a, b) => localeCompare(rank(a), rank(b)));
  const out = new Map<string, string>();
  for (const r of games) {
    const name = jsString(r.name);
    if (out.has(name)) {
      const first = games.find((g) => jsString(g.name) === name)?.host;
      notes.note("dup:" + name, `game ${name} is declared on more than one host, ${name}.${Zone} goes to ${typeof first === "string" ? first : ""}`);
      continue;
    }
    const ip = hostIPs.get(typeof r.host === "string" ? r.host : "") ?? "";
    if (isIPv4(ip)) out.set(name, ip);
  }
  return out;
}

async function tsAPICall(method: string, path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = { Authorization: "Bearer " + tsAPIKey };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(tsAPI + path, { method, headers, body: body !== undefined ? marshal(body) : undefined, signal: AbortSignal.timeout(10000) });
  const text = await res.text();
  if (res.status === 401) throw new Error("TS_API_KEY was rejected, expired? renew it in .env");
  if (res.status < 200 || res.status >= 300) throw new Error(`${method} ${path} got status ${res.status}: ${text.trim()}`);
  return text ? JSON.parse(text) : null;
}

let lastSplitSync = 0, lastGuestSweep = 0;

function syncSplitDNS(ns: string[]) {
  if (!tsAPIKey) {
    notes.note("split-dns", `TS_API_KEY unset, keep the .${Zone} split DNS nameservers in the Tailscale admin console by hand`);
    return;
  }
  if (!ns.length || now() - lastSplitSync < splitDNSMS) return;
  lastSplitSync = now();
  void (async () => {
    try {
      const cur = obj(await tsAPICall("GET", "/tailnet/-/dns/split-dns"))?.[Zone];
      const have = (Array.isArray(cur) ? cur.map(jsString) : []).sort();
      if (have.join(",") !== ns.join(",")) {
        await tsAPICall("PATCH", "/tailnet/-/dns/split-dns", { [Zone]: ns });
        notes.log(`split DNS for .${Zone} now points at ${ns.join(", ")}`);
      }
      notes.clear("split-dns");
    } catch (e) {
      notes.note("split-dns", `couldn't sync the .${Zone} split DNS, still retrying: ${errText(e)}`);
    }
  })();
}

function sweepGuests() {
  if (!tsAPIKey || now() - lastGuestSweep < guestSweepMS) return;
  lastGuestSweep = now();
  void (async () => {
    try {
      const devs = obj(await tsAPICall("GET", "/tailnet/-/devices"))?.devices;
      for (const d of Array.isArray(devs) ? devs : []) {
        const dm = obj(d) ?? {};
        if (!(Array.isArray(dm.tags) ? dm.tags : []).includes("tag:guest")) continue;
        // an unreadable created date counts as long past, as Go's zero time did
        if (now() - Date.parse(jsString(dm.created)) < guestTTLMS) continue;
        await tsAPICall("DELETE", "/device/" + (str(dm.nodeId) || str(dm.id)));
        notes.log(`removed guest ${jsString(dm.hostname)}, past 3 days`);
      }
      notes.clear("guests");
    } catch (e) {
      notes.note("guests", "couldn't sweep guest devices, still retrying: " + errText(e));
    }
  })();
}

// --- the tick --------------------------------------------------------------

let devices: Row[] = [];
let curRoutes: Row[] = [];
let curLock: unknown = null;
let curChain: unknown = null;
let lastOwnFp = "";

// phosphorus peers -> tailnet IP, self left out
export function peerIPs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of devices) {
    const name = typeof d.name === "string" ? d.name : "";
    const ip = hostIPs.get(name) ?? "";
    if (d.phosphorus === true && name !== selfHost && isIPv4(ip)) out[name] = ip;
  }
  return out;
}

async function tick() {
  const [peers, ok] = await knownPeers();
  const ownP = refresh(selfIP || selfHost);
  const polls: Promise<void>[] = [];
  for (const p of peers) {
    // tailscale's online flag flaps for idle peers: one still answering polled anyway
    if (!p.online && !stateFor(p.host).answered) continue;
    const st = stateFor(p.host);
    const quiet = st.misses >= missThreshold;
    const due = !quiet || (!st.trying && now() >= st.nextTry);
    if (!due) continue;
    if (quiet) {
      // never waited on, so its timeout holds no tick
      st.trying = true;
      st.nextTry = now() + quietRetryMS;
      void pollPeer(p).finally(() => void (st.trying = false));
    } else polls.push(pollPeer(p));
  }
  const [own] = await Promise.all([ownP, ...polls]);
  handOn();

  const platform = hooks.platform();
  let hot = false;
  if (ok) {
    const seen = new Set(peers.map((p) => p.host));
    for (const h of [...peerStates.keys()]) {
      if (seen.has(h)) continue;
      peerStates.delete(h);
      notes.clear("peer:" + h);
      hot = true;
      notes.log(h + " left the tailnet");
    }
    const next: Row[] = [];
    if (selfHost) next.push({ name: selfHost, os: platform, phosphorus: true, phosphorusSeen: true });
    for (const p of peers) {
      const st = stateFor(p.host);
      // its routes kept until it misses polls, never dropped on tailscale's flag alone
      const ph = st.answered && st.misses < missThreshold;
      if (!ph && !p.online) continue;
      // the version the host last reported, kept while it isn't answering
      next.push({ name: p.host, os: ph ? st.platform : p.os, phosphorus: ph, phosphorusSeen: st.everAnswered, version: st.version });
    }
    devices = next;
    hostIPs = new Map(peers.map((p) => [p.host, p.ip]));
    if (selfHost && selfIP) hostIPs.set(selfHost, selfIP);
    noteTailnetIPs(Object.fromEntries(hostIPs));
    pinTargets(peerIPs());
  }

  const mine: Row[] = own.map((r) => ({ ...r, host: selfHost }));
  const fp = marshal(mine);
  if (fp !== lastOwnFp) {
    lastOwnFp = fp;
    hot = true;
  }
  const merged = [...mine];
  for (const [h, st] of peerStates) for (const e of st.entries) merged.push({ ...e, host: h });
  const hostOfRow = (r: Row) => (typeof r.host === "string" ? r.host : "");
  merged.sort((a, b) => localeCompare(hostOfRow(a), hostOfRow(b)) || localeCompare(jsString(a.name), jsString(b.name)));
  curRoutes = merged;
  const ips = new Map(hostIPs);
  const hosts = sortedHosts();
  curLock = hosts.map((h) => peerStates.get(h)!.lock).find((l) => l != null) ?? null;
  curChain = curLock;
  if (curChain == null) {
    let best: Record<string, any> | undefined;
    for (const h of hosts) {
      const c = peerStates.get(h)!.chain;
      if (c && (!best || jsString(c.startedAt) > jsString(best.startedAt))) best = c;
    }
    if (best) curChain = best;
  }
  const held = curLock != null;
  gameIPs = mapGames(merged);
  const selfIPNow = selfIP;
  const livePeers: SSHPeer[] = peers.map((p) => ({ host: p.host, ip: p.ip }));
  const live = devices.filter((d) => d.phosphorus === true).map((d) => String(d.name)).sort();
  const ns = live.map((m) => hostIPs.get(m) ?? "").filter(isIPv4).sort();

  swap(merged, (h) => ips.get(h) ?? "");
  if (held || hooks.ownLock() != null) hot = true;
  gameDNS?.bind(selfIPNow);
  if (ok) {
    try {
      writeConfig(sshConfigFile, livePeers);
      notes.clear("ssh-config");
    } catch (e) {
      notes.note("ssh-config", `can't write ${sshConfigFile}: ${errText(e)}`);
    }
  }
  if (selfHost && live.length && live[0] === selfHost) {
    syncSplitDNS(ns);
    sweepGuests();
  }
  if (hot) markHot();
}

// the loop, each round done before the next is timed
export function start(h: Hooks) {
  if (h.mergeChat) hooks.mergeChat = h.mergeChat;
  if (h.mergePresence) hooks.mergePresence = h.mergePresence;
  if (h.platform) hooks.platform = h.platform;
  if (h.ownLock) hooks.ownLock = h.ownLock;
  if (h.hostServices) hooks.hostServices = h.hostServices;
  gameDNS = new DNSServer((name) => gameIPs.get(name) ?? "", (k, m) => notes.note(k, m));
  if (selfHost) writeFileAtomic(selfHostFile, selfHost);
  markHot();
  notes.log(`polling every online tailnet peer every ${FastMS}ms while the mesh is busy, every ${IdleMS}ms once it is quiet`);
  void (async () => {
    for (;;) {
      try {
        await tick();
        notes.clear("tick");
      } catch (e) {
        notes.note("tick", `tick failed, still retrying: ${errText(e)}`);
      }
      await sleep(intervalMS());
    }
  })();
}

// the merged service rows
export const routes = () => curRoutes;

// every device as the update pane lists them
export const tailnet = () => devices;

// a peer's running update chain
export const lock = () => curLock;

// the live walk, else the newest finished one
export const chain = () => curChain;

const answeredWithin = (st: PeerState, ms: number) => now() - st.answeredAt <= ms;

// answered within the git max age
export function peerGit(): any[] {
  const out: any[] = [];
  for (const h of sortedHosts()) {
    const st = peerStates.get(h)!;
    if (answeredWithin(st, gitMaxAgeMS) && st.git) out.push(st.git);
  }
  return out;
}

// answered within the model max age
export function peerModel(): any[] {
  const out: any[] = [];
  for (const h of sortedHosts()) {
    const st = peerStates.get(h)!;
    if (answeredWithin(st, modelMaxAgeMS) && st.model) out.push(st.model);
  }
  return out;
}

// each answering peer's sys digest
export function peerSys(): { host: string; digest: string }[] {
  const out: { host: string; digest: string }[] = [];
  for (const h of sortedHosts()) {
    const st = peerStates.get(h)!;
    if (st.sys && st.answered) out.push({ host: h, digest: st.sys });
  }
  return out;
}
