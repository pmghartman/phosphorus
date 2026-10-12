'use strict';
// the mesh update chain: this host's own update, the lock it publishes while
// driving one, and the walk across every host

const { execFile, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const clock = require('./clock');
const mesh = require('./mesh');
const { readJson, writeJsonAtomic, tailnetIp, requestJson } = require('./util');

const SELF_HOST = process.env.SELF_HOST || '';
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT || 8090);
const STATE_DIR = process.env.STATE_DIR || '/state';
const CHAIN_FILE = path.join(STATE_DIR, 'update-chain.json');
const UPDATE_SCRIPT = process.env.UPDATE_SCRIPT || '/repo/scripts/update.sh';
const VERSION_FILE = process.env.VERSION_FILE || '/opt/phosphorus/VERSION';
// the checkout update.sh resets, once it returns, what was built
const REPO_DIR = path.resolve(path.dirname(UPDATE_SCRIPT), '..');

// long enough for a cold layer cache, under PEER_CAP_MS, the peer's
// own verdict, not a guess from here
const UPDATE_TIMEOUT_MS = 1200000;
// a peer not listening failed now, not in minutes, still room for a tailnet
// round trip and handshake
const CONNECT_TIMEOUT_MS = 2000;
// update.sh done, swap handed off: a new frontend answering well within this
const SWAP_TIMEOUT_MS = 120000;
// answering = still working, whatever the build costs, a clock only on
// silence, the cap against a chain hanging forever
const PEER_QUIET_MS = 180000;
const PEER_CAP_MS = 1800000;
// own update swapping the walk out, read back by the next boot, never
// a chain from another day
const CHAIN_MAX_AGE_MS = 1800000;
// how long a finished chain stays readable to a browser that missed the end
const CHAIN_LINGER_MS = 120000;

function log(msg) { console.log(`[update] ${msg}`); }

function readVersion(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

// as rebuild stamps it: VERSION's <major>.<minor>, then the commit count
function repoVersion() {
  try {
    const n = execFileSync('git', ['-C', REPO_DIR, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
    return `${readVersion(path.join(REPO_DIR, 'VERSION'))}.${n}`;
  } catch { return ''; }
}

// --- this host's own update ------------------------------------------------

// server.js's, for disk and chat, none of either in here
let outcomeHook = () => {};
function onOutcome(fn) { outcomeHook = fn; }
// a chain ending, however it ended, here or on the boot after the own swap
let finishHook = () => {};
function onFinish(fn) { finishHook = fn; }

function runLocalUpdate() {
  outcomeHook({ state: 'running' });
  return new Promise((resolve) => {
    // via bash, not the shebang: no exec bit on a bind mount from Windows
    execFile('bash', [UPDATE_SCRIPT], { timeout: UPDATE_TIMEOUT_MS }, (err, stdout, stderr) => {
      // current: nothing to swap, this process staying, no restart to wait for
      const current = /already up to date/.test(String(stdout));
      // checkout already reset: the version about to run
      const version = repoVersion() || readVersion(VERSION_FILE);
      if (!err) { outcomeHook({ state: 'ok', current, version }); resolve({ ok: true, current, to: version }); return; }
      const detail = (stderr || stdout || err.message).toString().trim().split('\n').slice(-3).join(' ');
      const error = detail.slice(0, 500) || 'update failed';
      outcomeHook({ state: 'failed', error });
      resolve({ ok: false, error });
    });
  });
}

// --- peers ------------------------------------------------------------------

const peer = (host, opts) => requestJson({ host, port: FRONTEND_PORT, timeout: CONNECT_TIMEOUT_MS, ...opts });

// the update fired, back once the peer accepts it, before its swap, a short
// connect deadline: never reached as unreachable, not failed
function kickOffPeerUpdate(host) {
  return peer(host, { method: 'POST', path: '/api/update/local', body: {}, connectTimeout: CONNECT_TIMEOUT_MS })
    .then((r) => (r.status === 202 ? { ok: true }
      : { ok: false, error: String((r.body && r.body.error) || `status ${r.status}`).slice(0, 500) }))
    .catch((err) => ({ ok: false, unreachable: true, error: err.message }));
}

function fetchStatus(host) {
  return peer(host, { path: '/api/update/local/status' }).then((r) => {
    if (!r.body) throw new Error('unreadable status');
    return r.body;
  });
}

// best effort, blank as unknown: boot id telling a landed swap from the old
// process answering, version for the UI
function fetchSelf(host) {
  return peer(host, { path: '/api/mesh/snapshot' })
    .then((r) => ((r.body && r.body.self) || {}), () => ({}))
    .then((self) => ({ bootId: String(self.bootId || ''), version: String(self.version || '') }));
}

// "current" ending it in place, else the swap kills the peer's frontend,
// only a new boot id telling a landed swap from the old process's "ok"
async function callPeerUpdate(host, note) {
  const addr = (await tailnetIp(host)) || host;
  const before = await fetchSelf(addr);
  note({ from: before.version });
  // an "ok" already on disk: the last run's, not this one's
  const baselineAt = await fetchStatus(addr).then((s) => s.at || 0).catch(() => 0);
  const kicked = await kickOffPeerUpdate(addr);
  if (!kicked.ok) return kicked;

  const cap = Date.now() + PEER_CAP_MS;
  let quietUntil = Date.now() + PEER_QUIET_MS;
  let swapDeadline = 0;
  while (Date.now() < cap) {
    // the mesh's tick, held at the fast rate by the published lock
    await clock.sleep(clock.intervalMs());
    let status;
    try {
      status = await fetchStatus(addr);
      // answered: building or swapping, however long that takes
      quietUntil = Date.now() + PEER_QUIET_MS;
    } catch {
      // unreachable mid-build or mid-swap, a verdict only if it stays that way
      if (Date.now() > quietUntil) {
        return { ok: false, unreachable: true, error: 'stopped answering during its update' };
      }
      continue;
    }
    if (swapDeadline && Date.now() > swapDeadline) {
      return { ok: false, error: 'swap never landed, see docker logs phosphorus-updater on that host' };
    }
    if (status.state === 'failed') return { ok: false, error: status.error || 'update failed' };
    // idle baseline untouched: this peer's update not yet run
    if (status.state !== 'ok' || (baselineAt && status.at === baselineAt)) continue;
    if (status.current) return { ok: true, current: true, to: before.version };
    const after = await fetchSelf(addr);
    // no baseline, or the swap landed with a new frontend answering
    if (!before.bootId || (after.bootId && after.bootId !== before.bootId)) {
      return { ok: true, to: after.version || status.version || '' };
    }
    if (!swapDeadline) swapDeadline = Date.now() + SWAP_TIMEOUT_MS;
  }
  return { ok: false, unreachable: true, error: 'gave up waiting for the update to finish' };
}

// --- chain state ------------------------------------------------------------

// in memory on the initiator only, everyone else seeing its published lock,
// pruned once it stops answering
let chain = null;
let wake = null;

// published to peers, so every host's update pane follows the walk, and its
// results for as long as ours linger
function sharedChain() {
  if (!chainStatus()) return null;
  return {
    initiator: SELF_HOST, chainId: chain.id, startedAt: chain.startedAt, paused: chain.paused, done: chain.done,
    pauseReason: chain.pauseReason, order: chain.order, results: chain.results, errors: chain.errors || {},
  };
}

function ownLock() {
  const c = sharedChain();
  return c && !c.done ? c : null;
}

// the initiator's own chain over the merged peer view, a poll behind
function meshLock() {
  return ownLock() || mesh.lock();
}

function chainStatus() {
  if (!chain) return null;
  // readable long enough to see the last host land, not long enough to greet
  // the next chain
  if (chain.done && Date.now() - (chain.finishedAt || 0) > CHAIN_LINGER_MS) return null;
  return {
    chainId: chain.id,
    order: chain.order,
    results: chain.results,
    versions: chain.versions,
    target: chain.target,
    currentIndex: chain.currentIndex,
    paused: chain.paused,
    pauseReason: chain.pauseReason,
    errors: chain.errors || {},
    done: chain.done,
    finishedAt: chain.finishedAt || 0,
  };
}

// every transition to disk, this process the thing its own step replaces,
// the frontend after the swap closing the chain out
function saveChain() {
  if (!chain) return;
  try { writeJsonAtomic(CHAIN_FILE, { ...chain, savedAt: Date.now() }); } catch {}
}

// whatever a host lands on as the target, for the ones still waiting to
// name where they're headed
function note(host, fields) {
  chain.versions[host] = { ...chain.versions[host], ...fields };
  const to = chain.versions[host].to;
  if (to && to !== chain.versions[host].from) chain.target = to;
  saveChain();
}

// every phosphorus host, git hosts then self last so origin stays up for the rest's
// fetch, a quiet one walked too as unreachable, pausing the chain
function buildOrder(gitHosts) {
  const peers = [...new Set(mesh.tailnet()
    .filter((d) => d && (d.phosphorus || d.phosSeen) && d.name && d.name !== SELF_HOST)
    .map((d) => d.name))];
  const git = new Set(gitHosts);
  const rank = (m) => (git.has(m) ? 1 : 0);
  peers.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return [...peers, SELF_HOST];
}

// resolved by the user's answer to a pause, no polling of its own flags
function waitForUser() {
  return new Promise((resolve) => { wake = resolve; });
}

function resume() {
  const w = wake;
  wake = null;
  if (w) w();
}

function finish(reason) {
  for (const m of chain.order) {
    if (chain.results[m] === 'pending' || chain.results[m] === 'running') chain.results[m] = 'skipped';
  }
  chain.paused = false;
  chain.done = true;
  chain.finishedAt = Date.now();
  saveChain();
  log(`chain ${chain.id.slice(0, 8)} ${reason}`);
  finishHook(chain);
}

// a failure as the update pane's status column says it, the full text logged
function brief(result) {
  const e = String(result.error || '');
  if (/fetch origin/.test(e)) return 'fetch failed';
  if (/reset to origin/.test(e)) return 'reset failed';
  if (/swap|phosphorus-updater/.test(e)) return 'swap failed';
  if (/build failed/.test(e)) return 'build failed';
  if (/timed out|gave up/.test(e)) return 'timed out';
  return result.unreachable ? 'unreachable' : 'failed';
}

// server.js's own notes on the running chain, kept across the swap
function remember(fields) {
  if (!chain) return;
  Object.assign(chain, fields);
  saveChain();
}

// own step the one nobody can report: the walk taken down by the swap,
// closed out by this boot
function restoreChain() {
  const saved = readJson(CHAIN_FILE, null);
  if (!saved || saved.done || !Array.isArray(saved.order)) return;
  if (Date.now() - (saved.savedAt || 0) > CHAIN_MAX_AGE_MS) return;
  chain = { ...saved, cancelled: true, paused: false, versions: saved.versions || {}, errors: saved.errors || {} };
  const running = chain.order.find((m) => chain.results[m] === 'running');
  if (running === SELF_HOST) {
    chain.results[SELF_HOST] = 'ok';
    note(SELF_HOST, { to: readVersion(VERSION_FILE) });
    finish('finished after the swap');
    return;
  }
  // restarted for some other reason, no walk left driving this
  if (running) chain.pauseReason = `${SELF_HOST} restarted while updating ${running}`;
  finish('interrupted by a restart');
}

// a few seconds, as the chat warning promises, nothing moving until they
// pass, a cancel inside the window caught by the loop's first check
const START_GRACE_MS = 5000;

async function runChain() {
  await clock.sleep(START_GRACE_MS);
  for (let i = 0; i < chain.order.length; i++) {
    if (chain.cancelled) { finish('cancelled'); return; }

    const host = chain.order[i];
    chain.currentIndex = i;
    chain.results[host] = 'running';
    note(host, { from: host === SELF_HOST ? readVersion(VERSION_FILE) : '' });
    log(`updating ${host} (${i + 1}/${chain.order.length})`);

    // no round trip when caller and callee are this process
    const result = host === SELF_HOST
      ? await runLocalUpdate()
      : await callPeerUpdate(host, (fields) => note(host, fields));

    if (result.ok) {
      chain.results[host] = result.current ? 'current' : 'ok';
      note(host, { to: result.to || '' });
      continue;
    }

    chain.results[host] = result.unreachable ? 'unreachable' : 'fail';
    chain.errors[host] = brief(result);
    saveChain();
    // cancelled mid-call, no pause with nobody left to answer it
    if (chain.cancelled) { finish('cancelled'); return; }
    chain.paused = true;
    chain.pauseReason = result.unreachable
      ? `${host} unreachable: ${result.error}`
      : `${host} returned FAIL: ${result.error}`;
    log(`paused, ${chain.pauseReason}`);
    saveChain();

    await waitForUser();
    if (chain.cancelled) { finish('cancelled'); return; }
    chain.paused = false;
    chain.pauseReason = '';
  }

  chain.currentIndex = chain.order.length;
  finish('finished');
}

// --- the API the server exposes ---------------------------------------------

function start(gitHosts = []) {
  const held = meshLock();
  if (held) return { locked: held.initiator };

  const order = buildOrder(gitHosts);
  chain = {
    id: crypto.randomUUID(),
    order,
    results: Object.fromEntries(order.map((m) => [m, 'pending'])),
    versions: {},
    errors: {},
    target: '',
    currentIndex: 0,
    paused: false,
    pauseReason: '',
    cancelled: false,
    done: false,
    startedAt: new Date().toISOString(),
  };
  log(`chain ${chain.id.slice(0, 8)} starting over ${order.join(', ')}`);
  saveChain();

  // not awaited, the chain endpoint answering before the walk begins
  runChain().catch((err) => {
    log(`chain failed: ${err.message}`);
    finish('aborted');
  });
  return { chainId: chain.id, order };
}

// stops before the next call, never one already in flight
function cancel() {
  if (!chain || chain.done) return false;
  chain.cancelled = true;
  if (chain.paused) resume();
  return true;
}

function proceed() {
  if (!chain || chain.done || !chain.paused) return false;
  resume();
  return true;
}

module.exports = {
  START_GRACE_MS, runLocalUpdate, onOutcome, onFinish, remember, ownLock, sharedChain, meshLock, chainStatus, restoreChain, start, cancel, proceed,
};
