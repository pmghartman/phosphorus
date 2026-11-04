// this host's settings edited: its record in the store, etc/hosts/<host>/config.json,
// every edit checked first; the old phosphorus.ini moved in once, then gone
import { readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as store from "@phosphorus/store";
import {
  configLines,
  configRel,
  errText,
  fromIni,
  type HostConfig,
  LegacyIni,
  logf,
  normalize,
  SelfHost,
  type Share,
  StateDir,
} from "@phosphorus/util";

export type { HostConfig, Share };

const rel = () => configRel(SelfHost);

// this host's record as it stands, defaults filled
export const current = (): HostConfig => normalize(store.read(rel()));

// --- the move from phosphorus.ini ---------------------------------------------------

const lastName = join(StateDir, "config-host");

// the old ini into the store unless a record is there, then removed; a record left
// under this host's last name, renamed on the tailnet since, carried over
export function migrate() {
  if (!SelfHost) return;
  let before = "";
  try {
    before = readFileSync(lastName, "utf8").trim();
  } catch {}
  if (before && before !== SelfHost && store.read(rel()) === undefined) {
    const old = store.read(configRel(before));
    if (old !== undefined) {
      store.write(rel(), old);
      store.remove(configRel(before));
      logf("[config] %s's settings carried over to %s", before, SelfHost);
    }
  }
  try {
    writeFileSync(lastName + ".tmp", SelfHost + "\n", { mode: 0o644 });
    renameSync(lastName + ".tmp", lastName);
  } catch {}
  let text: string;
  try {
    text = readFileSync(LegacyIni, "utf8");
  } catch {
    return;
  }
  if (store.read(rel()) === undefined) {
    // on disk before the ini goes
    store.write(rel(), fromIni(text), true);
    logf("[config] %s moved into the store as %s", LegacyIni, rel());
  } else logf("[config] %s left over, the store's record kept", LegacyIni);
  try {
    rmSync(LegacyIni, { force: true });
  } catch (e) {
    logf("[config] couldn't remove %s: %s", LegacyIni, errText(e));
  }
  // config/ gone too when it held nothing else
  try {
    rmdirSync(dirname(LegacyIni));
  } catch {}
}

// --- edits ---------------------------------------------------------------------------

// as the daemon reads it: https, a path ending .gguf
export function linkOk(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.host === "") return false;
  return u.pathname.endsWith(".gguf");
}

// JS Number() of a form value: whole and at least lo
export function wholeAtLeast(v: string, lo: number): boolean {
  const n = Number(v.trim());
  return Number.isInteger(n) && n >= lo;
}

// the keys config_set takes, by section
export const Keys: Record<string, string[]> = {
  files: ["dir", "priv"],
  model: ["host", "gpu", "url", "ctx", "slots"],
  stacks: ["tz", "puid", "pgid"],
};

const permsRe = /^[rwd]+$/;
const once = (s: string, ch: string) => s.split(ch).length <= 2;

function checkShares(shares: Share[]): string {
  const seen = new Set<string>();
  for (const sh of shares) {
    const dir = sh.dir.trim();
    if (dir === "") return "a share's folder is required";
    if (dir.includes(",")) return "a folder can't contain a comma";
    if (/[\n\r]/.test(dir)) return "one line only";
    if (seen.has(dir)) return dir + " is shared twice";
    seen.add(dir);
    if (!permsRe.test(sh.perms) || !once(sh.perms, "r") || !once(sh.perms, "w") || !once(sh.perms, "d"))
      return "perms is a mix of r, w and d";
  }
  return "";
}

// the model's form values checked and typed
function checkModel(v: Record<string, string>): [string, HostConfig["model"]?] {
  for (const k of ["host", "gpu"]) if (v[k] !== "true" && v[k] !== "false") return [k + " is true or false"];
  if (v.ctx && !wholeAtLeast(v.ctx, 512)) return ["ctx is a whole number of tokens, 512 or more"];
  if (v.slots && !wholeAtLeast(v.slots, 1)) return ["slots is a whole number, 1 or more"];
  if (v.url && !linkOk(v.url)) return ["url is a https link to a single .gguf"];
  return [
    "",
    {
      host: v.host === "true",
      gpu: v.gpu === "true",
      url: v.url ?? "",
      ctx: Number(v.ctx || 0),
      slots: Number(v.slots || 0),
    },
  ];
}

// the change written unless dry, as [why, diff]
function commit(next: HostConfig, dry: boolean): [string, string] {
  const diff = lineDiff(configLines(current()).join("\n"), configLines(next).join("\n"));
  if (dry || diff === "") return ["", diff];
  store.write(rel(), next);
  return ["", diff];
}

// the model as the forms show it: every value a string
export function modelValues(c = current()): Record<string, string> {
  const m = c.model;
  return {
    host: String(m.host),
    gpu: String(m.gpu),
    url: m.url,
    ctx: m.ctx ? String(m.ctx) : "",
    slots: m.slots ? String(m.slots) : "",
  };
}

// editKey one key set, blank dropping it: [files] dir and priv in step, as the ini had them
export function editKey(section: string, key: string, value: string, dry: boolean): [string, string] {
  const keys = Keys[section];
  if (!keys) return ["no section " + section + ", only " + Object.keys(Keys).sort().join(", "), ""];
  if (!keys.includes(key)) return ["no key " + key + " in [" + section + "], only " + keys.join(", "), ""];
  if (/[\n\r]/.test(value)) return ["one line only", ""];
  value = value.trim();
  const c = current();
  if (section === "files") {
    const list = (v: string) => v.split(",").map((x) => x.trim());
    let dirs = c.shares.map((s) => s.dir),
      perms = c.shares.map((s) => s.perms);
    if (key === "dir") dirs = value ? list(value).filter(Boolean) : [];
    else perms = value ? list(value) : [];
    const shares = dirs.map((dir, i) => ({ dir, perms: perms[i] || "rwd" }));
    return editShares(shares, dry);
  }
  if (section === "model") {
    const v = { ...modelValues(c), [key]: value };
    if ((key === "host" || key === "gpu") && value === "") v[key] = "false";
    return editModel(v, dry);
  }
  return commit({ ...c, stacks: { ...c.stacks, [key]: value } }, dry);
}

// editShares the shares as this list, each checked
export function editShares(shares: Share[], dry: boolean): [string, string] {
  const why = checkShares(shares);
  if (why) return [why, ""];
  return commit({ ...current(), shares: shares.map((x) => ({ dir: x.dir.trim(), perms: x.perms })) }, dry);
}

// editModel the model as these values, the form's checks on them
export function editModel(vals: Record<string, string>, dry: boolean): [string, string] {
  const v = modelValues();
  for (const [k, x] of Object.entries(vals)) {
    if (!Keys.model!.includes(k)) return ["no key " + k + " in [model], only " + Keys.model!.join(", "), ""];
    v[k] = String(x).trim();
  }
  const [why, m] = checkModel(v);
  if (why) return [why, ""];
  return commit({ ...current(), model: m! }, dry);
}

// the values settings › hosts shows
export function configValues(): Record<string, any> {
  const c = current();
  return { shares: c.shares, model: modelValues(c), platform: process.platform };
}

// configText the record as lines
export const configText = () => configLines(current()).join("\n");

// lineDiff the lines b changed from a, "- " gone and "+ " new, unchanged left out
export function lineDiff(a: string, b: string): string {
  const lines = (t: string) => {
    t = t.replace(/\n+$/, "");
    return t === "" ? [] : t.split("\n");
  };
  const x = lines(a),
    y = lines(b);
  const n = x.length,
    m = y.length;
  const l: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      l[i]![j] = x[i] === y[j] ? l[i + 1]![j + 1]! + 1 : Math.max(l[i + 1]![j]!, l[i]![j + 1]!);
  const out: string[] = [];
  let i = 0,
    j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      i++;
      j++;
    } else if (j < m && (i === n || l[i]![j + 1]! >= l[i + 1]![j]!)) {
      if (y[j]!.trim() !== "") out.push("+ " + y[j]);
      j++;
    } else {
      if (x[i]!.trim() !== "") out.push("- " + x[i]);
      i++;
    }
  }
  return out.join("\n");
}
