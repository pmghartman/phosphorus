// a compose file read and written, and the few things asked of it: its services'
// ports, volumes, images and the variables it leaves to the .env

export type Service = Record<string, any>;
export type Compose = Record<string, any> & { services: Record<string, Service> };

// the variables phosphorus fills itself (packages/stacks render); every other is an env field
export const phosVars = ["APP_DATA", "APP_REPO", "PUID", "PGID", "TZ", "APP_URL", "APP_DOMAIN"];

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

// text as a compose file, or why not
export function parse(text: string): Compose {
  let v: unknown;
  try {
    v = text.trimStart().startsWith("{") ? JSON.parse(text) : Bun.YAML.parse(text);
  } catch (e) {
    throw new Error(`compose file doesn't parse: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
  }
  if (Array.isArray(v)) v = v[0];
  if (!isObj(v) || !isObj(v.services) || !Object.keys(v.services).length)
    throw new Error("compose file has no services");
  for (const [k, s] of Object.entries(v.services)) if (!isObj(s)) throw new Error(`service ${k} isn't a mapping`);
  return v as Compose;
}

export const dump = (c: Compose) => Bun.YAML.stringify(c, null, 2);

// ${X}, ${X:-d}, ${X-d}, ${X:?e}, ${X?e} and $X, $$ left alone
const varRe = /\$(?:\$|\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])((?:[^{}]|\{[^{}]*\})*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g;

export interface VarUse {
  default?: string;
  required: boolean;
}

// the variables text leaves to the .env, with their defaults
export function vars(text: string): Map<string, VarUse> {
  const out = new Map<string, VarUse>();
  for (const m of text.matchAll(varRe)) {
    const name = m[1] ?? m[4];
    if (!name) continue;
    const op = m[2];
    const cur = out.get(name) ?? { required: true };
    if (op === ":-" || op === "-") {
      cur.required = false;
      cur.default ??= m[3];
    } else if (op === "+" || op === ":+") cur.required = false;
    out.set(name, cur);
  }
  return out;
}

// text with each variable from values put in, defaults where it has none; the
// rest left. only: just the variables values names, the others' defaults kept
export function interpolate(text: string, values: Record<string, string>, only = false): string {
  return text.replace(varRe, (all, braced, op, arg, bare) => {
    const name = braced ?? bare;
    if (!name) return all;
    const v = values[name];
    if (only && v === undefined) return all;
    if (op === ":+" || op === "+") return v ? interpolate(arg ?? "", values, only) : "";
    if (v !== undefined && (v !== "" || !op?.startsWith(":"))) return v;
    if (op === ":-" || op === "-") return interpolate(arg ?? "", values, only);
    return all;
  });
}

// text with each variable renamed by to, others left: $X and ${X...} alike
export function rename(text: string, to: Record<string, string>): string {
  return text.replace(varRe, (all, braced, op, arg, bare) => {
    const name = braced ?? bare;
    const n = name && to[name];
    if (!n) return all;
    return op ? `\${${n}${op}${arg ?? ""}}` : `\${${n}}`;
  });
}

export interface Port {
  host?: number;
  container: number;
  udp?: boolean;
}

// a service's published ports; ranges and unresolved ones skipped
export function ports(s: Service): Port[] {
  const out: Port[] = [];
  for (const p of Array.isArray(s.ports) ? s.ports : []) {
    if (isObj(p)) {
      const container = Number(p.target);
      const host = p.published === undefined ? undefined : Number(p.published);
      if (Number.isInteger(container) && (host === undefined || Number.isInteger(host)))
        out.push({ container, host, udp: p.protocol === "udp" || undefined });
      continue;
    }
    const [spec, proto] = String(p).split("/");
    // "[ip:]host:container" or "container"; an ipv6 ip in brackets
    const parts = spec!.replace(/^\[[^\]]*\]:/, "").split(":");
    const container = Number(parts.at(-1));
    const host = parts.length > 1 ? Number(parts.at(-2)) : undefined;
    if (Number.isInteger(container) && (host === undefined || Number.isInteger(host)))
      out.push({ container, host, udp: proto === "udp" || undefined });
  }
  return out;
}

export interface Mount {
  type: "bind" | "volume";
  source: string;
  target: string;
}

const looksPath = (s: string) => /^([./~]|\$\{?[A-Za-z_])/.test(s);

// a service's mounts, short and long forms alike; anonymous volumes skipped
export function mounts(s: Service): Mount[] {
  const out: Mount[] = [];
  for (const v of Array.isArray(s.volumes) ? s.volumes : []) {
    if (isObj(v)) {
      if (typeof v.target !== "string" || typeof v.source !== "string" || !v.source) continue;
      out.push({ type: v.type === "bind" ? "bind" : "volume", source: v.source, target: v.target });
      continue;
    }
    const parts = String(v).split(":");
    if (parts.length < 2) continue;
    const [source, target] = parts as [string, string];
    out.push({ type: looksPath(source) ? "bind" : "volume", source, target });
  }
  return out;
}

// a service's environment as a map, list form or not
export function environment(s: Service): Record<string, string> {
  const e = s.environment;
  if (Array.isArray(e))
    return Object.fromEntries(
      e.map((x) => {
        const t = String(x);
        const i = t.indexOf("=");
        return i < 0 ? [t, ""] : [t.slice(0, i), t.slice(i + 1)];
      }),
    );
  if (isObj(e)) return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, v == null ? "" : String(v)]));
  return {};
}

// the web service and its container port: the one named, else the first service
// publishing a port that looks like a page
const webPorts = [80, 8080, 3000, 8000, 8096, 5000, 8888, 9000, 443, 8443];
export function guessWeb(c: Compose): { service: string; port: number } | undefined {
  let first: { service: string; port: number } | undefined;
  for (const [name, s] of Object.entries(c.services)) {
    for (const p of ports(s)) {
      if (p.udp) continue;
      if (webPorts.includes(p.container)) return { service: name, port: p.container };
      first ??= { service: name, port: p.container };
    }
    for (const x of Array.isArray(s.expose) ? s.expose : []) {
      const n = Number(String(x).split("/")[0]);
      if (webPorts.includes(n)) first ??= { service: name, port: n };
    }
  }
  return first;
}
