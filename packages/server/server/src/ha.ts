// failover for installed services as this frontend runs it: every group's
// votes and view, the active's snapshot served to standbys, an admin's standby
// edits and moves (@phosphorus/stacks/ha)
import { splitChunks } from "@phosphorus/delta";
import * as peers from "@phosphorus/peers";
import { setMasterOf } from "@phosphorus/services";
import { ids, runtime, seams, viewOf, wantOf, wantRel } from "@phosphorus/stacks";
import { attach, HA, haStatus, leads, setHA } from "@phosphorus/stacks/ha";
import * as store from "@phosphorus/store";
import { admins, Of } from "@phosphorus/users";
import { DataDir, FrontendPort, intervalMS, logf, markHot, obj, requestJSON, tailnetIP } from "@phosphorus/util";
import type { StackWant } from "@phosphorus/wire";
import type { Ctx } from "@phosphorus/wsock";
import { adminPass, bootID, isUpdating, selfHost } from "./config.ts";
import { userUIAsync } from "./hostops.ts";
import { forbidden, isBrowser, isLoopback, isTailnet, maxJSONBody, onJSON, readRaw, sendJSON } from "./http.ts";

const haRe = /^\/api\/ha\/([a-z][a-z0-9-]{0,62})\/(vote|view|snap|lists|blocks|handoff)$/;
const stackRe = /^\/api\/stacks\/([a-z][a-z0-9-]{0,39})\/(standbys|move)$/;

let h: HA | undefined;

// read several times a tick, parsed at most every 250ms
let cached: { at: number; wants: Record<string, StackWant> } | undefined;
function wants(): Record<string, StackWant> {
  if (cached && Date.now() - cached.at < 250) return cached.wants;
  const out: Record<string, StackWant> = {};
  for (const id of ids()) {
    const w = wantOf(id);
    if (w) out[id] = w;
  }
  cached = { at: Date.now(), wants: out };
  return out;
}

// failover's fields written over the stored want, whatever else it holds kept
function setWant(id: string, w: StackWant) {
  const { active, standbys, gen, by, at } = w;
  store.write(wantRel(id), { ...obj(store.read(wantRel(id))), active, standbys, gen, by, at });
  cached = undefined;
  seams.kick();
}

const addr = async (host: string) => (await tailnetIP(host)) || host;

// a standby's ask of an active's snapshot: chunk lists or chunks, a response on a 200; a list of a
// big file cut on the spot, so minutes allowed
async function post(host: string, g: string, op: "lists" | "blocks", body: unknown): Promise<Response | undefined> {
  try {
    const r = await fetch(`http://${await addr(host)}:${FrontendPort}/api/ha/${g}/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    return r.status === 200 ? r : undefined;
  } catch (e) {
    logf("[ha] %s: %s from %s: %s", g, op, host, e instanceof Error ? e.message : e);
    return;
  }
}

// started with the frontend; votes answered before any runtime attaches
export function startHA(): HA {
  h = new HA({
    self: selfHost,
    stateDir: DataDir,
    wants,
    setWant,
    peers: peers.peerHA,
    offlineMs: peers.offlineMS,
    pollMs: intervalMS,
    updating: isUpdating,
    bootId: () => bootID,
    notify: (title, body) => {
      // kept in each admin's bell until they open the wizard
      for (const u of admins()) userUIAsync(u, { kind: "notify", title, body, view: "apps" });
    },
    call: async (host, method, path, body) => {
      try {
        const r = await requestJSON({
          host: await addr(host),
          port: FrontendPort,
          method,
          path,
          body,
          // a snapshot's manifest lists every file
          timeoutMs: path.includes("/snap") ? 15000 : 500,
        });
        return r.status === 200 ? obj(r.body) : undefined;
      } catch {
        return undefined;
      }
    },
    lists: async (host, g, paths) => {
      const r = await post(host, g, "lists", { paths });
      const o = r && obj(await r.json().catch(() => undefined));
      return o ?? undefined;
    },
    blocks: async (host, g, want) => {
      const r = await post(host, g, "blocks", { want });
      if (!r) return;
      return splitChunks(new Uint8Array(await r.arrayBuffer()), want);
    },
    changed: markHot,
  });
  setHA(h);
  setMasterOf(leads);
  seams.haStatus = haStatus;
  attach(runtime);
  h.start();
  return h;
}

// every active stack handed to a standby before this frontend goes
export async function stopHA() {
  await h?.stop();
}

// this host's state in each group, for its peers
export const ownHA = () => h?.own() ?? {};

// an admin's standby edit or planned move, from the page or the connector
export function haStandbys(id: string, standbys: unknown, by: string, active?: unknown): [number, any] {
  if (!h) return [503, { error: "failover not started" }];
  markHot();
  const [st, out] = h.setStandbys(id, standbys, by, active);
  return st === 200 ? [st, { ok: true, want: viewOf(out.want) }] : [st, out];
}
export async function haMove(id: string, to: unknown): Promise<[number, any]> {
  if (!h) return [503, { error: "failover not started" }];
  markHot();
  return h.move(id, to);
}

export async function haRoute(c: Ctx, pathname: string, method: string, q: URLSearchParams) {
  let m = haRe.exec(pathname);
  if (m) {
    if (!(await isTailnet(c)) || !h) return forbidden();
    const [, g, op] = m as unknown as [string, string, string];
    if (op === "vote" && method === "POST") return onJSON(c, maxJSONBody, true, (p) => h!.vote(g, p));
    if (op === "view" && method === "GET") return sendJSON(200, h.view(g));
    if (op === "snap" && method === "GET") {
      const man = h.snap(g, q.get("have") ?? undefined);
      return man ? sendJSON(200, man) : sendJSON(409, { error: "no snapshot here" });
    }
    if (op === "lists" && method === "POST")
      return onJSON(c, maxJSONBody, true, async (p) => {
        const out = await h!.lists(g, p.paths);
        return out ? [200, out] : [409, { error: "no snapshot here" }];
      });
    if (op === "blocks" && method === "POST") {
      const raw = await readRaw(c, maxJSONBody);
      let want: unknown;
      try {
        want = raw && obj(JSON.parse(Buffer.from(raw).toString("utf8")))?.want;
      } catch {}
      const b = want ? await h.blocks(g, want) : undefined;
      return b
        ? new Response(b, { headers: { "content-type": "application/octet-stream" } })
        : sendJSON(409, { error: "a chunk is no longer there" });
    }
    if (op === "handoff" && method === "POST")
      return onJSON(c, maxJSONBody, true, (p) => {
        markHot();
        return h!.askHandoff(g, p.to);
      });
    return;
  }
  m = stackRe.exec(pathname);
  if (m && method === "POST") {
    const s = Of(c);
    if (!isBrowser(c) || !((!!s && s.admin) || (adminPass === "" && isLoopback(c)))) return forbidden();
    if (!h) return sendJSON(503, { error: "failover not started" });
    const id = m[1]!;
    if (m[2] === "standbys")
      return onJSON(c, maxJSONBody, true, (p) => haStandbys(id, p.standbys, s?.user ?? "admin", p.active));
    return onJSON(c, maxJSONBody, true, (p) => haMove(id, p.to));
  }
  return;
}
