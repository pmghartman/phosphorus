// *.<domain> reaching the mesh: a made-up name's /healthz asked through
// Cloudflare, "ok" from whichever host's ingress the tunnel picked; the last
// sure answer kept across restarts, a blip saying nothing
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { env, errText, markHot, Notes, now, RunDir, writeFileAtomic } from "@phosphorus/util";

const domain = env("BASE_DOMAIN").toLowerCase();
const file = join(RunDir, "wildcard");
const notes = new Notes("wildcard");
// again soon while it isn't up, so a route just added shows within the minute
const unsureMS = 30_000;
const sureMS = 600_000;

export type Wildcard = { state: "off" | "up" | "missing" | "unknown"; why?: string };

// the tunnel's id from TUNNEL_TOKEN, base64 JSON with it as t
export function tunnelID(token = process.env.TUNNEL_TOKEN ?? ""): string {
  try {
    const t = JSON.parse(Buffer.from(token, "base64").toString("utf8"))?.t;
    return typeof t === "string" && /^[0-9a-f-]{36}$/i.test(t) ? t : "";
  } catch {
    return "";
  }
}

// the last sure answer, up or missing, and why on the line after
function load(): [boolean | undefined, string] {
  try {
    const [t, because = ""] = readFileSync(file, "utf8").split("\n");
    return [t === "up" ? true : t === "missing" ? false : undefined, because.trim()];
  } catch {
    return [undefined, ""];
  }
}

let [known, why] = load();
// a check that said nothing either way: offline, a slow resolver
let blip = "";
let at = 0;
let busy = false;

function settle(up: boolean, because: string) {
  blip = "";
  if (known === up && why === because) return;
  const changed = known !== up;
  known = up;
  why = because;
  try {
    writeFileAtomic(file, `${up ? "up" : "missing"}\n${because}\n`);
  } catch {}
  if (!changed) return;
  notes.log(up ? `*.${domain} reaches the mesh: services without a mode get subdomains` : because);
  markHot();
}

// the two Cloudflare entries that make it, the tunnel named when its token says
function fix(): string {
  const id = tunnelID();
  const target = id ? `${id}.cfargotunnel.com` : "<tunnel id>.cfargotunnel.com";
  return `add a published application route *.${domain} -> http://localhost:80 on the tunnel, and a proxied CNAME named * to ${target} if the route didn't add one`;
}

async function check() {
  const name = `phosphorus-check-${Math.random().toString(36).slice(2, 10)}.${domain}`;
  try {
    await lookup(name);
  } catch (e) {
    // no such name: no * record; offline or a slow resolver says nothing
    if ((e as { code?: string })?.code === "ENOTFOUND") settle(false, `no DNS record covers *.${domain}: ${fix()}`);
    else blip = `couldn't look up a name under ${domain}: ${errText(e)}`;
    return;
  }
  try {
    const res = await fetch(`https://${name}/healthz`, {
      redirect: "manual",
      proxy: false,
      signal: AbortSignal.timeout(8000),
    } as RequestInit);
    const body = (await res.text()).trim();
    if (res.status === 200 && body === "ok") settle(true, "");
    else settle(false, `*.${domain} reaches Cloudflare but not phosphorus (HTTP ${res.status}): ${fix()}`);
  } catch (e) {
    blip = `couldn't reach a name under ${domain} over https: ${errText(e)}`;
  }
}

// asked again when due, a refresh's tick; only with a domain and a tunnel here
export function pollWildcard() {
  if (!domain || !process.env.TUNNEL_TOKEN || busy) return;
  if (now() - at < (known ? sureMS : unsureMS)) return;
  busy = true;
  at = now();
  check().finally(() => {
    busy = false;
  });
}

export const wildcardUp = () => known === true;

// for health: up, missing with the fix, or not known yet
export function wildcard(): Wildcard {
  if (!domain) return { state: "off", why: "no BASE_DOMAIN, tailnet only" };
  if (!process.env.TUNNEL_TOKEN) return { state: "off", why: "no TUNNEL_TOKEN on this host" };
  if (known === true) return { state: "up" };
  if (known === false) return { state: "missing", why };
  return { state: "unknown", why: blip || "not checked yet" };
}
