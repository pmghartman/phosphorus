// guests swept after their three days: tag:guest devices removed from the tailnet
// with the Tailscale API token, by the first live host
import { env, errText, marshal, Notes, now, obj } from "@phosphorus/util";

const notes = new Notes("mesh");
const tsAPIKey = env("TS_API_KEY");
const tsAPI = "https://api.tailscale.com/api/v2";
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

let lastGuestSweep = 0;

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
