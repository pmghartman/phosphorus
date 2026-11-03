import { beforeEach, expect, test } from "bun:test";
import { GitHubError, openRepo, repoOf, setHosts } from "../src/github.ts";
import { json } from "./helpers.ts";

// a stubbed GitHub: repos by owner/name, each its metadata and files
type Repo = { meta: Record<string, any>; files: Record<string, string> };
const repos: Record<string, Repo> = {
  "acme/notes": {
    meta: {
      name: "notes",
      full_name: "acme/notes",
      html_url: "https://github.com/acme/notes",
      description: "Notes, self-hosted",
      default_branch: "main",
      license: { spdx_id: "MIT" },
      topics: ["productivity"],
      owner: { avatar_url: "https://avatars.test/acme" },
    },
    files: {
      "README.md": "# Notes\n",
      "docker/compose.yml": [
        "services:",
        "  app:",
        "    build: ..",
        "    ports: ['3000:3000']",
        "    env_file: .env",
        "    volumes:",
        "      - ./uploads:/app/uploads",
        "      - ./nginx.conf:/etc/nginx.conf:ro",
        "  db:",
        "    image: postgres:16",
        "    volumes: [pg:/var/lib/postgresql/data]",
        "volumes:",
        "  pg: {}",
        "",
      ].join("\n"),
      "docker/nginx.conf": "events {}",
      "phos.yml": "tagline: Your notes, on your mesh\nhealth:\n  service: app\n  path: /healthz\n",
    },
  },
  "acme/lib": {
    meta: { name: "lib", full_name: "acme/lib", default_branch: "main", license: null, owner: {} },
    files: { "README.md": "a library", "src/index.ts": "" },
  },
};
let limited = false;
let calls = 0;

const f = async (url: string) => {
  calls++;
  if (limited)
    return json({ message: "API rate limit exceeded" }, 403, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1893456000",
    });
  let m = /^https:\/\/api\.test\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(url);
  if (m) {
    const r = repos[m[1]!];
    if (!r) return json({ message: "Not Found" }, 404);
    const rest = m[2] ?? "";
    if (!rest) return json(r.meta);
    if (rest === "/readme") return r.files["README.md"] ? new Response(r.files["README.md"]) : json({}, 404);
    if (rest.startsWith("/git/trees/")) {
      const dirs = new Set<string>();
      for (const p of Object.keys(r.files)) {
        const parts = p.split("/");
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
      }
      return json({
        tree: [
          ...[...dirs].map((path) => ({ path, type: "tree" })),
          ...Object.entries(r.files).map(([path, t]) => ({ path, type: "blob", size: t.length })),
        ],
        truncated: false,
      });
    }
  }
  m = /^https:\/\/raw\.test\/([^/]+\/[^/]+)\/main\/(.+)$/.exec(url);
  if (m) {
    const t = repos[m[1]!]?.files[m[2]!];
    return t === undefined ? new Response("404", { status: 404 }) : new Response(t);
  }
  return new Response("?", { status: 500 });
};

beforeEach(() => {
  setHosts("https://api.test", "https://raw.test");
  limited = false;
  calls = 0;
});

test("repo urls", () => {
  expect(repoOf("https://github.com/acme/notes")).toBe("acme/notes");
  expect(repoOf("github.com/acme/notes.git")).toBe("acme/notes");
  expect(repoOf("https://github.com/acme/notes/tree/dev")).toBe("acme/notes@dev");
  expect(repoOf("https://github.com/acme/notes/blob/main/README.md")).toBe("acme/notes");
  expect(repoOf("acme/notes")).toBe("acme/notes");
  expect(repoOf("https://gitlab.com/acme/notes")).toBeUndefined();
});

test("a repo opened: metadata, licence, README, tree, compose made to run from its clone", async () => {
  const o = await openRepo("https://github.com/acme/notes", f);
  expect(o.readme).toBe("# Notes\n");
  expect(o.tree.map((e) => e.path)).toContain("docker/compose.yml");
  const d = o.def;
  expect(d).toMatchObject({
    id: "notes",
    source: "github",
    ref: "acme/notes",
    licence: "MIT",
    category: "productivity",
    icon: "https://avatars.test/acme",
    tagline: "Your notes, on your mesh",
  });
  const c = Bun.YAML.parse(d.compose) as any;
  expect(c.services.app.build).toBe("${APP_REPO}");
  expect(c.services.app.volumes).toEqual([
    "${APP_DATA}/docker/uploads:/app/uploads",
    "${APP_REPO}/docker/nginx.conf:/etc/nginx.conf:ro",
  ]);
  expect(c.services.app.env_file).toEqual([{ path: "${APP_REPO}/docker/.env", required: false }]);
  // phos.yml's health over the derived; the derived volumes and postgres dump kept
  expect(d.manifest.health).toEqual({ service: "app", path: "/healthz", port: undefined });
  expect(d.manifest.volumes).toContainEqual({ service: "app", target: "/app/uploads", kind: "data" });
  expect(d.manifest.backup?.pre?.[0]?.service).toBe("db");
  expect(d.manifest.web).toEqual({ service: "app", port: 3000 });
});

test("kept a while: opened again without asking GitHub", async () => {
  await openRepo("acme/notes", f);
  const n = calls;
  await openRepo("https://github.com/acme/notes", f);
  expect(calls).toBe(n);
});

test("no compose file: kept empty for the check to block", async () => {
  const o = await openRepo("acme/lib", f);
  expect(o.def.compose).toBe("");
  expect(o.def.licence).toBe("NOASSERTION");
});

test("missing repos and a spent rate limit say so", async () => {
  await expect(openRepo("acme/nope", f)).rejects.toMatchObject({
    status: 404,
    message: "no public repo acme/nope on GitHub",
  });
  limited = true;
  const e = (await openRepo("acme/other", f).catch((e) => e)) as GitHubError;
  expect(e).toBeInstanceOf(GitHubError);
  expect(e.status).toBe(429);
  expect(e.message).toContain("limit on unauthenticated calls");
  expect(e.message).toContain("until 00:00 UTC");
  await expect(openRepo("not a url", f)).rejects.toMatchObject({ status: 400 });
});
