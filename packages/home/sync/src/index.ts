// the home kept alike on every host over the peers' links: a change pushed to
// every peer as it's found, the digests swapped now and then, a peer whose
// digest differs asked for all its versions and the newer ones taken
import { HomeRoot, setOnChange } from "@phosphorus/files";
import * as peers from "@phosphorus/peers";
import * as store from "@phosphorus/store";
import { errText, logf, markHot, SelfHost } from "@phosphorus/util";
import type { PeerFrame } from "@phosphorus/wire";
import { HomeSync, type Remote } from "./home.ts";

export { conflictName, HomeSync, type Rec, type Remote, skipped, TombstoneMs } from "./home.ts";

const digestEveryMs = 10_000;
// a whole index asked of a peer: a big home's takes a while
const stampsWaitMs = 120_000;

let sync: HomeSync | undefined;
let from: Remote = { list: async () => undefined, blocks: async () => undefined };
// each peer's digest once everything it had was taken, and a pull under way
const synced = new Map<string, string>();
const pulling = new Set<string>();

// the home's digest, "" before the sync starts: changes when anything in it does
export const digest = () => sync?.digest() ?? "";

const sendAll = (f: PeerFrame) => {
  for (const h of peers.upPeers()) peers.sendPeer(h, f);
};

// everything a peer holds newer than here, its digest marked once all of it arrived
async function pull(host: string, theirs: string) {
  if (!sync || pulling.has(host)) return;
  pulling.add(host);
  try {
    const st = await peers.requestPeer(host, "home.stamps", undefined, stampsWaitMs);
    if (!st || typeof st !== "object") return;
    const { far, left } = await sync.merge(host, st as Record<string, unknown>, from);
    if (far)
      logf(
        "[home] %d paths from %s stamped over a minute ahead of this clock, skipped until it's set right",
        far,
        host,
      );
    if (!far && !left) synced.set(host, theirs);
  } catch (e) {
    logf("[home] sync with %s failed, retrying: %s", host, errText(e));
  } finally {
    pulling.delete(host);
  }
}

function onFrame(host: string, f: PeerFrame) {
  if (f.type !== "home" || !sync) return;
  if (f.files && typeof f.files === "object") void sync.merge(host, f.files, from);
  if (typeof f.digest === "string" && f.digest !== sync.digest() && f.digest !== synced.get(host))
    void pull(host, f.digest);
}

// a peer's ask of this home: a version's chunk list, and chunks by name
export const listOf = (rel: string, c: string) => sync?.listOf(rel, c) ?? Promise.resolve(undefined);
export const blocksOf = (want: unknown) => sync?.blocksOf(want) ?? Promise.resolve(undefined);

// the home indexed and watched, and kept in step with every peer; remote asks the peer that has
// a version for its chunks
export async function start(remote: Remote) {
  from = remote;
  sync = new HomeSync({ root: HomeRoot, self: SelfHost, file: store.local("home-index.json") });
  sync.load();
  const s = sync;
  peers.onPeerReq("home.stamps", () => s.stamps());
  peers.onPeerFrame("home", onFrame);
  peers.onLinkUp((h) => {
    synced.delete(h);
    peers.sendPeer(h, { type: "home", digest: s.digest() });
  });
  s.onChange((rels) => {
    sendAll({ type: "home", files: s.stamps(rels) });
    markHot();
  });
  await s.scan();
  const touched = s.watch();
  // a write through the files API told at once, ahead of the watcher
  setOnChange((_op, rel, to) => {
    touched(rel);
    if (to) touched(to);
  });
  setInterval(() => sendAll({ type: "home", digest: s.digest() }), digestEveryMs);
  sendAll({ type: "home", digest: s.digest() });
}
