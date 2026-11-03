// CasaOS AppStore (Apache-2.0): Apps/<Name>/docker-compose.yml, its x-casaos
// blocks the store's own; /DATA/AppData/$AppID becomes the app's data
import { parse, ports } from "../compose.ts";
import { type Adapter, finish, mapStrings, Skip, slug } from "./common.ts";

// a localized text's English, else its first
function en(v: unknown): string {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object") return "";
  const m = v as Record<string, unknown>;
  const k =
    Object.keys(m).find((k) => /^en[_-]us$/i.test(k)) ??
    Object.keys(m).find((k) => /^en([_-]|$)/i.test(k)) ??
    Object.keys(m).find((k) => k !== "custom" && m[k]);
  return k ? String(m[k] ?? "").trim() : "";
}

// a shared folder of the CasaOS box (/DATA/Media) as a field, the app's data by default
const sharedVar = (dir: string) => `${dir.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_DIR`;

export const casaos: Adapter = {
  id: "casaos",
  name: "CasaOS AppStore",
  repo: "IceWhaleTech/CasaOS-AppStore",
  licence: "Apache-2.0",
  split: (p) => {
    const m = /^Apps\/([^/]+)\/(.+)$/.exec(p);
    return m ? [m[1]!, m[2]!] : undefined;
  },
  wants: (rel) => rel === "docker-compose.yml",
  adapt(ref, files) {
    const text = files["docker-compose.yml"];
    if (!text) throw new Skip("no docker-compose.yml");
    const c = parse(text);
    const x = c["x-casaos"];
    if (!x || typeof x !== "object") throw new Skip("no x-casaos block");
    const id = slug(typeof c.name === "string" ? c.name : ref);
    const name = en(x.title) || ref;
    delete c["x-casaos"];
    delete c.name;
    for (const s of Object.values(c.services)) delete s["x-casaos"];
    const app = /^\/DATA\/AppData\/(?:\$AppID|\$\{AppID\}|[^/$]+)(?=\/|$)/;
    const shared = /^\/DATA\/([^/$]+)/;
    const mapped = mapStrings(c, (s) => {
      // short volume syntax: the source before its colon
      const i = s.startsWith("/DATA/") ? s.indexOf(":") : -1;
      let src = i < 0 ? s : s.slice(0, i);
      const rest = i < 0 ? "" : s.slice(i);
      if (app.test(src)) src = src.replace(app, "${APP_DATA}");
      else src = src.replace(shared, (_, d: string) => `\${${sharedVar(d)}:-\${APP_DATA}/${d}}`);
      return (src + rest).replace(/\$\{?AppID\}?/g, id).replace(/\$(PUID|PGID|TZ)\b/g, "${$1}");
    });
    // the main service, and the container port behind its port_map
    const main = typeof x.main === "string" && mapped.services[x.main] ? x.main : Object.keys(mapped.services)[0]!;
    const pm = Number(x.port_map);
    const ps = ports(mapped.services[main]);
    const hit = ps.find((p) => p.host === pm) ?? ps.find((p) => p.container === pm) ?? ps.find((p) => !p.udp);
    return finish(mapped, {
      source: "casaos",
      ref,
      id,
      name,
      tagline: en(x.tagline),
      description: en(x.description),
      icon: typeof x.icon === "string" ? x.icon : "",
      category: typeof x.category === "string" ? x.category : "",
      repo: String(x.repo || x.website || ""),
      licence: casaos.licence,
      archs: x.architectures,
      web: hit ? { service: main, port: hit.container } : undefined,
    });
  },
};
