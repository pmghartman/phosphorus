'use strict';
// git hosts: this host's vote in the master election (git/container/elector.js
// runs it), and the frontend's git card, from what the mesh poll carries

const fs = require('fs');
const path = require('path');
const mesh = require('./mesh');
const { hesperusIni, readJson, readFresh, writeJsonAtomic, peerCall } = require('./util');

const SELF_HOST = process.env.SELF_HOST || '';
const STATE_DIR = process.env.STATE_DIR || '/state';

// --- election voter ------------------------------------------------------

// every host's vote: one lease plus the newest roster seen, persisted
// across restarts
const CLAIM_FILE = path.join(STATE_DIR, 'git-claim.json');
const ROSTER_FILE = path.join(STATE_DIR, 'git-roster.json');
const LEASE_CAP_MS = 10000;
const CLAIM_MAX_AGE_MS = 3000;
const NAME_RE = /^[A-Za-z0-9-]{1,63}$/;
const startMs = performance.now();
let lease = { holder: '', until: 0 };

// server.js's: whether this host is mid-swap, its boot id
let server = { isUpdating: () => false, bootId: '' };
function init(s) { server = s; }

function validMembers(m) {
  return Array.isArray(m) && m.length <= 256
    && m.every((x) => x && NAME_RE.test(x.name) && typeof x.git === 'boolean'
      && (x.tb === undefined || typeof x.tb === 'boolean'));
}

// prev set: a joint roster mid-change, both halves agreeing
function validRoster(r) {
  if (!r || !Number.isInteger(r.epoch) || r.epoch < 0 || !validMembers(r.members)) return null;
  if (r.prev !== null && !validMembers(r.prev)) return null;
  return { epoch: r.epoch, members: r.members, prev: r.prev };
}

let roster = validRoster(readJson(ROSTER_FILE, null)) || { epoch: 0, members: [], prev: null };

const isGitHost = () => hesperusIni('git', 'host') === 'true';

// monotonic clock: no lease stretched or cut by a wall-clock step
function vote(p) {
  const r = validRoster(p.roster);
  if (!NAME_RE.test(p.c || '') || !Number.isInteger(p.ms) || p.ms < 0 || p.ms > LEASE_CAP_MS || !r) {
    return [400, { error: 'bad c, ms or roster' }];
  }
  // a stale roster never winning, ours sent back for the caller to catch up
  if (r.epoch < roster.epoch) return [200, { granted: false, roster }];
  if (r.epoch > roster.epoch) {
    roster = r;
    writeJsonAtomic(ROSTER_FILE, roster);
  }
  const now = performance.now();
  if (now - startMs < LEASE_CAP_MS) return [200, { granted: false, abstaining: true, roster }];
  if (lease.holder && lease.holder !== p.c && now < lease.until) {
    return [200, { granted: false, holder: lease.holder, roster }];
  }
  // ms=0: the holder letting go
  lease = p.ms === 0 ? { holder: '', until: 0 } : { holder: p.c, until: now + p.ms };
  return [200, { granted: p.ms > 0, roster }];
}

// the elector's own view, only while it's still being refreshed
const claim = () => readFresh(CLAIM_FILE, CLAIM_MAX_AGE_MS);

const state = () => ({
  host: SELF_HOST, gitHost: isGitHost(), roster, claim: claim(), updating: server.isUpdating(), bootId: server.bootId,
});

// ours and every answering peer's, for the elector, no probing of its own
const view = () => [state(), ...mesh.peerGit()];

// --- git card ------------------------------------------------------------
const HANDOFF_FILE = path.join(STATE_DIR, 'git-handoff.json');
const FORCE_FILE = path.join(STATE_DIR, 'git-force-promote');

// by name, like the elector: MagicDNS for peers, connectTimeout for a
// powered-off host whose unanswered SYN would stall the hop
const peerJson = (host, method, p, body) => peerCall(host, { host, method, path: p, body, timeout: 5000, connectTimeout: 1500 });

// rows moved: host, reachability and role only, ageSec ticking by itself,
// never settled
const rowsFp = (rows) => JSON.stringify(rows.map(
  (h) => [h.host, h.reachable, h.role, h.master, h.gen, h.eligible, h.updating]));

// ours and every peer's git state, as the mesh poll last carried it, a
// silent host listed only while still a roster member (the elector drops it)
function rows() {
  const now = Math.floor(Date.now() / 1000);
  const out = new Map();
  for (const m of roster.members) if (m.git) out.set(m.name, { host: m.name, reachable: false });
  for (const s of [state(), ...mesh.peerGit()]) {
    if (!s || !NAME_RE.test(s.host || '')) continue;
    if (!(s.gitHost || s.claim)) { out.delete(s.host); continue; }
    const c = s.claim || {};
    out.set(s.host, {
      host: s.host, reachable: true, role: c.role || 'starting', master: c.master || '',
      gen: c.gen ?? null, ageSec: c.stamp ? Math.max(0, now - c.stamp) : null,
      eligible: !!c.eligible, updating: !!s.updating, handoffTo: c.handoffTo || '',
    });
  }
  return [...out.values()].sort((x, y) => x.host.localeCompare(y.host));
}

// ourselves directly, peers over the tailnet
function hop(host, body) {
  if (host !== SELF_HOST) return peerJson(host, 'POST', '/api/git/promote', body);
  return Promise.resolve(promote(body));
}

// the peer end of "make master", both directions: the live master handing the
// role over, or a host with no master above it taking it
function promote(body) {
  if (body.op === 'handoff') {
    const c = claim();
    if (!c || c.role !== 'master') return [409, { error: `${SELF_HOST} isn't the git master` }];
    if (!NAME_RE.test(body.to || '')) return [400, { error: 'bad target' }];
    writeJsonAtomic(HANDOFF_FILE, { to: body.to, at: Date.now() });
    return [200, { ok: true }];
  }
  if (body.op === 'take') {
    if (!isGitHost()) return [409, { error: `${SELF_HOST} isn't a git host` }];
    fs.writeFileSync(FORCE_FILE, '');
    return [200, { ok: true }];
  }
  return [400, { error: 'op must be handoff or take' }];
}

// a make master pressed here, until its host leads: a second press mid-handoff
// would see no master and force-promote, resetting the roster
const SETTLE_MS = 30000;
let inFlight = null;
const leads = (host) => rows().some((h) => h.host === host && h.reachable && h.role === 'master');

// with a live master a hand-off, without one a force-promote (git-force-promote)
async function force(target) {
  const all = rows();
  const t = all.find((h) => h.host === target);
  if (!t || !t.reachable) return [409, { error: `${target} isn't a reachable git host` }];
  if (t.role === 'master') return [409, { error: `${target} is already master` }];
  const moving = all.find((h) => h.reachable && h.handoffTo);
  if (moving) return [409, { error: `${moving.host} is already handing off to ${moving.handoffTo}` }];
  if (inFlight && Date.now() < inFlight.until && !leads(inFlight.to)) return [409, { error: `making ${inFlight.to} master is already under way` }];
  const master = all.find((h) => h.role === 'master' && h.reachable);
  if (!master && all.some((h) => h.reachable && h.role === 'starting')) return [409, { error: 'a git host is still starting, try once it settles' }];
  if (master && (!t.eligible || t.master !== master.host)) return [409, { error: `${target} isn't in sync with ${master.host} yet` }];
  const out = await hop(master ? master.host : target, master ? { op: 'handoff', to: target } : { op: 'take' });
  if (out[0] === 200) inFlight = { to: target, until: Date.now() + SETTLE_MS };
  return out;
}

// hesperus's press: done only once the target leads, so never pressed twice,
// already master counts as done
async function makeMaster(target) {
  if (leads(target)) return [200, { master: target, note: 'already master' }];
  const started = Date.now();
  const out = await force(target);
  if (out[0] !== 200 && !(inFlight && inFlight.to === target)) return out;
  while (Date.now() - started < SETTLE_MS) {
    if (leads(target)) return [200, { master: target, tookS: Math.round((Date.now() - started) / 1000) }];
    await new Promise((r) => setTimeout(r, 500));
  }
  return [504, { error: `${target} didn't take over in ${SETTLE_MS / 1000}s, the git tool shows where it stands` }];
}

module.exports = {
  init, vote, state, view, promote, force, makeMaster, rows, rowsFp,
};
