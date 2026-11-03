// a compose file's profiles as the render reads them: what isn't picked left out, so an up removes it
import { expect, test } from "bun:test";
import type { AppDef } from "@phosphorus/wire";
import { render } from "../src/render.ts";

const ctx = { dir: "/srv/phos/stacks/fj", ip: "100.64.0.7", puid: "1000", pgid: "1000", tz: "UTC", domain: "" };

const def: AppDef = {
  id: "fj",
  source: "phosphorus",
  ref: "fj",
  name: "Fj",
  tagline: "",
  description: "",
  icon: "",
  category: "",
  repo: "",
  licence: "",
  archs: [],
  compose: `services:
  app:
    image: app:1
    ports: ["3001:3000"]
    volumes: [app:/data]
  helper:
    image: helper:1
    profiles: [extra]
    depends_on: [app]
    volumes: [helper:/data]
  side:
    image: side:1
    profiles: [extra]
    depends_on:
      helper: { condition: service_started }
volumes:
  app: {}
  helper: {}
`,
  env: [],
  manifest: { volumes: [], web: { service: "app", port: 3000 } },
};

const services = (env: Record<string, string>) =>
  (Bun.YAML.parse(render(def, env, ctx).compose) as { services: Record<string, any> }).services;

test("render: a profile not picked leaves its services out, the rest shed their profiles", () => {
  expect(Object.keys(services({}))).toEqual(["app"]);
  expect(Object.keys(services({ COMPOSE_PROFILES: "none" }))).toEqual(["app"]);
  const on = services({ COMPOSE_PROFILES: "extra" });
  expect(Object.keys(on)).toEqual(["app", "helper", "side"]);
  expect(on.helper.profiles).toBeUndefined();
  expect(on.helper.volumes).toEqual(["/srv/phos/stacks/fj/data/helper:/data"]);
  expect(on.side.depends_on).toEqual({ helper: { condition: "service_started" } });
  expect(Object.keys(services({ COMPOSE_PROFILES: "*" }))).toEqual(["app", "helper", "side"]);
});

test("render: what's left out is no longer depended on, its named volumes undeclared", () => {
  const d: AppDef = {
    ...def,
    compose: def.compose.replace("    ports:", "    depends_on: [helper]\n    ports:"),
  };
  const doc = Bun.YAML.parse(render(d, {}, ctx).compose) as any;
  expect(doc.services.app.depends_on).toEqual([]);
  expect(doc.volumes).toBeUndefined();
});
