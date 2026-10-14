'use strict';
// the one loop on the clock: own services refreshed, every tailnet peer
// polled, both merged into the routing table, chat and presence handed on

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const clock = require('./clock');
const proxy = require('./proxy');
const services = require('./services');
const { createGameDns, ZONE } = require('./game-dns');
const { createSshInbound, writeSshConfig } = require('./ssh-relay');
const { FRONTEND_PORT, noteTailnetIps, notes, requestJson } = require('./util');

const STATE_DIR = process.env.STATE_DIR || '/state';
const SELF_HOST = process.env.SELF_HOST || '';
const SELF_HOST_FILE = path.join(STATE_DIR, 'self-host');
// included by the host's own ssh_config, see ssh-relay.js
const SSH_CONFIG_FILE = path.join(STATE_DIR, 'ssh_config');

// one hung request, tailnet RTTs well under 50ms
const POLL_TIMEOUT_MS = 700;
// counted at the fast rate, which a miss holds: a dead peer retired ~1.5s in
const MISS_THRESHOLD = Math.max(3, Math.ceil(1500 / clock.FAST_MS));
// `tailscale status` at ~120ms, membership moving on minutes
const DISCOVER_IDLE_MS = 5000;
const DISCOVER_HOT_MS = 1000;
const IPV4_RE = /^\d+\.\d+\.\d+\.\d+$/;
// a peer's git claim trusted this long past its last answer, like git.js's own
const GIT_MAX_AGE_MS = 3000;
// its model claim likewise, as model.js's own
const MODEL_MAX_AGE_MS = 5000;

// optional Tailscale API token, for split DNS and the guest sweep
const TS_API = 'https://api.tailscale.com/api/v2';
const TS_API_KEY = process.env.TS_API_KEY || '';
const SPLIT_DNS_MS = 30000;
const GUEST_TTL_MS = 3 * 24 * 3600 * 1000;
const GUEST_SWEEP_MS = 10 * 60 * 1000;

const { log, note, clear } = notes('mesh');

// server.js's: chat and presence in, own platform and update lock out

let hooks = { mergeChat: () => {}, mergePresence: () => {}, platform: () => '', ownLock: () => null };

// --- discovery -------------------------------------------------------------

let selfIp = '';
let hostIps = new Map();

// null, not []: a tailscaled hiccup, not everyone leaving
function discoverPeers() {
  return new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: 3000, maxBuffer: 16 << 20 }, (err, out) => {
      let status;
      try {
        if (err) throw err;
        status = JSON.parse(out);
        clear('tailscale');
      } catch (e) {
        note('tailscale', `can't reach tailscaled to list peers: ${e.message}`);
        resolve(null);
        return;
      }
      const v4 = (ips) => (ips || []).find((a) => a.includes('.')) || '';
      // as supervisor.sh derives SELF_HOST
      const hostOf = (dns) => (dns || '').replace(/\.$/, '').split('.')[0].toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      selfIp = v4(status.Self && status.Self.TailscaleIPs);
      // renamed on the tailnet: peers hopping here by the new name, a restart taking it up
      const renamed = SELF_HOST && hostOf(status.Self && status.Self.DNSName);
      if (renamed && renamed !== SELF_HOST) {
        log(`renamed on the tailnet to ${renamed}, restarting to follow`);
        process.exit(1);
      }
      const peers = [];
      for (const p of Object.values(status.Peer || {})) {
        const host = hostOf(p.DNSName);
        if (!host || host === SELF_HOST) continue;
        peers.push({ host, ip: v4(p.TailscaleIPs) || host, online: p.Online === true, os: p.OS || '' });
      }
      resolve(peers);
    });
  });
}

// host -> when tailscale first had it offline or gone, the git elector's
// witness when a 2-host mesh loses one
const offlineSince = new Map();
// ms offline per host, only while tailscale itself still answers
const offlineMs = () => (Date.now() - lastDiscover > 3 * DISCOVER_IDLE_MS ? {}
  : Object.fromEntries([...offlineSince].map(([h, t]) => [h, Date.now() - t])));

// the last list on a hiccup, re-asked sooner while something moves
let lastDiscover = 0;
let lastPeers = null;
async function knownPeers() {
  const maxAge = clock.isHot() ? DISCOVER_HOT_MS : DISCOVER_IDLE_MS;
  if (lastPeers && Date.now() - lastDiscover < maxAge) return lastPeers;
  const found = await discoverPeers();
  if (!found) return lastPeers;
  lastDiscover = Date.now();
  const online = new Set(found.filter((p) => p.online).map((p) => p.host));
  for (const h of online) offlineSince.delete(h);
  // offline now, or listed last time and gone since
  for (const h of [...found, ...(lastPeers || [])].map((p) => p.host)) {
    if (!online.has(h) && !offlineSince.has(h)) offlineSince.set(h, lastDiscover);
  }
  lastPeers = found;
  return found;
}

// --- peer polling ----------------------------------------------------------

const peerState = new Map();

function stateFor(host) {
  let s = peerState.get(host);
  if (!s) {
    s = {
      entries: [], presence: [], lock: null, chain: null, git: null, model: null, platform: '', version: '',
      rttMs: null, misses: 0, lastSeq: 0, chat: [], answered: false, fp: '',
      // answered at least once since it joined the tailnet, so a phosphorus
      // host gone quiet is still one, never cleared while it's a peer
      everAnswered: false,
    };
    peerState.set(host, s);
  }
  return s;
}

// past the miss threshold, or offline to tailscale: nothing of it served
function retire(st) {
  Object.assign(st, { entries: [], presence: [], lock: null, chain: null, git: null, model: null, projects: [], rttMs: null });
}

// only a 200 counts
async function fetchJson(host, urlPath) {
  const r = await requestJson({ host, port: FRONTEND_PORT, path: urlPath, timeout: POLL_TIMEOUT_MS });
  if (r.status !== 200 || !r.body) throw new Error(`status ${r.status}`);
  return r.body;
}

// timed like a peer's, so "local" is a real number too
let selfRttMs = null;
async function pollSelf() {
  const start = Date.now();
  selfRttMs = await fetchJson('127.0.0.1', '/api/mesh/snapshot').then(() => Date.now() - start, () => null);
}

// one request per peer for everything it publishes
async function pollPeer(peer) {
  const st = stateFor(peer.host);
  try {
    const start = Date.now();
    const snap = await fetchJson(peer.ip, `/api/mesh/snapshot?since=${st.lastSeq}`);
    st.rttMs = Date.now() - start;
    const entries = Array.isArray(snap.services) ? snap.services : [];
    // all or nothing per peer, a bad row keeping its last good list
    const bad = entries.map(proxy.rowError).find(Boolean);
    if (bad) note(`bad:${peer.host}`, `${peer.host} published a bad service, keeping its last good list: ${bad}`);
    else { st.entries = entries; clear(`bad:${peer.host}`); }
    st.presence = Array.isArray(snap.presence) ? snap.presence : [];
    // handed on below, lastSeq advanced once it lands
    st.chat = Array.isArray(snap.chat) ? snap.chat : [];
    const self = snap.self || {};
    // the host OS from the peer's frontend, every host linux to tailscale
    if (typeof self.platform === 'string') st.platform = self.platform;
    if (typeof self.version === 'string') st.version = self.version;
    st.lock = snap.lock && snap.lock.initiator ? snap.lock : null;
    st.chain = snap.chain && snap.chain.initiator ? snap.chain : null;
    st.git = snap.git && typeof snap.git === 'object' ? snap.git : null;
    st.model = snap.model && typeof snap.model === 'object' ? snap.model : null;
    st.modelRoles = snap.modelRoles && typeof snap.modelRoles === 'object' ? snap.modelRoles : null;
    st.modelKeys = snap.modelKeys && typeof snap.modelKeys === 'object' ? snap.modelKeys : null;
    st.sys = snap.sys && typeof snap.users === 'object' ? snap.sys : null;
    st.projects = Array.isArray(snap.projects) ? snap.projects.filter((x) => x && x.host === peer.host) : [];
    st.answeredAt = Date.now();
    // news: anything redrawn, chat to relay, or a first answer, rttMs left
    // out (its jitter would pin the mesh hot)
    const fp = JSON.stringify([st.entries, st.presence, st.lock, st.chain, st.platform, st.version, st.modelRoles, st.modelKeys, st.sys, st.projects]);
    if (fp !== st.fp || st.chat.length || !st.answered) clock.markHot();
    st.fp = fp;
    st.misses = 0;
    st.answered = true;
    st.everAnswered = true;
    note(`peer:${peer.host}`, `${peer.host} is online`);
  } catch {
    // a peer going quiet as news, confirmed or cleared at the fast rate
    clock.markHot();
    st.misses += 1;
    st.chat = [];
    if (st.misses >= MISS_THRESHOLD) retire(st);
    note(`peer:${peer.host}`, `${peer.host} is not answering on port ${FRONTEND_PORT}, is phosphorus running there?`);
  }
}

// peers' chat every tick it arrives, presence only on a change
let lastPresence = '';
function handOn() {
  const peers = {};
  const arrived = [];
  for (const [host, st] of peerState) {
    if (st.presence.length) peers[host] = st.presence;
    if (st.chat.length) arrived.push(st);
  }
  if (arrived.length) {
    hooks.mergeChat(arrived.flatMap((st) => st.chat));
    for (const st of arrived) {
      st.lastSeq = st.chat.reduce((m, x) => Math.max(m, x.seq || 0), st.lastSeq);
      st.chat = [];
    }
  }
  const json = JSON.stringify(peers);
  if (json !== lastPresence) { lastPresence = json; hooks.mergePresence(peers); }
}

// --- games: <name>.<zone> and split DNS ------------------------------------------

// name -> its host's tailnet IP, rebuilt every tick
let gameIps = new Map();
const gameDns = createGameDns((name) => gameIps.get(name) || '', note);
const sshInbound = createSshInbound(note);

// a name on two hosts: an online one first, then alphabetical
function mapGames(rows) {
  const rank = (r) => `${r.status === 'online' ? 0 : 1}:${r.host}`;
  const games = rows.filter((r) => r.type === 'game').sort((a, b) => rank(a).localeCompare(rank(b)));
  const out = new Map();
  for (const r of games) {
    if (out.has(r.name)) { note(`dup:${r.name}`, `game ${r.name} is declared on more than one host, ${r.name}.${ZONE} goes to ${games.find((g) => g.name === r.name).host}`); continue; }
    const ip = hostIps.get(r.host);
    if (IPV4_RE.test(ip || '')) out.set(r.name, ip);
  }
  return out;
}

async function tsApi(method, urlPath, body) {
  const res = await fetch(`${TS_API}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${TS_API_KEY}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 401) throw new Error('TS_API_KEY was rejected, expired? renew it in .env');
  if (!res.ok) throw new Error(`${method} ${urlPath} got status ${res.status}: ${(await res.text()).trim()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// leader only (first live host alphabetically), so hosts never fight over it
let lastSplitSync = 0;
async function syncSplitDns(nameservers) {
  if (!TS_API_KEY) {
    note('split-dns', `TS_API_KEY unset, keep the .${ZONE} split DNS nameservers in the Tailscale admin console by hand`);
    return;
  }
  if (!nameservers.length || Date.now() - lastSplitSync < SPLIT_DNS_MS) return;
  lastSplitSync = Date.now();
  try {
    const current = (await tsApi('GET', '/tailnet/-/dns/split-dns'))[ZONE] || [];
    if ([...current].sort().join() !== nameservers.join()) {
      await tsApi('PATCH', '/tailnet/-/dns/split-dns', { [ZONE]: nameservers });
      log(`split DNS for .${ZONE} now points at ${nameservers.join(', ')}`);
    }
    clear('split-dns');
  } catch (err) {
    note('split-dns', `couldn't sync the .${ZONE} split DNS, still retrying: ${err.message}`);
  }
}

// leader only, tag:guest devices from the join key, gone at 3 days
let lastGuestSweep = 0;
async function sweepGuests() {
  if (!TS_API_KEY || Date.now() - lastGuestSweep < GUEST_SWEEP_MS) return;
  lastGuestSweep = Date.now();
  try {
    const { devices = [] } = await tsApi('GET', '/tailnet/-/devices');
    for (const d of devices) {
      if (!(d.tags || []).includes('tag:guest')) continue;
      if (Date.now() - Date.parse(d.created) < GUEST_TTL_MS) continue;
      await tsApi('DELETE', `/device/${d.nodeId || d.id}`);
      log(`removed guest ${d.hostname}, past 3 days`);
    }
    clear('guests');
  } catch (err) {
    note('guests', `couldn't sweep guest devices, still retrying: ${err.message}`);
  }
}

// phosphorus peers -> tailnet IP, self left out
const peerIps = () => new Map(devices.filter((d) => d.phosphorus && d.name !== SELF_HOST && IPV4_RE.test(hostIps.get(d.name) || ''))
  .map((d) => [d.name, hostIps.get(d.name)]));

// --- the tick --------------------------------------------------------------

let devices = [];
let routes = [];
let lock = null;
let chain = null;
let lastOwnFp = '';

async function tick() {
  const peers = await knownPeers();
  // own services refreshed even while tailscaled can't list peers
  const [own] = await Promise.all([
    services.refresh(selfIp || SELF_HOST),
    ...(peers || []).filter((p) => p.online).map(pollPeer),
    pollSelf(),
  ]);
  handOn();

  if (peers) {
    const seen = new Set(peers.map((p) => p.host));
    for (const host of peerState.keys()) {
      if (seen.has(host)) continue;
      peerState.delete(host);
      clear(`peer:${host}`);
      clock.markHot();
      log(`${host} left the tailnet`);
    }
    // phosphorus: its frontend answers, offline non-phosphorus devices left out,
    // phosphorusSeen keeping a quiet one that answered before in the update pane
    const next = SELF_HOST ? [{ name: SELF_HOST, os: hooks.platform(), phosphorus: true, phosphorusSeen: true, rttMs: selfRttMs }] : [];
    for (const p of peers) {
      const st = stateFor(p.host);
      // never polled while offline, else its last answer lingering
      if (!p.online && st.answered) { st.answered = false; st.misses = 0; retire(st); clock.markHot(); }
      const phosphorus = p.online && st.answered && st.misses < MISS_THRESHOLD;
      if (!phosphorus && !p.online) continue;
      next.push({
        name: p.host, os: phosphorus ? st.platform : p.os, phosphorus: phosphorus, phosphorusSeen: st.everAnswered,
        rttMs: phosphorus ? st.rttMs : null, version: phosphorus ? st.version : '',
      });
    }
    devices = next;
    hostIps = new Map(peers.map((p) => [p.host, p.ip]));
    if (SELF_HOST && selfIp) hostIps.set(SELF_HOST, selfIp);
    noteTailnetIps(hostIps);
    proxy.pinTargets(peerIps());
  }

  const mine = own.map((r) => ({ ...r, host: SELF_HOST }));
  // our own services changing, news as much as a peer's
  const ownFp = JSON.stringify(mine);
  if (ownFp !== lastOwnFp) { lastOwnFp = ownFp; clock.markHot(); }
  const merged = [...mine];
  for (const [host, st] of peerState) for (const e of st.entries) merged.push({ ...e, host });
  // one order on every host, so a reorder never reads as a change
  merged.sort((a, b) => a.host.localeCompare(b.host) || String(a.name).localeCompare(String(b.name)));
  routes = merged;
  proxy.swap(merged, (host) => hostIps.get(host));

  // one chain at a time, so the first lock seen the only one, held hot
  lock = null;
  for (const st of peerState.values()) if (st.lock) { lock = st.lock; break; }
  // what the update pane shows: the live walk, else the newest finished one
  chain = lock || [...peerState.values()].map((st) => st.chain).filter(Boolean)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0] || null;
  if (lock || hooks.ownLock()) clock.markHot();

  gameIps = mapGames(merged);
  gameDns.bind(selfIp);
  sshInbound.bind(selfIp);
  if (peers) {
    try { writeSshConfig(SSH_CONFIG_FILE, peers); clear('ssh-config'); } catch (err) {
      note('ssh-config', `can't write ${SSH_CONFIG_FILE}: ${err.message}`);
    }
  }

  const live = devices.filter((d) => d.phosphorus).map((d) => d.name).sort();
  if (SELF_HOST && live[0] === SELF_HOST) {
    syncSplitDns(live.map((m) => hostIps.get(m)).filter((ip) => IPV4_RE.test(ip || '')).sort());
    sweepGuests();
  }
}

// each round done before the next is timed, a hung peer delaying rounds,
// never piling them up
async function start(h) {
  hooks = { ...hooks, ...h };
  // the git container's own name for this host, without Tailscale access
  if (SELF_HOST) {
    try {
      fs.writeFileSync(`${SELF_HOST_FILE}.tmp`, SELF_HOST);
      fs.renameSync(`${SELF_HOST_FILE}.tmp`, SELF_HOST_FILE);
    } catch {}
  }
  clock.markHot();
  log(`polling every online tailnet peer every ${clock.FAST_MS}ms while the mesh is busy, every ${clock.IDLE_MS}ms once it is quiet`);
  for (;;) {
    await tick().then(() => clear('tick'), (err) => note('tick', `tick failed, still retrying: ${err.message}`));
    await clock.sleep(clock.intervalMs());
  }
}

module.exports = {
  start,
  routes: () => routes,
  tailnet: () => devices,
  lock: () => lock,
  chain: () => chain,
  peerIps,
  // answered within GIT_MAX_AGE_MS, a dead master's claim never outliving it
  peerGit: () => [...peerState.values()].filter((st) => Date.now() - (st.answeredAt || 0) <= GIT_MAX_AGE_MS).map((st) => st.git).filter(Boolean),
  peerModelRoles: () => [...peerState.values()].map((st) => st.modelRoles).filter(Boolean),
  // when each provider's key was set, the keys themselves fetched apart
  peerModelKeys: () => [...peerState.entries()].filter(([, st]) => st.modelKeys).map(([host, st]) => ({ host, stamps: st.modelKeys })),
  // when each sys file last changed, the files fetched apart
  peerSys: () => [...peerState.entries()].filter(([, st]) => st.sys).map(([host, st]) => ({ host, stamps: st.sys })),
  peerModel: () => [...peerState.values()].filter((st) => Date.now() - (st.answeredAt || 0) <= MODEL_MAX_AGE_MS).map((st) => st.model).filter(Boolean),
  // the orangutan's projects on each answering peer
  peerProjects: () => [...peerState.values()].flatMap((st) => st.projects || []),
  offlineMs,
};
