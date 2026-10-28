// the api
import { errText, FrontendPort, marshal } from "@phosphorus/util";
import { type J, obj } from "./json.ts";

export const api = `http://127.0.0.1:${FrontendPort}`;
export const out = process.stdout;

export type Reply = { status: number; body: J };

// one call with a 2s cap, never proxied: status 0 with the error when it failed
export async function call(method: string, path: string, body?: unknown): Promise<Reply> {
  let res: Response;
  try {
    res = await fetch(api + path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? marshal(body) : undefined,
      signal: AbortSignal.timeout(2000),
      proxy: false,
    } as RequestInit);
  } catch (e) {
    return { status: 0, body: { error: errText(e) } };
  }
  let o: J = {};
  try {
    o = obj(JSON.parse(await res.text())) ?? {};
  } catch {}
  return { status: res.status, body: o };
}

export const post = (path: string, body?: unknown) => call("POST", path, body);

export function chainPost(action: string, password?: string) {
  const b: J = { action };
  if (password !== undefined) b.password = password;
  return post("/api/update/chain", b);
}
