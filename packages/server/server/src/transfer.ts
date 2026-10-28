// a file copied from any host's share to any other's, through this host
import { statSync } from "node:fs";
import * as files from "@phosphorus/files";
import type { Caller } from "@phosphorus/mcp";
import { uuid } from "@phosphorus/update";
import { Exists, SealGrant } from "@phosphorus/users";
import { errText, FrontendPort, tailnetIP } from "@phosphorus/util";
import { selfHost, whoHeader } from "./config.ts";
import type { Res } from "./http.ts";
import { decode, obj, str } from "./js.ts";
import { filesCall } from "./shares.ts";

// a copy's whole run, a large file over a slow peer included
const transferWait = 30 * 60 * 1000;

// localShare a share here, home only for a keyed caller and within their rights
function localShare(c: Caller | undefined, share: string, ...rels: string[]): [files.Share | undefined, number, any] {
  if (!files.enabled()) return [undefined, 503, { error: selfHost + " publishes no files directory" }];
  const sh = files.shareOf(share);
  if (!sh) return [undefined, 404, { error: selfHost + " has no such share" }];
  if (sh.id === "home") {
    if (!c) return [undefined, 403, { error: "the homes are for their users only" }];
    const who = { user: c.user, admin: !!c.admin };
    for (const r of rels) {
      const why = files.homeGate(who, r, Exists);
      if (why) return [undefined, files.gateCode(who, why), { error: why }];
    }
  }
  return [sh, 0, undefined];
}

// peerFiles a raw files request to a peer, the caller's rights sealed along
async function peerFiles(
  signal: AbortSignal,
  c: Caller | undefined,
  host: string,
  op: string,
  method: string,
  q: URLSearchParams,
  body: ReadableStream<Uint8Array> | undefined,
  size: number,
): Promise<Response> {
  const ip = await tailnetIP(host);
  if (!ip) throw new Error(`can't find ${host} on the tailnet`);
  q.set("hop", "1");
  const headers: Record<string, string> = {};
  if (body) headers["Content-Length"] = String(size);
  if (c) headers[whoHeader] = SealGrant({ u: c.user, a: !!c.admin }, transferWait);
  return fetch(`http://${ip}:${FrontendPort}/api/files/${host}/${op}?${q}`, {
    method,
    headers,
    body,
    signal,
    duplex: "half",
  } as RequestInit);
}

async function errOf(res: Response): Promise<string> {
  let text = "";
  try {
    text = (await res.text()).slice(0, 4096);
  } catch {}
  return str(obj(decode(text))?.error) || `status ${res.status}`;
}

// Loc a file on a host's share
export type Loc = { host: string; share: string; path: string };

// copyAcross one file from a share to a share, any hosts, moved when move
export async function copyAcross(c: Caller | undefined, from: Loc, to: Loc, move: boolean): Promise<Res> {
  if (from.host === to.host && from.share === to.share && from.path === to.path)
    return [400, { error: "the same file" }];
  const signal = AbortSignal.timeout(transferWait);
  let src: ReadableStream<Uint8Array>;
  let size: number;
  if (from.host === selfHost) {
    const [sh, st, b] = localShare(c, from.share, from.path);
    if (!sh) return [st, b];
    const abs = files.downloadPath(sh, from.path);
    if (!abs) return [404, { error: "no such file (folders aren't copied)" }];
    try {
      size = statSync(abs).size;
      src = Bun.file(abs).stream();
    } catch (e) {
      return [500, { error: errText(e) }];
    }
  } else {
    let res: Response;
    try {
      res = await peerFiles(
        signal,
        c,
        from.host,
        "download",
        "GET",
        new URLSearchParams({ share: from.share, path: from.path }),
        undefined,
        0,
      );
    } catch (e) {
      return [502, { error: errText(e) }];
    }
    if (res.status !== 200) return [res.status, { error: await errOf(res) }];
    const cl = res.headers.get("content-length");
    size = cl !== null && /^\d+$/.test(cl) ? Number(cl) : -1;
    if (size < 0) {
      await res.body?.cancel().catch(() => {});
      return [502, { error: from.host + " sent no size" }];
    }
    src = res.body ?? new ReadableStream();
  }
  const id = uuid().replaceAll("-", "");
  let st: number, out: any;
  if (to.host === selfHost) {
    const [sh, s, b] = localShare(c, to.share, to.path);
    if (!sh) {
      await src.cancel().catch(() => {});
      return [s, b];
    }
    [st, out] = await files.write(sh, to.path, src, { id, offset: 0, total: size });
  } else {
    const q = new URLSearchParams({ share: to.share, path: to.path, id, offset: "0", total: String(size) });
    let res: Response;
    try {
      res = await peerFiles(signal, c, to.host, "upload", "POST", q, src, size);
    } catch (e) {
      return [502, { error: errText(e) }];
    }
    if (res.status !== 200) return [res.status, { error: await errOf(res) }];
    await res.body?.cancel().catch(() => {});
    [st, out] = [200, { ok: true, path: to.path }];
  }
  if (st !== 200 || !move) return [st, out];
  const [dst, b] = await filesCall(c, from.host, "delete", from.share, { path: from.path });
  if (dst >= 300) return [200, { ok: true, path: to.path, note: "copied, the original left: " + str(obj(b)?.error) }];
  return [200, { ok: true, path: to.path, moved: true }];
}
