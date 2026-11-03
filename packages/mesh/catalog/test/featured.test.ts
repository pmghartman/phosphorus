// phosphorus's own apps: Forgejo as the mesh's git, whole without a fetch
import { expect, test } from "bun:test";
import { all, find, sources, tree } from "../src/catalogs.ts";
import { rendered } from "../src/check.ts";
import { environment, parse, phosVars, ports, vars } from "../src/compose.ts";
import { forgejo } from "../src/featured.ts";

test("Forgejo is listed first, under phosphorus, routed as git", () => {
  expect(all()[0]).toBe(forgejo);
  expect(find("phosphorus", "forgejo")).toBe(forgejo);
  expect(forgejo.id).toBe("git");
  expect(sources()[0]).toMatchObject({ id: "phosphorus", apps: 1, licence: "Apache-2.0" });
  expect(tree("phosphorus", "forgejo")).toEqual([{ path: "docker-compose.yml", type: "file" }]);
});

test("its compose: one service, the web and ssh ports, /data its data", () => {
  const c = parse(forgejo.compose);
  expect(Object.keys(c.services)).toEqual(["forgejo"]);
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

test("its fields: the ports defaulted, the secrets generated, nothing else left open", () => {
  const open = [...vars(forgejo.compose).keys()].filter((v) => !phosVars.includes(v)).sort();
  expect(open).toEqual(["HTTP_PORT", "INTERNAL_TOKEN", "SECRET_KEY", "SSH_PORT"]);
  expect(forgejo.env).toEqual([
    { name: "HTTP_PORT", label: "Web port on the host", default: "3001" },
    { name: "SSH_PORT", label: "SSH port on the host", default: "2222" },
    { name: "SECRET_KEY", label: "Secret key", secret: true },
    { name: "INTERNAL_TOKEN", label: "Internal token", secret: true },
  ]);
});

test("its manifest: /data copied after a sqlite .backup, the healthz checked", () => {
  const m = forgejo.manifest;
  expect(m.volumes).toEqual([{ service: "forgejo", target: "/data", kind: "data" }]);
  expect(m.web).toEqual({ service: "forgejo", port: 3000 });
  expect(m.health).toEqual({ service: "forgejo", path: "/api/healthz", port: 3000 });
  const pre = m.backup!.pre!;
  expect(pre).toHaveLength(1);
  expect(pre[0]!.service).toBe("forgejo");
  expect(pre[0]!.run[2]).toContain(`.backup '$db.phos-backup'`);
  expect(pre[0]!.run[2]).toContain("[ ! -s $db ] ||");
});
