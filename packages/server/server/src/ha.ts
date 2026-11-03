// failover for installed services as this frontend runs it: every group's
// votes and view, the active's snapshot served to standbys, an admin's standby
// edits and moves (@phosphorus/stacks/ha)
import * as peers from "@phosphorus/peers";
import { setMasterOf } from "@phosphorus/services";
import { ids, runtime, seams, viewOf, wantOf, wantRel } from "@phosphorus/stacks";
import { attach, HA, haStatus, leads, setHA } from "@phosphorus/stacks/ha";
import * as store from "@phosphorus/store";
import { admins, Of } from "@phosphorus/users";
import { FrontendPort, intervalMS, logf, markHot, obj, requestJSON, StateDir, tailnetIP } from "@phosphorus/util";
import type { StackWant } from "@phosphorus/wire";
import type { Ctx } from "@phosphorus/wsock";
import { adminPass, bootID, isUpdating, selfHost } from "./config.ts";
import { userUIAsync } from "./hostops.ts";
import { forbidden, isBrowser, isLoopback, isTailnet, maxJSONBody, onJSON, sendJSON } from "./http.ts";

const haRe = /^\/api\/ha\/([a-z][a-z0-9-]{0,62})\/(vote|view|snap|file|handoff)$/;
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

// started with the frontend; votes answered before any runtime attaches
export function startHA(): HA {
  h = new HA({
    self: selfHost,
    stateDir: StateDir,
    wants,
    setWant,
    peers: peers.peerHA,
    offlineMs: peers.offlineMS,
    pollMs: intervalMS,
    updating: isUpdating,
    bootId: () => bootID,
    notify: (title, body) => {
      for (const u of admins()) userUIAsync(u, { kind: "notify", title, body });
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
          timeoutMs: path.endsWith("/snap") ? 15000 : 500,
        });
        return r.status === 200 ? obj(r.body) : undefined;
      } catch {
        return undefined;
      }
    },
    fetchFile: async (host, g, path, file) => {
      try {
        const res = await fetch(
          `http://${await addr(host)}:${FrontendPort}/api/ha/${g}/file?p=${encodeURIComponent(path)}`,
          { signal: AbortSignal.timeout(10 * 60 * 1000) },
        );
        if (res.status !== 200) return false;
        await Bun.write(file, res);
        return true;
      } catch (e) {
        logf("[ha] %s: pulling %s from %s: %s", g, path, host, e instanceof Error ? e.message : e);
        return false;
      }
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

export async function haRoute(c: Ctx, pathname: string, method: string, q: URLSearchParams) {
  let m = haRe.exec(pathname);
  if (m) {
    if (!(await isTailnet(c)) || !h) return forbidden();
    const [, g, op] = m as unknown as [string, string, string];
    if (op === "vote" && method === "POST") return onJSON(c, maxJSONBody, true, (p) => h!.vote(g, p));
    if (op === "view" && method === "GET") return sendJSON(200, h.view(g));
    if (op === "snap" && method === "GET") {
      const man = h.manifest(g);
      return man ? sendJSON(200, man) : sendJSON(409, { error: "no snapshot here" });
    }
    if (op === "file" && method === "GET") {
      const f = h.file(g, q.get("p") ?? "");
      return f ? new Response(Bun.file(f)) : sendJSON(404, { error: "no such file" });
    }
    if (op === "handoff" && method === "POST")
      return onJSON(c, maxJSONBody, true, (p) => {
        markHot();
        return h!.askHandoff(g, p.to);
      });
    return;
  }
  m = stackRe.exec(pathname);
  // the old git's move is the stacks' own route, not a failover move
  if (m && method === "POST" && m[1] !== "legacy-git") {
    const s = Of(c);
    if (!isBrowser(c) || !((!!s && s.admin) || (adminPass === "" && isLoopback(c)))) return forbidden();
    if (!h) return sendJSON(503, { error: "failover not started" });
    const id = m[1]!;
    if (m[2] === "standbys")
      return onJSON(c, maxJSONBody, true, (p) => {
        markHot();
        const [st, out] = h!.setStandbys(id, p.standbys, s?.user ?? "admin");
        return st === 200 ? [st, { ok: true, want: viewOf(out.want) }] : [st, out];
      });
    return onJSON(c, maxJSONBody, true, (p) => {
      markHot();
      return h!.move(id, p.to);
    });
  }
  return;
}
