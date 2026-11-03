// the chat across hosts, over the app's internal routes: each host's own lines
// pushed to every other as they're posted, a catch-up from the last seq held
// when a host comes up, when its word on who's on (every few seconds) names a
// newer line than held here, and every half minute after. Not the store: its
// files are whole and newest-wins, so a host's log would go to every peer whole
// on each line, and a file per line would sit in every digest and keep a
// tombstone for 90 days
import type { AppContext } from "@phosphorus/app-sdk";
import {
  type Msg,
  mergeFromPeers,
  mergePeerPresence,
  onOwnLines,
  onPresence,
  ownChatSince,
  ownHead,
  peerSeq,
  presence,
} from "./log.ts";
import { marshal, now, num, obj } from "./util.ts";

const tickMS = 2000;
const catchUpMS = 30_000;
const presenceMS = 10_000;
// a host's people no longer believed past this without a word from it
const presenceStaleMS = 25_000;
const hostRe = /^[a-z0-9][a-z0-9-]{0,62}$/;

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function mesh(ctx: AppContext): { stop: () => void } {
  // when each host was last caught up from, gone once it drops so its return asks at once
  const caught = new Map<string, number>();
  const asking = new Set<string>();
  const heard = new Map<string, { at: number; people: unknown[] }>();
  let saidAt = 0;
  let said = "";

  const others = () => ctx.hosts().filter((h) => h !== ctx.host);
  const fromHost = (b: Msg | undefined) => {
    const h = typeof b?.host === "string" ? b.host : "";
    return hostRe.test(h) && h !== ctx.host ? h : "";
  };

  ctx.route(
    "POST",
    "/lines",
    async (r) => {
      const b = obj(await r.json());
      if (!fromHost(b)) return [400, { error: "from which host?" }];
      mergeFromPeers(arr(b!.lines));
      return [200, { ok: true }];
    },
    { internal: true },
  );
  ctx.route("POST", "/since", async (r) => [200, { lines: ownChatSince(num(obj(await r.json())?.seq)) }], {
    internal: true,
  });
  ctx.route(
    "POST",
    "/presence",
    async (r) => {
      const b = obj(await r.json());
      const h = fromHost(b);
      if (!h) return [400, { error: "from which host?" }];
      heard.set(h, { at: now(), people: arr(b!.people) });
      handPresence();
      // a line of its missed while either was away
      if (num(b!.seq) > peerSeq(h)) catchUp(h);
      return [200, { ok: true }];
    },
    { internal: true },
  );

  // a line posted here, to every host up; one that misses it catches up later
  onOwnLines((lines) => {
    for (const h of others()) ctx.peer(h, "/lines", { host: ctx.host, lines }).catch(() => caught.delete(h));
  });

  let shown = "";
  function handPresence() {
    const up = new Set(others());
    const peers: Record<string, unknown[]> = {};
    for (const [h, p] of heard) {
      if (!up.has(h) || now() - p.at > presenceStaleMS) heard.delete(h);
      else peers[h] = p.people;
    }
    const j = marshal(peers);
    if (j === shown) return;
    shown = j;
    mergePeerPresence(peers);
  }

  function sayPresence(force: boolean) {
    const people = presence();
    const j = marshal(people);
    if (!force && j === said && now() - saidAt < presenceMS) return;
    said = j;
    saidAt = now();
    for (const h of others()) ctx.peer(h, "/presence", { host: ctx.host, people, seq: ownHead() }).catch(() => {});
  }
  onPresence(() => sayPresence(false));

  function catchUp(h: string) {
    if (asking.has(h)) return;
    asking.add(h);
    ctx
      .peer(h, "/since", { seq: peerSeq(h) })
      .then((b) => {
        const lines = arr(obj(b)?.lines);
        if (lines.length) mergeFromPeers(lines);
        caught.set(h, now());
      })
      .catch(() => {})
      .finally(() => asking.delete(h));
  }

  function tick() {
    const up = others();
    for (const h of caught.keys()) if (!up.includes(h)) caught.delete(h);
    let fresh = false;
    for (const h of up) {
      const at = caught.get(h);
      if (at === undefined && !asking.has(h)) fresh = true;
      if (at === undefined || now() - at > catchUpMS) catchUp(h);
    }
    sayPresence(fresh);
    handPresence();
  }

  const t = setInterval(tick, tickMS);
  tick();
  return { stop: () => clearInterval(t) };
}
