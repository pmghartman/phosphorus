// the mesh as this host sees it: the tailnet asked who is there, one socket to
// each phosphorus peer carrying state, chat and the store's changes as they
// happen, and the views the rest of the host reads: routes, devices, locks,
// the git and model states of live peers
import { join } from "node:path";
import { pinTargets, type Row, rowError, swap } from "@phosphorus/proxy";
import { refresh } from "@phosphorus/services";
import * as store from "@phosphorus/store";
import {
  errText,
  FrontendPort,
  intervalMS,
  isHot,
  isIPv4,
  isLoopbackAddr,
  localeCompare,
  markHot,
  marshal,
  Notes,
  noteTailnetIPs,
  now,
  obj,
  onHot,
  SelfHost,
  StateDir,
  sleep,
  writeFileAtomic,
} from "@phosphorus/util";
import { PeerCloseWrongHost, type PeerFrame, type PeerHello, type PeerReq, type PeerState } from "@phosphorus/wire";
import type { Conn } from "@phosphorus/wsock";
import {
  DiscoverIdleMS,
  discovered,
  hostOf,
  lastKnown,
  offlineMS,
  type Peer,
  refreshPeers,
  selfIPNow,
  trusted,
} from "./discovery.ts";
import { bindGameDNS, jsString, mapGames, startGameDNS, sweepGuests, syncSplitDNS, truthy } from "./dns.ts";
import { HostHeader, Link } from "./link.ts";
import { type Peer as SSHPeer, writeConfig } from "./ssh.ts";

export { HostHeader, hostOf, offlineMS, trusted };

const selfHost = SelfHost;
const selfHostFile = join(StateDir, "self-host");
const sshConfigFile = join(StateDir, "ssh_config");
const notes = new Notes("mesh");

const discoverHotMS = 1000;
// discovery kept fast this long after the tailnet changed
const discoverHotFor = 10_000;
// a peer tailscale calls offline still dialled this long after it was last up: the flag flaps
const dialAfterDownMs = 10 * 60 * 1000;
// a peer's state frame older than this is no longer believed, link or no link
const stateMaxAgeMS = 15_000;
// own state pushed in full this often, the changed keys at once
const fullStateMS = 10_000;
const stateCoalesceMS = 250;
const digestEveryMS = 10_000;
const pullBatch = 40;

// --- hooks: the server's side ----------------------------------------------------

export type Own = {
  presence: unknown[];
  lock: unknown;
  chain: unknown;
  git: unknown;
  model: unknown;
};

export type Hooks = {
  mergeChat?: (chat: any[]) => void;
  mergePresence?: (peers: Record<string, any[]>) => void;
  platform?: () => string;
  ownLock?: () => unknown;
  // a peer's rows as the store published them, undefined before they arrived
  hostServices?: (host: string) => Row[] | undefined;
  // this host's state for its peers
  own?: () => Own;
  // this host's chat lines after seq
  ownChat?: (since: number) => unknown[];
  // the highest seq of a host's lines already held here
  chatSince?: (host: string) => number;
  self?: () => { version: string; bootId: string };
};

const hooks: Required<Hooks> = {
  mergeChat: () => {},
  mergePresence: () => {},
  platform: () => "",
  ownLock: () => null,
  hostServices: () => undefined,
  own: () => ({ presence: [], lock: null, chain: null, git: null, model: null }),
  ownChat: () => [],
  chatSince: () => 0,
  self: () => ({ version: "", bootId: "" }),
};

// --- what each peer last said --------------------------------------------------------

type PeerInfo = {
  host: string;
  link?: Link;
  everUp: boolean;
  platform: string;
  version: string;
  presence: any[];
  lock: Record<string, any> | null;
  chain: Record<string, any> | null;
  git: Record<string, any> | null;
  model: Record<string, any> | null;
  services: Row[];
  stateAt: number;
  // the far side's digest as last heard, and the one already matched
  digest: string;
  synced: string;
  // the keys of own state last sent, by key
  sentState: Record<string, string>;
  sentAllAt: number;
};

const infos = new Map<string, PeerInfo>();

function infoFor(host: string): PeerInfo {
  let s = infos.get(host);
  if (!s) {
    s = {
      host,
      everUp: false,
      platform: "",
      version: "",
      presence: [],
      lock: null,
      chain: null,
      git: null,
      model: null,
      services: [],
      stateAt: 0,
      digest: "",
      synced: "",
      sentState: {},
      sentAllAt: 0,
    };
    infos.set(host, s);
  }
  return s;
}

const isUp = (s: PeerInfo) => !!s.link?.up;
const sortedHosts = () => [...infos.keys()].sort();
const upHosts = () => sortedHosts().filter((h) => isUp(infos.get(h)!));

// an object, with key truthy when given, else null
function objOrNull(v: unknown, key: string): Record<string, any> | null {
  const m = obj(v);
  return m && (!key || truthy(m[key])) ? m : null;
}

// a peer's state frame taken in; true when anything it holds changed
function applyState(s: PeerInfo, f: PeerState): boolean {
  const before = marshal([s.presence, s.lock, s.chain, s.git, s.model, s.services]);
  if ("presence" in f) s.presence = Array.isArray(f.presence) ? f.presence : [];
  if ("lock" in f) s.lock = objOrNull(f.lock, "initiator");
  if ("chain" in f) s.chain = objOrNull(f.chain, "initiator");
  if ("git" in f) s.git = objOrNull(f.git, "");
  if ("model" in f) s.model = objOrNull(f.model, "");
  if ("services" in f) {
    const entries = (Array.isArray(f.services) ? f.services : []).map(obj);
    let bad = "";
    for (const e of entries) if ((bad = rowError(e))) break;
    if (bad) notes.note(`bad:${s.host}`, `${s.host} published a bad service, keeping its last good list: ${bad}`);
    else {
      s.services = entries as Row[];
      notes.clear(`bad:${s.host}`);
    }
  }
  s.stateAt = now();
  return before !== marshal([s.presence, s.lock, s.chain, s.git, s.model, s.services]);
}

let lastPresence = "";
function handPresence() {
  const peers: Record<string, any[]> = {};
  for (const h of upHosts()) {
    const s = infos.get(h)!;
    if (s.presence.length) peers[h] = s.presence;
  }
  const j = marshal(peers);
  if (j === lastPresence) return;
  lastPresence = j;
  hooks.mergePresence(peers);
}

// --- the links -------------------------------------------------------------------------

const helloFrame = (): PeerHello => {
  const self = hooks.self();
  return {
    type: "hello",
    host: selfHost,
    version: self.version,
    platform: hooks.platform(),
    bootId: self.bootId,
    storeDigest: store.digest(),
    storeSeq: store.seq(),
    chatSince: 0,
  };
};

// the dialling side: this host's name sorts first
const dials = (host: string) => selfHost < host;

const events = {
  hello: () => helloFrame(),
  onHello(link: Link, hello: PeerHello): boolean {
    if (hello.host !== link.host) return false;
    return true;
  },
  onUp(link: Link) {
    const s = infoFor(link.host);
    const h = link.hello!;
    s.everUp = true;
    s.platform = h.platform;
    s.version = h.version;
    s.digest = h.storeDigest;
    s.sentState = {};
    s.stateAt = now();
    notes.note(`peer:${link.host}`, `${link.host} is online`);
    // everything the far side wants, now: the state, its missing chat, the store
    sendState(s, true);
    const lines = hooks.ownChat(h.chatSince);
    if (lines.length) link.send({ type: "chat", lines });
    link.sent = store.seq();
    if (h.storeDigest !== store.digest()) void syncWith(link);
    rebuildDevices(lastKnown());
    markHot();
  },
  onDialError(link: Link, why: string) {
    notes.note(`dial:${link.host}`, `can't reach ${link.host} at ${link.ip}:${FrontendPort}: ${why}`);
  },
  onDown(link: Link) {
    const s = infos.get(link.host);
    if (s) {
      s.presence = [];
      s.lock = s.chain = s.git = s.model = null;
      s.synced = "";
    }
    notes.note(`peer:${link.host}`, `${link.host} is not answering on its link, is phosphorus running there?`);
    handPresence();
    rebuildDevices(lastKnown());
    markHot();
  },
  onFrame(link: Link, f: PeerFrame) {
    const s = infoFor(link.host);
    switch (f.type) {
      case "state":
        if (applyState(s, f)) {
          handPresence();
          markHot();
        }
        break;
      case "chat":
        if (Array.isArray(f.lines) && f.lines.length) {
          hooks.mergeChat(f.lines);
          markHot();
        }
        break;
      case "store": {
        if (f.files && typeof f.files === "object") {
          store.merge(f.files);
          // a peer's clock too far ahead: its files wait, and the log says so
          const far = Object.values(f.files).filter((x) => store.ahead(obj(x)?.t)).length;
          if (far) store.aheadLog(link.host, far);
        }
        link.cursor = f.seq;
        s.digest = "";
        break;
      }
      case "digest":
        s.digest = f.store;
        if (f.store !== store.digest() && f.store !== s.synced) void syncWith(link);
        break;
    }
  },
  async onReq(_link: Link, req: PeerReq): Promise<unknown> {
    const body = obj(req.body) ?? {};
    switch (req.op) {
      case "store.stamps":
        return store.stamps();
      case "store.files": {
        const rels = Array.isArray(body.rels)
          ? body.rels.filter((r: unknown) => typeof r === "string").slice(0, 200)
          : [];
        return store.dump(rels);
      }
      case "chat.since":
        return hooks.ownChat(typeof body.seq === "number" ? body.seq : 0);
    }
    throw new Error(`no such op ${req.op}`);
  },
};

// a socket a peer dialled, from the frontend's /api/peer
export function acceptLink(conn: Conn, host: string | null, ip: string): boolean {
  const refuse = (why: string) => {
    notes.note(`accept:${host}`, `a link from ${host ?? "an unnamed host"} at ${ip} refused: ${why}`);
    conn.close(PeerCloseWrongHost);
    return false;
  };
  if (!host || !/^[a-z0-9][a-z0-9-]*$/.test(host) || host === selfHost) return refuse("no such name");
  if (dials(host)) return refuse("this host dials it, not the other way");
  const known = lastKnown().find((p) => p.host === host);
  if (!known) return refuse("not on the tailnet");
  // its tailnet address, or this machine's own loopback (a test mesh)
  if (isIPv4(known.ip) && known.ip !== ip && !isLoopbackAddr(ip)) return refuse(`${known.ip} expected`);
  notes.clear(`accept:${host}`);
  const s = infoFor(host);
  s.link ??= new Link(host, ip, events);
  return s.link.attach(conn);
}

// the full exchange with one peer: its versions asked, the newer ones fetched
async function syncWith(link: Link) {
  const s = infoFor(link.host);
  try {
    const st = obj(await link.request("store.stamps"));
    if (!st) return;
    const { rels, ahead } = store.wanted(st);
    for (let i = 0; i < rels.length; i += pullBatch) {
      const got = obj(await link.request("store.files", { rels: rels.slice(i, i + pullBatch) }));
      if (got) store.merge(got);
    }
    // a slow clock's skipped files retried, never marked synced
    if (ahead > 0) return store.aheadLog(link.host, ahead);
    s.synced = link.hello?.storeDigest ?? "";
  } catch (e) {
    notes.note(`sync:${link.host}`, `sync with ${link.host} failed, retrying: ${errText(e)}`);
  }
}

// every live link brought level, for store.pull()
export async function syncStore() {
  await Promise.all(upHosts().map((h) => syncWith(infos.get(h)!.link!)));
}

// the store's changes since what each link last got
function pushStore() {
  for (const h of upHosts()) {
    const link = infos.get(h)!.link!;
    const d = store.since(link.sent);
    if (!d) {
      link.send({ type: "digest", store: store.digest() });
      link.sent = store.seq();
      continue;
    }
    if (Object.keys(d.files).length) link.send({ type: "store", seq: d.seq, files: d.files });
    link.sent = d.seq;
  }
}

// this host's state to one peer: the keys that changed, or all of them
function sendState(s: PeerInfo, all: boolean) {
  const link = s.link;
  if (!link?.up) return;
  const own = hooks.own();
  const keys: Record<string, unknown> = { ...own, services: ownRows };
  const frame: PeerState = { type: "state" };
  let any = false;
  for (const [k, v] of Object.entries(keys)) {
    const j = marshal(v);
    if (!all && s.sentState[k] === j) continue;
    s.sentState[k] = j;
    (frame as unknown as Record<string, unknown>)[k] = v;
    any = true;
  }
  if (all) s.sentAllAt = now();
  if (any) link.send(frame);
}

let stateQueued = false;
function pushState() {
  if (stateQueued) return;
  stateQueued = true;
  setTimeout(() => {
    stateQueued = false;
    for (const h of upHosts()) {
      const s = infos.get(h)!;
      sendState(s, now() - s.sentAllAt > fullStateMS);
    }
  }, stateCoalesceMS);
}

// this host's chat lines to every live peer, as the chat posts them
export function pushChat(lines: unknown[]) {
  if (!lines.length) return;
  for (const h of upHosts()) infos.get(h)!.link!.send({ type: "chat", lines });
}

// the links reconciled with the tailnet: dialled where this host dials, dropped
// for hosts that left
function reconcileLinks(peers: Peer[]) {
  const seen = new Set(peers.map((p) => p.host));
  for (const [h, s] of infos) {
    if (seen.has(h)) continue;
    s.link?.stop();
    infos.delete(h);
    notes.clear(`peer:${h}`);
    notes.log(`${h} left the tailnet`);
    markHot();
  }
  for (const p of peers) {
    if (!dials(p.host)) continue;
    const s = infoFor(p.host);
    const recent = s.link ? now() - s.link.upAt < dialAfterDownMs : false;
    if (!p.online && !recent && !s.link?.up) {
      s.link?.stop();
      s.link = undefined;
      continue;
    }
    if (!s.link) s.link = new Link(p.host, p.ip, events);
    s.link.redial(p.ip);
    s.link.startDialling();
  }
}

// --- the views ---------------------------------------------------------------------------

let devices: Row[] = [];
let hostIPs = new Map<string, string>();
let curRoutes: Row[] = [];
let curLock: unknown = null;
let curChain: unknown = null;
let ownRows: Row[] = [];
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

// the merged service rows
export const routes = () => curRoutes;

// every device as the update pane lists them
export const tailnet = () => devices;

// a peer's running update chain
export const lock = () => curLock;

// the live walk, else the newest finished one
export const chain = () => curChain;

const fresh = (s: PeerInfo) => isUp(s) && now() - s.stateAt <= stateMaxAgeMS;

// live peers' git states
export function peerGit(): any[] {
  const out: any[] = [];
  for (const h of sortedHosts()) {
    const s = infos.get(h)!;
    if (fresh(s) && s.git) out.push(s.git);
  }
  return out;
}

// live peers' model states
export function peerModel(): any[] {
  const out: any[] = [];
  for (const h of sortedHosts()) {
    const s = infos.get(h)!;
    if (fresh(s) && s.model) out.push(s.model);
  }
  return out;
}

// each peer's link, up or not, for the page and tests
export const links = (): Record<string, boolean> =>
  Object.fromEntries(sortedHosts().map((h) => [h, isUp(infos.get(h)!)]));

// tests: a peer's socket dropped
export function dropLink(host: string) {
  infos.get(host)?.link?.drop();
}

// --- the loops ----------------------------------------------------------------------------

// the tailnet read, the device rows and the links following it
let discoverHotUntil = 0;
async function discover() {
  const { peers, ok, changed } = await refreshPeers();
  if (!ok) return;
  if (changed) discoverHotUntil = now() + discoverHotFor;
  reconcileLinks(peers);
  hostIPs = new Map(peers.map((p) => [p.host, p.ip]));
  if (selfHost && selfIPNow()) hostIPs.set(selfHost, selfIPNow());
  noteTailnetIPs(Object.fromEntries(hostIPs));
  if (changed) {
    const livePeers: SSHPeer[] = peers.map((p) => ({ host: p.host, ip: p.ip }));
    try {
      writeConfig(sshConfigFile, livePeers);
      notes.clear("ssh-config");
    } catch (e) {
      notes.note("ssh-config", `can't write ${sshConfigFile}: ${errText(e)}`);
    }
    markHot();
  }
}

function rebuildDevices(peers: Peer[]) {
  const platform = hooks.platform();
  const next: Row[] = [];
  if (selfHost) next.push({ name: selfHost, os: platform, phosphorus: true, phosphorusSeen: true });
  for (const p of peers) {
    const s = infos.get(p.host);
    const ph = !!s && isUp(s);
    // the device kept while its link is up, whatever tailscale's flag says
    if (!ph && !p.online) continue;
    next.push({
      name: p.host,
      os: ph ? s.platform : p.os,
      phosphorus: ph,
      phosphorusSeen: s?.everUp ?? false,
      version: s?.version ?? "",
    });
  }
  devices = next;
  pinTargets(peerIPs());
}

// own services refreshed, the routes merged, the names and locks derived
async function tick() {
  const own = await refresh(selfIPNow() || selfHost);
  let hot = false;
  const peers = lastKnown();
  if (discovered()) rebuildDevices(peers);
  ownRows = own.map((r) => ({ ...r, host: selfHost }));
  const fp = marshal(ownRows);
  if (fp !== lastOwnFp) {
    lastOwnFp = fp;
    hot = true;
    pushState();
  }
  const merged = [...ownRows];
  for (const h of upHosts()) {
    const s = infos.get(h)!;
    const published = hooks.hostServices(h);
    for (const e of published ?? s.services) merged.push({ ...e, host: h });
  }
  const hostOfRow = (r: Row) => (typeof r.host === "string" ? r.host : "");
  merged.sort((a, b) => localeCompare(hostOfRow(a), hostOfRow(b)) || localeCompare(jsString(a.name), jsString(b.name)));
  if (marshal(merged) !== marshal(curRoutes)) hot = true;
  curRoutes = merged;
  const hosts = upHosts();
  curLock = hosts.map((h) => infos.get(h)!.lock).find((l) => l != null) ?? null;
  curChain = curLock;
  if (curChain == null) {
    let best: Record<string, any> | undefined;
    for (const h of hosts) {
      const c = infos.get(h)!.chain;
      if (c && (!best || jsString(c.startedAt) > jsString(best.startedAt))) best = c;
    }
    if (best) curChain = best;
  }
  mapGames(merged, hostIPs);
  const live = devices
    .filter((d) => d.phosphorus === true)
    .map((d) => String(d.name))
    .sort();
  const ns = live
    .map((m) => hostIPs.get(m) ?? "")
    .filter(isIPv4)
    .sort();
  swap(merged, (h) => hostIPs.get(h) ?? "");
  if (curLock != null || hooks.ownLock() != null) hot = true;
  bindGameDNS(selfIPNow());
  if (selfHost && live.length && live[0] === selfHost) {
    syncSplitDNS(ns);
    sweepGuests();
  }
  if (hot) markHot();
}

// the loops: discovery on its own clock, the tick on the mesh's, the pushes on changes
export function start(h: Hooks) {
  Object.assign(hooks, Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined)));
  startGameDNS();
  if (selfHost) writeFileAtomic(selfHostFile, selfHost);
  store.setSyncer(syncStore);
  store.onDelta(pushStore);
  onHot(pushState);
  markHot();
  notes.log("one link to each phosphorus peer, the tailnet asked who is there every few seconds");
  void (async () => {
    for (;;) {
      try {
        await discover();
      } catch (e) {
        notes.note("discover", `discovery failed, still retrying: ${errText(e)}`);
      }
      await sleep(now() < discoverHotUntil || isHot() ? discoverHotMS : DiscoverIdleMS);
    }
  })();
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
  setInterval(() => {
    for (const h of upHosts()) infos.get(h)!.link!.send({ type: "digest", store: store.digest() });
  }, digestEveryMS);
}
