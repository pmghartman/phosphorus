// this host's own update, the lock it publishes while driving one, and the
// mesh's, every host at once
import { join } from "node:path";
import { lock as meshLockOf, tailnet } from "@phosphorus/peers";
import { env, errText, localeCompare, logf as log, now, obj, readJSON, SelfHost, StateDir, writeJSONAtomic } from "@phosphorus/util";
import { ask, callPeerUpdate, readVersion, type Result, result, seams, settleSelf, str, uuid, VersionFile, watchPeer } from "./local.ts";

export { ask, busy, callPeerUpdate, onFailed, readVersion, type Request, type Result, result, seams, settleSelf, status, uuid, VersionFile, verdict, watchPeer } from "./local.ts";

const selfHost = SelfHost;
const chainFile = join(StateDir, "update-chain.json");
const feedURL = env("PHOSPHORUS_FEED_URL", "https://github.com/pmghartman/phosphorus/releases/download/update/latest.json");

const feedTTLMS = 600000;
const feedRetryMS = 30000;
export const chainMaxAgeMS = 1800000;
const chainLingerMS = 120000;

const logf = (f: string, ...a: unknown[]) => log("[update] " + f, ...a);

// numeric, part by part, 0.13 < 0.13.1 < 0.14
export function newer(a: string, b: string): boolean {
  const pa = a.split("."), pb = b.split(".");
  const num = (xs: string[], i: number) => (i < xs.length ? Number(xs[i]) || 0 : 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = num(pa, i) - num(pb, i);
    if (d !== 0) return d > 0;
  }
  return false;
}

const feed = { at: 0, latest: "", notes: "", error: "" };
let fetching: Promise<void> | undefined;

async function fetchFeed() {
  try {
    const r = await fetch(feedURL, { signal: AbortSignal.timeout(10000) });
    if (r.status < 200 || r.status >= 300) throw new Error(`feed answered ${r.status}`);
    const j = obj(await r.json());
    if (!j) throw new Error("feed isn't an object");
    feed.at = now();
    feed.latest = str(j.version);
    feed.notes = str(j.notes);
    feed.error = "";
  } catch (e) {
    // retried soon, not held for the whole ttl
    feed.at = now() - feedTTLMS + feedRetryMS;
    feed.error = errText(e);
  }
}

// the newest release against this host's, cached
export async function check(force: boolean): Promise<Record<string, any>> {
  if (fetching) await fetching;
  if (force || now() - feed.at > feedTTLMS) await (fetching = fetchFeed().finally(() => void (fetching = undefined)));
  const cur = readVersion(VersionFile);
  return {
    current: cur, latest: feed.latest, notes: feed.notes, error: feed.error,
    available: feed.latest !== "" && cur !== "" && newer(feed.latest, cur), checkedAt: feed.at,
  };
}

// --- chain state ------------------------------------------------------------

// the mesh update, on the initiator only; update-chain.json's shape
export type Chain = {
  id: string;
  order: string[];
  results: Record<string, string>;
  versions: Record<string, Record<string, string>>;
  errors: Record<string, string>;
  details?: Record<string, string>;
  target: string;
  cancelled: boolean;
  done: boolean;
  startedAt: string;
  finishedAt: number;
  savedAt: number;
};

let finishHook: (c: Chain) => void = () => {};

// a chain ending, however it ended
export const onFinish = (fn: (c: Chain) => void) => void (finishHook = fn);

let chain: Chain | undefined;

function chainStatus_(): Record<string, any> | null {
  if (!chain) return null;
  if (chain.done && now() - chain.finishedAt > chainLingerMS) return null;
  return {
    chainId: chain.id, order: chain.order, results: chain.results, versions: chain.versions,
    target: chain.target, errors: chain.errors, done: chain.done, finishedAt: chain.finishedAt,
  };
}

function shared(): Record<string, any> | null {
  if (!chain || chainStatus_() === null) return null;
  return {
    initiator: selfHost, chainId: chain.id, startedAt: chain.startedAt, done: chain.done,
    order: chain.order, results: chain.results, errors: chain.errors,
  };
}

// published to peers
export const sharedChain = (): unknown => shared();

// while this host drives a chain
export function ownLock(): unknown {
  const c = shared();
  return !c || c.done === true ? null : c;
}

// the initiator's own chain over the merged peer view
export const meshLock = (): unknown => ownLock() ?? meshLockOf();

// this host's chain, null when none
export const chainStatus = (): unknown => chainStatus_();

// Go's field order and omitempty kept, the file read back by the next release
function save() {
  if (!chain) return;
  const c = chain;
  c.savedAt = now();
  writeJSONAtomic(chainFile, {
    id: c.id, order: c.order, results: c.results, versions: c.versions, errors: c.errors,
    details: c.details && Object.keys(c.details).length ? c.details : undefined,
    target: c.target, cancelled: c.cancelled, done: c.done, startedAt: c.startedAt,
    finishedAt: c.finishedAt || undefined, savedAt: c.savedAt,
  });
}

function note(host: string, fields: Record<string, string>) {
  if (!chain) return;
  const v = (chain.versions[host] ??= {});
  Object.assign(v, fields);
  const to = v.to;
  if (to && to !== v.from) chain.target = to;
  save();
}

function buildOrder(gitHosts: string[]): string[] {
  const git = new Set(gitHosts);
  const seen = new Set<string>();
  const peers: string[] = [];
  for (const d of tailnet()) {
    const n = typeof d.name === "string" ? d.name : "";
    if ((d.phosphorus === true || d.phosphorusSeen === true) && n && n !== selfHost && !seen.has(n)) {
      seen.add(n);
      peers.push(n);
    }
  }
  const rank = (m: string) => (git.has(m) ? 1 : 0);
  peers.sort((a, b) => rank(a) - rank(b) || localeCompare(a, b));
  return [...peers, selfHost];
}

function finish(reason: string) {
  if (!chain) return;
  for (const m of chain.order) {
    const r = chain.results[m];
    if (r === "pending" || r === "running") chain.results[m] = "skipped";
  }
  chain.done = true;
  chain.finishedAt = now();
  save();
  logf("chain %s %s", chain.id.slice(0, 8), reason);
  const c = { ...chain };
  queueMicrotask(() => finishHook(c));
}

const briefRes: [RegExp, string][] = [
  [/agent|feed|apt/, "update failed"],
  [/pull failed/, "pull failed"],
  [/restart never landed/, "restart failed"],
  [/build failed/, "build failed"],
  [/timed out|gave up/, "timed out"],
];

export function brief(r: Result): string {
  for (const [re, out] of briefRes) if (re.test(r.error)) return out;
  return r.unreachable ? "unreachable" : "failed";
}

// a host's outcome recorded
function record(host: string, r: Result): boolean {
  if (!chain) return false;
  if (r.ok) {
    chain.results[host] = r.current ? "current" : "ok";
    note(host, { to: r.to, stage: "" });
    return true;
  }
  chain.results[host] = r.unreachable ? "unreachable" : "fail";
  chain.errors[host] = brief(r);
  (chain.details ??= {})[host] = r.error;
  logf("%s failed: %s", host, r.error);
  save();
  return false;
}

// one host followed, a throw its failure rather than the chain's
async function follow(host: string, fn: () => Promise<Result>) {
  let r: Result;
  try {
    r = await fn();
  } catch (e) {
    r = result({ error: errText(e) });
  }
  record(host, r);
}

const noter = (host: string) => (f: Record<string, string>) => note(host, f);

// a chain this host drove through its own restart: every host still running
// followed to its verdict again, this one's read from its agent
export function restoreChain() {
  const saved = readJSON<Partial<Chain>>(chainFile);
  if (!saved || saved.done || !Array.isArray(saved.order)) return;
  if (now() - (saved.savedAt ?? 0) > chainMaxAgeMS) return;
  chain = {
    ...saved, id: String(saved.id ?? ""), order: saved.order, results: saved.results ?? {}, versions: saved.versions ?? {}, errors: saved.errors ?? {},
    target: saved.target ?? "", cancelled: !!saved.cancelled, done: false, startedAt: saved.startedAt ?? "", finishedAt: saved.finishedAt ?? 0, savedAt: saved.savedAt ?? 0,
  };
  const c = chain;
  const running = c.order.filter((m) => c.results[m] === "running");
  if (!running.length) {
    finish("finished after the swap");
    return;
  }
  logf("chain %s back after the swap, still watching %s", c.id.slice(0, 8), running.join(", "));
  void (async () => {
    await Promise.all(
      running.map((host) => {
        const v = c.versions[host] ?? {};
        const { id = "", from = "", boot = "" } = v;
        const stage = v.stage || "asked";
        return follow(host, () => (host === selfHost ? settleSelf(id) : watchPeer(host, id, from, boot, stage, noter(host))));
      }),
    );
    finish("finished");
  })();
}

// every host at once, this one too, each through its own agent; this host's
// swap ends the driver, restoreChain picking the rest up on its boot
async function runChain() {
  await Bun.sleep(testing.startGraceMS);
  if (!chain) return;
  if (chain.cancelled) {
    finish("cancelled");
    return;
  }
  const hosts = [...chain.order];
  for (const h of hosts) chain.results[h] = "running";
  logf("updating %s at once", hosts.join(", "));
  await Promise.all(
    hosts.map((host) =>
      follow(host, async () => {
        if (host !== selfHost) return callPeerUpdate(host, noter(host));
        const q = ask();
        note(host, { from: readVersion(VersionFile), stage: "installing", id: q.id });
        return q.wait();
      }),
    ),
  );
  finish("finished");
}

// a chain over only those hosts, every host when only is empty, or who holds
// the lock
export function start(gitHosts: string[], only: string[]): Record<string, any> {
  const held = obj(meshLock());
  if (held) return { locked: held.initiator };
  let order = buildOrder(gitHosts);
  if (only.length) {
    const kept = order.filter((h) => only.includes(h));
    if (!kept.length) return { error: `none of ${only.join(", ")} is a phosphorus host on the mesh` };
    order = kept;
  }
  const results: Record<string, string> = {};
  for (const m of order) results[m] = "pending";
  chain = {
    id: uuid(), order, results, versions: {}, errors: {}, target: "", cancelled: false, done: false,
    startedAt: new Date().toISOString(), finishedAt: 0, savedAt: 0,
  };
  logf("chain %s starting over %s", chain.id.slice(0, 8), order.join(", "));
  save();
  const id = chain.id;
  runChain().catch((e) => {
    logf("chain failed: %s", errText(e));
    finish("aborted");
  });
  return { chainId: id, order };
}

// stops a chain still in its grace, before any host is asked
export function cancel(): boolean {
  if (!chain || chain.done) return false;
  chain.cancelled = true;
  return true;
}

// the tests' hands: nothing moving until the grace passes, every chain and
// request forgotten
export const testing = {
  startGraceMS: 5000,
  chain: () => chain,
  reset() {
    seams.reset();
    chain = undefined;
    finishHook = () => {};
  },
};
