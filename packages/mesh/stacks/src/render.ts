// a stack's project as one host writes it: the compose file with every data volume
// a bind mount under data/ (cache under cache/), phosphorus's variables filled in,
// host ports only on the web service and bound to the tailnet address; the .env beside it
import { type AppDef, fromRepo, profileOn } from "@phosphorus/wire";

// what the host puts into the render
export type Ctx = {
  // the project folder, <phosphorus>/stacks/<id>
  dir: string;
  // this host's tailnet address: every published port is bound to it
  ip: string;
  puid: string;
  pgid: string;
  tz: string;
  // the mesh's domain, "" without one
  domain: string;
};

export type Rendered = {
  compose: string;
  // the web service's port on the host, 0 when it has none
  webPort: number;
  // the folders its binds want made first
  dirs: string[];
  // services built from the repo: cloned into src/ first, pull skipping them
  build: boolean;
  // the repo wanted in src/: built from, or a relative bind into it
  clone: boolean;
};

// the variables phosphorus fills in itself
export const Ours = ["APP_DATA", "PUID", "PGID", "TZ", "APP_URL", "APP_DOMAIN"] as const;

export const envNameRe = /^[A-Za-z_][A-Za-z0-9_]*$/;

// $NAME, ${NAME}, ${NAME:-x}, ${NAME-x}, ${NAME:?x} filled from vars as compose
// would; names not in vars, and $$, left for compose, or taken as unset when all
export function interp(s: string, vars: Record<string, string>, all = false): string {
  return s.replace(
    /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (m, braced?: string, op?: string, alt?: string, bare?: string) => {
      const name = braced ?? bare;
      if (!name || (!all && !(name in vars))) return m;
      if (!(name in vars)) return op === ":-" || op === "-" ? (alt ?? "") : "";
      const v = vars[name]!;
      if (op === ":-" && !v) return alt ?? "";
      if (op === ":+") return v ? (alt ?? "") : "";
      if (op === "+") return alt ?? "";
      return v;
    },
  );
}

// every string in a parsed document filled from vars
function fill(v: unknown, vars: Record<string, string>, all = false): unknown {
  if (typeof v === "string") return interp(v, vars, all);
  if (Array.isArray(v)) return v.map((x) => fill(x, vars, all));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars, all)]));
  return v;
}

type Doc = Record<string, any>;

// a compose port as host ip, host port(s), container port(s) and protocol
type Port = { published: string; target: string; protocol: string };

export function parsePort(p: unknown): Port | undefined {
  if (typeof p === "number") return { published: "", target: String(p), protocol: "" };
  if (p && typeof p === "object") {
    const o = p as Doc;
    if (o.target === undefined) return;
    return {
      published: o.published === undefined ? "" : String(o.published),
      target: String(o.target),
      protocol: typeof o.protocol === "string" ? o.protocol : "",
    };
  }
  if (typeof p !== "string") return;
  let s = p.trim();
  let protocol = "";
  const slash = s.lastIndexOf("/");
  if (slash >= 0) {
    protocol = s.slice(slash + 1);
    s = s.slice(0, slash);
  }
  // [::1]:80:80, 1.2.3.4:80:80, 80:80, 80
  s = s.replace(/^\[[^\]]*\]:/, "");
  const parts = s.split(":");
  if (parts.length > 3) return;
  const target = parts.at(-1)!;
  const published = parts.length >= 2 ? parts.at(-2)! : "";
  return { published, target, protocol };
}

const first = (range: string) => Number(range.split("-")[0]);

// a path relative to the project made safe: no way up out of it
const inside = (rel: string) =>
  rel
    .replaceAll("\\", "/")
    .split("/")
    .filter((x) => x && x !== "." && x !== "..")
    .join("/");

const slug = (target: string) => inside(target).replaceAll("/", "-") || "root";

// the project rendered: def's compose for this host, env its opened values
export function render(def: AppDef, env: Record<string, string>, ctx: Ctx): Rendered {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(def.compose);
  } catch (e) {
    throw new Error(`the compose file doesn't parse: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the compose file isn't a mapping");
  const services = (raw as Doc).services;
  if (!services || typeof services !== "object" || !Object.keys(services).length)
    throw new Error("the compose file has no services");
  const web = def.manifest.web;
  if (web && !(web.service in services)) throw new Error(`no service ${web.service} for the web page`);

  // the web port first: APP_URL names it
  const all: Record<string, string> = { ...env };
  const data = `${ctx.dir}/data`;
  const base = { APP_DATA: data, PUID: ctx.puid, PGID: ctx.pgid, TZ: ctx.tz };
  let webPort = 0;
  if (web) {
    const svc = services[web.service] as Doc;
    for (const p of Array.isArray(svc?.ports) ? svc.ports : []) {
      const pp = parsePort(fill(p, { ...all, ...base }, true));
      if (pp && first(pp.target) === web.port) webPort = first(pp.published) || web.port;
    }
    if (!webPort) webPort = web.port;
  }
  const appDomain = ctx.domain ? `${def.id}.${ctx.domain}` : "";
  const vars: Record<string, string> = {
    ...base,
    APP_DOMAIN: appDomain,
    APP_URL: appDomain ? `https://${appDomain}` : webPort ? `http://${ctx.ip}:${webPort}` : "",
  };

  const doc = fill(raw, vars) as Doc;
  const top = (doc.volumes && typeof doc.volumes === "object" ? doc.volumes : {}) as Doc;
  // a service whose profiles aren't picked left out (a copy already up then an orphan its up
  // removes), the rest shed their profiles; what's left out no longer depended on, its volumes undeclared
  const dropped = new Set<string>();
  const droppedVols = new Set<string>();
  for (const [name, s] of Object.entries(doc.services as Doc)) {
    if (!s || typeof s !== "object") continue;
    const svc = s as Doc;
    if (profileOn(svc.profiles, all.COMPOSE_PROFILES ?? "")) {
      delete svc.profiles;
      continue;
    }
    dropped.add(name);
    for (const v of Array.isArray(svc.volumes) ? svc.volumes : [])
      droppedVols.add(typeof v === "string" ? v.split(":")[0]! : String((v as Doc)?.source ?? ""));
    delete (doc.services as Doc)[name];
  }
  if (!Object.keys(doc.services as Doc).length) throw new Error("no service runs with the profiles picked");
  for (const s of Object.values(doc.services as Doc)) {
    const svc = s as Doc;
    if (Array.isArray(svc?.depends_on)) svc.depends_on = svc.depends_on.filter((d: unknown) => !dropped.has(String(d)));
    else if (svc?.depends_on && typeof svc.depends_on === "object")
      for (const d of Object.keys(svc.depends_on)) if (dropped.has(d)) delete svc.depends_on[d];
  }
  const kindOf = (service: string, target: string) =>
    def.manifest.volumes.find(
      (v) => v.service === service && v.target.replace(/\/+$/, "") === target.replace(/\/+$/, ""),
    )?.kind;
  const github = fromRepo(def);
  const dirs = new Set<string>();
  const used = new Set<string>();
  let build = false;
  let clone = false;

  // a volume's host side: [source, long-syntax type] as rewritten, or undefined to keep it
  const rewrite = (service: string, source: string, target: string): string | undefined => {
    const kind = kindOf(service, target);
    const under = (k: "data" | "cache" | undefined, rel: string) => {
      const p = `${ctx.dir}/${k === "cache" ? "cache" : "data"}/${rel}`;
      dirs.add(p);
      return p;
    };
    // an anonymous volume: a bind only when the manifest counts it
    if (!source) return kind ? under(kind, `${service}-${slug(target)}`) : undefined;
    if (source.startsWith("/") || source.startsWith("~")) {
      if (source === data || source.startsWith(data + "/")) dirs.add(source);
      return;
    }
    if (source.startsWith(".")) {
      // a repo's own file, from its clone, unless the manifest says it's data
      if (github && !kind) {
        clone = true;
        return `${ctx.dir}/src/${inside(source)}`;
      }
      return under(kind, inside(source));
    }
    // a named volume, unless the mesh doesn't own it
    const decl = top[source] as Doc | null | undefined;
    if (decl && typeof decl === "object" && decl.external) return;
    used.add(source);
    return under(kind, inside(source));
  };

  // a volume's source as compose will read it: the person's values, a default naming ${APP_DATA} filled too
  const paths = { ...Object.fromEntries(Object.entries(all).map(([k, x]) => [k, interp(x, vars)])), ...vars };
  for (const [name, s] of Object.entries(doc.services as Doc)) {
    if (!s || typeof s !== "object") continue;
    const svc = s as Doc;
    if (Array.isArray(svc.volumes))
      svc.volumes = svc.volumes.map((v: unknown) => {
        if (typeof v === "string") {
          const filled = interp(v, paths, true);
          const parts = filled.split(":");
          const [source, target, mode] =
            parts.length === 1 ? ["", parts[0]!, ""] : [parts[0]!, parts[1]!, parts[2] ?? ""];
          const to = rewrite(name, source, target);
          return to === undefined ? filled : `${to}:${target}${mode ? ":" + mode : ""}`;
        }
        const o = v as Doc;
        if (!o || typeof o !== "object" || typeof o.target !== "string") return v;
        if (o.type && o.type !== "volume" && o.type !== "bind") return v;
        const source = typeof o.source === "string" ? interp(o.source, paths, true) : "";
        const to = rewrite(name, source, o.target);
        if (to === undefined) return source ? { ...o, source } : v;
        const { volume: _, ...rest } = o;
        return { ...rest, type: "bind", source: to, bind: { ...(o.bind ?? {}), create_host_path: true } };
      });
    if (name === web?.service && svc.network_mode !== "host") {
      const ports: string[] = [];
      for (const p of Array.isArray(svc.ports) ? svc.ports : []) {
        const pp = parsePort(fill(p, all, true));
        if (!pp) continue;
        const pub = pp.published || pp.target;
        ports.push(`${ctx.ip}:${pub}:${pp.target}${pp.protocol ? "/" + pp.protocol : ""}`);
      }
      if (!ports.some((p) => first(p.split(":")[2]!) === web.port)) ports.push(`${ctx.ip}:${webPort}:${web.port}`);
      svc.ports = ports;
    } else delete svc.ports;
    if (svc.build !== undefined) {
      build = true;
      if (github) {
        clone = true;
        const ctxOf = (c: unknown) =>
          typeof c === "string" && !/^[a-z]+:\/\//i.test(c) && !c.startsWith("/") ? `${ctx.dir}/src/${inside(c)}` : c;
        svc.build =
          typeof svc.build === "string"
            ? ctxOf(svc.build)
            : { ...svc.build, context: ctxOf((svc.build as Doc).context ?? ".") };
      }
    }
  }
  for (const n of used) delete top[n];
  for (const n of droppedVols) if (n in top && !(top[n] as Doc | null)?.external) delete top[n];
  if (doc.volumes && !Object.keys(top).length) delete doc.volumes;
  doc.name = `phos-${def.id}`;
  const { name, ...rest } = doc;
  return {
    compose: Bun.YAML.stringify({ name, ...rest }, null, 2) + "\n",
    webPort,
    dirs: [...dirs].sort(),
    build,
    clone,
  };
}

// a value as .env holds it for compose: single quotes when it can, else double
// with \, " and $ escaped
export function quote(v: string): string {
  if (!/['\n\r]/.test(v)) return `'${v}'`;
  return `"${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("\n", "\\n").replaceAll("\r", "\\r")}"`;
}

// the .env: phosphorus's variables, then the app's values, opened
export function envText(def: AppDef, env: Record<string, string>, ctx: Ctx, webPort: number): string {
  const appDomain = ctx.domain ? `${def.id}.${ctx.domain}` : "";
  const ours: Record<string, string> = {
    APP_DATA: `${ctx.dir}/data`,
    PUID: ctx.puid,
    PGID: ctx.pgid,
    TZ: ctx.tz,
    APP_DOMAIN: appDomain,
    APP_URL: appDomain ? `https://${appDomain}` : webPort ? `http://${ctx.ip}:${webPort}` : "",
  };
  const lines = ["# written by phosphorus: changes are overwritten"];
  for (const [k, v] of Object.entries(ours)) lines.push(`${k}=${quote(v)}`);
  for (const [k, v] of Object.entries(env)) if (envNameRe.test(k) && !(k in ours)) lines.push(`${k}=${quote(v)}`);
  return lines.join("\n") + "\n";
}
