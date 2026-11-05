// this host for the mesh: its state published to peers and built for the
// page, the update chain and guest keys
import * as catalog from "@phosphorus/catalog";
import { State as modelState, Summary } from "@phosphorus/model";
import * as peers from "@phosphorus/peers";
import { own as ownServices, unpublished, wildcard } from "@phosphorus/services";
import * as stacks from "@phosphorus/stacks";
import * as store from "@phosphorus/store";
import * as homesync from "@phosphorus/sync";
import * as update from "@phosphorus/update";
import { logf, markHot, marshal } from "@phosphorus/util";
import * as webapps from "@phosphorus/webapps";
import * as afterglow from "./afterglow.ts";
import { adminPass, baseDomain, getPlatform, selfHost, selfInfo, tsAPIKey, Version } from "./config.ts";
import { ownHA } from "./ha.ts";
import type { Res } from "./http.ts";
import { decode, obj, str } from "./js.ts";
import { filesInfo } from "./shares.ts";

// --- etc/hosts/<host>/ ------------------------------------------------------

const hostRel = (h: string, f: string) => "etc/hosts/" + h.toLowerCase() + "/" + f + ".json";

export function publishHost() {
  if (!selfHost) return;
  const put = (f: string, data: unknown) => {
    const cur = marshal(store.read(hostRel(selfHost, f)));
    const next = marshal(decode(marshal(data)));
    if (cur !== next) store.write(hostRel(selfHost, f), data);
  };
  put("services", ownServices());
  put("info", {
    version: Version(),
    platform: getPlatform(),
    files: filesInfo(),
    apps: webapps.installed(),
    found: unpublished(),
    wildcard: wildcard(),
    stacks: stacks.statuses(),
    docker: stacks.dockerInfo(),
    afterglow: afterglow.status(),
    ...catalog.facts(),
  });
}

// every phosphorus host as a place to install an app: its tailnet os and its info
export function stackHosts(): catalog.HostFacts[] {
  const os = new Map(peers.tailnet().map((d) => [d.name.toLowerCase(), d.os]));
  return Object.entries(hostsInfo()).map(([host, i]) => ({
    host,
    os: os.get(host),
    platform: i.platform,
    arch: i.arch,
    distro: i.distro,
    docker: i.docker,
    listening: i.listening,
  }));
}

export function hostsInfo(): Record<string, any> {
  const out: Record<string, any> = {};
  const seen = new Set<string>();
  for (const f of store.list("etc/hosts")) {
    const h = f.split("/", 1)[0]!;
    if (seen.has(h)) continue;
    seen.add(h);
    const v = store.read(hostRel(h, "info"));
    if (v !== undefined) out[h] = v;
  }
  return out;
}

export function hostServices(h: string): Record<string, any>[] | undefined {
  const arr = store.read(hostRel(h, "services"));
  if (!Array.isArray(arr)) return;
  return arr.map((x) => obj(x) ?? ({} as Record<string, any>));
}

// --- state ------------------------------------------------------------------

export function buildState(): Record<string, any> {
  let chain = update.chainStatus();
  const mine = chain !== null && chain !== undefined;
  if (!mine) chain = peers.chain();
  return {
    domain: baseDomain,
    self: selfInfo(),
    routes: peers.routes(),
    tailnet: peers.tailnet(),
    lock: update.meshLock(),
    model: Summary(),
    chain: chain ?? null,
    chainMine: mine,
    hosts: hostsInfo(),
    apps: webapps.wants(),
    home: homesync.digest(),
    stacks: stacks.views(),
  };
}

// a stack served: its active copy up and well somewhere
export function stackServing(id: string): boolean {
  return Object.values(hostsInfo()).some((i) => {
    const s = obj(obj(obj(i)?.stacks)?.[id]);
    return s?.role === "active" && s.running === true && s.healthy !== false;
  });
}

let lastStateFp = "";

function stateFp(s: Record<string, any>): string {
  const tn = (s.tailnet as Record<string, any>[]).map((d) => [d.name, d.os, d.phosphorus, d.phosphorusSeen, d.version]);
  const m = s.model as Record<string, any>;
  return marshal([s.self, s.routes, s.lock, s.chain, tn, m.agents, m.keys, s.hosts, s.apps, s.home, s.stacks]);
}

export function noteState(s: Record<string, any>): string {
  const fp = stateFp(s);
  const changed = fp !== lastStateFp;
  lastStateFp = fp;
  if (changed) markHot();
  return fp;
}

// this host's state as its peers' links carry it
export function ownState(): peers.Own {
  return {
    lock: update.ownLock(),
    chain: update.sharedChain(),
    model: modelState() ?? null,
    ha: ownHA(),
  };
}

// --- the update chain ------------------------------------------------------------

export function chainAction(action: string, password: string, admin: boolean, only: string[] = []): Res {
  switch (action) {
    case "start": {
      if (!admin && (adminPass === "" || password !== adminPass))
        return [401, { error: "admins only, or the admin password" }];
      // the hosts serving a stack with standbys updated last, each handing it over
      const ha = Object.values(stacks.views()).flatMap((v) => (v.standbys.length ? [v.active] : []));
      const started = update.start(ha, only);
      if ("locked" in started) return [409, { status: "locked", by: started.locked }];
      if ("error" in started) return [404, { error: started.error }];
      return [202, started];
    }
    case "cancel":
      return [update.cancel() ? 200 : 409, { status: "ok" }];
  }
  return [400, { error: "action must be start or cancel" }];
}

// --- guest keys --------------------------------------------------------------

const tsTailnet = "https://api.tailscale.com/api/v2/tailnet/-";

let guestTagOwned = false;

// a tailscale API error, as against one reaching it
class TSError extends Error {}

async function ownGuestTag() {
  if (guestTagOwned) return;
  const got = await fetch(tsTailnet + "/acl", {
    headers: { Authorization: "Bearer " + tsAPIKey, Accept: "application/hujson" },
    signal: AbortSignal.timeout(10000),
  });
  const body = await got.text();
  if (got.status < 200 || got.status >= 300) throw new TSError(`tailscale said ${got.status} reading the policy`);
  let lines = body.split("\n");
  const live = (re: RegExp) => lines.findIndex((l) => re.test(l) && !/^\s*\/\//.test(l));
  if (live(/"tag:guest"\s*:/) === -1) {
    const owners = live(/^\s*"tagOwners"\s*:\s*\{/);
    if (owners !== -1)
      lines = [...lines.slice(0, owners + 1), '\t\t"tag:guest": ["autogroup:admin"],', ...lines.slice(owners + 1)];
    else {
      const at = live(/^\s*\{/) + 1;
      lines = [...lines.slice(0, at), '\t"tagOwners": { "tag:guest": ["autogroup:admin"] },', ...lines.slice(at)];
    }
    const etag = got.headers.get("etag") || "*";
    const put = await fetch(tsTailnet + "/acl", {
      method: "POST",
      body: lines.join("\n"),
      signal: AbortSignal.timeout(10000),
      headers: { Authorization: "Bearer " + tsAPIKey, "Content-Type": "application/hujson", "If-Match": etag },
    });
    const b = await put.text();
    if (put.status < 200 || put.status >= 300) {
      const msg = str(obj(decode(b))?.message) || "no reason given";
      throw new TSError(`tailscale said ${put.status} adding tag:guest to the policy: ${msg}`);
    }
    logf("[frontend] added tag:guest to the tailnet policy tagOwners");
  }
  guestTagOwned = true;
}

export async function mintGuestKey(): Promise<Res> {
  if (!tsAPIKey) return [503, { error: "TS_API_KEY unset in .env" }];
  try {
    await ownGuestTag();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return [500, { error: e instanceof TSError ? msg : "couldn't reach tailscale: " + msg }];
  }
  const body = marshal({
    capabilities: {
      devices: { create: { reusable: false, ephemeral: true, preauthorized: true, tags: ["tag:guest"] } },
    },
    expirySeconds: 3 * 24 * 3600,
    description: "phosphorus guest",
  });
  let res: Response;
  try {
    res = await fetch(tsTailnet + "/keys", {
      method: "POST",
      body,
      headers: { Authorization: "Bearer " + tsAPIKey, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    return [500, { error: "couldn't reach tailscale: " + (e instanceof Error ? e.message : String(e)) }];
  }
  const out = obj(decode(await res.text())) ?? {};
  if (res.status < 200 || res.status >= 300)
    return [500, { error: `tailscale said ${res.status}: ${str(out.message) || "no reason given"}` }];
  return [200, { key: out.key, expires: out.expires }];
}

// --- startup -----------------------------------------------------------------
