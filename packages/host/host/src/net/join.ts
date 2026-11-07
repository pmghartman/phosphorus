// a new host on the mesh: its join key's token and a new WireGuard key sent to
// the control server at the mesh's domain, an address and the hub given back
import * as envfile from "@phosphorus/envfile";
import { b64, keyPair } from "@phosphorus/wg";
import { fail } from "../base.ts";
import { saveMeshKey, writeJoined } from "./key.ts";
import type { Joined } from "./plan.ts";

export async function joinMesh(mk: envfile.MeshKey, name: string, osName: string): Promise<Joined> {
  const k = keyPair();
  let res: Response;
  try {
    res = await fetch(mk.url + "/mesh/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: mk.token, name, key: b64(k.pub), os: osName }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw fail(`couldn't reach ${mk.url}: ${e instanceof Error ? e.message : e}`);
  }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw fail(`${mk.url} refused the join: ${body?.error || `status ${res.status}`}`);
  const j: Joined = {
    name: String(body?.name || name),
    ip: String(body?.ip ?? ""),
    hub: {
      name: String(body?.hub?.name ?? ""),
      ip: String(body?.hub?.ip ?? ""),
      key: String(body?.hub?.key ?? ""),
      endpoint: String(body?.hub?.endpoint ?? ""),
    },
    domain: String(body?.domain ?? ""),
    token: mk.token.split(".")[0],
  };
  if (!j.ip || !j.hub.key) throw fail(`${mk.url} answered the join without an address or hub`);
  saveMeshKey(k);
  writeJoined(j);
  return j;
}
