import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "phos-host-"));
process.env.PHOSPHORUS_HOME = dir;
const { commands, main, parse, usageText, version } = await import("@phosphorus/host");
const base = await import("../src/base.ts");
const { durText, lastLine, setHome, splitLines, sshInclude } = base;
const { plistText, xmlEsc } = await import("../src/darwin.ts");
const { escapeArg, psq } = await import("../src/windows.ts");
const { absTo, bakeEnv, envFileText, migrateHome, oldHomes, readEnvFile, signature, splitComma, withPath } =
  await import("../src/native.ts");
const { kept, syncPayload } = await import("../src/install.ts");
const { field } = await import("../src/upgrade.ts");
const { keySet } = await import("../src/start.ts");
const { desktopURLs, frontPage } = await import("../src/front.ts");

test("parse takes --update, --home and --payload, the rest in order", () => {
  expect(parse([])).toEqual({ update: false, payload: "", home: "", rest: [] });
  expect(parse(["all", "--update", "--home", "/h", "--payload", "/p", "x"])).toEqual({
    update: true,
    payload: "/p",
    home: "/h",
    rest: ["all", "x"],
  });
  // a trailing --home with no value is an ordinary argument, as Go left it
  expect(parse(["--home"])).toEqual({ update: false, payload: "", home: "", rest: ["--home"] });
});

test("commands and usage", async () => {
  for (const c of [
    "",
    "start",
    "stop",
    "restart",
    "update",
    "keys",
    "install",
    "setup",
    "rebuild",
    "upgrade",
    "run",
    "uninstall",
    "status",
    "version",
    "help",
    "-h",
    "--help",
  ])
    expect(commands.has(c)).toBe(true);
  for (const c of ["serve", "ps", "vpn", "cli"]) expect(commands.has(c)).toBe(false);
  // one usage, every command it names taken
  expect(usageText.startsWith("usage: phos ")).toBe(true);
  for (const m of usageText.matchAll(/phos (\w+)/g)) expect(commands.has(m[1]!)).toBe(true);
  expect(usageText).not.toMatch(/\b(ps|vpn|all)\b/);
  expect(await main("help", [])).toBe(0);
});

test("version reads the home's VERSION, else dev", () => {
  expect(version()).toBe("dev");
  expect(base.home).toBe(dir);
  writeFileSync(join(dir, "VERSION"), "1.2.3\n");
  expect(version()).toBe("1.2.3");
});

test("launchd plist as Go rendered it, xml escaped", () => {
  const p = plistText(
    "/Users/a&b/Library/Phosphorus/bin/phosphorus",
    "/Users/a&b/Library/Phosphorus",
    "/Users/a&b/Library/Phosphorus/state/phosphorus.log",
  );
  expect(p).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>dev.phosphorus.host</string>
	<key>ProgramArguments</key>
	<array><string>/Users/a&amp;b/Library/Phosphorus/bin/phosphorus</string><string>run</string><string>--home</string><string>/Users/a&amp;b/Library/Phosphorus</string></array>
	<key>EnvironmentVariables</key>
	<dict><key>PHOSPHORUS_HOME</key><string>/Users/a&amp;b/Library/Phosphorus</string></dict>
	<key>WorkingDirectory</key><string>/Users/a&amp;b/Library/Phosphorus</string>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>5</integer>
	<key>ExitTimeOut</key><integer>150</integer>
	<key>ProcessType</key><string>Interactive</string>
	<key>StandardOutPath</key><string>/Users/a&amp;b/Library/Phosphorus/state/phosphorus.log</string>
	<key>StandardErrorPath</key><string>/Users/a&amp;b/Library/Phosphorus/state/phosphorus.log</string>
</dict>
</plist>
`);
  expect(xmlEsc("<a&b>")).toBe("&lt;a&amp;b&gt;");
});

test("escapeArg as syscall.EscapeArg, psq as a PowerShell literal", () => {
  expect(escapeArg("")).toBe('""');
  expect(escapeArg("abc")).toBe("abc");
  expect(escapeArg("a b")).toBe('"a b"');
  expect(escapeArg(String.raw`C:\Users\x\phosphorus\bin\phosphorus.exe`)).toBe(
    String.raw`C:\Users\x\phosphorus\bin\phosphorus.exe`,
  );
  expect(escapeArg(String.raw`C:\Program Files\x`)).toBe(String.raw`"C:\Program Files\x"`);
  expect(escapeArg('a"b')).toBe(String.raw`a\"b`);
  expect(escapeArg(String.raw`a\"b`)).toBe(String.raw`a\\\"b`);
  expect(escapeArg("a b\\")).toBe('"a b\\\\"');
  expect(escapeArg("a\\b c")).toBe('"a\\b c"');
  expect(psq("it's")).toBe("'it''s'");
});

test("phos alone: the front page, linked to the desktop", () => {
  expect(desktopURLs("mesh.example", "box")).toEqual(["https://mesh.example/", "http://box/"]);
  expect(desktopURLs("", "box")).toEqual(["http://box/"]);
  expect(desktopURLs("", "")).toEqual(["http://localhost/"]);
  const f = { version: "2.15", running: true, host: "box", domain: "mesh.example", up: 4, seen: 5 };
  expect(frontPage(f, false)).toBe(
    [
      "",
      "  phosphorus 2.15",
      "  ● running on box, 4 of 5 hosts up",
      "",
      "  every app is on the desktop, open it in a browser:",
      "    https://mesh.example/",
      "    http://box/  on the tailnet",
      "",
      "  phos help lists the commands",
      "",
    ].join("\n"),
  );
  expect(frontPage({ ...f, running: false, domain: "" }, false)).toContain("● stopped on box: phos start brings it up");
  // a terminal gets an OSC 8 link, its text the URL itself
  expect(frontPage(f, true)).toContain("\x1b]8;;https://mesh.example/\x1b\\https://mesh.example/\x1b]8;;\x1b\\");
});

test("the baked env file round-trips, PATH gets the tools first", () => {
  const text = envFileText({ B: "2", A: "x=y", PATH: "/bin" });
  expect(text).toBe("# baked by phosphorus rebuild, read by phosphorus run\nA=x=y\nB=2\nPATH=/bin\n");
  expect(readEnvFile(join(dir, "nope"))).toEqual({});
  writeFileSync(join(dir, "e.env"), text.replaceAll("\n", "\r\n") + "  # c\n\n");
  expect(readEnvFile(join(dir, "e.env"))).toEqual({ A: "x=y", B: "2", PATH: "/bin" });
  if (process.platform !== "win32") {
    const env = withPath({ X: "1", Path: "/usr/bin" });
    expect(env.Path!.endsWith(":/usr/bin")).toBe(true);
    expect(env.Path!.startsWith("/")).toBe(true);
    expect(withPath({}).PATH!.endsWith("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")).toBe(true);
  }
  expect(splitComma(" a, b ,")).toEqual(["a", "b", ""]);
  expect(absTo("/h", " x/ ")).toBe(join("/h", "x"));
  expect(absTo("/h", "/abs/")).toBe("/abs");
});

test("bakeEnv from phosphorus.ini, missing share dirs skipped", () => {
  setHome(dir);
  mkdirSync(join(dir, "config"), { recursive: true });
  mkdirSync(join(dir, "share"), { recursive: true });
  writeFileSync(
    join(dir, "config", "phosphorus.ini"),
    "[files]\ndir = share/, nope, /\npriv = r,,rw\n[model]\nhost = true\n",
  );
  const m = bakeEnv();
  expect(m.PHOSPHORUS_HOME).toBe(dir);
  expect(m.STATE_DIR).toBe(join(dir, "state"));
  expect(m.PHOSPHORUS_FILES_DIRS).toBe(join(dir, "share"));
  expect(m.PHOSPHORUS_FILES_PERMS).toBe("r");
  expect(m.GIT_USER).toBeUndefined();
  const s1 = signature(m);
  expect(s1).toBe(signature({ ...m }));
  expect(signature({ ...m, X: "1" })).not.toBe(s1);
  expect(s1).toMatch(/^[0-9a-f]{64}$/);
});

test("syncPayload copies the release, keeps this host's config, leaves services.export out, prunes the last release's files", () => {
  const src = join(dir, "payload"),
    dst = join(dir, "home");
  mkdirSync(join(src, "config"), { recursive: true });
  mkdirSync(join(src, "web", "assets"), { recursive: true });
  writeFileSync(join(src, "VERSION"), "2\n");
  writeFileSync(join(src, "config", "services.export"), "[new]\n");
  writeFileSync(join(src, "config", "phosphorus.ini"), "new\n");
  writeFileSync(join(src, "web", "assets", "a.js"), "a");
  writeFileSync(join(src, ".phosphorus-installed"), "x");
  mkdirSync(join(dst, "config"), { recursive: true });
  mkdirSync(join(dst, "old", "deep"), { recursive: true });
  writeFileSync(join(dst, "config", "services.export"), "[mine]\n");
  writeFileSync(join(dst, "old", "deep", "gone.js"), "g");
  writeFileSync(join(dst, "old", "stay.txt"), "s");
  writeFileSync(join(dst, ".phosphorus-manifest"), "old/deep/gone.js\nconfig/phosphorus.ini\nfiles/x\n");
  syncPayload(src, dst);
  expect(readFileSync(join(dst, "VERSION"), "utf8")).toBe("2\n");
  expect(readFileSync(join(dst, "config", "services.export"), "utf8")).toBe("[mine]\n");
  expect(readFileSync(join(dst, "config", "phosphorus.ini"), "utf8")).toBe("new\n");
  expect(readFileSync(join(dst, "web", "assets", "a.js"), "utf8")).toBe("a");
  expect(existsSync(join(dst, ".phosphorus-installed"))).toBe(false);
  expect(existsSync(join(dst, "old", "deep"))).toBe(false);
  expect(existsSync(join(dst, "old", "stay.txt"))).toBe(true);
  expect(readFileSync(join(dst, ".phosphorus-manifest"), "utf8")).toBe(
    `VERSION\n${process.platform === "win32" ? "bin/phos.exe\nbin/phosphorus.exe" : "bin/phosphorus"}\nconfig/phosphorus.ini\nweb/assets/a.js\n`,
  );
  expect(kept("config/services.export")).toBe(false);
  expect(kept("config/phosphorus.ini")).toBe(true);
  expect(kept("files/a/b")).toBe(true);
  expect(kept("web/a")).toBe(false);
});

test("small helpers", () => {
  expect(field("phosphorus:\n  Installed: 1.0\n  Candidate: 1.1\n", "Candidate:")).toBe("1.1");
  expect(field("x", "Installed:")).toBe("");
  expect(lastLine("a\nE: bad\nok\n", /ERROR|E:/)).toBe("E: bad");
  expect(lastLine("a\nb\n")).toBe("b");
  expect(lastLine("", /x/)).toBe("");
  expect(keySet({ TS_AUTHKEY: "k", BASE_DOMAIN: "" })).toEqual({
    TS_AUTHKEY: true,
    BASE_DOMAIN: false,
    TUNNEL_TOKEN: false,
    TS_API_KEY: false,
    ADMIN_PASS: false,
  });
  expect(durText(5000)).toBe("5s");
  expect(durText(60_000)).toBe("1m0s");
  expect(splitLines("a\r\nb\n")).toEqual(["a", "b"]);
  expect(sshInclude()).toBe(`Include "${join(dir, "state", "ssh_config").replaceAll("\\", "/")}"`);
});

test("the home moved once into <phosphorus>/home, files/ gone, a clash left behind", () => {
  setHome(dir);
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "phosphorus.ini"), "[home]\ndir = big\n");
  mkdirSync(join(dir, "files", "home", "ann", "Desktop"), { recursive: true });
  writeFileSync(join(dir, "files", "home", "ann", "Desktop", "a.txt"), "a");
  mkdirSync(join(dir, "big", "home", "ann"), { recursive: true });
  writeFileSync(join(dir, "big", "home", "ann", "b.txt"), "b");
  mkdirSync(join(dir, "home", "bob"), { recursive: true });
  writeFileSync(join(dir, "home", "bob", "c.txt"), "c");
  writeFileSync(join(dir, "big", "home", "bob.txt"), "old");
  writeFileSync(join(dir, "home", "bob.txt"), "new");
  const old = oldHomes();
  expect(old).toEqual([join(dir, "big", "home"), join(dir, "files", "home")]);
  migrateHome(old);
  for (const [p, t] of [
    ["ann/Desktop/a.txt", "a"],
    ["ann/b.txt", "b"],
    ["bob/c.txt", "c"],
    ["bob.txt", "new"],
  ])
    expect(readFileSync(join(dir, "home", p!), "utf8")).toBe(t!);
  expect(existsSync(join(dir, "files"))).toBe(false);
  expect(readFileSync(join(dir, "big", "home", "bob.txt"), "utf8")).toBe("old");
  expect(oldHomes()).toEqual([join(dir, "big", "home")]);
});
