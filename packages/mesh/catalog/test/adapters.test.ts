import { describe, expect, test } from "bun:test";
import { casaos } from "../src/adapters/casaos.ts";
import { cosmos } from "../src/adapters/cosmos.ts";
import { runtipi } from "../src/adapters/runtipi.ts";
import { build } from "../src/catalogs.ts";
import { parse } from "../src/compose.ts";
import { stream, tarball } from "./helpers.ts";

describe("casaos", async () => {
  const ix = await build(casaos, stream(tarball("casaos")));
  const d = ix.apps.find((a) => a.ref === "Demo")!;

  test("the app, its English text and its source's terms", () => {
    expect(d.id).toBe("demo");
    expect(d.name).toBe("Demo App");
    expect(d.tagline).toBe("A demo");
    expect(d.description).toBe("The demo, at length.");
    expect(d.category).toBe("utilities");
    expect(d.licence).toBe("Apache-2.0");
    expect(d.repo).toBe("https://github.com/example/demo");
    expect(d.archs).toEqual(["amd64", "arm64"]);
  });

  test("x-casaos dropped, paths and variables mapped", () => {
    const c = parse(d.compose);
    expect(c["x-casaos"]).toBeUndefined();
    expect(c.name).toBeUndefined();
    expect(c.services.demo!["x-casaos"]).toBeUndefined();
    expect(c.services.demo!.volumes[0].source).toBe("${APP_DATA}/config");
    expect(c.services.demo!.volumes[1]).toBe("${MEDIA_DIR:-${APP_DATA}/Media}:/media");
    expect(c.services.demo!.environment).toEqual({ PUID: "${PUID}", PGID: "${PGID}", TZ: "${TZ}" });
  });

  test("port_map is the web port, the bind its data", () => {
    expect(d.manifest.web).toEqual({ service: "demo", port: 8080 });
    expect(d.manifest.volumes).toEqual([{ service: "demo", target: "/config", kind: "data" }]);
    expect(d.env.map((f) => f.name)).toEqual(["MEDIA_DIR"]);
    expect(d.env[0]!.default).toBe("${APP_DATA}/Media");
  });

  test("an app without x-casaos skipped, with why", () => {
    expect(ix.skipped).toEqual([{ ref: "NoMeta", why: "no x-casaos block" }]);
    expect(ix.trees.Demo).toEqual([{ path: "docker-compose.yml", type: "file", size: expect.any(Number) }]);
  });
});

describe("runtipi", async () => {
  const ix = await build(runtipi, stream(tarball("runtipi")));
  const d = ix.apps.find((a) => a.ref === "demo")!;

  test("config.json's fields as env fields, random ones secret", () => {
    expect(d.licence).toBe("GPL-3.0");
    expect(d.description).toBe("The demo, from its description.md.\n");
    const by = Object.fromEntries(d.env.map((f) => [f.name, f]));
    expect(by.DEMO_ADMIN_PASSWORD).toEqual({ name: "DEMO_ADMIN_PASSWORD", label: "Admin password", required: true });
    expect(by.DEMO_DB_PASSWORD!.secret).toBe(true);
    expect(by.DEMO_DB_PASSWORD!.required).toBeUndefined();
    expect(by.DEMO_MODE!.options).toEqual(["a", "b"]);
    expect(by.MEDIA_DIR!.default).toBe("${APP_DATA}/media");
  });

  test("Runtipi's variables, labels and network mapped away", () => {
    const c = parse(d.compose);
    const s = c.services.demo!;
    expect(c.version).toBeUndefined();
    expect(s.ports).toEqual(["8107:80"]);
    expect(s.environment).toContain("URL=${APP_URL}");
    expect(s.volumes).toEqual(["${APP_DATA}/data:/data", "${MEDIA_DIR:-${APP_DATA}/media}/movies:/movies"]);
    expect(s.labels).toBeUndefined();
    expect(s.networks).toBeUndefined();
    expect(c.services["demo-db"]!.networks).toBeUndefined();
  });

  test("the app's port is its web page; postgres dumped before a copy", () => {
    expect(d.manifest.web).toEqual({ service: "demo", port: 80 });
    expect(d.manifest.backup?.pre).toEqual([
      {
        service: "demo-db",
        run: [
          "sh",
          "-c",
          'pg_dump -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}" -f /var/lib/postgresql/data/phos-backup.sql',
        ],
      },
    ]);
    expect(d.manifest.health).toEqual({ service: "demo-db" });
  });

  test("a schema v2 docker-compose.json when there's no YAML", () => {
    const v2 = ix.apps.find((a) => a.ref === "v2only")!;
    const s = parse(v2.compose).services.v2only!;
    expect(s.image).toBe("example/v2:1");
    expect(s.ports).toEqual(["8200:3000"]);
    expect(s.volumes).toEqual(["${APP_DATA}/data:/data"]);
    expect(v2.manifest.web).toEqual({ service: "v2only", port: 3000 });
  });

  test("an app leaning on a Runtipi service skipped", () => {
    expect(ix.skipped).toEqual([{ ref: "needsdb", why: "needsdb depends on tipi-db, a Runtipi service" }]);
  });
});

describe("cosmos", async () => {
  const ix = await build(cosmos, stream(tarball("cosmos")));
  const d = ix.apps.find((a) => a.ref === "Demo")!;

  test("Whiskers mapped: names, passwords, hostnames, the form's defaults", () => {
    expect(d.id).toBe("cosmo-demo");
    expect(d.licence).toBe("AGPL-3.0");
    expect(d.tagline).toBe("A demo servapp.");
    expect(d.icon).toBe("https://example.test/cosmo.png");
    const c = parse(d.compose);
    const s = c.services["cosmo-demo"]!;
    expect(s.container_name).toBe("cosmo-demo");
    expect(s.environment).toEqual(["SECRET=${PASSWORD_0}", "HOST=${APP_DOMAIN}"]);
    // the checkbox off by default: the cache volume left out
    expect(s.volumes).toEqual([
      { source: "cosmo-demo-config", target: "/config", type: "volume" },
      { source: "${MEDIA_PATH:-${APP_DATA}/media}", target: "/media", type: "bind" },
    ]);
    expect(c.volumes).toEqual({ "cosmo-demo-config": {} });
    expect(s.routes).toBeUndefined();
    expect(s.UID).toBeUndefined();
    expect(s.labels).toEqual({ keep: "yes" });
    expect(c["cosmos-installer"]).toBeUndefined();
  });

  test("its route the web port, its password a secret", () => {
    expect(d.manifest.web).toEqual({ service: "cosmo-demo", port: 9000 });
    const by = Object.fromEntries(d.env.map((f) => [f.name, f]));
    expect(by.PASSWORD_0!.secret).toBe(true);
    expect(by.MEDIA_PATH).toEqual({ name: "MEDIA_PATH", label: "Path to your media", default: "${APP_DATA}/media" });
  });

  test("what has no counterpart skipped, with why", () => {
    expect(ix.skipped).toEqual([{ ref: "Odd", why: "{RootHostname} has no counterpart here" }]);
  });
});
