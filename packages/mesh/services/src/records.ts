// the pages each host publishes, etc/services/<host>/<name>.json in the store, every
// host's in every copy: a found page's port and who may open it, its scheme sniffed;
// an installed service's route is its want's (packages/stacks), a game server the Games app's
import { join } from "node:path";
import { type Row, rowError } from "@phosphorus/proxy";
import * as store from "@phosphorus/store";
import { DataDir, Notes, readJSON, SelfHost, writeFileAtomic } from "@phosphorus/util";

const notes = new Notes("services");
const dirOf = (host: string) => `etc/services/${host}`;
const relOf = (host: string, name: string) => `${dirOf(host)}/${name}.json`;
// a store path's part is at most 64, a DNS label 63
const nameMax = 63;

// one record: a page's port, public when open to all
export type Rec = { port: number; public?: boolean };

// why name and port can't be a record, "" when they can
function recError(name: string, port: unknown): string {
  if (name.length > nameMax) return `a name is at most ${nameMax} characters`;
  return rowError({ name, port, scheme: "http", mode: "path" });
}

// a record's row, its scheme blank to be sniffed; undefined when it won't check
function rowOf(host: string, name: string, r: Rec | undefined): Row | undefined {
  if (!r) return;
  const why = recError(name, r.port);
  if (why) {
    notes.note(`rec:${name}`, `${relOf(host, name)} not published: ${why}`);
    return;
  }
  notes.clear(`rec:${name}`);
  return { name, port: r.port, scheme: "", ...(r.public === true ? { public: true } : {}) };
}

// a host's records as rows, by name
export function records(host = SelfHost): Row[] {
  const out: Row[] = [];
  for (const f of store.list(dirOf(host))) {
    const name = f.replace(/\.json$/, "");
    const row = rowOf(host, name, store.read<Rec>(relOf(host, name)));
    if (row) out.push(row);
  }
  return out;
}

// a host's records as an admin reads them
export const listed = (host = SelfHost): { name: string; port: number; public?: boolean }[] =>
  records(host).map((r) => ({ name: r.name, port: r.port, ...(r.public ? { public: true } : {}) }));

// an installed service's name, its route its want's
const installed = (name: string) => store.read(`etc/stacks/${name}.json`) !== undefined;

// --- removed: a found page whose record was taken out left alone ------------------

const removedFile = join(DataDir, "services-removed");

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

// a record as its one line
const lineOf = (name: string, r: Rec) => `${name} :${r.port}${r.public ? " public" : ""}`;

// name on host published at port (its own kept when not given) or public set, or removed;
// with dry the change it would make, "- " gone and "+ " new; why not, "" once done
export function editService(
  name: string,
  set: { port?: number; public?: boolean },
  remove: boolean,
  dry: boolean,
  host = SelfHost,
): [string, string] {
  const rel = relOf(host, name);
  const before = store.read<Rec>(rel);
  if (remove) {
    if (!before) return [`no service ${name}`, ""];
    if (!dry) {
      store.remove(rel);
      if (host === SelfHost) setRemoved(before.port, true);
    }
    return ["", `- ${lineOf(name, before)}`];
  }
  if (installed(name)) return [`${name} is an installed service, its page set in the service wizard`, ""];
  const port = set.port ?? before?.port;
  if (port === undefined) return [`${name} has no port`, ""];
  const why = recError(name, port);
  if (why) return [why, ""];
  const rec: Rec = { port };
  if (set.public ?? before?.public) rec.public = true;
  if (before && lineOf(name, before) === lineOf(name, rec)) return ["", ""];
  if (!dry) {
    store.write(rel, rec);
    if (host === SelfHost) setRemoved(port, false);
  }
  return ["", [...(before ? [`- ${lineOf(name, before)}`] : []), `+ ${lineOf(name, rec)}`].join("\n")];
}

// name's public set or dropped, on whichever host the record is
export function setPublic(host: string, name: string, on: boolean): [number, any] {
  const r = store.read<Rec>(relOf(host, name));
  if (!r) return [404, { error: `${host} declares no service called ${name}` }];
  if (!!r.public !== on) store.write(relOf(host, name), { port: r.port, ...(on ? { public: true } : {}) });
  return [200, { public: on }];
}

// a found page written in by its port alone; false when its name is taken
export function adoptOne(name: string, port: number): boolean {
  if (store.read(relOf(SelfHost, name)) !== undefined || installed(name)) return false;
  store.write(relOf(SelfHost, name), { port } satisfies Rec);
  return true;
}
