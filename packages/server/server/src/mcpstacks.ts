// the connector's way to the installed services and the optional apps: what the
// wizard and the apps page read and press, for a key's call
import * as catalog from "@phosphorus/catalog";
import type { Caller } from "@phosphorus/mcp";
import * as stacks from "@phosphorus/stacks";
import { markHot, obj } from "@phosphorus/util";
import * as webapps from "@phosphorus/webapps";
import { haMove, haStandbys } from "./ha.ts";
import { hostsInfo } from "./server.ts";

type Res = [number, any] | Promise<[number, any]>;
const s = (v: unknown) => (typeof v === "string" ? v : "");

// every installed service as the mesh wants it, each host's copy beside it
function list(): [number, any] {
  const copies: Record<string, Record<string, unknown>> = {};
  const docker: Record<string, unknown> = {};
  for (const [host, i] of Object.entries(hostsInfo())) {
    const o = obj(i);
    if (o?.docker) docker[host] = o.docker;
    for (const [id, st] of Object.entries(obj(o?.stacks) ?? {})) (copies[id] ??= {})[host] = st;
  }
  const out = Object.entries(stacks.views()).map(([id, v]) => ({ ...v, copies: copies[id] ?? {} }));
  return [200, { stacks: out, docker }];
}

export function stacksOp(c: Caller | undefined, op: string, p: Record<string, any>): Res {
  const by = c?.user ?? "phosphorus";
  const id = s(p.id);
  switch (op) {
    case "list":
      return list();
    case "catalog": {
      const q = new URLSearchParams();
      for (const k of ["q", "source", "category"]) if (s(p[k])) q.set(k, s(p[k]));
      return catalog.catalogRoute(q);
    }
    case "app":
      return s(p.source) === "github" ? catalog.repoRoute({ url: s(p.ref) }) : catalog.appRoute(s(p.source), s(p.ref));
    case "check":
      return catalog.checkRoute(p);
    case "install":
      return stacks.Install(p, by);
    case "update":
      return stacks.Update(id, by);
    case "remove":
      return stacks.Remove(id, p.keepData !== false, by);
    case "standbys":
      return haStandbys(id, p.standbys, by, p.active);
    case "move":
      return haMove(id, p.to);
  }
  return [400, { error: `no stacks op ${op}` }];
}

export async function appsOp(op: string, id: string): Promise<[number, any]> {
  if (op === "list") return [200, await webapps.summary(false)];
  if (op !== "install" && op !== "remove") return [400, { error: "action is install or remove" }];
  markHot();
  return op === "install" ? webapps.Install(id) : webapps.Remove(id);
}
