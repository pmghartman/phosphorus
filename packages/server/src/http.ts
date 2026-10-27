// what every route shares: JSON in and out, who's asking, from where
import { MaxText } from "@phosphorus/files";
import { trusted } from "@phosphorus/mesh";
import { isLoopbackAddr, isTailnetAddr, unrebindable } from "@phosphorus/proxy";
import { Of } from "@phosphorus/users";
import { marshal } from "@phosphorus/util";
import { type Ctx, type Handler, isUpgrade } from "@phosphorus/wsock";
import { obj } from "./js.ts";

export const maxJSONBody = 64 * 1024;
export const maxSaveBody = 2 * 1024 * 1024;
// a whole text file saved, its JSON escapes and all
export const maxTextBody = 3 * MaxText;

// [status, body]: what every call answers
export type Res = [number, any];

export const sendJSON = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(marshal(body), { status, headers: { "Content-Type": "application/json", ...headers } });

export const plain = (status: number, text: string) => new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

export const forbidden = () => plain(403, "forbidden");

export const refuse = (status: number) => new Response(null, { status });

export const isLoopback = (c: Ctx) => !c.ingress && isLoopbackAddr(c.ip);

export const isTailnet = async (c: Ctx) => !c.ingress && isTailnetAddr(c.ip) && (await trusted(c.ip));

export const reqHost = (c: Ctx) => c.req.headers.get("host") ?? "";

export function sameOrigin(c: Ctx): boolean {
  const o = c.req.headers.get("origin");
  if (!o) return true;
  try {
    return new URL(o).host === reqHost(c);
  } catch {
    return false;
  }
}

// pageUser a logged-in user's own page asking, never another site's: the
// login a pass where a key would be for any other caller
export function pageUser(c: Ctx): boolean {
  const s = Of(c);
  return !!s && !s.boot && sameOrigin(c);
}

// meshOnly the frontend port: loopback and tailnet sockets alone, by a Host
// no page can rebind; the socket's own address isn't readable here, so the
// remote's alone is checked
export const meshOnly =
  (next: Handler): Handler =>
  (c) => {
    if (!(isLoopbackAddr(c.ip) || isTailnetAddr(c.ip)) || !unrebindable(reqHost(c))) return forbidden();
    return next(c);
  };

// crossSite a write or socket from another site's page
export function crossSite(c: Ctx): boolean {
  const m = c.req.method;
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return isUpgrade(c.req) && !sameOrigin(c);
  return !sameOrigin(c);
}

export const isBrowser = (c: Ctx) => c.ingress || isLoopback(c);
export const isLocalOrPeer = async (c: Ctx) => isBrowser(c) || (await isTailnet(c));

// readRaw the body up to max bytes, undefined past it
export async function readRaw(c: Ctx, max: number): Promise<Uint8Array | undefined> {
  const body = c.req.body;
  if (!body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for await (const ch of body as unknown as AsyncIterable<Uint8Array>) {
      n += ch.length;
      if (n > max) return;
      chunks.push(ch);
    }
  } catch {
    return;
  }
  return Buffer.concat(chunks);
}

// onJSON a JSON body in, status and body out, bad JSON {} or a strict 400
export async function onJSON(c: Ctx, max: number, strict: boolean, handle: (p: Record<string, any>) => Res | Promise<Res>): Promise<Response> {
  const b = await readRaw(c, max);
  if (b === undefined) return plain(400, "bad request");
  let v: unknown;
  try {
    v = JSON.parse(b.length ? Buffer.from(b).toString("utf8") : "{}");
  } catch {
    if (strict) return sendJSON(400, { error: "invalid json" });
    v = {};
  }
  // JS's `|| {}` keeps arrays and other truthy values; handlers read keys off them as undefined
  const [status, body] = await handle(obj(v) ?? {});
  return sendJSON(status, body);
}
