// crypto
import { createHash, randomBytes } from "node:crypto";
import * as store from "@phosphorus/store";
import { env, marshal, obj, sleep } from "@phosphorus/util";
import type { Ctx } from "@phosphorus/wsock";

export const secretRel = "etc/secret.json";
export const admin = "admin";
export const Cookie = "phosphorus-user";
export const sessionMS = 30 * 24 * 3600 * 1000;
export const bootSessionMS = 3600 * 1000;
export const maxVault = 64 * 1024;
export const maxPass = 256;
export const triesMS = 15 * 60 * 1000;
export const maxPrefs = 32 * 1024;
export const MaxWall = 3 * 1024 * 1024;
export const pullWait = 3000;

export const passwd = (n: string) => `etc/passwd/${n}.json`;
export const shadow = (n: string) => `etc/shadow/${n}.json`;
export const vaultFile = (n: string) => `home/${n}/vault.json`;
export const prefsFile = (n: string) => `home/${n}/prefs.json`;
export const wallFile = (n: string) => `home/${n}/wallpaper.json`;
export const mcpFile = (n: string) => `home/${n}/mcp.json`;

export const adminPass = env("ADMIN_PASS", env("PHOSPHORUS_UPDATE_PASSWORD"));
export const nameRe = /^[a-z0-9][a-z0-9._-]{0,31}$/;
export const reserved = [admin, "shared", "sys", "usr"];
export const baseDomain = env("BASE_DOMAIN").toLowerCase();
export const selfHost = env("SELF_HOST");
export const triesMax: Record<string, number> = { ip: 5, user: 20 };
export const tries = new Map<string, number[]>();
export const prefKeys = ["icons", "theme", "palette", "custom", "recent", "color", "agentview"];
export const wallTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];

// the request a session is read from or a cookie is written for
export type Req = Pick<Ctx, "req" | "url" | "ip">;

// Init the mesh secret's oldest-wins rule
export const Init = () => store.oldestWins(secretRel);

export type ShadowRec = { salt: string; hash: string; pwAt: string };
export type LiveUser = ShadowRec & { admin: boolean };

// a shadow record's fields, each a string or absent as Go's struct took them
export function shadowOf(v: unknown): ShadowRec | undefined {
  const o = obj(v);
  if (!o) return;
  const f = (k: string) =>
    o[k] === undefined || o[k] === null ? "" : typeof o[k] === "string" ? (o[k] as string) : undefined;
  const salt = f("salt"),
    hash = f("hash"),
    pwAt = f("pwAt");
  if (salt === undefined || hash === undefined || pwAt === undefined) return;
  return { salt, hash, pwAt };
}

export function live(name: string): LiveUser | undefined {
  if (!nameRe.test(name)) return;
  const pw = store.read(passwd(name));
  if (pw === undefined) return;
  const sh = shadowOf(store.read(shadow(name)));
  if (!sh) return;
  return { admin: truthy(obj(pw)?.admin), ...sh };
}

// Go's truthy: false, nil, 0 and "" are false, everything else true
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "";
  return true;
}

// a value as the page's string: JSON for anything not scalar
export function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return marshal(v);
}

export const names = () =>
  store
    .list("etc/passwd")
    .map((f) => f.replace(/\.json$/, ""))
    .filter((n) => live(n) !== undefined)
    .sort();

export const hasAdmin = () => names().some((n) => live(n)?.admin);

// a fresh host's empty etc/ never taken for a mesh without admins
export async function anyAdmin(): Promise<boolean> {
  if (hasAdmin()) return true;
  await pull();
  return hasAdmin();
}

export let pulled = false;
// pull the mesh's sys, waiting at most pullWait
export async function pull() {
  await Promise.race([store.pull(), sleep(pullWait)]);
  pulled = true;
}

// MeshKey one per mesh, the oldest winning
export function MeshKey(): Uint8Array {
  let v = obj(store.read(secretRel))?.v;
  if (typeof v !== "string") {
    store.write(secretRel, { v: randomBytes(32).toString("hex") });
    v = obj(store.read(secretRel))?.v;
    if (typeof v !== "string") v = "";
  }
  return createHash("sha256").update(v).digest();
}
