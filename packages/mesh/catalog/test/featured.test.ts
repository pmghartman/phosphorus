// phosphorus's own apps: Forgejo as the mesh's git, whole without a fetch
import { expect, test } from "bun:test";
import { all, find, sources, tree } from "../src/catalogs.ts";
import { check, rendered } from "../src/check.ts";
import { environment, parse, phosVars, ports, vars } from "../src/compose.ts";
import { audiobookshelf, circuit, forgejo, jellyfin, jupyterlab, tavern } from "../src/featured.ts";

const linux = { host: "razer", platform: "linux", arch: "amd64", docker: { state: "present" as const } };

test("Forgejo is listed first, under phosphorus, routed as forgejo with git its alias", () => {
  expect(all()[0]).toBe(forgejo);
  expect(find("phosphorus", "forgejo")).toBe(forgejo);
  expect(forgejo.id).toBe("forgejo");
  expect(forgejo.manifest.aliases).toEqual(["git"]);
  expect(sources()[0]).toMatchObject({ id: "phosphorus", apps: 6, licence: "Apache-2.0" });
  expect(tree("phosphorus", "forgejo")).toEqual([{ path: "docker-compose.yml", type: "file" }]);
});

test("its compose: Forgejo, the web and ssh ports, /data its data; the runner only when picked", () => {
  const c = parse(forgejo.compose);
  expect(Object.keys(c.services)).toEqual(["forgejo", "runner-docker", "runner"]);
  expect(Object.keys(rendered(forgejo, {}).services)).toEqual(["forgejo"]);
  expect(Object.keys(rendered(forgejo, { COMPOSE_PROFILES: "runner" }).services)).toEqual([
    "forgejo",
    "runner-docker",
    "runner",
  ]);
  const s = c.services.forgejo!;
  // as the check reads them, the defaults filled in
  expect(ports(rendered(forgejo, {}).services.forgejo!)).toEqual([
    { host: 3001, container: 3000 },
    { host: 2222, container: 22 },
  ]);
  expect(ports(rendered(forgejo, { SSH_PORT: "2022" }).services.forgejo!)[1]).toEqual({ host: 2022, container: 22 });
  expect(s.volumes).toEqual(["forgejo:/data"]);
  const env = environment(s);
  expect(env.FORGEJO__database__PATH).toBe("/data/gitea/forgejo.db");
  expect(env.FORGEJO__server__ROOT_URL).toBe("${APP_URL}/");
  expect(env.FORGEJO__security__SECRET_KEY).toBe("${SECRET_KEY}");
  // the restore script's own variables escaped from compose
  expect(s.entrypoint[2]).toContain('"$$db.phos-backup"');
  expect(s.entrypoint[2]).toContain('exec /usr/bin/entrypoint "$$@"');
  expect(s.healthcheck.test).toEqual(["CMD", "curl", "-fsS", "http://localhost:3000/api/healthz"]);
});

test("its fields: the ports defaulted, the secrets generated, the runner off, nothing else left open", () => {
  const open = [...vars(forgejo.compose).keys()].filter((v) => !phosVars.includes(v)).sort();
  expect(open).toEqual([
    "COMPOSE_PROFILES",
    "HTTP_PORT",
    "INTERNAL_TOKEN",
    "RUNNER_CAPACITY",
    "RUNNER_SECRET",
    "SECRET_KEY",
    "SSH_PORT",
  ]);
  expect(forgejo.env).toEqual([
    { name: "HTTP_PORT", label: "Web port on the host", default: "3001" },
    { name: "SSH_PORT", label: "SSH port on the host", default: "2222" },
    { name: "SECRET_KEY", label: "Secret key", secret: true },
    { name: "INTERNAL_TOKEN", label: "Internal token", secret: true },
    { name: "COMPOSE_PROFILES", label: "Actions runner", default: "none", options: ["none", "runner"] },
    { name: "RUNNER_CAPACITY", label: "Runner's jobs at once", default: "2" },
    { name: "RUNNER_SECRET", label: "Runner's shared secret", secret: true },
  ]);
});

test("its runner: checked only when picked, linked by the one secret on both sides", () => {
  const off = check(forgejo, {}, [linux], {});
  expect(off.items.some((i) => i.text.includes("privileged"))).toBe(false);
  const on = check(forgejo, { COMPOSE_PROFILES: "runner" }, [linux], {});
  expect(on.items).toContainEqual({ level: "warn", text: "runner-docker runs privileged" });
  const c = parse(forgejo.compose);
  const fj = c.services.forgejo!.entrypoint[2] as string;
  expect(fj).toContain("forgejo-cli actions register --name phosphorus --keep-labels --secret $$s");
  expect(environment(c.services.forgejo!).RUNNER_SECRET).toBe("${RUNNER_SECRET}");
  const r = c.services.runner!;
  expect(environment(r).RUNNER_SECRET).toBe("${RUNNER_SECRET}");
  expect(environment(r).DOCKER_HOST).toBe("tcp://runner-docker:2375");
  // both derive the 40 hex the same way; the runner's uuid its first 16 as bytes
  const derive = 's=$$(printf %s "$$RUNNER_SECRET" | sha1sum | cut -c1-40)';
  expect(fj).toContain(derive);
  expect(r.entrypoint[2]).toContain(derive);
  expect(r.entrypoint[2]).toContain("url: http://forgejo:3000");
  expect(r.entrypoint[2]).toContain('u="$${h:0:8}-$${h:8:4}-$${h:12:4}-$${h:16:4}-$${h:20:12}"');
});

test("its manifest: /data copied after a sqlite .backup, the healthz checked", () => {
  const m = forgejo.manifest;
  expect(m.volumes).toEqual([
    { service: "forgejo", target: "/data", kind: "data" },
    { service: "runner", target: "/data", kind: "data" },
    { service: "runner-docker", target: "/var/lib/docker", kind: "cache" },
  ]);
  expect(m.web).toEqual({ service: "forgejo", port: 3000 });
  expect(m.health).toEqual({ service: "forgejo", path: "/api/healthz", port: 3000 });
  const pre = m.backup!.pre!;
  expect(pre).toHaveLength(1);
  expect(pre[0]!.service).toBe("forgejo");
  expect(pre[0]!.run[2]).toContain(`.backup '$db.phos-backup'`);
  expect(pre[0]!.run[2]).toContain("[ ! -s $db ] ||");
});

test("Tavern and Circuit follow Forgejo, each built from its own repo", () => {
  expect(all().slice(0, 6)).toEqual([forgejo, tavern, circuit, jellyfin, audiobookshelf, jupyterlab]);
  expect(find("phosphorus", "tavern")).toBe(tavern);
  expect(find("phosphorus", "circuit")).toBe(circuit);
  for (const d of [tavern, circuit]) {
    expect(d.repo).toMatch(/^https:\/\/github\.com\/pmghartman\//);
    const r = check(d, {}, [linux], {});
    expect(r.verdict).toBe("installable");
    expect(r.items).toContainEqual({ level: "ok", text: `builds ${d.id} from the repo` });
    expect(parse(d.compose).services[d.id]!.build.context).toBe(".");
  }
});

test("Tavern: the host's network for the gateway, data/ its data, the db backed up and checked", () => {
  const s = parse(tavern.compose).services.tavern!;
  expect(s.network_mode).toBe("host");
  expect(s.ports).toBeUndefined();
  expect(s.volumes).toEqual(["tavern:/app/data"]);
  expect(s.user).toBe("${PUID}:${PGID}");
  expect(environment(s)).toMatchObject({ TAVERN_PORT: "8484", TAVERN_DATA_DIR: "/app/data", TAVERN_UPDATES: "off" });
  expect(s.entrypoint[2]).toContain("fs.copyFileSync(bk, db)");
  expect(s.entrypoint[2]).toContain("exec node server/index.js");
  // nothing left for compose to fill but phosphorus's own
  expect([...vars(tavern.compose).keys()].filter((v) => !phosVars.includes(v))).toEqual([]);
  expect(tavern.env).toEqual([]);
  const m = tavern.manifest;
  expect(m.volumes).toEqual([{ service: "tavern", target: "/app/data", kind: "data" }]);
  expect(m.web).toEqual({ service: "tavern", port: 8484 });
  expect(m.health).toEqual({ service: "tavern", path: "/api/health", port: 8484 });
  expect(m.backup!.pre![0]!.run[2]).toContain('c.backup(db + ".phos-backup")');
});

test("Circuit: its port a field, nothing kept, the version asked for health", () => {
  const s = parse(circuit.compose).services.circuit!;
  expect(ports(rendered(circuit, {}).services.circuit!)).toEqual([{ host: 8099, container: 8099 }]);
  expect(ports(rendered(circuit, { HTTP_PORT: "8100" }).services.circuit!)).toEqual([{ host: 8100, container: 8099 }]);
  expect(environment(s)).toEqual({ PORT: "8099", CIRCUIT_UPDATES: "off" });
  expect(s.volumes).toBeUndefined();
  expect(circuit.env).toEqual([{ name: "HTTP_PORT", label: "Web port on the host", default: "8099" }]);
  expect(circuit.manifest).toEqual({
    volumes: [],
    health: { service: "circuit", path: "/api/version", port: 8099 },
    web: { service: "circuit", port: 8099 },
  });
});

test("Jellyfin, Audiobookshelf and JupyterLab: images pulled, data kept, one name each, Jellyfin's media", () => {
  const img = (d: typeof jellyfin) => parse(d.compose).services[d.manifest.web!.service]!.image;
  expect([jellyfin, audiobookshelf, jupyterlab].map(img)).toEqual([
    "jellyfin/jellyfin:10.11.11",
    "ghcr.io/advplyr/audiobookshelf:2.36.0",
    "ghcr.io/prefix-dev/pixi:0.83.0-bookworm",
  ]);
  expect([jellyfin, audiobookshelf, jupyterlab].map((d) => d.id)).toEqual(["jellyfin", "audiobookshelf", "jupyterlab"]);
  expect(jellyfin.manifest.aliases).toEqual(["media"]);
  expect(find("phosphorus", "jellyfin")).toBe(jellyfin);
  expect(all().filter((d) => d.manifest.aliases?.length)).toEqual([forgejo, jellyfin]);
  for (const d of [jellyfin, audiobookshelf, jupyterlab]) {
    expect(check(d, {}, [linux], { [img(d)]: { archs: ["amd64"] } }).verdict).toBe("installable");
    expect([...vars(d.compose).keys()].filter((v) => !phosVars.includes(v)).sort()).toEqual(
      d.env.map((f) => f.name).sort(),
    );
  }
});

test("Jellyfin: /config its data with config/ inside, /cache not copied, the media at /srv/media", () => {
  const s = parse(jellyfin.compose).services.jellyfin!;
  expect(s.volumes).toEqual([
    "jellyfin-config:/config",
    "jellyfin-cache:/cache",
    "${MEDIA_DIR:-/srv/media}:/srv/media",
  ]);
  expect(ports(rendered(jellyfin, {}).services.jellyfin!)).toEqual([{ host: 8096, container: 8096 }]);
  expect(jellyfin.manifest.volumes).toEqual([
    { service: "jellyfin", target: "/config", kind: "data" },
    { service: "jellyfin", target: "/cache", kind: "cache" },
  ]);
  expect(jellyfin.manifest.health).toEqual({ service: "jellyfin", path: "/health", port: 8096 });
  expect(jellyfin.env.map((f) => [f.name, f.default])).toEqual([
    ["HTTP_PORT", "8096"],
    ["MEDIA_DIR", "/srv/media"],
  ]);
});

test("Audiobookshelf: its db and metadata kept, the books from the host, 13378 outside", () => {
  const s = parse(audiobookshelf.compose).services.audiobookshelf!;
  expect(s.volumes).toEqual([
    "audiobookshelf-config:/config",
    "audiobookshelf-metadata:/metadata",
    "${AUDIOBOOKS_DIR:-/srv/media/audiobooks}:/audiobooks",
  ]);
  expect(ports(rendered(audiobookshelf, {}).services.audiobookshelf!)).toEqual([{ host: 13378, container: 80 }]);
  expect(audiobookshelf.manifest.web).toEqual({ service: "audiobookshelf", port: 80 });
  expect(audiobookshelf.manifest.health).toEqual({ service: "audiobookshelf", path: "/healthcheck", port: 80 });
});

test("JupyterLab: the pixi workspace seeded once, its own page the origin, a token typed at install", () => {
  const s = parse(jupyterlab.compose).services.jupyterlab!;
  const sh = s.entrypoint[2] as string;
  expect(sh).toContain("if [ ! -f hub/pixi.toml ]; then");
  expect(sh).toContain("[ -f hub/jupyter_server_config.py ] ||");
  expect(sh).toContain("exec pixi run --manifest-path hub/pixi.toml jupyter lab");
  // compose's $$ for the shell's own
  expect(sh).toContain('--ServerApp.root_dir=/lab --ServerApp.allow_origin="$$APP_URL" ');
  expect(environment(s)).toMatchObject({
    HOME: "/lab",
    APP_URL: "${APP_URL}",
    JUPYTER_TOKEN: "${JUPYTER_TOKEN}",
  });
  expect(s.volumes).toEqual(["jupyterlab:/lab"]);
  expect(jupyterlab.env.find((f) => f.name === "JUPYTER_TOKEN")).toMatchObject({ secret: true });
  expect(jupyterlab.manifest.volumes).toEqual([{ service: "jupyterlab", target: "/lab", kind: "data" }]);
  expect(jupyterlab.manifest.health).toEqual({ service: "jupyterlab", path: "/api", port: 8888 });
});
