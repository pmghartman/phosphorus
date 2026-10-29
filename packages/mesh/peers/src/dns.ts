// the mesh's names: game servers answered by this host's DNS, the tailnet's
// split DNS pointed at the live hosts, and guests swept after their three days
import { Server as DNSServer, Zone } from "@phosphorus/gamedns";
import type { Row } from "@phosphorus/proxy";
import { env, errText, isIPv4, localeCompare, marshal, Notes, now, obj } from "@phosphorus/util";

const notes = new Notes("mesh");
const tsAPIKey = env("TS_API_KEY");
const tsAPI = "https://api.tailscale.com/api/v2";
const splitDNSMS = 30000;
const guestTTLMS = 3 * 24 * 3600 * 1000;
const guestSweepMS = 10 * 60 * 1000;

// as a JS template literal renders a JSON value
export const jsString = (v: unknown): string =>
  v == null
    ? "null"
    : Array.isArray(v)
      ? v.map((e) => (e == null ? "" : jsString(e))).join(",")
      : typeof v === "object"
        ? "[object Object]"
        : String(v);
// Go's truthy: false, nil, 0, NaN and "" are false
export const truthy = (v: unknown) => (typeof v === "number" ? v !== 0 && !Number.isNaN(v) : !!v);
const str = (v: unknown) => (truthy(v) ? jsString(v) : "");

let gameIPs = new Map<string, string>();
let gameDNS: DNSServer | undefined;

// the DNS server up, answering what mapGames last found
export function startGameDNS() {
  gameDNS = new DNSServer(
    (name) => gameIPs.get(name) ?? "",
    (k, m) => notes.note(k, m),
  );
}

export const bindGameDNS = (ip: string) => gameDNS?.bind(ip);

// game name -> its host's IPv4, the online copy first when a name is declared twice
export function mapGames(rows: Row[], hostIPs: Map<string, string>) {
  const rank = (r: Row) => (r.status === "online" ? "0:" : "1:") + (typeof r.host === "string" ? r.host : "");
  const games = rows.filter((r) => r.type === "game").sort((a, b) => localeCompare(rank(a), rank(b)));
  const out = new Map<string, string>();
  for (const r of games) {
    const name = jsString(r.name);
    if (out.has(name)) {
      const first = games.find((g) => jsString(g.name) === name)?.host;
      notes.note(
        `dup:${name}`,
        `game ${name} is declared on more than one host, ${name}.${Zone} goes to ${typeof first === "string" ? first : ""}`,
      );
      continue;
    }
    const ip = hostIPs.get(typeof r.host === "string" ? r.host : "") ?? "";
    if (isIPv4(ip)) out.set(name, ip);
  }
  gameIPs = out;
}

async function tsAPICall(method: string, path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = { Authorization: `Bearer ${tsAPIKey}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(tsAPI + path, {
    method,
    headers,
    body: body !== undefined ? marshal(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  if (res.status === 401) throw new Error("TS_API_KEY was rejected, expired? renew it in .env");
  if (res.status < 200 || res.status >= 300)
    throw new Error(`${method} ${path} got status ${res.status}: ${text.trim()}`);
  return text ? JSON.parse(text) : null;
}

let lastSplitSync = 0;
let lastGuestSweep = 0;

// the .<zone> split DNS pointed at the live hosts' addresses
export function syncSplitDNS(ns: string[]) {
  if (!tsAPIKey) {
    notes.note(
      "split-dns",
      `TS_API_KEY unset, keep the .${Zone} split DNS nameservers in the Tailscale admin console by hand`,
    );
    return;
  }
  if (!ns.length || now() - lastSplitSync < splitDNSMS) return;
  lastSplitSync = now();
  void (async () => {
    try {
      const cur = obj(await tsAPICall("GET", "/tailnet/-/dns/split-dns"))?.[Zone];
      const have = (Array.isArray(cur) ? cur.map(jsString) : []).sort();
      if (have.join(",") !== ns.join(",")) {
        await tsAPICall("PATCH", "/tailnet/-/dns/split-dns", { [Zone]: ns });
        notes.log(`split DNS for .${Zone} now points at ${ns.join(", ")}`);
      }
      notes.clear("split-dns");
    } catch (e) {
      notes.note("split-dns", `couldn't sync the .${Zone} split DNS, still retrying: ${errText(e)}`);
    }
  })();
}

// tag:guest devices older than their three days removed from the tailnet
export function sweepGuests() {
  if (!tsAPIKey || now() - lastGuestSweep < guestSweepMS) return;
  lastGuestSweep = now();
  void (async () => {
    try {
      const devs = obj(await tsAPICall("GET", "/tailnet/-/devices"))?.devices;
      for (const d of Array.isArray(devs) ? devs : []) {
        const dm = obj(d) ?? {};
        if (!(Array.isArray(dm.tags) ? dm.tags : []).includes("tag:guest")) continue;
        // an unreadable created date counts as long past, as Go's zero time did
        if (now() - Date.parse(jsString(dm.created)) < guestTTLMS) continue;
        await tsAPICall("DELETE", `/device/${str(dm.nodeId) || str(dm.id)}`);
        notes.log(`removed guest ${jsString(dm.hostname)}, past 3 days`);
      }
      notes.clear("guests");
    } catch (e) {
      notes.note("guests", `couldn't sweep guest devices, still retrying: ${errText(e)}`);
    }
  })();
}
