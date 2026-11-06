// the home's .env: its keys read and written in place, the file locked to the
// system and the account running phosphorus
import { chmodSync, chownSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { runSync } from "@phosphorus/util";

// one .env entry, as the setup forms ask for it; mesh: copied from a peer when
// left blank on a host joining a mesh
export type Key = { name: string; label: string; hint: string; mesh: boolean };

// every key phosphorus reads; a new host brings MESH_KEY, or TS_AUTHKEY on a
// mesh still on Tailscale's hosted control
export const Keys: Key[] = [
  {
    name: "MESH_KEY",
    label: "Mesh join key",
    hint: "from settings, network on a mesh host; the only key a new host needs",
    mesh: false,
  },
  {
    name: "TS_AUTHKEY",
    label: "Tailscale auth key",
    hint: "only for a mesh still on Tailscale's hosted control; reusable, expires every 90 days",
    mesh: false,
  },
  { name: "BASE_DOMAIN", label: "Domain", hint: "optional, for access off the tailnet", mesh: true },
  {
    name: "TUNNEL_TOKEN",
    label: "Cloudflare tunnel token",
    hint: "optional, with the domain; its routes <domain> and *.<domain> to http://localhost:80",
    mesh: true,
  },
  {
    name: "TS_API_KEY",
    label: "Tailscale API token",
    hint: "guest join keys and their sweep, expires every 90 days",
    mesh: true,
  },
  { name: "ADMIN_PASS", label: "Admin password", hint: "setup admin's login, the gate on a mesh update", mesh: true },
];

// every KEY=value, blank values kept
export function read(file: string): Record<string, string> {
  try {
    return parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

// KEY=value lines, comments and blanks skipped, the last one winning
export function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (let l of text.replaceAll("\r\n", "\n").split("\n")) {
    l = l.trim();
    if (!l || l[0] === "#") continue;
    const i = l.indexOf("=");
    if (i >= 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return out;
}

// the keys a host can't start without: a join key, the rest a peer's
export function missing(file: string): string[] {
  return hasJoinKey(read(file)) ? [] : ["MESH_KEY"];
}

// MESH_KEY or TS_AUTHKEY set
export const hasJoinKey = (v: Record<string, string | undefined>) => !!(v.MESH_KEY || v.TS_AUTHKEY);

// a mesh join key's parts: the control server's URL and a headscale preauth key
export type MeshKey = { url: string; key: string };

const meshKeyPrefix = "phos1.";

// phos1.<base64url JSON {u, k}>
export function formatMeshKey(m: MeshKey): string {
  return meshKeyPrefix + Buffer.from(JSON.stringify({ u: m.url, k: m.key })).toString("base64url");
}

// a mesh join key's parts, undefined when it isn't one
export function parseMeshKey(s: string | undefined): MeshKey | undefined {
  const t = clean(s);
  if (!t.startsWith(meshKeyPrefix)) return undefined;
  try {
    const j = JSON.parse(Buffer.from(t.slice(meshKeyPrefix.length), "base64url").toString("utf8"));
    const url = typeof j?.u === "string" ? j.u.replace(/\/+$/, "") : "";
    const key = typeof j?.k === "string" ? j.k : "";
    if (!/^https:\/\/[^/\s]+$/.test(url) || !key) return undefined;
    return { url, key };
  } catch {
    return undefined;
  }
}

// a pasted key: whitespace, quotes and newlines gone
const clean = (v = "") => v.replace(/\s+/g, "").replace(/^["']+|["']+$/g, "");

// the given keys set, blanks skipped, every other line kept; written in place
// so its owner, mode and ACL stay
export function set(file: string, vals: Record<string, string>) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
  const lines = text ? text.replaceAll("\r\n", "\n").replace(/\n+$/, "").split("\n") : [];
  const done = new Set<string>();
  lines.forEach((l, i) => {
    const t = l.trim();
    const eq = t.indexOf("=");
    const k = eq >= 0 ? t.slice(0, eq).trim() : "";
    if (eq < 0 || k.startsWith("#")) return;
    const v = clean(vals[k]);
    if (!v) return;
    if (done.has(k)) {
      lines[i] = "";
      return;
    }
    lines[i] = k + "=" + v;
    done.add(k);
  });
  for (const k of Keys) {
    const v = clean(vals[k.name]);
    if (v && !done.has(k.name)) {
      lines.push(k.name + "=" + v);
      done.add(k.name);
    }
  }
  for (const [k, raw] of Object.entries(vals)) {
    const v = clean(raw);
    if (v && !done.has(k)) lines.push(k + "=" + v);
  }
  writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
}

// SYSTEM (the service) and the user running the app on Windows, nothing
// inherited; else 0600, root's when root writes it
export function lock(file: string) {
  if (process.platform === "win32") {
    const r = runSync([
      "icacls",
      file,
      "/inheritance:r",
      "/grant:r",
      `${process.env.USERNAME}:(M)`,
      "/grant:r",
      "SYSTEM:(F)",
    ]);
    if (!r.ok) throw new Error(r.output.trim() || "icacls failed");
    return;
  }
  if (process.geteuid?.() === 0) chownSync(file, 0, 0);
  chmodSync(file, 0o600);
}

// the file there, locked
export function ensure(file: string) {
  if (!existsSync(file)) writeFileSync(file, "", { mode: 0o600 });
  lock(file);
}
