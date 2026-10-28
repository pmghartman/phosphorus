import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { runSync } from "@phosphorus/util";
import { lsCommand, uploadCommand } from "../src/fs.ts";
import { dupNames, okDir, okName, parseLs } from "../src/index.ts";
import { tmp } from "./fake.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

test("parse ls", () => {
  const out =
    "/home/pmh\x00fzeta.txt\x00dsrc\x00fodd\nname\x00dAlpha\x00\x00" + "12 1700000000\n4096 1700000001\n3 5\n4096 7\n";
  const { dir, entries, more } = parseLs(bytes(out));
  expect([dir, more]).toEqual(["/home/pmh", false]);
  expect(entries).toEqual([
    { name: "Alpha", dir: true, size: 4096, mtime: 7000 },
    { name: "src", dir: true, size: 4096, mtime: 1700000001000 },
    { name: "odd\nname", dir: false, size: 3, mtime: 5000 },
    { name: "zeta.txt", dir: false, size: 12, mtime: 1700000000000 },
  ]);
  // stat lines that don't line up dropped, the names kept; more flagged
  const r = parseLs(bytes("/x\x00fa\x00fb\x001\x00" + "1 2\n"));
  expect([r.more, r.entries.length, r.entries[0]!.size]).toEqual([true, 2, 0]);
  for (const bad of ["", "relative\x00\x00", "/x\x00fa"])
    expect(() => parseLs(bytes(bad))).toThrow("unreadable listing");
});

test("dup names", () => {
  expect(dupNames("shot.final.png", 2)).toEqual(["shot.final.png", "shot.final (1).png", "shot.final (2).png"]);
  expect(dupNames(".env", 1)[1]).toBe(".env (1)");
  expect(dupNames("README", 1)[1]).toBe("README (1)");
  for (const [n, ok] of Object.entries({
    "a.txt": true,
    "it's $(x).txt": true,
    "": false,
    ".": false,
    "..": false,
    "a/b": false,
    "a\nb": false,
  }))
    expect(okName(n), n).toBe(ok);
  for (const [d, ok] of Object.entries({
    "": true,
    "~": true,
    "~/x": true,
    "/x": true,
    x: false,
    "~x": false,
    "/a\nb": false,
  }))
    expect(okDir(d), d).toBe(ok);
});

// the scripts run by a local sh in place of the login shell, paths that
// would break or inject if spliced in
test.skipIf(process.platform === "win32" || !Bun.which("sh"))("fs scripts run", () => {
  const home = tmp("fs");
  const odd = join(home, `it's $(touch pwned) "x"`);
  mkdirSync(join(odd, "sub dir"), { recursive: true });
  mkdirSync(join(odd, ".hidden"), { recursive: true });
  writeFileSync(join(odd, "-rf"), "abc");
  writeFileSync(join(odd, "new\nline"), "");
  symlinkSync("/nowhere", join(odd, "dangling"));
  const sh = (cmd: string, stdin: string) => {
    const r = runSync(["sh", "-c", cmd], { env: { HOME: home, PATH: "/usr/bin:/bin" }, cwd: home, input: stdin });
    return [r.stdout, r.code] as const;
  };
  const [out, code] = sh(lsCommand("~/" + basename(odd)), "");
  expect(code, out).toBe(0);
  const { dir, entries, more } = parseLs(bytes(out));
  expect(more).toBe(false);
  expect(dir).toBe(realpathSync(odd));
  for (const e of entries) if (e.name === "-rf") expect([e.size, e.dir, e.mtime > 0]).toEqual([3, false, true]);
  expect(entries.map((e) => e.name).join("|")).toBe(".hidden|sub dir|-rf|dangling|new\nline");
  expect(existsSync(join(home, "pwned"))).toBe(false);
  // home by default, an empty folder, a missing one
  expect(sh(lsCommand(""), "")[0]).toContain(basename(home));
  const [empty, ec] = sh(lsCommand(join(odd, "sub dir")), "");
  expect(ec).toBe(0);
  expect(empty.endsWith("sub dir\x00\x00")).toBe(true);
  expect(sh(lsCommand("/nowhere/at/all"), "")[1]).toBe(3);
  // uploads: the name, then "name (1)", never overwriting
  for (const want of ["a b.txt", "a b (1).txt", "a b (2).txt"]) {
    const [p, c] = sh(uploadCommand(odd, 5, dupNames("a b.txt", 2)), "hello");
    expect([c, basename(p)]).toEqual([0, want]);
  }
  expect(sh(uploadCommand(odd, 5, dupNames("a b.txt", 2)), "hello")[1]).toBe(4);
  expect(readFileSync(join(odd, "a b.txt"), "utf8")).toBe("hello");
  // cut short: gone again
  expect(sh(uploadCommand(odd, 9, dupNames("short.bin", 1)), "abc")[1]).toBe(5);
  expect(existsSync(join(odd, "short.bin"))).toBe(false);
  const [p, c] = sh(uploadCommand("~/" + basename(odd), 2, ["$(touch pwned)"]), "hi");
  expect(c).toBe(0);
  expect(p.endsWith("/$(touch pwned)")).toBe(true);
  expect(existsSync(join(home, "pwned"))).toBe(false);
});
