// Cosmos servapps (AGPL-3.0, fetched on the host, never vendored): servapps/<Name>/
// description.json and cosmos-compose.json, a compose file in Whiskers templating.
// Its placeholders become variables, its conditionals are settled on the form's
// defaults, and what has no counterpart here skips the app with the reason
import type { EnvField } from "@phosphorus/wire";
import { type Compose, parse } from "../compose.ts";
import { type Adapter, declareVolumes, dropLabels, finish, Skip, slug } from "./common.ts";

// "moviePath" -> "MOVIE_PATH"
const envName = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase();

type Ctx = Record<string, string | boolean | undefined>;

// the template with its fixed placeholders put in
function fixed(t: string, id: string): string {
  return t
    .replace(/\{(?:Static)?ServiceName\}/g, id)
    .replace(/\{Hostnames\.[^{}\s"]*\}/g, "${APP_DOMAIN}")
    .replace(/\{Passwords\.\[?(\d+)\]?\}/g, "${PASSWORD_$1}")
    .replace(/\{DefaultDataPath\}/g, "${APP_DATA}")
    .replace(/\{RootProtocol\}/g, "https");
}

const ifRe = /\{if (not )?([\w.-]+)\}((?:(?!\{if )[\s\S])*?)\{\/if\}/;

// the conditionals settled, innermost first, by truth
function settle(t: string, truth: (name: string) => boolean): string {
  for (let m = ifRe.exec(t); m; m = ifRe.exec(t)) {
    const [then, other = ""] = m[3]!.split("{else}");
    const on = truth(m[2]!) !== !!m[1];
    t = t.slice(0, m.index) + (on ? then : other) + t.slice(m.index + m[0].length);
  }
  return t;
}

const ctxName = (cond: string) => {
  if (!cond.startsWith("Context.")) throw new Skip(`a condition on ${cond}`);
  return cond.slice(8);
};

export const cosmos: Adapter = {
  id: "cosmos",
  name: "Cosmos servapps",
  repo: "azukaar/cosmos-servapps-official",
  licence: "AGPL-3.0",
  split: (p) => {
    const m = /^servapps\/([^/]+)\/(.+)$/.exec(p);
    return m ? [m[1]!, m[2]!] : undefined;
  },
  wants: (rel) => rel === "description.json" || rel === "cosmos-compose.json" || rel === "docker-compose.yml",
  adapt(ref, files) {
    let desc: Record<string, any>;
    try {
      desc = JSON.parse(files["description.json"] ?? "");
    } catch {
      throw new Skip("no readable description.json");
    }
    const tpl = files["cosmos-compose.json"] ?? files["docker-compose.yml"];
    if (!tpl) throw new Skip("no cosmos-compose.json");
    const id = slug(String(desc.name || ref));
    const base = fixed(tpl, id);
    // the form first, its fields under conditions too, its defaults the context
    // the conditionals are settled on
    let form: Record<string, any>[] = [];
    for (const guess of [true, false]) {
      try {
        const t = settle(base, () => guess).replace(/\{Context\.[\w-]+\}/g, "");
        const v = parse(t);
        form = v["cosmos-installer"]?.form ?? [];
        break;
      } catch {}
    }
    const ctx: Ctx = {};
    const kinds: Record<string, string> = {};
    const labels: Record<string, string> = {};
    for (const f of Array.isArray(form) ? form : []) {
      if (!f || typeof f.name !== "string") continue;
      kinds[f.name] = String(f.type);
      labels[f.name] = String(f.label ?? f.name);
      if (f.type === "checkbox") ctx[f.name] = f.initialValue === true || f.initialValue === "true";
      else if (f.type === "text" || f.type === "password")
        ctx[f.name] = typeof f.initialValue === "string" ? f.initialValue : undefined;
    }
    let t = settle(base, (c) => !!ctx[ctxName(c)]);
    const env: EnvField[] = [];
    t = t.replace(/\{Context\.([\w-]+)\}/g, (_, n: string) => {
      const kind = kinds[n];
      if (kind === "checkbox") return String(!!ctx[n]);
      if (kind !== "text" && kind !== "password") throw new Skip(`{Context.${n}} has no counterpart here`);
      const name = envName(n);
      const def = ctx[n] as string | undefined;
      if (!env.some((f) => f.name === name)) {
        const f: EnvField = { name, label: labels[n]! };
        if (def) f.default = def;
        else f.required = true;
        env.push(f);
      }
      return def ? `\${${name}:-${def}}` : `\${${name}}`;
    });
    const left = /(?<!\$)\{[A-Za-z][\w.[\]-]*\}/.exec(t);
    if (left) throw new Skip(`${left[0]} has no counterpart here`);
    for (const m of t.matchAll(/\$\{PASSWORD_(\d+)\}/g))
      if (!env.some((f) => f.name === `PASSWORD_${m[1]}`))
        env.push({ name: `PASSWORD_${m[1]}`, label: `Password ${Number(m[1]) + 1}`, secret: true });
    let c: Compose;
    try {
      c = parse(t);
    } catch (e) {
      throw new Skip(e instanceof Error ? e.message : String(e));
    }
    delete c["cosmos-installer"];
    delete c.minVersion;
    let icon = "";
    let web: { service: string; port: number } | undefined;
    for (const [n, s] of Object.entries(c.services)) {
      const lb = s.labels && !Array.isArray(s.labels) ? s.labels : {};
      if (!icon && typeof lb["cosmos-icon"] === "string") icon = lb["cosmos-icon"];
      for (const r of Array.isArray(s.routes) ? s.routes : []) {
        const m = /^https?:\/\/([^:/]+):(\d+)/.exec(String(r?.target ?? ""));
        if (m && !web) web = { service: c.services[m[1]!] ? m[1]! : n, port: Number(m[2]) };
      }
      for (const k of ["routes", "UID", "GID", "uid", "gid", "post_install", "post-install"]) delete s[k];
      dropLabels(s, /^cosmos-/);
    }
    declareVolumes(c);
    const tagline = String(desc.description ?? "");
    return finish(c, {
      source: "cosmos",
      ref,
      id,
      name: String(desc.name || ref),
      tagline: /^[^.!?]*[.!?]?/.exec(tagline)?.[0] ?? tagline,
      description: String(desc.longDescription || desc.description || ""),
      icon: icon || `https://azukaar.github.io/cosmos-servapps-official/servapps/${ref}/icon.png`,
      category: Array.isArray(desc.tags) ? String(desc.tags[0] ?? "") : "",
      repo: String(desc.repository || desc.url || ""),
      licence: cosmos.licence,
      archs: desc.supported_architectures,
      env,
      web,
    });
  },
};
