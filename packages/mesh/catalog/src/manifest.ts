// the manifest phosphorus derives when a source gives none: which volumes are
// data, how a database is dumped before its copy, what says it's well; and the
// env fields a compose file leaves open
import type { EnvField, Hook, PhosManifest, VolumeRef } from "@phosphorus/wire";
import { type Compose, environment, guessWeb, mounts, phosVars, vars } from "./compose.ts";

const cacheRe = /(^|[/_.-])(cache|caches|tmp|temp|transcodes?)([/_.-]|$)/i;

// an image's repository, no registry or tag: "library/postgres" -> "postgres"
export function imageName(image: string): string {
  let s = image.split("@")[0]!;
  const slash = s.lastIndexOf("/");
  const colon = s.lastIndexOf(":");
  if (colon > slash) s = s.slice(0, colon);
  const parts = s.split("/");
  if (parts.length > 1 && /[.:]|^localhost$/.test(parts[0]!)) parts.shift();
  if (parts[0] === "library") parts.shift();
  return parts.join("/").toLowerCase();
}

const isPostgres = (n: string) => /(^|\/)(postgres|postgresql|postgis|pgvector|pgvecto-rs|timescaledb[\w-]*)$/.test(n);
const isMysql = (n: string) => /(^|\/)(mariadb|mysql|percona-server)$/.test(n);
// images known to keep a sqlite file, and where
const sqliteOf: Record<string, string> = {
  "vaultwarden/server": "/data/db.sqlite3",
  "louislam/uptime-kuma": "/app/data/kuma.db",
};

const under = (path: string, dir: string) => path === dir || path.startsWith(dir.replace(/\/$/, "") + "/");

// a service's sqlite files: the image's own, or env values naming one
function sqliteFiles(image: string, env: Record<string, string>): string[] {
  const out = new Set<string>();
  const known = sqliteOf[imageName(image)];
  if (known) out.add(known);
  for (const v of Object.values(env)) {
    const m = /^(?:sqlite:\/\/)?(\/[^\s;?]+\.(?:db|sqlite3?))$/.exec(v);
    if (m) out.add(m[1]!);
  }
  return [...out];
}

export function derive(c: Compose, web?: PhosManifest["web"]): PhosManifest {
  const volumes: VolumeRef[] = [];
  const pre: Hook[] = [];
  for (const [service, s] of Object.entries(c.services)) {
    const data: string[] = [];
    for (const m of mounts(s)) {
      if (m.type === "bind" && !m.source.startsWith("${APP_DATA}")) continue;
      const kind = cacheRe.test(m.target) || cacheRe.test(m.source.replace("${APP_DATA}", "")) ? "cache" : "data";
      volumes.push({ service, target: m.target, kind });
      if (kind === "data") data.push(m.target);
    }
    const image = typeof s.image === "string" ? s.image : "";
    const name = imageName(image);
    const into = data[0];
    if (!image || !into) continue;
    const dump = `${into.replace(/\/$/, "")}/phos-backup.sql`;
    if (isPostgres(name))
      pre.push({
        service,
        run: [
          "sh",
          "-c",
          `pg_dump -U "\${POSTGRES_USER:-postgres}" -d "\${POSTGRES_DB:-\${POSTGRES_USER:-postgres}}" -f ${dump}`,
        ],
      });
    else if (isMysql(name))
      pre.push({
        service,
        run: [
          "sh",
          "-c",
          `"$(command -v mariadb-dump || command -v mysqldump)" --all-databases --single-transaction -uroot -p"\${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}" > ${dump}`,
        ],
      });
    else
      for (const db of sqliteFiles(image, environment(s)))
        if (data.some((d) => under(db, d)))
          pre.push({
            service,
            run: ["sh", "-c", `! command -v sqlite3 >/dev/null || sqlite3 ${db} ".backup '${db}.phos-backup'"`],
          });
  }
  web ??= guessWeb(c);
  const checked = Object.entries(c.services).filter(([, s]) => s.healthcheck && !s.healthcheck.disable);
  const hc = checked.find(([n]) => n === web?.service) ?? checked[0];
  const health = hc ? { service: hc[0] } : web ? { service: web.service, port: web.port } : undefined;
  const m: PhosManifest = { volumes };
  if (pre.length) m.backup = { pre };
  if (health) m.health = health;
  if (web) m.web = web;
  return m;
}

const secretRe = /(PASSWORD|PASSWD|SECRET|TOKEN|SALT|_KEY)$/i;

// "DB_ROOT_PASSWORD" -> "DB root password"
export const labelOf = (name: string) => {
  const s = name.toLowerCase().replace(/_+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// given, and a field for each variable the compose file leaves to the .env
// that isn't one phosphorus fills: a secret one generated, one without a
// default required
export function envFields(compose: string, given: EnvField[]): EnvField[] {
  const out = [...given];
  const have = new Set(given.map((f) => f.name));
  for (const [name, use] of vars(compose)) {
    if (have.has(name) || phosVars.includes(name)) continue;
    have.add(name);
    const f: EnvField = { name, label: labelOf(name) };
    if (use.default !== undefined) f.default = use.default;
    if (secretRe.test(name) && !use.default) f.secret = true;
    else if (use.required) f.required = true;
    out.push(f);
  }
  return out;
}

// the manifest a repo's phos.yml gives, laid over the derived one
export function overlay(base: PhosManifest, given: unknown): PhosManifest {
  if (!given || typeof given !== "object" || Array.isArray(given)) return base;
  const g = given as Record<string, any>;
  const out: PhosManifest = { ...base };
  if (Array.isArray(g.volumes))
    out.volumes = g.volumes
      .filter((v: any) => v && typeof v.service === "string" && typeof v.target === "string")
      .map((v: any) => ({ service: v.service, target: v.target, kind: v.kind === "cache" ? "cache" : "data" }));
  const hooks = (v: unknown): Hook[] | undefined =>
    Array.isArray(v)
      ? v
          .filter((h: any) => h && typeof h.service === "string")
          .map((h: any) => ({
            service: h.service,
            run: Array.isArray(h.run) ? h.run.map(String) : ["sh", "-c", String(h.run)],
          }))
      : undefined;
  if (g.backup && typeof g.backup === "object") {
    const pre = hooks(g.backup.pre);
    const post = hooks(g.backup.post);
    out.backup = { pre: pre ?? base.backup?.pre, post: post ?? base.backup?.post };
  }
  if (g.health && typeof g.health.service === "string")
    out.health = {
      service: g.health.service,
      path: typeof g.health.path === "string" ? g.health.path : undefined,
      port: Number.isInteger(g.health.port) ? g.health.port : undefined,
    };
  if (g.web && typeof g.web.service === "string" && Number.isInteger(g.web.port))
    out.web = { service: g.web.service, port: g.web.port };
  if (typeof g.preferredHost === "string") out.preferredHost = g.preferredHost;
  return out;
}
