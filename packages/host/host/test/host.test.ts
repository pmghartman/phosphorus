import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "phos-host-"));
process.env.PHOSPHORUS_HOME = dir;
const { commands, main, parse, usageText, version } = await import("@phosphorus/host");
const base = await import("../src/base.ts");
const { durText, lastLine, setHome, splitLines, sshInclude } = base;
const { plistText, xmlEsc } = await import("../src/darwin.ts");
const { escapeArg, psq } = await import("../src/windows.ts");
const { absTo, bakeEnv, envFileText, readEnvFile, signature, splitComma, withPath } = await import("../src/native.ts");
const { packaged, same, syncPayload } = await import("../src/install.ts");
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

test("bakeEnv from this host's settings record, missing share dirs skipped", () => {
  setHome(dir);
  mkdirSync(join(dir, "share"), { recursive: true });
  mkdirSync(join(dir, "state", "run"), { recursive: true });
  mkdirSync(join(dir, "sys", "etc", "hosts", "mike"), { recursive: true });
  writeFileSync(join(dir, "state", "run", "self-host"), "mike\n");
  const shares = [
    { dir: "share/", perms: "r" },
    { dir: "nope", perms: "" },
    { dir: "/", perms: "rw" },
  ];
  writeFileSync(
    join(dir, "sys", "etc", "hosts", "mike", "config.json"),
    JSON.stringify({ t: Date.now(), h: "mike", c: "x", data: { shares, model: { host: true } } }),
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

test("syncPayload copies the release, prunes the last release's files", () => {
  const src = join(dir, "payload"),
    dst = join(dir, "home");
  mkdirSync(join(src, "web", "assets"), { recursive: true });
  writeFileSync(join(src, "VERSION"), "2\n");
  writeFileSync(join(src, "web", "assets", "a.js"), "a");
  writeFileSync(join(src, ".phosphorus-installed"), "x");
  mkdirSync(join(dst, "old", "deep"), { recursive: true });
  writeFileSync(join(dst, "old", "deep", "gone.js"), "g");
  writeFileSync(join(dst, "old", "stay.txt"), "s");
  writeFileSync(join(dst, ".phosphorus-manifest"), "old/deep/gone.js\n");
  syncPayload(src, dst);
  expect(readFileSync(join(dst, "VERSION"), "utf8")).toBe("2\n");
  expect(readFileSync(join(dst, "web", "assets", "a.js"), "utf8")).toBe("a");
  expect(existsSync(join(dst, ".phosphorus-installed"))).toBe(false);
  expect(existsSync(join(dst, "old", "deep"))).toBe(false);
  expect(existsSync(join(dst, "old", "stay.txt"))).toBe(true);
  expect(readFileSync(join(dst, ".phosphorus-manifest"), "utf8")).toBe(
    `VERSION\n${process.platform === "win32" ? "bin/phos.exe\nbin/phosphorus.exe" : "bin/phosphorus"}\nweb/assets/a.js\n`,
  );
});

test("an unchanged file left as it is, a changed one copied", () => {
  const src = join(dir, "same-src"),
    dst = join(dir, "same-dst");
  mkdirSync(src, { recursive: true });
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(src, "a"), "one");
  syncPayload(src, dst);
  // same bytes, other mtime: compared, not rewritten
  utimesSync(join(dst, "a"), 1, 1);
  expect(same(join(src, "a"), join(dst, "a"))).toBe(true);
  syncPayload(src, dst);
  expect(statSync(join(dst, "a")).mtimeMs).toBe(1000);
  writeFileSync(join(src, "a"), "two");
  expect(same(join(src, "a"), join(dst, "a"))).toBe(false);
  syncPayload(src, dst);
  expect(readFileSync(join(dst, "a"), "utf8")).toBe("two");
  expect(same(join(src, "a"), join(dir, "nope"))).toBe(false);
  expect(packaged("/usr/lib/phosphorus/bin/phosphorus")).toBe(process.platform === "linux");
  expect(packaged("/var/lib/phosphorus/bin/phosphorus")).toBe(false);
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

test("the tools pinned per OS, fetched only when a pin moves or a file is gone", async () => {
  const { Cloudflared, ensureTools, pins, Tailscale } = await import("../src/tools.ts");
  const { os } = await import("../src/os.ts");
  const names = (p: { files: Record<string, string> }[]) => p.flatMap((x) => Object.keys(x.files));
  expect(names(pins("linux", "x64"))).toEqual(["tailscale", "tailscaled", "cloudflared"]);
  expect(names(pins("linux", "arm64", false))).toEqual(["cloudflared"]);
  expect(names(pins("darwin", "arm64"))).toEqual(["cloudflared"]);
  expect(names(pins("win32", "x64"))).toEqual(["cloudflared.exe"]);
  expect(pins("linux", "arm64")[0]!.url).toContain(`tailscale_${Tailscale}_arm64.tgz`);

  // every pin's file here at its version: nothing fetched
  const lib = os.libexec();
  mkdirSync(lib, { recursive: true });
  const want = pins();
  for (const p of want) for (const f of Object.keys(p.files)) writeFileSync(join(lib, f), "x");
  writeFileSync(join(lib, "versions.json"), JSON.stringify(Object.fromEntries(want.map((p) => [p.name, p.ver]))));
  const real = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = (async () => {
    asked++;
    return new Response("not cloudflared");
  }) as unknown as typeof fetch;
  try {
    await ensureTools();
    expect(asked).toBe(0);
    // a moved pin fetched, the wrong bytes refused
    writeFileSync(join(lib, "versions.json"), JSON.stringify({ cloudflared: "old", tailscale: Tailscale }));
    await expect(ensureTools()).rejects.toThrow(/checksum mismatch/);
    expect(asked).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(join(lib, "versions.json"), "utf8")).cloudflared).toBe("old");
  } finally {
    globalThis.fetch = real;
  }
  expect(Cloudflared).toMatch(/^\d{4}\.\d+\.\d+$/);
}, 30_000);

test("afterglow: its config with the link on and GameStream off, the token kept, the driver's version", async () => {
  const ag = await import("../src/afterglow.ts");
  const p = ag.pathsOf("C:\\Users\\me\\phosphorus\\state\\data\\afterglow");
  const conf = ag.confText(p, ag.linkPort, "ab".repeat(24));
  const kv = Object.fromEntries(
    conf
      .split("\r\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split(" = ")),
  );
  expect(kv.phos_link_port).toBe("47100");
  expect(kv.phos_link_token).toBe("ab".repeat(24));
  expect(kv.system_tray).toBe("disabled");
  expect(kv.upnp).toBe("off");
  expect(kv.file_apps).toBe(p.apps);
  expect(kv.dd_configuration_option).toBe("ensure_primary");
  expect(JSON.parse(ag.appsText())).toEqual({ env: {}, apps: [] });
  expect(JSON.parse(ag.linkText(47100, "t"))).toEqual({ port: 47100, token: "t" });
  expect(ag.svcBinPath("C:\\h\\afterglow", "C:\\d\\afterglow.conf")).toBe(
    `"${join("C:\\h\\afterglow", "tools", "afterglowsvc.exe")}" "C:\\d\\afterglow.conf"`,
  );
  const t = "0123456789abcdef".repeat(3);
  expect(ag.tokenOf(ag.linkText(47100, t), () => "fresh")).toBe(t);
  expect(ag.tokenOf("not json", () => "fresh")).toBe("fresh");
  expect(ag.tokenOf(ag.linkText(47100, "short"), () => "fresh")).toBe("fresh");
  expect(ag.driverVer("[Version]\r\nDriverVer = 07/14/2025,1.10.9.289\r\n")).toBe("07/14/2025,1.10.9.289");
});
