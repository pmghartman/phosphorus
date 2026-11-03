// Runtipi appstore (GPL-3.0, fetched on the host, never vendored): apps/<id>/
// config.json and docker-compose.yml, or the schema v2 docker-compose.json when
// there's no YAML; Runtipi's proxy labels and network dropped, an app that needs
// another Runtipi app's service skipped; variables no form field gives become fields
import type { EnvField } from "@phosphorus/wire";
import { type Compose, interpolate, parse, ports, rename, type Service } from "../compose.ts";
import { type Adapter, dropLabels, finish, Skip, slug } from "./common.ts";

// Runtipi's own variables, and what they become
const renames: Record<string, string> = {
  APP_DATA_DIR: "APP_DATA",
  ROOT_FOLDER_HOST: "APP_DATA",
  LOCAL_DOMAIN: "APP_DOMAIN",
  APP_LOCAL_DOMAIN: "APP_DOMAIN",
  APP_HOST: "APP_DOMAIN",
};
const literals: Record<string, string> = {
  APP_PROTOCOL: "https",
  NETWORK_INTERFACE: "0.0.0.0",
  APP_EXPOSED: "true",
};

// a v2 docker-compose.json as compose; a key it doesn't know is a skip
function fromV2(j: Record<string, any>): Compose {
  const keys: Record<string, (s: Service, v: any, x: Record<string, any>) => void> = {
    name: () => {},
    image: (s, v) => void (s.image = v),
    isMain: () => {},
    internalPort: (s, v, x) => {
      if (x.isMain) (s.ports ??= []).push(`\${APP_PORT}:${v}`);
      else (s.expose ??= []).push(String(v));
    },
    addPorts: (s, v) => {
      for (const p of v ?? []) (s.ports ??= []).push(`${p.hostPort}:${p.containerPort}${p.udp ? "/udp" : ""}`);
    },
    environment: (s, v) => {
      s.environment = Array.isArray(v) ? Object.fromEntries(v.map((e: any) => [e.key, String(e.value)])) : v;
    },
    volumes: (s, v) => {
      s.volumes = (v ?? []).map((m: any) => `${m.hostPath}:${m.containerPath}${m.readOnly ? ":ro" : ""}`);
    },
    command: (s, v) => void (s.command = v),
    entrypoint: (s, v) => void (s.entrypoint = v),
    user: (s, v) => void (s.user = v),
    workingDir: (s, v) => void (s.working_dir = v),
    hostname: (s, v) => void (s.hostname = v),
    dependsOn: (s, v) => void (s.depends_on = v),
    healthCheck: (s, v) =>
      void (s.healthcheck = {
        test: v.test,
        interval: v.interval,
        timeout: v.timeout,
        retries: v.retries,
        start_period: v.startPeriod,
      }),
    privileged: (s, v) => void (s.privileged = v),
    capAdd: (s, v) => void (s.cap_add = v),
    devices: (s, v) => void (s.devices = v),
    networkMode: (s, v) => void (s.network_mode = v),
    shmSize: (s, v) => void (s.shm_size = v),
    ulimits: (s, v) => void (s.ulimits = v),
    extraLabels: () => {},
    stopGracePeriod: (s, v) => void (s.stop_grace_period = v),
  };
  const services: Record<string, Service> = {};
  for (const x of Array.isArray(j.services) ? j.services : []) {
    const s: Service = { restart: "unless-stopped" };
    for (const [k, v] of Object.entries(x)) {
      const f = keys[k];
      if (!f) throw new Skip(`docker-compose.json (schema v2) key ${k} isn't mapped`);
      f(s, v, x);
    }
    services[String(x.name)] = s;
  }
  return parse(JSON.stringify({ services }));
}

function field(f: Record<string, any>): EnvField | undefined {
  const name = typeof f.env_variable === "string" ? f.env_variable : "";
  if (!name) return;
  const out: EnvField = { name, label: String(f.label || name) };
  if (f.default !== undefined && f.default !== null) out.default = String(f.default);
  if (f.type === "random") out.secret = true;
  else if (f.required) out.required = true;
  if (Array.isArray(f.options)) out.options = f.options.map((o: any) => String(o?.value ?? o));
  return out;
}

export const runtipi: Adapter = {
  id: "runtipi",
  name: "Runtipi appstore",
  repo: "runtipi/runtipi-appstore",
  licence: "GPL-3.0",
  split: (p) => {
    const m = /^apps\/([^_/][^/]*)\/(.+)$/.exec(p);
    return m ? [m[1]!, m[2]!] : undefined;
  },
  wants: (rel) =>
    rel === "config.json" ||
    rel === "docker-compose.yml" ||
    rel === "docker-compose.json" ||
    rel === "metadata/description.md",
  adapt(ref, files) {
    let cfg: Record<string, any>;
    try {
      cfg = JSON.parse(files["config.json"] ?? "");
    } catch {
      throw new Skip("no readable config.json");
    }
    if (cfg.available === false) throw new Skip("marked unavailable in the appstore");
    const env = (Array.isArray(cfg.form_fields) ? cfg.form_fields : []).map(field).filter(Boolean) as EnvField[];
    const port = Number(cfg.port);
    const prep = (text: string) => {
      // the media folders as a field, the app's data by default; a url as ${APP_URL}
      let t = text
        .replaceAll("${ROOT_FOLDER_HOST}/media", "${MEDIA_DIR:-${APP_DATA}/media}")
        .replace(/\$\{APP_PROTOCOL(?::-https?)?\}:\/\/\$\{APP_DOMAIN\}/g, "${APP_URL}");
      t = interpolate(
        t,
        { ...literals, APP_ID: ref, ...(Number.isInteger(port) ? { APP_PORT: String(port) } : {}) },
        true,
      );
      return rename(t, renames);
    };
    let c: Compose;
    const yml = files["docker-compose.yml"];
    if (yml) c = parse(prep(yml));
    else if (files["docker-compose.json"]) {
      const j = JSON.parse(files["docker-compose.json"]);
      if (j.schemaVersion !== 2) throw new Skip("docker-compose.json isn't schema v2");
      c = parse(prep(JSON.stringify(fromV2(j))));
    } else throw new Skip("no docker-compose.yml");
    const names = new Set(Object.keys(c.services));
    for (const [n, s] of Object.entries(c.services)) {
      dropLabels(s, /^(traefik|runtipi)\./);
      const dns = Array.isArray(s.dns) ? s.dns : s.dns === undefined ? [] : [s.dns];
      if (dns.some((d: unknown) => String(d).includes("DNS_IP"))) delete s.dns;
      if (Array.isArray(s.networks)) {
        s.networks = s.networks.filter((x: unknown) => !/^tipi[_-]main[_-]network$/.test(String(x)));
        if (!s.networks.length) delete s.networks;
      } else if (s.networks && typeof s.networks === "object") {
        for (const k of Object.keys(s.networks)) if (/^tipi[_-]main[_-]network$/.test(k)) delete s.networks[k];
        if (!Object.keys(s.networks).length) delete s.networks;
      }
      const deps = Array.isArray(s.depends_on) ? s.depends_on : Object.keys(s.depends_on ?? {});
      for (const d of deps) if (!names.has(String(d))) throw new Skip(`${n} depends on ${d}, a Runtipi service`);
    }
    if (c.networks && typeof c.networks === "object") {
      for (const [k, v] of Object.entries(c.networks as Record<string, any>)) {
        if (/^tipi[_-]main[_-]network$/.test(k)) delete c.networks[k];
        else if (v?.external) throw new Skip(`uses the external network ${k}`);
      }
      if (!Object.keys(c.networks).length) delete c.networks;
    }
    // the main service: the one Runtipi publishes on the app's port
    let web: { service: string; port: number } | undefined;
    for (const [n, s] of Object.entries(c.services)) {
      const p = ports(s).find((p) => p.host === port && !p.udp);
      if (p) web = { service: n, port: p.container };
      if (web) break;
    }
    return finish(c, {
      source: "runtipi",
      ref,
      id: slug(typeof cfg.id === "string" ? cfg.id : ref),
      name: String(cfg.name || ref),
      tagline: String(cfg.short_desc ?? ""),
      description: files["metadata/description.md"] ?? String(cfg.description ?? ""),
      icon: `https://raw.githubusercontent.com/${runtipi.repo}/HEAD/apps/${ref}/metadata/logo.jpg`,
      category: Array.isArray(cfg.categories) ? String(cfg.categories[0] ?? "") : "",
      repo: String(cfg.source ?? ""),
      licence: runtipi.licence,
      archs: cfg.supported_architectures,
      env,
      web,
    });
  },
};
