// the services wizard and the apps page as tools: what's installed, the
// catalogue, and an admin's install, update, removal, standbys and moves
import { obj } from "@phosphorus/util";
import { adminOf, arr, askerOf, errc, object, pressed, runes, src, str, type Tool } from "./common.ts";

const idRe = /^[a-z][a-z0-9-]{0,39}$/;
const readmeMax = 1500;
const listMax = 40;

// an app's page cut to what a caller acts on
function page(b: Record<string, any>) {
  const d = obj(b.def) ?? {};
  const m = obj(d.manifest) ?? {};
  return {
    id: d.id,
    source: d.source,
    ref: d.ref,
    name: d.name,
    tagline: d.tagline,
    category: d.category,
    repo: d.repo,
    licence: d.licence,
    env: d.env ?? [],
    web: m.web ?? null,
    aliases: m.aliases ?? [],
    data: arr(m.volumes).filter((v) => obj(v)?.kind === "data"),
    check: b.check,
    readme: runes(str(b.readme), readmeMax),
  };
}

const stackId = (a: Record<string, any>) => {
  const id = str(a.id);
  if (!idRe.test(id)) throw errc("bad_input", "id is the installed service's, as stacks lists it");
  return id;
};

const hostList = (v: unknown) => arr(v).map((h) => str(h));

export const stackTools = (): Tool[] => [
  {
    name: "stacks",
    title: "Installed services",
    read: true,
    description:
      "The services installed from the wizard: each one's app, active host and standbys, and every host's copy " +
      "(role, running, healthy, a job's log tail); docker on each host.",
    schema: object(),
    run: () => pressed(src.actions.stacks(undefined, "list", {})),
  },
  {
    name: "stack_catalog",
    title: "Service catalogue",
    read: true,
    scope: "key",
    description:
      "The wizard's catalogue: search by q, source and category; with source and ref, that app's page " +
      "(its env fields, web port, data and whether and where it installs). source github with ref a repo url opens a repo.",
    schema: object({
      q: { type: "string", description: "words over name, tagline and category" },
      source: { type: "string", description: "phosphorus, casaos, runtipi, cosmos or github" },
      category: { type: "string" },
      ref: { type: "string", description: "with source: the app's ref, as the search lists it" },
      env: {
        type: "object",
        description: "with ref: values to check it with",
        additionalProperties: { type: "string" },
      },
    }),
    run: async (a, m) => {
      const source = str(a.source);
      const ref = str(a.ref);
      if (ref) {
        if (!source) throw errc("bad_input", "ref goes with source");
        const b = obj(await pressed(src.actions.stacks(m.caller, "app", { source, ref }))) ?? {};
        const out = page(b);
        if (obj(a.env)) out.check = await pressed(src.actions.stacks(m.caller, "check", { source, ref, env: a.env }));
        return out;
      }
      const b =
        obj(await pressed(src.actions.stacks(m.caller, "catalog", { q: a.q, source, category: a.category }))) ?? {};
      const apps = arr(b.apps);
      const out: Record<string, any> = { apps: apps.slice(0, listMax) };
      if (apps.length > listMax) out.more = apps.length - listMax;
      if (!str(a.q) && !source) out.sources = b.sources;
      return out;
    },
  },
  {
    name: "stack_control",
    title: "Install or change a service",
    admin: true,
    destructive: true,
    description:
      "An admin's change to an installed service, every host following: install (source, ref, active, standbys, env; " +
      "stack_catalog with env first, blank secret fields generated), update, remove (keep_data, true unless said), " +
      "standbys (the hosts keeping a copy), move (to a standby, a planned handoff). Never fill a secret the person didn't give.",
    schema: object(
      {
        action: { type: "string", enum: ["install", "update", "remove", "standbys", "move"] },
        id: { type: "string", description: "the installed service, as stacks lists it" },
        source: { type: "string" },
        ref: { type: "string" },
        env: { type: "object", additionalProperties: { type: "string" } },
        active: { type: "string", description: "install or standbys: the host serving it" },
        standbys: { type: "array", items: { type: "string" } },
        keep_data: { type: "boolean", default: true },
        to: { type: "string", description: "move: the standby taking over" },
      },
      "action",
    ),
    run: (a, m) => {
      adminOf(m);
      askerOf(m);
      const act = str(a.action);
      if (act === "install") {
        if (!str(a.source) || !str(a.ref) || !str(a.active))
          throw errc("bad_input", "install takes source, ref and active");
        return pressed(
          src.actions.stacks(m.caller, "install", {
            source: str(a.source),
            ref: str(a.ref),
            env: obj(a.env) ?? {},
            active: str(a.active),
            standbys: hostList(a.standbys),
          }),
        );
      }
      const id = stackId(a);
      if (act === "update") return pressed(src.actions.stacks(m.caller, "update", { id }));
      if (act === "remove")
        return pressed(src.actions.stacks(m.caller, "remove", { id, keepData: a.keep_data !== false }));
      if (act === "standbys")
        return pressed(
          src.actions.stacks(m.caller, "standbys", {
            id,
            standbys: hostList(a.standbys),
            ...(str(a.active) ? { active: str(a.active) } : {}),
          }),
        );
      if (act === "move") {
        if (!str(a.to)) throw errc("bad_input", "move takes to");
        return pressed(src.actions.stacks(m.caller, "move", { id, to: str(a.to) }));
      }
      throw errc("bad_input", "action is install, update, remove, standbys or move");
    },
  },
  {
    name: "apps",
    title: "Optional apps",
    read: true,
    description:
      "Phosphorus's optional apps (code, chat, viewer, games): each one's latest release, what the mesh runs and each host's copy.",
    schema: object(),
    run: async () => {
      const b = obj(await pressed(src.actions.apps("list", ""))) ?? {};
      return arr(b.apps).map((x) => {
        const o = obj(x) ?? {};
        return {
          id: o.id,
          name: o.name,
          tagline: o.tagline,
          latest: o.latest,
          want: o.want,
          local: o.local,
          feedError: o.feedError || undefined,
        };
      });
    },
  },
  {
    name: "app_control",
    title: "Install or remove an app",
    admin: true,
    destructive: true,
    description:
      "An admin's install (the latest release, every host following) or removal of an optional app, by its id from apps.",
    schema: object(
      {
        action: { type: "string", enum: ["install", "remove"] },
        id: { type: "string" },
      },
      "action",
      "id",
    ),
    run: (a, m) => {
      adminOf(m);
      askerOf(m);
      const act = str(a.action);
      if (act !== "install" && act !== "remove") throw errc("bad_input", "action is install or remove");
      return pressed(src.actions.apps(act, str(a.id)));
    },
  },
];
