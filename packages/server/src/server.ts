// this host for the mesh: its games run, its state published to peers and
// built for the page, the update chain and guest keys
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { markHot } from "@phosphorus/clock";
import { jsNumber } from "@phosphorus/files";
import { Zone } from "@phosphorus/gamedns";
import * as git from "@phosphorus/git";
import * as mesh from "@phosphorus/mesh";
import { State as modelState, Summary } from "@phosphorus/model";
import { own as ownServices, setPending } from "@phosphorus/services";
import * as sysfs from "@phosphorus/sysfs";
import * as update from "@phosphorus/update";
import { lockACL, logf, marshal, peerCall, run, tailnetIP } from "@phosphorus/util";
import * as webapps from "@phosphorus/webapps";
import { ownChat, presence } from "./chat.ts";
import { adminPass, baseDomain, gameKey, gameKeyDir, getPlatform, hostSSHHost, hostSSHPort, selfHost, selfInfo, tsAPIKey, Version } from "./config.ts";
import { deskStamps } from "./desk.ts";
import type { Res } from "./http.ts";
import { decode, type Msg, num, obj, str } from "./js.ts";
import { filesInfo } from "./shares.ts";

// --- game servers ------------------------------------------------------------

export const gameUserRe = /^[A-Za-z0-9._\\-]+$/;

export async function runGameLocally(name: string, action: string): Promise<Res> {
  let game: Record<string, any> | undefined;
  for (const r of ownServices()) if (r.type === "game" && r.name === name) game = r;
  if (!game) return [404, { error: `${selfHost} hosts no game called ${name}` }];
  if (game.controllable !== true) return [409, { error: name + " has no start/stop commands in services.export" }];
  let user = "";
  try {
    user = readFileSync(join(gameKeyDir, "user"), "utf8").trim();
    if (!gameUserRe.test(user) || user.startsWith("-")) throw new Error("bad user");
    mkdirSync(dirname(gameKey), { recursive: true, mode: 0o700 });
    const key = readFileSync(join(gameKeyDir, "id_ed25519"));
    writeFileSync(gameKey, key, { mode: 0o600 });
    chmodSync(gameKey, 0o600);
    lockACL(gameKey, false);
  } catch {
    return [503, { error: `play/stop isn't set up on ${selfHost}; run phos game-control-setup there` }];
  }
  setPending(name, action);
  const r = await run(
    ["ssh", "-i", gameKey, "-p", hostSSHPort, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", `${user}@${hostSSHHost}`, `${action} ${name}`],
    { timeoutMs: 60000 },
  );
  if (!r.ok) {
    setPending(name, "");
    let why = r.stderr.trim() || r.error || `exit status ${r.code}`;
    if (why.length > 300) why = why.slice(-300);
    if (!why) why = action + " failed";
    // the key's forced command still naming a file an old release had
    if (why.includes("No such file") || why.includes("not found")) why += `; the play/stop key on ${selfHost} points at a missing program, run phos game-control-setup there or update it`;
    logf("[frontend] game %s: %s failed: %s", name, action, why);
    return [502, { error: why }];
  }
  logf("[frontend] game %s: %s ran", name, action);
  return [200, { ok: true }];
}

export async function forwardGame(host: string, name: string, action: string): Promise<Res> {
  const ip = await tailnetIP(host);
  if (!ip) return [502, { error: `can't find ${host} on the tailnet` }];
  return peerCall(host, { host: ip, method: "POST", path: `/api/games/${host}/${name}/${action}?hop=1`, timeoutMs: 65000 });
}

// --- etc/hosts/<host>/ ------------------------------------------------------

const hostRel = (h: string, f: string) => "etc/hosts/" + h.toLowerCase() + "/" + f + ".json";

export function publishHost() {
  if (!selfHost) return;
  const put = (f: string, data: unknown) => {
    const cur = marshal(sysfs.read(hostRel(selfHost, f)));
    const next = marshal(decode(marshal(data)));
    if (cur !== next) sysfs.write(hostRel(selfHost, f), data);
  };
  put("services", ownServices());
  put("info", { version: Version(), platform: getPlatform(), files: filesInfo(), desk: deskStamps(), apps: webapps.installed() });
}

export function hostsInfo(): Record<string, any> {
  const out: Record<string, any> = {};
  const seen = new Set<string>();
  for (const f of sysfs.list("etc/hosts")) {
    const h = f.split("/", 1)[0]!;
    if (seen.has(h)) continue;
    seen.add(h);
    const v = sysfs.read(hostRel(h, "info"));
    if (v !== undefined) out[h] = v;
  }
  return out;
}

export function hostServices(h: string): Record<string, any>[] | undefined {
  const arr = sysfs.read(hostRel(h, "services"));
  if (!Array.isArray(arr)) return;
  return arr.map((x) => obj(x) ?? ({} as Record<string, any>));
}

// --- state ------------------------------------------------------------------

export const gitRowsAny = (): any[] => git.rows().map((r) => ({ ...r }));

export function buildState(): Record<string, any> {
  let chain = update.chainStatus();
  const mine = chain !== null && chain !== undefined;
  if (!mine) chain = mesh.chain();
  return {
    domain: baseDomain, gameZone: Zone, self: selfInfo(), routes: mesh.routes(), tailnet: mesh.tailnet(),
    lock: update.meshLock(), gitHosts: gitRowsAny(), model: Summary(), chain: chain ?? null, chainMine: mine, hosts: hostsInfo(),
    apps: webapps.wants(),
  };
}

let lastStateFp = "";

function stateFp(s: Record<string, any>): string {
  const tn = (s.tailnet as Record<string, any>[]).map((d) => [d.name, d.os, d.phosphorus, d.phosphorusSeen, d.version]);
  const m = s.model as Record<string, any>;
  return marshal([s.self, s.routes, s.lock, s.chain, tn, git.rowsFp(git.rows()), m.agents, m.keys, s.hosts, s.apps]);
}

export function noteState(s: Record<string, any>): string {
  const fp = stateFp(s);
  const changed = fp !== lastStateFp;
  lastStateFp = fp;
  if (changed) markHot();
  return fp;
}

export function snapshot(q: URLSearchParams): Record<string, any> {
  const chat: Msg[] = [];
  if (q.has("since")) {
    let s = jsNumber(q.get("since"));
    if (Number.isNaN(s)) s = 0;
    for (const m of ownChat) if (num(m.seq) > s) chat.push(m);
  }
  return {
    self: selfInfo(), presence: presence(), lock: update.ownLock(), chain: update.sharedChain(),
    git: git.state(), model: modelState() ?? null, sysDigest: sysfs.digest(), chat,
  };
}

// --- the update chain ------------------------------------------------------------

export function chainAction(action: string, password: string, admin: boolean, only: string[] = []): Res {
  switch (action) {
    case "start": {
      if (!admin && (adminPass === "" || password !== adminPass)) return [401, { error: "admins only, or the admin password" }];
      const hosts = git.rows().map((h) => str(h.host));
      const started = update.start(hosts, only);
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
  const got = await fetch(tsTailnet + "/acl", { headers: { Authorization: "Bearer " + tsAPIKey, Accept: "application/hujson" }, signal: AbortSignal.timeout(10000) });
  const body = await got.text();
  if (got.status < 200 || got.status >= 300) throw new TSError(`tailscale said ${got.status} reading the policy`);
  let lines = body.split("\n");
  const live = (re: RegExp) => lines.findIndex((l) => re.test(l) && !/^\s*\/\//.test(l));
  if (live(/"tag:guest"\s*:/) === -1) {
    const owners = live(/^\s*"tagOwners"\s*:\s*\{/);
    if (owners !== -1) lines = [...lines.slice(0, owners + 1), '\t\t"tag:guest": ["autogroup:admin"],', ...lines.slice(owners + 1)];
    else {
      const at = live(/^\s*\{/) + 1;
      lines = [...lines.slice(0, at), '\t"tagOwners": { "tag:guest": ["autogroup:admin"] },', ...lines.slice(at)];
    }
    const etag = got.headers.get("etag") || "*";
    const put = await fetch(tsTailnet + "/acl", {
      method: "POST", body: lines.join("\n"), signal: AbortSignal.timeout(10000),
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
    capabilities: { devices: { create: { reusable: false, ephemeral: true, preauthorized: true, tags: ["tag:guest"] } } },
    expirySeconds: 3 * 24 * 3600, description: "phosphorus guest",
  });
  let res: Response;
  try {
    res = await fetch(tsTailnet + "/keys", { method: "POST", body, headers: { Authorization: "Bearer " + tsAPIKey, "Content-Type": "application/json" }, signal: AbortSignal.timeout(10000) });
  } catch (e) {
    return [500, { error: "couldn't reach tailscale: " + (e instanceof Error ? e.message : String(e)) }];
  }
  const out = obj(decode(await res.text())) ?? {};
  if (res.status < 200 || res.status >= 300) return [500, { error: `tailscale said ${res.status}: ${str(out.message) || "no reason given"}` }];
  return [200, { key: out.key, expires: out.expires }];
}

// --- startup -----------------------------------------------------------------

