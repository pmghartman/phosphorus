// config/ edited in place: services.export and phosphorus.ini section by
// section, comments, order and every other section kept; the forms over them
// and the same rewrites for the frontend
import { basename, dirname, join } from "node:path";
import { chmodSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { parse } from "@phosphorus/services";
import { env, errText, RepoDir } from "@phosphorus/util";
import { type Field, type Form, formValues, formVals, newForm } from "./form.ts";
import { indexOf } from "./json.ts";
import { openForm, servicesTab, ui } from "./state.ts";
import { chownLike } from "./sys.ts";

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

const findSection = (d: Doc, name: string) => d.secs.find((s) => s.name === name);

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
    if (k !== "") f[k] = line.slice(line.indexOf("=") + 1).trim().replace(quotesRe, "");
  }
  return f;
}

// vals key to value, undefined drops the key, absent untouched, new keys after the last
export function rewriteSection(s: Section, name: string, vals: Record<string, string | undefined>, order: string[]): string[] {
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

// --- services.export ------------------------------------------------------------

const svcKeys = ["port", "scheme", "mode", "base_path", "extras", "type", "start", "stop", "public"];

export function serviceForm(s: Section | undefined): Form {
  const f = fieldsOf(s);
  const fl = (key: string, hint: string, ...choices: string[]): Field => ({ key, value: f[key] ?? "", hint, choices: choices.length ? choices : undefined });
  const out = newForm({ kind: "service", title: "new service", isNew: !s, fields: [] });
  let name = "";
  if (s) {
    out.title = "editing [" + s.name + "]";
    out.orig = s.name;
    name = s.name;
  }
  out.fields = [
    { key: "name", value: name, hint: "lowercase letters, digits, -" },
    fl("port", "required, 1-65535"),
    fl("scheme", "blank = http", "", "http", "https"),
    fl("mode", "blank = path, subdomain = <name>.<domain>, a path without one", "", "path", "subdomain"),
    fl("base_path", "sub-path stripped before proxying"),
    fl("extras", 'JSON: {"max_body":"50MB","forwarded_proto":"https"}'),
    fl("public", "true = no phosphorus login, the service's own only", "", "true", "false"),
    fl("type", "blank, or game", "", "game"),
    fl("start", "games only: host command behind play"),
    fl("stop", "games only: host command behind stop"),
  ];
  return out;
}

// the neighbouring service in file order, unsaved changes asked about first
export function switchService(dir: number) {
  const f = ui.form!;
  const secs = splitSections(readText(servicesFile)).secs;
  const n = secs.length;
  if (n === 0) return;
  let at = -1;
  if (f.isNew) {
    if (dir < 0) at = n;
  } else {
    secs.forEach((s, i) => {
      if (s.name === f.orig) at = i;
    });
  }
  const next = (((at + dir) % n) + n) % n;
  const goTo = () => {
    ui.sel[servicesTab] = next;
    const idx = f.idx;
    openForm(serviceForm(secs[next]));
    ui.form!.idx = idx;
  };
  if (formValues(f) === f.initial) {
    goTo();
    return;
  }
  const what = f.isNew ? "the new service" : "[" + f.orig + "]";
  ui.confirm = { text: "discard changes to " + what + "?", danger: true, onYes: goTo };
}

const svcVals = (v: Record<string, string>) => Object.fromEntries(svcKeys.map((k) => [k, v[k] ? v[k] : undefined]));

// the whole candidate file through the frontend's own parser, a bad edit never
// reaching disk to blackhole the file
export function saveService(f: Form): string {
  const v = formVals(f);
  if (!v.name) return "name is required";
  if (!v.port) return "port is required";
  if (v.type === "game" && !v.start !== !v.stop) return "start and stop go together";
  if (v.type !== "game" && (v.start || v.stop)) return "start and stop are for games only";
  if (v.type === "game" && v.public) return "public is for web services only";
  const d = splitSections(readText(servicesFile));
  let s: Section | undefined;
  if (!f.isNew) {
    s = findSection(d, f.orig);
    if (!s) return "[" + f.orig + "] is gone from the file, reopen it";
  }
  if (!s) s = appendSection(d, v.name!);
  s.lines = rewriteSection(s, v.name!, svcVals(v), svcKeys);
  return commitServices(d);
}

export function deleteService(name: string): string {
  const d = splitSections(readText(servicesFile));
  d.secs = d.secs.filter((s) => s.name !== name);
  return commitServices(d);
}

function commitServices(d: Doc): string {
  const [, err] = parse(joinDoc(d));
  if (err) return err;
  return writeDoc(servicesFile, d);
}

// --- phosphorus.ini [files] -----------------------------------------------------

export type Share = { dir: string; perms: string };

const splitList = (v: string) => v.split(",").map((s) => s.trim()).filter((s) => s !== "");

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
  if (shares.length > 0) vals = { dir: shares.map((x) => x.dir).join(", "), priv: shares.map((x) => x.perms).join(", ") };
  s.lines = rewriteSection(s, "files", vals, ["dir", "priv"]);
  return writeDoc(iniFile, d);
}

export function shareForm(i: number): Form {
  let s: Share = { dir: "", perms: "" };
  let title = "new share";
  if (i >= 0) {
    s = readShares()[i]!;
    title = "edit share " + s.dir;
  }
  return newForm({
    kind: "share",
    title,
    origIdx: i,
    isNew: i < 0,
    fields: [
      { key: "dir", value: s.dir, hint: "host path, never / or a home directory" },
      { key: "perms", value: s.perms, hint: "r browse, w upload/rename, d delete", choices: ["r", "rw", "rwd"] },
    ],
  });
}

const permsRe = /^[rwd]+$/;
const count = (s: string, ch: string) => s.split(ch).length - 1;

export function saveShare(f: Form): string {
  const dir = f.fields[0]!.value.trim(), perms = f.fields[1]!.value.trim();
  if (dir === "") return "dir is required";
  if (dir.includes(",")) return "dir can't contain a comma";
  if (!permsRe.test(perms) || count(perms, "r") > 1 || count(perms, "w") > 1 || count(perms, "d") > 1) return "perms is a mix of r, w and d";
  const shares = readShares();
  const wasHome = !f.isNew && isHomeDir(shares[f.origIdx]!.dir);
  if (f.isNew) shares.push({ dir, perms });
  else shares[f.origIdx] = { dir, perms };
  const err = writeShares(shares);
  if (err) return err;
  if (wasHome) return writeHomeDir(dir);
  return "";
}

// --- phosphorus.ini [home] ------------------------------------------------------
// the [files] dir whose home/ holds the users, shared/ and .sys/, blank the home's
// files/, a change moving home/ there on the rebuild

const homeKey = (d: string) => d.trim().replace(/[/\\]+$/, "");

export function readHomeDir(): string {
  const s = findSection(splitSections(readText(iniFile)), "home");
  if (!s) return "";
  return homeKey(fieldsOf(s).dir ?? "");
}

export function writeHomeDir(dir: string): string {
  const d = splitSections(readText(iniFile));
  const s = iniSection(d, "home");
  s.lines = rewriteSection(s, "home", { dir: homeKey(dir) }, ["dir"]);
  return writeDoc(iniFile, d);
}

export function isHomeDir(dir: string): boolean {
  const h = readHomeDir();
  return h !== "" && homeKey(dir) === h;
}

// --- phosphorus.ini [git] -------------------------------------------------------

export function readGitHost(): boolean {
  const s = findSection(splitSections(readText(iniFile)), "git");
  return process.platform === "linux" && !!s && fieldsOf(s).host === "true";
}

export function writeGitHost(on: boolean): string {
  if (on && process.platform !== "linux") return "git hosts run on Linux alone: forgejo and the git daemon ship for it only";
  const d = splitSections(readText(iniFile));
  const s = iniSection(d, "git");
  s.lines = rewriteSection(s, "git", { host: String(on) }, ["host"]);
  return writeDoc(iniFile, d);
}

// --- phosphorus.ini [model] -----------------------------------------------------

// host, gpu and url always written, ctx and slots only once set
const modelKeys = ["host", "gpu", "url", "ctx", "slots"];
const modelKept = new Set(["host", "gpu", "url"]);
const boolKeys = ["host", "gpu"];

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

export function modelForm(): Form {
  const m = readModel();
  const fl = (key: string, hint: string, ...choices: string[]): Field => ({ key, value: m[key] ?? "", hint, choices: choices.length ? choices : undefined });
  return newForm({
    kind: "model",
    title: "[model]",
    gpuWas: m.gpu!,
    hostWas: m.host!,
    fields: [
      fl("host", "true runs the model here for the whole mesh, downloading llama.cpp's llama-server (with NVIDIA's CUDA runtime on an nvidia gpu) and the model itself, several GB", "false", "true"),
      fl("gpu", "true offloads it to this nvidia, amd or intel gpu, the rest in ram", "false", "true"),
      fl("url", "download link to a single .gguf, pasted or typed, a hugging face page link works too"),
      fl("ctx", "context tokens, blank is 65536, and every token costs memory"),
      fl("slots", "asks answered at once, sharing ctx, blank is 4"),
    ],
  });
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

export function saveModel(f: Form): string {
  const v = { ...readModel(), ...formVals(f) };
  if (v.ctx && !wholeAtLeast(v.ctx, 512)) return "ctx is a whole number of tokens, 512 or more";
  for (const k of boolKeys) if (v[k] !== "true" && v[k] !== "false") return k + " is true or false";
  if (v.slots && !wholeAtLeast(v.slots, 1)) return "slots is a whole number, 1 or more";
  if (v.url && !linkOk(v.url)) return "url is a https link to a single .gguf";
  return writeModel(v);
}

// --- edits from the frontend: the same rewrites as the forms ---------------------

const svcNameRe = /^[a-z0-9][a-z0-9-]*$/;

// setService [name] written with fields, a blank one dropped, or removed; "" once saved
export const setService = (name: string, fields: Record<string, string>, remove: boolean) => editService(name, fields, remove, false)[0];

// editService setService, or with dry the change it would make as a diff, nothing written
export function editService(name: string, fields: Record<string, string>, remove: boolean, dry: boolean): [string, string] {
  if (!svcNameRe.test(name)) return ["name: lowercase letters, digits, -", ""];
  const before = readText(servicesFile);
  const d = splitSections(before);
  let s = findSection(d, name);
  if (remove) {
    if (!s) return ["no service " + name, ""];
    d.secs = d.secs.filter((x) => x.name !== name);
    return commitDry(d, before, dry);
  }
  const v = fieldsOf(s);
  for (const [k, x] of Object.entries(fields)) {
    if (!svcKeys.includes(k)) return ["no field " + k + ", only " + svcKeys.join(", "), ""];
    v[k] = x.trim();
  }
  if (!v.port) return ["port is required", ""];
  if (v.type === "game" && !v.start !== !v.stop) return ["start and stop go together", ""];
  if (v.type !== "game" && (v.start || v.stop)) return ["start and stop are for games only", ""];
  if (!s) s = appendSection(d, name);
  s.lines = rewriteSection(s, name, svcVals(v), svcKeys);
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
  home: ["dir"],
};

// setIni phosphorus.ini's section key set, blank dropping it; "" once saved
export const setIni = (section: string, key: string, value: string) => editIni(section, key, value, false)[0];

// editIni setIni held to IniKeys, a section left empty removed, or with dry
// the change it would make as a diff
export function editIni(section: string, key: string, value: string, dry: boolean): [string, string] {
  const keys = IniKeys[section];
  if (!keys) return ["no section " + section + ", only " + Object.keys(IniKeys).sort().join(", "), ""];
  if (indexOf(keys, key) < 0) return ["no key " + key + " in [" + section + "], only " + keys.join(", "), ""];
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
  const x = lines(a), y = lines(b);
  const n = x.length, m = y.length;
  const l: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) l[i]![j] = x[i] === y[j] ? l[i + 1]![j + 1]! + 1 : Math.max(l[i + 1]![j]!, l[i]![j + 1]!);
  const out: string[] = [];
  let i = 0, j = 0;
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
