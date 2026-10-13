'use strict';
// the mesh update chain: this host's own update, the lock it publishes while
// driving one, and the walk across every host

const crypto = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const clock = require('./clock');
const mesh = require('./mesh');
const { readJson, writeJsonAtomic, tailnetIp, requestJson } = require('./util');

const SELF_HOST = process.env.SELF_HOST || '';
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT || 8090);
const STATE_DIR = process.env.STATE_DIR || '/state';
const CHAIN_FILE = path.join(STATE_DIR, 'update-chain.json');
const VERSION_FILE = process.env.VERSION_FILE || '/opt/hesperus/VERSION';
// the home as the host sees it, a pre-installer checkout's clone
const REPO_DIR = process.env.REPO_DIR || '/repo';
// handed to the host's agent (systemd path unit, the app), its verdict read back
const REQUEST_FILE = path.join(STATE_DIR, 'update-request.json');
const AGENT_FILE = path.join(STATE_DIR, 'update-agent.json');
// the release feed: newest version, the installers and app feeds beside it
const FEED_URL = process.env.HESPERUS_FEED_URL || 'https://github.com/pmghartman/hesperus/releases/download/update/latest.json';
const FEED_TTL_MS = 600000;
// a pre-installer checkout's update: the release's .deb installed on the host,
// migrating it into its home
const INSTALLER = 'hesperus-installer';
const PLATFORM_FILE = path.join(STATE_DIR, 'platform.json');
// nobody answering the request: no agent on this host
const AGENT_PICKUP_MS = 60000;

// long enough for a cold layer cache, under PEER_CAP_MS, the peer's
// own verdict, not a guess from here
const UPDATE_TIMEOUT_MS = 1200000;
// a peer not listening failed now, not in minutes, still room for a tailnet
// round trip and handshake
const CONNECT_TIMEOUT_MS = 2000;
// the agent done, swap handed off: a new frontend answering well within this
const SWAP_TIMEOUT_MS = 120000;
// answering = still working, whatever the build costs, a clock only on
// silence, the cap against a chain hanging forever
const PEER_QUIET_MS = 180000;
// a checkout's install migrating it, silent while it copies models and shares
const INSTALL_QUIET_MS = 1500000;
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

const isCheckout = () => fs.existsSync(path.join(REPO_DIR, '.git'));

// releases are MAJOR.MINOR, an old checkout's version its commit count past that
const behind = (latest, v) => !!latest && !!v && (String(v).split('.').length > 2 || newer(latest, v));

// numeric, part by part, 0.13 < 0.13.1 < 0.14
function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

let feed = { at: 0, latest: '', error: '' };

// the newest release against this host's, cached, force: a button's fresh look
async function check(force = false) {
  if (force || Date.now() - feed.at > FEED_TTL_MS) {
    try {
      const r = await fetch(FEED_URL, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`feed answered ${r.status}`);
      const j = await r.json();
      feed = { at: Date.now(), latest: String(j.version || ''), notes: String(j.notes || ''), error: '' };
    } catch (err) {
      feed = { ...feed, at: Date.now(), error: err.message };
    }
  }
  const current = readVersion(VERSION_FILE);
  return {
    current, latest: feed.latest, notes: feed.notes || '', error: feed.error,
    available: behind(feed.latest, current), checkedAt: feed.at,
  };
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
  const done = (r) => {
    if (r.ok) outcomeHook({ state: 'ok', current: r.current, version: r.to });
    else outcomeHook({ state: 'failed', error: r.error });
    return r;
  };
  if (isCheckout()) return checkoutUpdate().then(done);
  const id = crypto.randomUUID();
  try { writeJsonAtomic(REQUEST_FILE, { id, at: Date.now() }); } catch (err) {
    return Promise.resolve(done({ ok: false, error: `couldn't request the update: ${err.message}` }));
  }
  // the agent's swap may kill this process first, the next boot then answering
  return (async () => {
    const started = Date.now();
    while (Date.now() - started < UPDATE_TIMEOUT_MS) {
      await clock.sleep(2000);
      const a = readJson(AGENT_FILE, {});
      if (a.id !== id) {
        if (Date.now() - started > AGENT_PICKUP_MS && fs.existsSync(REQUEST_FILE)) {
          try { fs.unlinkSync(REQUEST_FILE); } catch {}
          return done({ ok: false, error: 'no update agent on this host: reinstall from the latest release' });
        }
        continue;
      }
      if (a.state === 'ok') return done({ ok: true, current: !!a.current, to: a.version || readVersion(VERSION_FILE) });
      if (a.state === 'failed') return done({ ok: false, error: String(a.error || 'update failed').slice(0, 500) });
    }
    return done({ ok: false, error: 'update timed out' });
  })();
}

function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => resolve({
      ok: !err, out: String(stdout).trim(), err: String(stderr || (err && err.message) || '').trim(),
    }));
  });
}
const lastLine = (s) => s.split('\n').filter(Boolean).pop() || '';

// the checkout's own host path, what nsenter on the host runs from
async function hostRepo() {
  const r = await run('docker', ['inspect', 'hesperus', '--format',
    '{{range .Mounts}}{{if eq .Destination "/repo"}}{{.Source}}{{end}}{{end}}'], 10000);
  return r.ok ? r.out : '';
}

// the release's .deb on the host, in a sibling outliving this container, its
// installer migrating the checkout into /var/lib/hesperus
async function checkoutUpdate() {
  const platform = String((readJson(PLATFORM_FILE, {}) || {}).platform || '');
  if (platform !== 'linux') {
    return { ok: false, error: `a checkout on ${platform || 'this host'}: run the latest release's installer there` };
  }
  const repo = await hostRepo();
  if (!repo.startsWith('/')) return { ok: false, error: 'can\'t find this checkout on the host' };
  log(`a checkout at ${repo}: installing the latest release over it`);
  await run('docker', ['rm', '-f', INSTALLER], 30000);
  const started = await run('docker', ['run', '-d', '--name', INSTALLER, '--privileged', '--pid=host', '--net=host',
    '--entrypoint', 'nsenter', 'hesperus:latest', '-t', '1', '-m', '-u', '-i', '-n', '-p', '--',
    'bash', `${repo}/scripts/install-release.sh`], 60000);
  if (!started.ok) return { ok: false, error: `couldn't start ${INSTALLER}: ${lastLine(started.err)}` };
  // the migration stops this container, the next boot answering for it
  const until = Date.now() + UPDATE_TIMEOUT_MS;
  while (Date.now() < until) {
    await clock.sleep(2000);
    const s = await run('docker', ['inspect', '-f', '{{.State.Status}}:{{.State.ExitCode}}', INSTALLER], 10000);
    if (!s.ok || !s.out.startsWith('exited:')) continue;
    if (s.out === 'exited:0') return { ok: true, to: feed.latest || '' };
    const logs = await run('docker', ['logs', '--tail', '20', INSTALLER], 10000);
    return { ok: false, error: lastLine(`${logs.out}\n${logs.err}`.split('\n').filter((l) => /ERROR/.test(l)).join('\n')) || `${INSTALLER} ${s.out}` };
  }
  return { ok: false, error: 'install timed out' };
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
// process answering, version for the UI, a phosphorus-era peer by its tailnet's key
function fetchSelf(host) {
  return peer(host, { path: '/api/mesh/snapshot' })
    .then((r) => r.body || {}, () => ({}))
    .then((b) => {
      const self = b.self || {};
      return {
        bootId: String(self.bootId || ''), version: String(self.version || ''), checkout: !!self.checkout,
        platform: String(self.platform || ''),
        phosphorus: Array.isArray(b.tailnet) && b.tailnet.some((d) => d && 'phosphorus' in d),
      };
    });
}

// "current" ending it in place, else the swap kills the peer's frontend,
// only a new boot id telling a landed swap from the old process's "ok"
async function callPeerUpdate(host, note, quietMs = PEER_QUIET_MS) {
  const addr = (await tailnetIp(host)) || host;
  const before = await fetchSelf(addr);
  note({ from: before.version });
  // an "ok" already on disk: the last run's, not this one's
  const baselineAt = await fetchStatus(addr).then((s) => s.at || 0).catch(() => 0);
  const kicked = await kickOffPeerUpdate(addr);
  if (!kicked.ok) return kicked;

  const cap = Date.now() + PEER_CAP_MS;
  let quietUntil = Date.now() + quietMs;
  let swapDeadline = 0;
  while (Date.now() < cap) {
    // the mesh's tick, held at the fast rate by the published lock
    await clock.sleep(clock.intervalMs());
    let status;
    try {
      status = await fetchStatus(addr);
      // answered: building or swapping, however long that takes
      quietUntil = Date.now() + quietMs;
    } catch {
      // unreachable mid-build or mid-swap, a verdict only if it stays that way
      if (Date.now() > quietUntil) {
        return { ok: false, unreachable: true, error: 'stopped answering during its update' };
      }
      continue;
    }
    if (swapDeadline && Date.now() > swapDeadline) {
      return { ok: false, error: 'swap never landed, see docker logs hesperus-updater on that host' };
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

// every hesperus host, git hosts then self last so origin stays up for the rest's
// fetch, a quiet one walked too as unreachable, pausing the chain
function buildOrder(gitHosts) {
  const peers = [...new Set(mesh.tailnet()
    .filter((d) => d && (d.hesperus || d.hesperusSeen) && d.name && d.name !== SELF_HOST)
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
  if (/agent|feed|apt/.test(e)) return 'update failed';
  if (/pull failed/.test(e)) return 'pull failed';
  if (/swap|hesperus-updater/.test(e)) return 'swap failed';
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

    // a phosphorus-era peer's own update pulls the wrong repo: the installer only
    const addr = host === SELF_HOST ? '' : (await tailnetIp(host)) || host;
    const installing = (p) => p.checkout && p.platform === 'linux';
    let quietMs = PEER_QUIET_MS;
    if (addr) {
      const p = await fetchSelf(addr);
      if (installing(p)) quietMs = INSTALL_QUIET_MS;
      if (p.phosphorus) {
        chain.results[host] = 'skipped';
        chain.errors[host] = 'needs the installer';
        note(host, { from: p.version });
        continue;
      }
    }

    // no round trip when caller and callee are this process
    let result = host === SELF_HOST
      ? await runLocalUpdate()
      : await callPeerUpdate(host, (fields) => note(host, fields), quietMs);
    // a pre-installer checkout pulled onto this code: a second hop, its Linux install
    if (result.ok && addr && installing(await fetchSelf(addr))) {
      log(`${host} is still a checkout, installing the release there`);
      result = await callPeerUpdate(host, (fields) => note(host, fields), INSTALL_QUIET_MS);
    }

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
  START_GRACE_MS, check, newer, isCheckout, runLocalUpdate, onOutcome, onFinish, remember, ownLock, sharedChain, meshLock, chainStatus, restoreChain, start, cancel, proceed,
};
