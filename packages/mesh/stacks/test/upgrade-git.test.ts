// after stacks.test.ts, which sets the env @phosphorus/util reads on its first import:
// the old built-in git's data folder (fixtures/legacy-git, a db made here) moved into
// the git stack, installed with the old servants as standbys, deleted once cleared
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppDef } from "@phosphorus/wire";

const dir = mkdtempSync(join(tmpdir(), "phos-upgrade-git-"));
const old = join(dir, "git");
process.env.LEGACY_GIT_DIR = old;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const S = await import("@phosphorus/stacks");

cpSync(join(import.meta.dir, "fixtures", "legacy-git"), old, { recursive: true });
mkdirSync(join(old, "db"));
const db = new Database(join(old, "db", "forgejo.db"));
db.run("CREATE TABLE repository (id INTEGER PRIMARY KEY, owner_name TEXT, name TEXT)");
db.run("INSERT INTO repository (owner_name, name) VALUES ('alice', 'app')");
db.close();

// the featured Forgejo as far as the move reads it
const forgejo: AppDef = {
  id: "git",
  source: "phosphorus",
  ref: "forgejo",
  name: "Forgejo",
  tagline: "",
  description: "",
  icon: "",
  category: "developer",
  repo: "",
  licence: "GPL-3.0-or-later",
  archs: [],
  compose: "services:\n  forgejo:\n    image: codeberg.org/forgejo/forgejo:16\n    volumes:\n      - forgejo:/data\n",
  env: [
    { name: "SECRET_KEY", label: "Secret key", secret: true },
    { name: "INTERNAL_TOKEN", label: "Internal token", secret: true },
  ],
  manifest: {
    volumes: [{ service: "forgejo", target: "/data", kind: "data" }],
    web: { service: "forgejo", port: 3000 },
  },
};
S.seams.hosts = () => ["a", "b", "c"];
S.seams.defOf = async (source, ref) => (source === "phosphorus" && ref === "forgejo" ? forgejo : undefined);

const data = () => join(S.dirOf("git"), "data", "forgejo");
const read = (...p: string[]) => readFileSync(join(data(), ...p), "utf8");

test("the old app.ini's paths become the image's", () => {
  const ini = S.rewriteIni(readFileSync(join(old, "conf", "app.ini"), "utf8"));
  expect(ini).toContain("PATH    = /data/gitea/forgejo.db");
  expect(ini).toContain("ROOT = /data/git/repositories");
  expect(ini).toContain("[lfs]\nPATH = /data/git/lfs");
  expect(ini).toContain("APP_DATA_PATH    = /data/gitea\n");
  expect(ini).toContain("AVATAR_UPLOAD_PATH      = /data/gitea/avatars");
  expect(ini).toContain("RUN_USER = git\n");
  expect(ini).not.toContain("WORK_PATH");
  expect(ini).not.toContain("/var/lib/phosphorus");
});

test("the old copy is offered with its version", () => {
  expect(S.legacyInfo()).toEqual({ gen: 7, stamp: 1761000000 });
  expect(S.legacyInfo(join(dir, "nothing"))).toBeUndefined();
});

test("a move asked of a host that isn't one is refused", () => {
  expect(S.LegacyMove({ from: "zed", standbys: [] }, "admin")[0]).toBe(400);
  expect(S.LegacyMove({ from: "a", standbys: ["zed"] }, "admin")[0]).toBe(400);
});

test("the master's copy moves into the git stack, the servants its standbys", async () => {
  const [st, out] = S.LegacyMove({ from: "a", standbys: ["b", "c", "a"] }, "admin");
  expect(st).toBe(200);
  expect(out.legacy).toMatchObject({ from: "a", standbys: ["b", "c"], state: "asked" });
  // only the asked host moves it
  await S.tickLegacy("b");
  expect(S.legacyOf()?.state).toBe("asked");
  await S.tickLegacy("a");
  expect(S.legacyOf()).toMatchObject({ state: "moved", from: "a" });

  const w = S.wantOf("git")!;
  expect(w).toMatchObject({ active: "a", standbys: ["b", "c"], gen: 1, by: "admin" });
  expect(w.def.source).toBe("phosphorus");
  const [env] = S.opened(w);
  expect(env).toEqual({ SECRET_KEY: "fixture-secret-key", INTERNAL_TOKEN: "fixture.internal.token" });
  expect(w.env.SECRET_KEY).toStartWith("sealed:");

  // the image's layout under /data
  const moved = new Database(join(data(), "gitea", "forgejo.db"), { readonly: true });
  expect(moved.query("SELECT owner_name, name FROM repository").all()).toEqual([{ owner_name: "alice", name: "app" }]);
  moved.close();
  expect(read("git", "repositories", "alice", "app.git", "HEAD")).toBe("ref: refs/heads/main\n");
  expect(read("git", "lfs", "ab", "cd", "abcd0001")).toBe("lfs object\n");
  expect(read("gitea", "avatars", "alice")).toBe("png\n");
  expect(read("gitea", "attachments", "1", "report")).toBe("pdf\n");
  expect(read("gitea", "templates", "home.tmpl")).toContain("home");
  expect(read("gitea", "public", "assets", "site.css")).toBe("body{}\n");
  const ini = read("gitea", "conf", "app.ini");
  expect(ini).toContain("LFS_JWT_SECRET   = lfs-jwt-fixture");
  expect(ini).toContain("JWT_SECRET = oauth-jwt-fixture");
  expect(ini).not.toContain("/var/lib/phosphorus");
  // the server hooks call the image's forgejo
  expect(read("git", "repositories", "alice", "app.git", "hooks", "pre-receive.d", "gitea")).toBe(
    `#!/usr/bin/env bash\n"/app/gitea/gitea" hook --config='/data/gitea/conf/app.ini' pre-receive\n`,
  );
  expect(read("git", "repositories", "alice", "app.git", "hooks", "pre-receive")).toContain("hookname=$(basename $0)");
  // the rebuildable and the old daemon's own left behind
  for (const p of ["log", "queues", "GIT_VERSION", "GIT_CHANGE", "snap", "db"])
    expect(existsSync(join(data(), "gitea", p)) || existsSync(join(data(), p))).toBe(false);
  expect(existsSync(`${data()}.part`)).toBe(false);
  // nothing deleted yet
  expect(existsSync(join(old, "db", "forgejo.db"))).toBe(true);
});

test("a second move is refused once the stack is installed", () => {
  const [st, out] = S.LegacyMove({ from: "a", standbys: [] }, "admin");
  expect(st).toBe(409);
  expect(out.error).toContain("already installed");
});

test("the old copies stay until the admin says the stack serves", async () => {
  const [st, out] = S.LegacyClear("admin", false);
  expect(st).toBe(409);
  expect(out.error).toContain("isn't serving");
  await S.tickLegacy("a");
  expect(existsSync(old)).toBe(true);

  expect(S.LegacyClear("admin", true)[0]).toBe(200);
  await S.tickLegacy("b");
  expect(existsSync(old)).toBe(false);
  expect(S.legacyInfo()).toBeUndefined();
  // the stack's copy untouched
  expect(existsSync(join(data(), "gitea", "forgejo.db"))).toBe(true);
});

test("a failed move leaves no half copy and says why", async () => {
  const other = join(dir, "git2");
  process.env.LEGACY_GIT_DIR = other;
  mkdirSync(join(other, "db"), { recursive: true });
  // nothing to copy: the db is empty
  const [st] = S.LegacyMove({ from: "a", standbys: [] }, "admin");
  expect(st).toBe(409);
  S.Remove("git", true, "admin");
  rmSync(data(), { recursive: true, force: true });
  expect(S.LegacyMove({ from: "a", standbys: [] }, "admin")[0]).toBe(200);
  await S.tickLegacy("a");
  expect(S.legacyOf()).toMatchObject({ state: "failed" });
  expect(S.legacyOf()?.error).toContain("no forgejo.db");
  expect(existsSync(data())).toBe(false);
  expect(S.wantOf("git")).toBeUndefined();
});
