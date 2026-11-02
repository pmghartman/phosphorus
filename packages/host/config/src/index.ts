// config/ edited in place: services.export and phosphorus.ini section by
// section, comments, order and every other section kept; the frontend's and
// the agents' edits come through here

import { chmodSync, readFileSync, renameSync, type Stats, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Keys, migrate, parse } from "@phosphorus/services";
import { chownLike, env, errText, RepoDir } from "@phosphorus/util";

// the home's config/, read-write, /etc/phosphorus a read-only mount
const configDir = env("PHOSPHORUS_CONFIG_DIR", join(RepoDir, "config"));
export const servicesFile = join(configDir, "services.export");
export const iniFile = join(configDir, "phosphorus.ini");

// --- config files ---------------------------------------------------------------

export type Section = { name: string; lines: string[] };
export type Doc = { head: string[]; secs: Section[] };

const headRe = /^\[\s*(.*?)\s*\]$/;
const quotesRe = /^"|"$/g;

export function splitSections(text: string): Doc {
  const d: Doc = { head: [], secs: [] };
  let cur: Section | undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = headRe.exec(line.trim());
    if (m) {
      cur = { name: m[1]!, lines: [line] };
      d.secs.push(cur);
      continue;
    }
    if (cur) cur.lines.push(line);
    else d.head.push(line);
  }
  return d;
}

export const joinDoc = (d: Doc) => [...d.head, ...d.secs.flatMap((s) => s.lines)].join("\n");

export const findSection = (d: Doc, name: string) => d.secs.find((s) => s.name === name);

export function keyOf(line: string): string {
  const t = line.trim();
  const eq = t.indexOf("=");
  if (t === "" || t[0] === "#" || t[0] === ";" || eq <= 0) return "";
  return t.slice(0, eq).trim();
}

export function fieldsOf(s: Section | undefined): Record<string, string> {
  const f: Record<string, string> = {};
  if (!s) return f;
  for (const line of s.lines.slice(1)) {
    const k = keyOf(line);
    if (k !== "")
      f[k] = line
        .slice(line.indexOf("=") + 1)
        .trim()
        .replace(quotesRe, "");
  }
  return f;
}

// vals key to value, undefined drops the key, absent untouched, new keys after the last
export function rewriteSection(
  s: Section,
  name: string,
  vals: Record<string, string | undefined>,
  order: string[],
): string[] {
  const out = ["[" + name + "]"];
  const done = new Set<string>();
  let after = 1;
  const kv = (k: string, v: string) => (k + " = " + v).replace(/[ \t]+$/, "");
  for (const line of s.lines.slice(1)) {
    const k = keyOf(line);
    if (k !== "" && k in vals) {
      done.add(k);
      const v = vals[k];
      if (v !== undefined) {
        out.push(kv(k, v));
        after = out.length;
      }
      continue;
    }
    out.push(line);
    if (k !== "") after = out.length;
  }
  const extra: string[] = [];
  for (const k of order) {
    const v = vals[k];
    if (!done.has(k) && v !== undefined) extra.push(kv(k, v));
  }
  return [...out.slice(0, after), ...extra, ...out.slice(after)];
}

const noteRe = /^\s*[#;]/;

// [name] taken out with the comment right above it; the blanks and comment
// after its keys head the next section, so they stay
export function dropSection(d: Doc, name: string) {
  const i = d.secs.findIndex((s) => s.name === name);
  if (i < 0) return;
  const above = i > 0 ? d.secs[i - 1]!.lines : d.head;
  while (above.length > 0 && noteRe.test(above[above.length - 1]!)) above.pop();
  while (above.length > 0 && above[above.length - 1]!.trim() === "") above.pop();
  const lines = d.secs[i]!.lines;
  let k = lines.length;
  while (k > 1 && (lines[k - 1]!.trim() === "" || noteRe.test(lines[k - 1]!))) k--;
  const tail = lines.slice(k);
  if (above.length === 0) while (tail.length > 0 && tail[0]!.trim() === "") tail.shift();
  above.push(...tail);
  d.secs.splice(i, 1);
}

// one blank line before it, one trailing newline after
export function appendSection(d: Doc, name: string): Section {
  const last = d.secs.length > 0 ? d.secs[d.secs.length - 1]!.lines : d.head;
  while (last.length > 0 && last[last.length - 1]!.trim() === "") last.pop();
  if (last.length > 0) last.push("");
  const s = { name, lines: ["[" + name + "]", ""] };
  d.secs.push(s);
  return s;
}

export function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

// a node fs error's reason alone, as Go's PathError.Err reads it: "permission denied"
export function osErrText(e: unknown): string {
  const m = errText(e);
  return /^[A-Z]+: ([^,]*), \w+ '/.exec(m)?.[1] ?? m;
}

// temp then rename, owner and mode kept, else a root-owned file in the host's home
function writeAtomic(file: string, text: string) {
  let st: Stats | undefined;
  try {
    st = statSync(file);
  } catch {}
  const tmp = join(dirname(file), `.${basename(file)}.phosphorus-${process.pid}`);
  writeFileSync(tmp, text, { mode: 0o644 });
  try {
    if (st) {
      chmodSync(tmp, st.mode & 0o7777);
      chownLike(tmp, st);
    }
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

function writeDoc(file: string, d: Doc): string {
  try {
    writeAtomic(file, joinDoc(d));
  } catch (e) {
    return `can't write ${file}: ${osErrText(e)}`;
  }
  return "";
}

// --- phosphorus.ini [files] -----------------------------------------------------

export type Share = { dir: string; perms: string };

const splitList = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

// unset perms full access, as the frontend reads them
export function readShares(): Share[] {
  const f = fieldsOf(findSection(splitSections(readText(iniFile)), "files"));
  const perms = splitList(f.priv ?? "");
  return splitList(f.dir ?? "").map((dir, i) => ({ dir, perms: i < perms.length ? perms[i]! : "rwd" }));
}

const iniSection = (d: Doc, name: string) => findSection(d, name) ?? appendSection(d, name);

export function writeShares(shares: Share[]): string {
  const d = splitSections(readText(iniFile));
  const s = iniSection(d, "files");
  let vals: Record<string, string | undefined> = { dir: "", priv: undefined };
  if (shares.length > 0)
    vals = { dir: shares.map((x) => x.dir).join(", "), priv: shares.map((x) => x.perms).join(", ") };
  s.lines = rewriteSection(s, "files", vals, ["dir", "priv"]);
  return writeDoc(iniFile, d);
}

// --- phosphorus.ini [git] -------------------------------------------------------

export function readGitHost(): boolean {
  const s = findSection(splitSections(readText(iniFile)), "git");
  return process.platform === "linux" && !!s && fieldsOf(s).host === "true";
}

export function writeGitHost(on: boolean): string {
  if (on && process.platform !== "linux")
    return "git hosts run on Linux alone: forgejo and the git daemon ship for it only";
  const d = splitSections(readText(iniFile));
  const s = iniSection(d, "git");
  s.lines = rewriteSection(s, "git", { host: String(on) }, ["host"]);
  return writeDoc(iniFile, d);
}

// --- phosphorus.ini [model] -----------------------------------------------------

// host, gpu and url always written, ctx and slots only once set
const modelKeys = ["host", "gpu", "url", "ctx", "slots"];
const modelKept = new Set(["host", "gpu", "url"]);

export function readModel(): Record<string, string> {
  const f = fieldsOf(findSection(splitSections(readText(iniFile)), "model"));
  const out: Record<string, string> = {};
  for (const k of modelKeys) {
    out[k] = f[k] ?? "";
    // flags never blank, the form's choices always somewhere to start
    if (out[k] === "" && (k === "host" || k === "gpu")) out[k] = "false";
  }
  return out;
}

export function writeModel(vals: Record<string, string>): string {
  const d = splitSections(readText(iniFile));
  const s = iniSection(d, "model");
  const out: Record<string, string | undefined> = {};
  for (const k of modelKeys) {
    const v = (vals[k] ?? "").trim();
    out[k] = v !== "" ? v : modelKept.has(k) ? "" : undefined;
  }
  s.lines = rewriteSection(s, "model", out, modelKeys);
  return writeDoc(iniFile, d);
}

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

// --- edits from the frontend: the same rewrites as the forms ---------------------

// setService [name] written with fields, a blank one dropped, or removed; "" once saved
export const setService = (name: string, fields: Record<string, string>, remove: boolean) =>
  editService(name, fields, remove, false)[0];

// editService setService, [from] renamed to [name] when given, or with dry the
// change it would make as a diff, nothing written; the keys and every check are
// @phosphorus/services', old keys dropped on the way
export function editService(
  name: string,
  fields: Record<string, string>,
  remove: boolean,
  dry: boolean,
  from = name,
): [string, string] {
  const before = readText(servicesFile);
  const d = splitSections(migrate(before));
  let s = findSection(d, from);
  if (remove) {
    if (!s) return ["no service " + from, ""];
    dropSection(d, from);
    return commitDry(d, before, dry);
  }
  if (from !== name && !s) return ["no service " + from, ""];
  if (from !== name && findSection(d, name)) return ["there's already a service " + name, ""];
  const v = fieldsOf(s);
  for (const [k, x] of Object.entries(fields)) {
    if (!Keys.includes(k)) return ["no field " + k + ", only " + Keys.join(", "), ""];
    v[k] = x.trim();
  }
  if (!s) s = appendSection(d, name);
  s.lines = rewriteSection(s, name, Object.fromEntries(Keys.map((k) => [k, v[k] || undefined])), Keys);
  return commitDry(d, before, dry);
}

// commitDry services.export checked, then written, or only diffed when dry
function commitDry(d: Doc, before: string, dry: boolean): [string, string] {
  const [, err] = parse(joinDoc(d));
  if (err) return [err, ""];
  const diff = lineDiff(before, joinDoc(d));
  if (dry) return ["", diff];
  return [writeDoc(servicesFile, d), diff];
}

// IniKeys the phosphorus.ini keys phosphorus reads, by section
export const IniKeys: Record<string, string[]> = {
  files: ["dir", "priv"],
  git: ["host"],
  model: ["host", "gpu", "url", "ctx", "slots"],
};

// setIni phosphorus.ini's section key set, blank dropping it; "" once saved
export const setIni = (section: string, key: string, value: string) => editIni(section, key, value, false)[0];

// editIni setIni held to IniKeys, a section left empty removed, or with dry
// the change it would make as a diff
export function editIni(section: string, key: string, value: string, dry: boolean): [string, string] {
  const keys = IniKeys[section];
  if (!keys) return ["no section " + section + ", only " + Object.keys(IniKeys).sort().join(", "), ""];
  if (!keys.includes(key)) return ["no key " + key + " in [" + section + "], only " + keys.join(", "), ""];
  if (/[\n\r]/.test(value)) return ["one line only", ""];
  const before = readText(iniFile);
  const d = splitSections(before);
  const s = iniSection(d, section);
  value = value.trim();
  s.lines = rewriteSection(s, section, { [key]: value !== "" ? value : undefined }, [key]);
  // a header with no keys left dropped, its blank lines with it
  if (Object.keys(fieldsOf(s)).length === 0) d.secs = d.secs.filter((x) => x !== s);
  const diff = lineDiff(before, joinDoc(d));
  if (dry) return ["", diff];
  return [writeDoc(iniFile, d), diff];
}

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

// configText phosphorus.ini and services.export as they stand
export const configText = (): [string, string] => [readText(iniFile), readText(servicesFile)];
