'use strict';
// git master election: every host's frontend voting, a majority lease making one
// master, joint rosters keeping quorums overlapping, acted on by git-daemon.sh

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const num = (k, d) => Number(process.env[k] || d);
const STATE_DIR = process.env.STATE_DIR || '/state';
const FRONTEND_PORT = num('FRONTEND_PORT', 8090);
const CLAIM_FILE = path.join(STATE_DIR, 'git-claim.json');

// newest roster this host has used or seen, so a restart can't lead on an older one
const ROSTER_FILE = path.join(STATE_DIR, 'git-elector-roster.json');
// the frontend's "make master": {to, at}, written on the master
const HANDOFF_FILE = path.join(STATE_DIR, 'git-handoff.json');
const HANDOFF_MAX_AGE_MS = 30000;
const LOCAL_FILE = process.env.LOCAL_FILE || '/run/git-local';
const DECISION_FILE = process.env.DECISION_FILE || '/run/git-decision';
const LEASE_UNTIL_FILE = process.env.LEASE_UNTIL_FILE || '/run/git-lease-until';
const LITEFS_PID_FILE = process.env.LITEFS_PID_FILE || '/run/git-litefs-pid';
// litefs's "<txid>/<checksum>" for forgejo's db, gone while its mount is down
const DB_POS_FILE = process.env.DB_POS_FILE || '/var/lib/hesperus/git/litefs/forgejo.db-pos';
// rsyncd refusing pulls while it exists (rsyncd.conf)
const PROMOTING_FILE = process.env.PROMOTING_FILE || '/run/git-promoting';

// the slowest tick, the frontend's view naming the mesh's own, often faster
const TICK_MS = num('TICK_MS', 500);
const PROBE_TIMEOUT_MS = num('PROBE_TIMEOUT_MS', 500);
// a voter's grant lifetime, roughly the failover time after a crash
const LEASE_MS = num('LEASE_MS', 4000);
// master fencing this early, before any grant can lapse, past a tick
const LEASE_MARGIN_MS = num('LEASE_MARGIN_MS', 1500);
const PROMOTE_GRACE = num('PROMOTE_GRACE', 2);
const ADD_AFTER_MS = num('ADD_AFTER_MS', 3000);
const REMOVE_AFTER_MS = num('REMOVE_AFTER_MS', 300000);
// after a handoff, sat out this long so the successor wins, not us again
const HOLD_MS = num('HOLD_MS', 15000);
// tailscale's word a member is gone, once it has held this long
const WITNESS_MS = num('WITNESS_MS', 60000);
// a sync seen this recently still vouching for the data, so a pull running
// long or one lagging txn at the last look doesn't strand a crashed master's heirs
const VOUCH_MS = num('VOUCH_MS', 120000);

const SELF_HOST = fs.readFileSync(path.join(STATE_DIR, 'self-host'), 'utf8').trim();
const NAME_RE = /^[A-Za-z0-9-]{1,63}$/;
const EMPTY = { epoch: 0, members: [], prev: null };

const log = (msg) => console.log(`[elector] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = (xs) => [...new Set(xs)];
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// CLOCK_BOOTTIME, same clock git-daemon.sh's watchdog reads
function uptimeMs() {
  return Math.round(parseFloat(fs.readFileSync('/proc/uptime', 'utf8')) * 1000);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function validMembers(m) {
  return Array.isArray(m) && m.every((x) => x && NAME_RE.test(x.name) && typeof x.git === 'boolean'
    && (x.tb === undefined || typeof x.tb === 'boolean'));
}

function validRoster(r) {
  if (!r || !Number.isInteger(r.epoch) || r.epoch < 0 || !validMembers(r.members)) return null;
  if (r.prev !== null && !validMembers(r.prev)) return null;
  return { epoch: r.epoch, members: r.members, prev: r.prev };
}

function validClaim(c) {
  if (!c || !['master', 'servant', 'none'].includes(c.role)) return null;
  if (!Number.isInteger(c.gen) || !Number.isInteger(c.stamp)) return null;
  return c;
}

// own tailnet IP: our hostname possibly 127.0.1.1 (/etc/hosts), refused
// by the frontend's tailnet gate, losing our own vote
function selfAddr() {
  for (const list of Object.values(os.networkInterfaces())) {
    const a = (list || []).find((x) => x.family === 'IPv4' && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(x.address));
    if (a) return a.address;
  }
  return SELF_HOST;
}

// parsed JSON on a 200, else null, never rejects
function call(host, method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: host === SELF_HOST ? selfAddr() : host, port: FRONTEND_PORT, method, path: p,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve(res.statusCode === 200 ? JSON.parse(buf) : null); } catch { resolve(null); }
      });
    });
    const timer = setTimeout(() => req.destroy(), PROBE_TIMEOUT_MS);
    req.on('error', () => { clearTimeout(timer); resolve(null); });
    if (data) req.write(data);
    req.end();
  });
}

// --- roster ------------------------------------------------------------

let known = validRoster(readJson(ROSTER_FILE, null)) || EMPTY;

function adopt(r) {
  r = validRoster(r);
  if (!r || r.epoch <= known.epoch) return;
  known = r;
  writeAtomic(ROSTER_FILE, JSON.stringify(known));
}

const names = (m) => m.map((x) => x.name);
const gitNames = (m) => m.filter((x) => x.git).map((x) => x.name).sort();
const voters = (r) => uniq([...names(r.members), ...(r.prev ? names(r.prev) : [])]);
const describe = (m) => m.map((x) => (x.git ? `${x.name}*` : x.name)).join(' ');

// the leader that wrote the roster, so an even split keeps whoever leads
function tiebreaker(m) {
  const t = m.find((x) => x.tb && x.git);
  return t ? t.name : gitNames(m)[0];
}

// majority of m, exactly half only with the tiebreaker, a sole git host
// needing no votes, with nothing else to lead
function partOk(m, granted, leader) {
  const gits = gitNames(m);
  if (gits.length === 1 && gits[0] === leader) return true;
  const got = m.filter((x) => granted.has(x.name)).length;
  return got * 2 > m.length || (got * 2 === m.length && gits.length > 0 && granted.has(tiebreaker(m)));
}

function quorum(r, granted, leader) {
  return partOk(r.members, granted, leader) && (!r.prev || partOk(r.prev, granted, leader));
}

// --- mesh view -----------------------------------------------------------

const firstSeen = new Map();
const lastSeen = new Map();
const gitFlag = new Map();
let claims = new Map();
let selfState = null;
let viewOk = false;
// members out of view that tailscale has had offline for WITNESS_MS
let witnessed = new Set();
let pollMs = TICK_MS;

// every host's git state as the local frontend's mesh poll last carried it,
// false when the frontend didn't answer, the last view left standing
async function probe() {
  const now = uptimeMs();
  const view = await call(SELF_HOST, 'GET', '/api/git/view');
  viewOk = !!(view && Array.isArray(view.states));
  if (!viewOk) return false;
  pollMs = Number.isFinite(view.pollMs) && view.pollMs > 0 ? view.pollMs : TICK_MS;
  const states = new Map(view.states.filter((s) => s && NAME_RE.test(s.host || '')).map((s) => [s.host, s]));
  claims = new Map();
  const off = view.offlineMs && typeof view.offlineMs === 'object' ? view.offlineMs : {};
  witnessed = new Set(Object.keys(off).filter((h) => NAME_RE.test(h) && h !== SELF_HOST && !states.has(h)
    && Number.isFinite(off[h]) && off[h] >= WITNESS_MS));
  for (const h of firstSeen.keys()) if (!states.has(h)) firstSeen.delete(h);
  for (const [h, s] of states) {
    adopt(s.roster);
    lastSeen.set(h, now);
    if (!firstSeen.has(h)) firstSeen.set(h, now);
    gitFlag.set(h, s.gitHost === true);
    if (h === SELF_HOST) selfState = s;
    const c = validClaim(s.claim);
    if (c && h !== SELF_HOST) claims.set(h, { ...c, host: h, txid: Number.isInteger(c.txid) ? c.txid : -1 });
  }
  return true;
}

async function campaign(r, ms, extra = []) {
  const vs = uniq([...voters(r), ...extra]);
  const replies = await Promise.all(vs.map((h) => call(h, 'POST', '/api/git/vote', { c: SELF_HOST, ms, roster: r })));
  const granted = new Set();
  vs.forEach((h, i) => {
    const rep = replies[i];
    if (!rep) return;
    if (rep.granted === true) granted.add(h);
    adopt(rep.roster);
  });
  return granted;
}

// --- decision ------------------------------------------------------------

let role = 'none';
let master = '';
let gen = 0;
let leaseUntil = 0;
let committed = -1;
let noMasterTicks = 0;
let skip = 0;
let refused = '';
let holdUntil = 0;
let stopping = false;
let handedOffBoot = '';
// our named successor, published in the claim while holdUntil runs
let handoffTo = '';
// in sync with the master when it was last seen, kept once it's gone
let vouched = false;
let vouchedAt = 0;
// litefs holding every txn of the master's last claim, kept once it's gone
let dbOk = false;
// the master last followed, pulled from once more on taking over
let lastMaster = '';
let finalFrom = '';
// why no election is under way, logged when it changes
let lastStall = '';
function stall(why) {
  if (why === lastStall) return;
  lastStall = why;
  log(`no master, not campaigning: ${why}`);
}

// our db position, -1 while litefs is down, one read at a time so a hung
// fuse mount leaves it stale (behind the master) rather than piling up
let txid = -1;
let posReading = false;
function readPos() {
  if (posReading) return;
  posReading = true;
  fs.promises.readFile(DB_POS_FILE, 'utf8').then((s) => {
    const m = /^([0-9a-f]{16})\//.exec(s);
    txid = m ? parseInt(m[1], 16) : -1;
  }, () => { txid = -1; }).finally(() => { posReading = false; });
}

const me = (local) => ({ gen: local.gen, stamp: local.stamp, txid, host: SELF_HOST });

// rsync and litefs both caught up with the master
const synced = (local) => local.inSync && dbOk;

// newer data first (gen, rsync stamp, db position), then name
function better(a, b) {
  if (a.gen !== b.gen) return a.gen > b.gen;
  if (a.stamp !== b.stamp) return a.stamp > b.stamp;
  if (a.txid !== b.txid) return a.txid > b.txid;
  return a.host < b.host;
}

function readLocal() {
  const [g, s, inSync, force] = (() => {
    try { return fs.readFileSync(LOCAL_FILE, 'utf8').trim().split(/\s+/); } catch { return []; }
  })();
  return { gen: Number(g) || 0, stamp: Number(s) || 0, inSync: inSync === '1', force: force === '1' };
}

// may lead without losing writes: recently in sync, forced, or every other
// git host in view or, vouched for, witnessed gone (then the freshest campaigns)
function eligible(local, r) {
  if (local.force || synced(local)) return true;
  const gits = new Set([...gitNames(r.members), ...(r.prev ? gitNames(r.prev) : [])]);
  gits.delete(SELF_HOST);
  return [...gits].every((h) => claims.has(h) || (vouched && witnessed.has(h)));
}

// hosts up long enough, not members yet, asked for votes by the leader too
function pending() {
  const now = uptimeMs();
  const members = new Set(names(known.members));
  return [...firstSeen].filter(([h, t]) => !members.has(h) && now - t >= ADD_AFTER_MS).map(([h]) => h);
}

// added only once its vote is ours, so growing the roster can't cost the majority
function desiredMembers(grantedLast) {
  const now = uptimeMs();
  const out = new Map();
  for (const m of known.members) {
    if (m.name !== SELF_HOST && now - (lastSeen.get(m.name) ?? now) > REMOVE_AFTER_MS) continue;
    out.set(m.name, { name: m.name, git: gitFlag.has(m.name) ? gitFlag.get(m.name) : m.git, tb: false });
  }
  for (const h of pending()) {
    if (grantedLast.has(h)) out.set(h, { name: h, git: gitFlag.get(h) === true, tb: false });
  }
  out.set(SELF_HOST, { name: SELF_HOST, git: true, tb: true });
  return [...out.values()].sort(byName);
}

let grantedLast = new Set();

// one step at a time, each only once the last landed on a quorum
function nextRoster() {
  // blind to the mesh, every member looking silent
  if (committed !== known.epoch || !viewOk) return known;
  if (known.prev) return { epoch: known.epoch + 1, members: known.members, prev: null };
  const want = desiredMembers(grantedLast);
  if (JSON.stringify(want) === JSON.stringify(known.members)) return known;
  return { epoch: known.epoch + 1, members: want, prev: known.members };
}

async function lead() {
  const r = nextRoster();
  if (r !== known) {
    // persisted before any voter sees it
    known = r;
    writeAtomic(ROSTER_FILE, JSON.stringify(known));
    log(`roster ${r.epoch}: ${describe(r.members)}${r.prev ? ` (joint with ${describe(r.prev)})` : ''}`);
  }
  const sent = uptimeMs();
  const [, granted] = await Promise.all([probe(), campaign(r, LEASE_MS, pending())]);
  grantedLast = granted;
  if (quorum(r, granted, SELF_HOST)) {
    leaseUntil = sent + LEASE_MS - LEASE_MARGIN_MS;
    committed = r.epoch;
  }
  if (uptimeMs() >= leaseUntil) {
    log('lost the vote majority, stepping down');
    role = 'none';
    master = '';
  }
}

async function followOrCampaign(local) {
  // no view, no new decision, the last one standing until the frontend answers
  if (!(await probe())) return;
  let best = null;
  for (const c of claims.values()) {
    if (c.role === 'master' && (!best || better(c, best))) best = c;
  }

  if (best) {
    noMasterTicks = 0;
    // never our data traded for an older lineage
    if (best.gen < local.gen) {
      if (refused !== best.host) log(`refusing to follow ${best.host}: its data (gen ${best.gen}) is older than ours (gen ${local.gen}), fix by hand`);
      refused = best.host;
      vouched = false;
      vouchedAt = 0;
      dbOk = false;
      role = 'none';
      master = '';
      return;
    }
    refused = '';
    lastStall = '';
    // its claim predating our read, so >= means nothing missing
    dbOk = txid >= best.txid;
    if (synced(local)) vouchedAt = uptimeMs();
    vouched = uptimeMs() - vouchedAt < VOUCH_MS;
    lastMaster = best.host;
    role = 'servant';
    master = best.host;
    return;
  }

  role = 'none';
  master = '';
  noMasterTicks += 1;
  // a handing-off master naming its successor, the rest waiting it out
  const named = namedSuccessor();
  if (named && named !== SELF_HOST) return;
  if (skip > 0) { skip -= 1; return; }
  if (uptimeMs() < holdUntil) return;
  if (noMasterTicks < PROMOTE_GRACE) return;

  // a new mesh's first roster: every host in view, a forced one too (the
  // operator's word that the hosts out of view are gone for good)
  const boot = known.epoch === 0 || local.force;
  // members tailscale has seen go, dropped only by one vouched for the lost master,
  // else a 2-host mesh's half is never a majority
  const gone = !boot && vouched ? names(known.members).filter((h) => witnessed.has(h)) : [];
  const r = boot
    ? { epoch: known.epoch + 1, members: uniq([...firstSeen.keys(), SELF_HOST]).map((h) => ({ name: h, git: h === SELF_HOST || gitFlag.get(h) === true, tb: h === SELF_HOST })).sort(byName), prev: null }
    : gone.length
      ? { epoch: known.epoch + 1, members: known.members.filter((m) => !gone.includes(m.name)).map((m) => ({ ...m, tb: m.name === SELF_HOST })), prev: null }
      : known;
  const member = r.members.some((m) => m.name === SELF_HOST && m.git);
  if (!member) { stall('not a git member of the roster'); return; }
  if (!eligible(local, r)) {
    const out = gitNames(r.members).filter((h) => h !== SELF_HOST && !claims.has(h));
    stall(`not in sync, and ${out.join(', ') || 'no host'} out of view${vouched ? ' (waiting on tailscale to call them gone)' : ' (never vouched for the last master)'}`);
    return;
  }
  // a forced host leading regardless, the operator's pick over any better claim
  for (const c of claims.values()) {
    if (!local.force && named !== SELF_HOST && better(c, me(local))) { stall(`${c.host} has newer data, waiting on it`); return; }
  }

  if (local.force) log(`forced: resetting roster to ${describe(r.members)}`);
  else if (gone.length) log(`${gone.join(', ')} offline per tailscale for ${WITNESS_MS / 1000}s, roster without it: ${describe(r.members)}`);
  // persisted before any voter sees it
  if (r !== known) {
    known = r;
    writeAtomic(ROSTER_FILE, JSON.stringify(known));
  }
  const sent = uptimeMs();
  const granted = await campaign(r, LEASE_MS);
  if (!quorum(r, granted, SELF_HOST)) {
    // partial grants handed back, backoff by rank so the best host retries first
    await campaign(r, 0);
    stall(`${granted.size} of ${voters(r).length} votes, no majority`);
    skip = Math.max(0, gitNames(r.members).indexOf(SELF_HOST)) + 1;
    return;
  }
  // the last master, still answering (a handoff, not a crash): its data
  // quiescent now, pulled once more by git-daemon.sh before forgejo starts
  const prev = claims.get(lastMaster);
  finalFrom = prev && prev.role !== 'master' && prev.gen >= local.gen ? lastMaster : '';
  gen = Math.max(local.gen, ...[...claims.values()].map((c) => c.gen)) + 1;
  leaseUntil = sent + LEASE_MS - LEASE_MARGIN_MS;
  committed = r.epoch;
  role = 'master';
  master = SELF_HOST;
  vouched = false;
  vouchedAt = 0;
  lastStall = '';
  const how = gitNames(r.members).length === 1 ? 'sole git host' : `won ${granted.size} of ${voters(r).length} votes`;
  log(`${how} (roster ${r.epoch}: ${describe(r.members)}), promoting self, gen ${gen}`);
}

// lease first, never a master decision without it, kept after stepping
// down, where a lapsed deadline makes it fence
function writeOut(local) {
  // master without forgejo yet: mid final pull, so nobody pulls a half tree
  try {
    if (role === 'master' && !litefsUp()) fs.writeFileSync(PROMOTING_FILE, '');
    else fs.rmSync(PROMOTING_FILE, { force: true });
  } catch {}
  writeAtomic(LEASE_UNTIL_FILE, `${leaseUntil}\n`);
  const g = role === 'master' ? Math.max(gen, local.gen) : local.gen;
  writeAtomic(DECISION_FILE, `${role} ${master || '-'} ${g} ${uptimeMs()} ${(role === 'master' && finalFrom) || '-'}\n`);
  writeClaim(local, g);
}

// the frontend dropping a claim older than 3s, a long handoff refreshing it
function writeClaim(local, g = local.gen) {
  writeAtomic(CLAIM_FILE, JSON.stringify({
    host: SELF_HOST, role, master, gen: g, stamp: local.stamp, txid,
    eligible: role === 'master' || synced(local), roster: known.epoch,
    handoffTo: uptimeMs() < holdUntil ? handoffTo : '',
  }));
}

const litefsUp = () => { try { return fs.readFileSync(LITEFS_PID_FILE, 'utf8').trim() !== ''; } catch { return false; } };

// an in-sync git servant of ours, able to take over
function canTakeOver(h) {
  const c = claims.get(h);
  return !!c && c.role === 'servant' && c.master === SELF_HOST && c.eligible
    && known.members.some((m) => m.name === h && m.git);
}

// the freshest one, '' for a sole git host
function successor() {
  let best = null;
  for (const c of claims.values()) {
    if (canTakeOver(c.host) && (!best || better(c, best))) best = c;
  }
  return best ? best.host : '';
}

// the successor as tiebreaker, able to lead even when an even
// split (a two-host mesh included) would otherwise leave no one
async function passTiebreak(to) {
  if (known.prev || !to) return;
  const members = known.members.map((m) => ({ ...m, tb: m.name === to }));
  for (const prev of [known.members, null]) {
    const r = { epoch: known.epoch + 1, members, prev };
    known = r;
    writeAtomic(ROSTER_FILE, JSON.stringify(known));
    if (!quorum(r, await campaign(r, LEASE_MS), SELF_HOST)) return;
  }
  log(`${to} is now the tiebreaker`);
}

// planned exit: forgejo down first, still renewing, then the tiebreak and
// grants to the named successor, taking over in a tick
async function handOff(reason, to) {
  log(`${reason}, handing off${to ? ` to ${to}` : ''}`);
  role = 'none';
  master = '';
  handoffTo = to;
  holdUntil = uptimeMs() + HOLD_MS;
  writeOut(readLocal());
  while (litefsUp()) {
    const sent = uptimeMs();
    if (quorum(known, await campaign(known, LEASE_MS), SELF_HOST)) leaseUntil = sent + LEASE_MS - LEASE_MARGIN_MS;
    // lapsed: the watchdog fencing, the grants freeing themselves
    if (uptimeMs() >= leaseUntil) return;
    writeClaim(readLocal());
    await sleep(200);
  }
  await passTiebreak(to);
  await campaign(known, 0);
}

// a claim naming a successor that's still in view
function namedSuccessor() {
  for (const c of claims.values()) {
    if (c.handoffTo && (c.handoffTo === SELF_HOST || claims.has(c.handoffTo))) return c.handoffTo;
  }
  return '';
}

// consumed on read, only a following, in-sync git host qualifies
function handoffRequest() {
  const req = readJson(HANDOFF_FILE, null);
  if (!req) return '';
  try { fs.unlinkSync(HANDOFF_FILE); } catch {}
  if (!Number.isFinite(req.at) || Date.now() - req.at > HANDOFF_MAX_AGE_MS) return '';
  if (!canTakeOver(req.to)) {
    log(`not handing off to ${req.to}: not an in-sync servant of ours`);
    return '';
  }
  return req.to;
}

async function tick() {
  if (stopping) return;
  readPos();
  const local = readLocal();
  let to = '';
  // update.sh announcing itself to the frontend before the swap takes this host off the tailnet
  const leaving = role === 'master' && selfState && selfState.updating && handedOffBoot !== selfState.bootId;
  if (leaving) handedOffBoot = selfState.bootId;
  if (leaving && (to = successor())) {
    await handOff('an update is about to restart this host', to);
  } else if (role === 'master' && (to = handoffRequest())) {
    await handOff('asked from the frontend', to);
  } else if (role === 'master') {
    // sole git host: nobody to take over, so forgejo up until the swap stops it
    if (leaving) log('an update is about to restart this host, no servant to take over, staying master');
    await lead();
  } else {
    await followOrCampaign(local);
  }
  if (!stopping) writeOut(local);
}

// TERM from git-daemon.sh once forgejo is down
process.on('SIGTERM', async () => {
  stopping = true;
  try { fs.unlinkSync(CLAIM_FILE); } catch {}
  if (role === 'master') await handOff('shutting down', successor()); else await campaign(known, 0);
  process.exit(0);
});

async function main() {
  // silent members given a full REMOVE_AFTER_MS from our start, not from zero
  const now = uptimeMs();
  for (const h of voters(known)) lastSeen.set(h, now);
  writeOut(readLocal());
  log(`starting as ${SELF_HOST}, roster ${known.epoch}: ${describe(known.members) || '(none yet)'}`);
  for (;;) {
    const t0 = Date.now();
    try { await tick(); } catch (e) { log(`tick failed: ${e.message}`); }
    // the mesh's cadence, never slower than TICK_MS, which the lease margin covers
    await sleep(Math.max(0, Math.min(pollMs, TICK_MS) - (Date.now() - t0)));
  }
}

main();
