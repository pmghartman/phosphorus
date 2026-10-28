import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, sep } from "node:path";
import type { Entry, Share } from "@phosphorus/files";

process.env.HOME_FS = mkdtempSync(join(tmpdir(), "phos-files-"));
const F = await import("@phosphorus/files");
const share = (real: string): Share => ({ id: "0", label: "", perms: "rwd", root: real, real, ok: true });

// a share of a whole drive or the root holds what's under it, its separator already its own
test("inside root", () => {
  const wd = process.cwd();
  const root = parse(wd).root;
  const sh = share(root);
  expect(F.inside(sh, root) && F.inside(sh, wd)).toBe(true);
  const dir = share(wd);
  expect(F.inside(dir, join(wd, "x"))).toBe(true);
  expect(F.inside(dir, wd + "x") || F.inside(dir, dirname(wd))).toBe(false);
  expect(F.toAbs(sh, "a/b")).toBe(join(root, "a", "b"));
});

test("system folder is admins only", () => {
  const isUser = (s: string) => s === "ann" || s === "bob";
  const admin = { user: "root", admin: true }, ann = { user: "ann", admin: false };
  for (const rel of ["/.sys", "/.sys/etc/x.json", "/.SYS/home/ann/prefs.json"]) {
    expect(F.homeGate(admin, rel, isUser)).toBe("");
    expect(F.homeGate(ann, rel, isUser)).toBe(F.Gone);
  }
  expect(F.homeGate(ann, "/ann/notes.txt", isUser)).toBe("");
  expect(F.homeGate(ann, "/bob/notes.txt", isUser)).not.toBe("");
  expect([F.gateCode(ann, F.Gone), F.gateCode(undefined, "log in"), F.gateCode(ann, "admins only")]).toEqual([404, 401, 403]);
  const entries = [".sys", "ann", "shared"].map((name) => ({ name, dir: true, link: false, size: null, mtime: null }));
  const names = (es: Entry[]) => es.map((e) => e.name).join(",");
  expect(names(F.homeFilterList(ann, "", entries, isUser))).toBe("ann,shared");
  // an admin sees the system's folder, though never another user's home
  expect(names(F.homeFilterList(admin, "", entries, isUser))).toBe(".sys,shared");
});

test("save, read, upload, list", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "phos-share-")));
  const sh = share(root);
  expect((await F.save(sh, "a/b.txt", { text: "hello world" }))[0]).toBe(200);
  expect((await F.save(sh, "a/b.txt", { old: "world", new: "there" }))[1].ok).toBe(true);
  expect((await F.read(sh, "a/b.txt"))[1].text).toBe("hello there");
  const body = (s: string) => new Blob([s]).stream();
  expect((await F.write(sh, "up.bin", body("abc"), { id: "abcdefgh", offset: 0, total: 6 }))[1].next).toBe(3);
  expect((await F.write(sh, "up.bin", body("def"), { id: "abcdefgh", offset: 3, total: 6 }))[1].path).toBe("up.bin");
  expect((await F.read(sh, "up.bin"))[1].text).toBe("abcdef");
  const [, l] = await F.list(sh, "");
  expect(l.entries.map((e: Entry) => e.name)).toEqual(["a", "up.bin"]);
  expect((await F.read(sh, "../x"))[0]).toBe(400);
  const [, s] = await F.search(sh, "", "there", true, "");
  expect(s.results).toEqual([{ path: "a/b.txt", matches: [{ line: 1, text: "hello there" }] }]);
  const [, t] = await F.tree(sh, "", 3, "");
  expect(t.entries.map((e: any) => e.path)).toEqual(["a/", "up.bin", "a/b.txt"]);
  expect(sep.length).toBe(1);
});
