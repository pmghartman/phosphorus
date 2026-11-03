// the pages each host publishes by hand, etc/services/<host>/<name>.json in the
// store, every host's in every copy; an installed service's route is its want's
// (packages/stacks), a game server the Games app's
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Row } from "@phosphorus/proxy";
import * as store from "@phosphorus/store";
import { env, errText, Notes, RepoDir, readJSON, SelfHost, StateDir, writeFileAtomic } from "@phosphorus/util";
import { headRe, Keys, parse } from "./parse.ts";

const notes = new Notes("services");
const dirOf = (host: string) => `etc/services/${host}`;
const relOf = (host: string, name: string) => `${dirOf(host)}/${name}.json`;
// a store path's part is at most 64, a DNS label 63
const nameMax = 63;

// one record: what a services.export section held, the scheme blank to be sniffed
export type Rec = { port: number; scheme?: string; max_body?: string; public?: boolean; aliases?: string[] };

const recFrom = (r: Row): Rec => {
  const out: Rec = { port: r.port as number };
  if (r.scheme) out.scheme = r.scheme as string;
  if (r.max_body !== undefined) out.max_body = String(r.max_body);
  if (r.public === true) out.public = true;
  if (Array.isArray(r.aliases) && r.aliases.length) out.aliases = r.aliases as string[];
  return out;
};

// a record as a section's key = value strings
function fieldsOf(r: Rec | undefined): Record<string, string> {
  if (!r) return {};
  const f: Record<string, string> = { port: String(r.port) };
  if (r.scheme) f.scheme = r.scheme;
  if (r.max_body) f.max_body = r.max_body;
  if (r.public) f.public = "true";
  if (r.aliases?.length) f.aliases = r.aliases.join(", ");
  return f;
}

// a section's text for a diff, its keys in order
const textOf = (name: string, r: Rec | undefined) =>
  r ? [`[${name}]`, ...Keys.flatMap((k) => (fieldsOf(r)[k] ? [`${k} = ${fieldsOf(r)[k]}`] : []))] : [];

// fields as a record, held to the checks a services.export section had; or why not
function recOf(name: string, fields: Record<string, string>): [Rec | undefined, string] {
  if (name.length > nameMax) return [undefined, `a name is at most ${nameMax} characters`];
  for (const [k, v] of Object.entries(fields)) {
    if (!Keys.includes(k)) return [undefined, `no field ${k}, only ${Keys.join(", ")}`];
    if (/[\r\n]/.test(v)) return [undefined, "one line only"];
  }
  const lines = Object.entries(fields).flatMap(([k, v]) => (v ? [`${k} = ${v}`] : []));
  const [rows, why] = parse([`[${name}]`, ...lines].join("\n"));
  if (why) return [undefined, why];
  return [recFrom(rows[0]!), ""];
}

// a row from a record, the same a section parsed to; undefined when it won't check
function rowOf(name: string, r: unknown): Row | undefined {
  if (!r || typeof r !== "object") return;
  const [rec, why] = recOf(name, fieldsOf(r as Rec));
  if (why) {
    notes.note(`rec:${name}`, `${relOf(SelfHost, name)} not published: ${why}`);
    return;
  }
  notes.clear(`rec:${name}`);
  const row: Row = { name, port: rec!.port, scheme: rec!.scheme ?? "" };
  if (rec!.max_body) row.max_body = rec!.max_body;
  if (rec!.public) row.public = true;
  if (rec!.aliases) row.aliases = rec!.aliases;
  return row;
}

// a host's records as rows, by name
export function records(host = SelfHost): Row[] {
  const out: Row[] = [];
  for (const f of store.list(dirOf(host))) {
    const name = f.replace(/\.json$/, "");
    const row = rowOf(name, store.read(relOf(host, name)));
    if (row) out.push(row);
  }
  return out;
}

// a host's records as an admin reads them: each one's fields
export const listed = (host = SelfHost) =>
  store.list(dirOf(host)).map((f) => {
    const name = f.replace(/\.json$/, "");
    return { name, ...fieldsOf(store.read<Rec>(relOf(host, name))) };
  });

// an installed service's name, its route its want's
const installed = (name: string) => store.read(`etc/stacks/${name}.json`) !== undefined;

// --- removed: a found page whose record was taken out left alone ------------------

const removedFile = join(StateDir, "services-removed");

// the ports whose records were removed here, kept across restarts
export function removedPorts(): Set<number> {
  const a = readJSON(removedFile);
  return new Set(Array.isArray(a) ? a.filter((p) => Number.isInteger(p)) : []);
}

function setRemoved(port: number, on: boolean) {
  const set = removedPorts();
  if (set.has(port) === on) return;
  if (on) set.add(port);
  else set.delete(port);
  try {
    writeFileAtomic(removedFile, JSON.stringify([...set].sort((a, b) => a - b)) + "\n");
  } catch {}
}

// --- edits ------------------------------------------------------------------------

// the lines b changed from a, "- " gone and "+ " new
const diffOf = (a: string[], b: string[]) =>
  [
    ...a.filter((l) => !b.includes(l)).map((l) => `- ${l}`),
    ...b.filter((l) => !a.includes(l)).map((l) => `+ ${l}`),
  ].join("\n");

// [name] on host written with fields (a blank one dropped) or removed, or with dry
// the change it would make as a diff; why not, "" once done
export function editService(
  name: string,
  fields: Record<string, string>,
  remove: boolean,
  dry: boolean,
  host = SelfHost,
): [string, string] {
  const rel = relOf(host, name);
  const before = store.read<Rec>(rel);
  if (remove) {
    if (!before) return [`no service ${name}`, ""];
    const diff = diffOf(textOf(name, before), []);
    if (!dry) {
      store.remove(rel);
      if (host === SelfHost) setRemoved(before.port, true);
    }
    return ["", diff];
  }
  if (installed(name)) return [`${name} is an installed service, its page set in the service wizard`, ""];
  const v = fieldsOf(before);
  for (const [k, x] of Object.entries(fields)) v[k] = x.trim();
  const [rec, why] = recOf(name, v);
  if (why) return [why, ""];
  const diff = diffOf(textOf(name, before), textOf(name, rec));
  if (!dry && diff) {
    store.write(rel, rec);
    if (host === SelfHost) setRemoved(rec!.port, false);
  }
  return ["", diff];
}

// [name]'s public set or dropped, on whichever host the record is
export function setPublic(host: string, name: string, on: boolean): [number, any] {
  const r = store.read<Rec>(relOf(host, name));
  if (!r) return [404, { error: `${host} declares no service called ${name}` }];
  const next: Rec = { ...r };
  if (on) next.public = true;
  else delete next.public;
  if (!!r.public !== on) store.write(relOf(host, name), next);
  return [200, { public: on }];
}

// a found page written in by its port alone; false when its name is taken
export function adoptOne(name: string, port: number): boolean {
  if (store.read(relOf(SelfHost, name)) !== undefined || installed(name)) return false;
  store.write(relOf(SelfHost, name), { port } satisfies Rec);
  return true;
}

// --- the file it came from --------------------------------------------------------

// services.export as this host kept it: each page a record, an installed service's
// left to its want; a game's and one that won't check kept in it, the file gone once empty
export function migrateFile(file = env("SERVICES_FILE", join(RepoDir, "config", "services.export"))) {
  // a source checkout's own config/ left alone
  if (existsSync(join(RepoDir, ".git"))) return;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  const secs: string[][] = [];
  for (const l of text.split("\n")) {
    if (headRe.test(l.replace(/\r$/, "").trim())) secs.push([l]);
    else secs.at(-1)?.push(l);
  }
  const kept: string[] = [];
  const took: string[] = [];
  for (const sec of secs) {
    const [rows, why] = parse(sec.join("\n"));
    const name = headRe.exec(sec[0]!.replace(/\r$/, "").trim())![1]!;
    if (why || !rows.length) {
      if (why) notes.log(`[${name}] kept in ${file}, not a record: ${why}`);
      kept.push(...sec);
      continue;
    }
    if (installed(name)) continue;
    if (store.read(relOf(SelfHost, name)) === undefined) store.write(relOf(SelfHost, name), recFrom(rows[0]!));
    took.push(name);
  }
  try {
    if (kept.length) {
      const rest = kept.join("\n");
      if (rest !== text) writeFileAtomic(file, rest);
    } else rmSync(file, { force: true });
  } catch (e) {
    notes.log(`${file} not rewritten: ${errText(e)}`);
  }
  if (took.length) notes.log(`moved into the store from ${file}: ${took.join(", ")}`);
}
