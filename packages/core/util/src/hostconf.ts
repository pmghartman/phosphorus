// this host's settings: its record in the store, etc/hosts/<host>/config.json, read
// off disk by any process; the old phosphorus.ini until the service moves it in
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type Share = { dir: string; perms: string };
export type ModelConf = { host: boolean; gpu: boolean; url: string; ctx: number; slots: number };
export type HostConfig = {
  shares: Share[];
  model: ModelConf;
  // stacks' TZ, PUID and PGID; blank the defaults
  stacks: { tz: string; puid: string; pgid: string };
  // a first-party app's minisign key in place of the catalogue's pin
  apps: Record<string, { key: string }>;
};

export const configRel = (host: string) => `etc/hosts/${host.toLowerCase()}/config.json`;

export const emptyConfig = (): HostConfig => ({
  shares: [],
  model: { host: false, gpu: false, url: "", ctx: 0, slots: 0 },
  stacks: { tz: "", puid: "", pgid: "" },
  apps: {},
});

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);
const o = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// a record as stored, anything missing or mistyped its default
export function normalize(raw: unknown): HostConfig {
  const r = o(raw),
    m = o(r.model),
    st = o(r.stacks);
  const c = emptyConfig();
  if (Array.isArray(r.shares))
    for (const x of r.shares) {
      const dir = s(o(x).dir);
      if (dir) c.shares.push({ dir, perms: s(o(x).perms) || "rwd" });
    }
  c.model = { host: m.host === true, gpu: m.gpu === true, url: s(m.url), ctx: n(m.ctx), slots: n(m.slots) };
  c.stacks = { tz: s(st.tz), puid: s(st.puid), pgid: s(st.pgid) };
  for (const [id, v] of Object.entries(o(r.apps))) if (s(o(v).key)) c.apps[id] = { key: s(o(v).key) };
  return c;
}

// --- the old phosphorus.ini ------------------------------------------------------

// "section\0key" to value, first wins, quotes stripped, ; and # comment lines
export function parseIni(text: string): Map<string, string> {
  const keys = new Map<string, string>();
  let cur = "";
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*[;#]/.test(line)) continue;
    const h = /^\s*\[\s*(.+?)\s*\]\s*$/.exec(line);
    if (h) {
      cur = h[1]!;
      continue;
    }
    const m = /^\s*([^=]+?)\s*=\s*(.*?)\s*$/.exec(line);
    const k = m && cur + "\0" + m[1];
    if (k && !keys.has(k)) keys.set(k, m[2]!.replace(/^"|"$/g, ""));
  }
  return keys;
}

const list = (v: string) =>
  v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

// what an ini said, as a record
export function fromIni(text: string): HostConfig {
  const k = parseIni(text);
  const g = (sec: string, key: string) => k.get(sec + "\0" + key) ?? "";
  const perms = g("files", "priv")
    .split(",")
    .map((x) => x.trim());
  const c = emptyConfig();
  c.shares = list(g("files", "dir")).map((dir, i) => ({
    dir: dir.replace(/[/\\]+$/, "") || dir,
    perms: perms[i] || "rwd",
  }));
  c.model = {
    host: g("model", "host") === "true",
    gpu: g("model", "gpu") === "true",
    url: g("model", "url"),
    ctx: Math.trunc(Number(g("model", "ctx"))) || 0,
    slots: Math.trunc(Number(g("model", "slots"))) || 0,
  };
  c.stacks = { tz: g("stacks", "tz"), puid: g("stacks", "puid"), pgid: g("stacks", "pgid") };
  for (const [key, v] of k) {
    const m = /^apps\0([a-z0-9-]+)_key$/.exec(key);
    if (m && v.trim()) c.apps[m[1]!] = { key: v.trim() };
  }
  return c;
}

// --- read off disk ----------------------------------------------------------------

export type Places = { sys: string; ini: string; state: string; self: string };

const sigOf = (p: string) => {
  try {
    const st = statSync(p, { bigint: true });
    return `${st.ino}:${st.size}:${st.mtimeNs}`;
  } catch {
    return "-";
  }
};
const text = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

// this host's name: the service's, else the one it last wrote down
export function selfName(p: Places): string {
  return (p.self || text(join(p.state, "self-host")) || "").trim().toLowerCase();
}

let memo: { sig: string; c: HostConfig } | undefined;

// the record when there is one (a tombstone: nothing set), else the ini's
export function readConfig(p: Places): HostConfig {
  const self = selfName(p);
  const rec = self ? join(p.sys, configRel(self)) : "";
  const sig = `${rec}\n${rec ? sigOf(rec) : "-"}\n${p.ini}\n${sigOf(p.ini)}`;
  if (memo?.sig === sig) return memo.c;
  let c: HostConfig | undefined;
  const raw = rec ? text(rec) : undefined;
  if (raw !== undefined)
    try {
      const f = JSON.parse(raw);
      c = f?.gone ? emptyConfig() : normalize(f?.data);
    } catch {}
  if (!c) {
    const ini = text(p.ini);
    c = ini === undefined ? emptyConfig() : fromIni(ini);
  }
  memo = { sig, c };
  return c;
}

// the record as lines, a diff's two sides
export function configLines(c: HostConfig): string[] {
  const out = c.shares.map((x) => `share ${x.dir} ${x.perms}`);
  for (const [k, v] of Object.entries(c.model)) if (v !== "" && v !== 0 && v !== false) out.push(`model.${k} = ${v}`);
  for (const [k, v] of Object.entries(c.stacks)) if (v) out.push(`stacks.${k} = ${v}`);
  for (const id of Object.keys(c.apps).sort()) out.push(`apps.${id}.key = ${c.apps[id]!.key}`);
  return out;
}
