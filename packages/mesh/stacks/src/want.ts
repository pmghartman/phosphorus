// what the mesh wants: etc/stacks/<id>.json, an admin's install, update or removal,
// every host following; secret values sealed under the mesh's key
import { randomBytes } from "node:crypto";
import * as store from "@phosphorus/store";
import { B64URL, type Box, MeshKey, Open, Seal } from "@phosphorus/users";
import { markHot, now, obj } from "@phosphorus/util";
import type { AppDef, AppSummary, EnvField, Hook, PhosManifest, StackView, StackWant } from "@phosphorus/wire";
import { logf } from "./docker.ts";
import { idRe, wantRel } from "./ids.ts";
import { envNameRe } from "./render.ts";
import { seams } from "./seams.ts";

// a removal: etc/stacks/removed/<id>.json, whether its hosts keep the data
export const removedRel = (id: string) => `etc/stacks/removed/${id}.json`;

const sources = ["phosphorus", "casaos", "runtipi", "cosmos", "github"];
const hostRe = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const composeMax = 256 << 10;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const port = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 65536 ? v : 0);
// a page's other name, as a route's
const aliasRe = /^[a-z0-9][a-z0-9-]{0,62}$/;

function hooks(v: unknown): Hook[] {
  return arr(v).flatMap((h) => {
    const o = obj(h);
    const run = arr(o?.run).filter((x): x is string => typeof x === "string");
    return o && typeof o.service === "string" && run.length ? [{ service: o.service, run }] : [];
  });
}

// a def as JSON held it, or why it isn't one
export function defOf(v: unknown): AppDef | string {
  const o = obj(v);
  if (!o) return "no app";
  if (typeof o.id !== "string" || !idRe.test(o.id)) return "the app's id is [a-z][a-z0-9-], at most 40";
  if (!sources.includes(str(o.source))) return `the app's source is ${sources.join(", ")}`;
  if (!str(o.ref)) return "the app has no ref";
  const compose = str(o.compose);
  if (!compose.trim()) return "the app has no compose file";
  if (compose.length > composeMax) return "the compose file is over 256K";
  const env: EnvField[] = [];
  for (const f of arr(o.env)) {
    const e = obj(f);
    if (!e || !envNameRe.test(str(e.name))) return `an env field's name isn't a variable: ${str(e?.name)}`;
    const field: EnvField = { name: e.name, label: str(e.label) || e.name };
    if (typeof e.default === "string") field.default = e.default;
    if (e.secret === true) field.secret = true;
    if (e.required === true) field.required = true;
    const opts = arr(e.options).filter((x): x is string => typeof x === "string");
    if (opts.length) field.options = opts;
    env.push(field);
  }
  const m = obj(o.manifest) ?? {};
  const manifest: PhosManifest = {
    volumes: arr(m.volumes).flatMap((x) => {
      const v = obj(x);
      return v && typeof v.service === "string" && typeof v.target === "string"
        ? [{ service: v.service, target: v.target, kind: v.kind === "cache" ? ("cache" as const) : ("data" as const) }]
        : [];
    }),
  };
  const b = obj(m.backup);
  if (b) manifest.backup = { pre: hooks(b.pre), post: hooks(b.post) };
  const h = obj(m.health);
  if (h && typeof h.service === "string") {
    manifest.health = { service: h.service };
    if (typeof h.path === "string") manifest.health.path = h.path;
    if (port(h.port)) manifest.health.port = port(h.port);
  }
  const w = obj(m.web);
  if (w) {
    if (typeof w.service !== "string" || !port(w.port)) return "the web page needs a service and a port";
    manifest.web = { service: w.service, port: port(w.port) };
  }
  const al = arr(m.aliases).filter((x): x is string => typeof x === "string" && aliasRe.test(x));
  if (al.length) manifest.aliases = al;
  if (typeof m.preferredHost === "string") manifest.preferredHost = m.preferredHost;
  return {
    id: o.id,
    source: o.source,
    ref: o.ref,
    name: str(o.name) || o.id,
    tagline: str(o.tagline),
    description: str(o.description),
    icon: str(o.icon),
    category: str(o.category),
    repo: str(o.repo),
    licence: str(o.licence),
    archs: arr(o.archs).filter((x): x is string => typeof x === "string"),
    compose,
    env,
    manifest,
  };
}

// --- sealed values ------------------------------------------------------------

const sealedPre = "sealed:";

export const seal = (v: string) =>
  sealedPre + Buffer.from(JSON.stringify(Seal(MeshKey(), v)), "utf8").toString("base64url");

// a value opened, the value itself when it isn't sealed; undefined when it won't open
export function unseal(v: string): string | undefined {
  if (!v.startsWith(sealedPre)) return v;
  const raw = B64URL(v.slice(sealedPre.length));
  if (!raw) return;
  try {
    return Open(MeshKey(), JSON.parse(Buffer.from(raw).toString("utf8")) as Box);
  } catch {
    return;
  }
}

// a want's env opened for its .env; the names that wouldn't open
export function opened(w: StackWant): [Record<string, string>, string[]] {
  const out: Record<string, string> = {};
  const bad: string[] = [];
  for (const [k, v] of Object.entries(w.env)) {
    const o = unseal(v);
    if (o === undefined) bad.push(k);
    else out[k] = o;
  }
  return [out, bad];
}

// the env a def asks for: given values, then the kept ones, then defaults; a secret
// left blank generated; secrets sealed. [env, the required ones still missing, why not]
export function fillEnv(
  def: AppDef,
  given: Record<string, unknown>,
  kept: Record<string, string> = {},
): [Record<string, string>, string[], string] {
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const f of def.env) {
    const g = given[f.name];
    if (g !== undefined && typeof g !== "string") return [{}, [], `${f.name} isn't text`];
    if (typeof g === "string" && g !== "") {
      if (f.options && !f.options.includes(g)) return [{}, [], `${f.name} is one of ${f.options.join(", ")}`];
      if (/[\0]/.test(g)) return [{}, [], `${f.name} has a NUL`];
      env[f.name] = f.secret ? seal(g) : g;
      continue;
    }
    if (f.name in kept) {
      env[f.name] = kept[f.name]!;
      continue;
    }
    if (f.default) env[f.name] = f.default;
    else if (f.secret) env[f.name] = seal(randomBytes(18).toString("base64url"));
    else if (f.required) missing.push(f.name);
    else env[f.name] = "";
  }
  return [env, missing, ""];
}

// --- the wants ------------------------------------------------------------------

export function wantOf(id: string): StackWant | undefined {
  if (!idRe.test(id)) return;
  const o = obj(store.read(wantRel(id)));
  if (!o) return;
  const def = defOf(o.def);
  if (typeof def === "string" || def.id !== id) return;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(o.env) ?? {})) if (typeof v === "string") env[k] = v;
  const w: StackWant = {
    def,
    env,
    active: str(o.active),
    standbys: arr(o.standbys).filter((x): x is string => typeof x === "string"),
    gen: typeof o.gen === "number" ? o.gen : 0,
    by: str(o.by),
    at: typeof o.at === "number" ? o.at : 0,
  };
  if (o.public === true) w.public = true;
  return w;
}

// every stack the mesh wants, by id
export function ids(): string[] {
  return store
    .list("etc/stacks")
    .filter((f) => !f.includes("/") && f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .filter((id) => idRe.test(id))
    .sort();
}

// a removal's wish for the data: kept unless the admin said otherwise
export const keepDataOf = (id: string) => obj(store.read(removedRel(id)))?.keepData !== false;

export function summaryOf(def: AppDef): AppSummary {
  const { id, source, ref, name, tagline, icon, category, licence } = def;
  return { id, source, ref, name, tagline, icon, category, licence, installed: true };
}

export function viewOf(w: StackWant): StackView {
  const { def, env: _, ...rest } = w;
  const v: StackView = { ...rest, summary: summaryOf(def) };
  if (def.manifest.web) v.web = def.manifest.web;
  const values: Record<string, string> = {};
  for (const f of def.env) if (!f.secret) values[f.name] = w.env[f.name] ?? "";
  if (Object.keys(values).length) v.values = values;
  return v;
}

// State.stacks
export function views(): Record<string, StackView> {
  const out: Record<string, StackView> = {};
  for (const id of ids()) {
    const w = wantOf(id);
    if (w) out[id] = viewOf(w);
  }
  return out;
}

// the active host and standbys asked, or why they won't do
function placement(p: Record<string, any>): [string, string[], string] {
  const active = str(p.active);
  const known = seams.hosts();
  if (!hostRe.test(active)) return ["", [], "pick a host"];
  if (!known.includes(active)) return ["", [], `${active} isn't a phosphorus host`];
  const standbys: string[] = [];
  for (const h of arr(p.standbys)) {
    if (typeof h !== "string" || !known.includes(h)) return ["", [], `${String(h)} isn't a phosphorus host`];
    if (h === active) return ["", [], `${h} is already the app's host`];
    if (!standbys.includes(h)) standbys.push(h);
  }
  return [active, standbys, ""];
}

// the app asked for, from its source; the body's own def where tests allow it
async function resolve(p: Record<string, any>): Promise<AppDef | string> {
  const source = str(p.source);
  const ref = str(p.ref);
  if (seams.defInBody && p.def !== undefined) {
    const d = defOf(p.def);
    if (typeof d !== "string" && (d.source !== source || d.ref !== ref)) return "the def isn't the one asked for";
    return d;
  }
  if (!sources.includes(source) || !ref) return "pick an app: a source and its ref";
  if (!seams.defOf) return "the catalogue isn't on this host yet";
  const d = await seams.defOf(source, ref);
  return d ? defOf(d) : `no app ${ref} in ${source}`;
}

function write(w: StackWant) {
  store.write(wantRel(w.def.id), w);
  markHot();
  seams.kick();
}

// an admin's install: the app's want written with gen 1, every host following; [status, body]
export async function Install(p: Record<string, any>, by: string): Promise<[number, any]> {
  const def = await resolve(p);
  if (typeof def === "string") return [/^no app/.test(def) ? 404 : 400, { error: def }];
  if (wantOf(def.id)) return [409, { error: `${def.name} is already installed; update it instead` }];
  const [active, standbys, why] = placement(p);
  if (why) return [400, { error: why }];
  const [env, missing, bad] = fillEnv(def, obj(p.env) ?? {});
  if (bad) return [400, { error: bad }];
  if (missing.length) return [400, { error: `${missing.join(", ")} wanted`, missing }];
  const w: StackWant = { def, env, active, standbys, gen: 1, by, at: now() };
  store.remove(removedRel(def.id));
  write(w);
  logf("%s installed on %s for %s%s", def.id, active, by, standbys.length ? `, standbys ${standbys.join(", ")}` : "");
  return [200, { ok: true, want: viewOf(w) }];
}

// an update: the def again from its source when it has one, new fields filled and
// the values given taken, the gen bumped so every copy pulls and comes up again
export async function Update(id: string, by: string, given: Record<string, unknown> = {}): Promise<[number, any]> {
  const w = wantOf(id);
  if (!w) return [404, { error: `no stack called ${id}` }];
  let def = w.def;
  if (seams.defOf) {
    const d = await seams.defOf(def.source, def.ref).catch(() => undefined);
    const fresh = d && defOf(d);
    if (fresh && typeof fresh !== "string" && fresh.id === id) def = fresh;
  }
  const [env, missing, bad] = fillEnv(def, given, w.env);
  if (bad) return [400, { error: bad }];
  if (missing.length) return [400, { error: `${missing.join(", ")} wanted`, missing }];
  const next: StackWant = { ...w, def, env, gen: w.gen + 1, by, at: now() };
  write(next);
  logf("%s updated to gen %d for %s", id, next.gen, by);
  return [200, { ok: true, want: viewOf(next) }];
}

// the app off every host, its data kept unless keepData is false
export function Remove(id: string, keepData: boolean, by: string): [number, any] {
  const w = wantOf(id);
  if (!w) return [404, { error: `no stack called ${id}` }];
  store.write(removedRel(id), { keepData, gen: w.gen, by, at: now() });
  store.remove(wantRel(id));
  markHot();
  seams.kick();
  logf("%s removed for %s, data %s", id, by, keepData ? "kept" : "deleted");
  return [200, { ok: true }];
}

// open to all or behind the phosphorus login, kept in the want so every host that serves it
// publishes it so; no gen bumped, nothing restarted
export function SetPublic(id: string, on: boolean, by: string): [number, any] {
  const w = wantOf(id);
  if (!w) return [404, { error: `no stack called ${id}` }];
  if (!!w.public === on) return [200, { ok: true, public: on }];
  const { public: _, ...rest } = w;
  write({ ...rest, ...(on ? { public: true } : {}), by, at: now() });
  logf("%s made %s for %s", id, on ? "public" : "private", by);
  return [200, { ok: true, public: on }];
}

// Docker asked of a host: etc/stacks/docker/<host>.json, that host installing it
export const dockerRel = (host: string) => `etc/stacks/docker/${host}.json`;

export function AskDocker(host: string, by: string): [number, any] {
  if (!hostRe.test(host) || !seams.hosts().includes(host)) return [400, { error: `${host} isn't a phosphorus host` }];
  store.write(dockerRel(host), { by, at: now() });
  markHot();
  seams.kick();
  return [200, { ok: true }];
}
