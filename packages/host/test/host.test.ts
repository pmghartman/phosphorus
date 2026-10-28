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
const { authorizedKeysKept, gameKeyLine } = await import("../src/game.ts");
const { absTo, bakeEnv, envFileText, psText, readEnvFile, signature, splitComma, withPath } = await import("../src/native.ts");
const { kept, syncPayload } = await import("../src/install.ts");
const { field } = await import("../src/upgrade.ts");
const { keySet } = await import("../src/start.ts");

test("parse takes --update, --home and --payload, the rest in order", () => {
  expect(parse([])).toEqual({ update: false, payload: "", home: "", rest: [] });
  expect(parse(["all", "--update", "--home", "/h", "--payload", "/p", "x"])).toEqual({ update: true, payload: "/p", home: "/h", rest: ["all", "x"] });
  // a trailing --home with no value is an ordinary argument, as Go left it
  expect(parse(["--home"])).toEqual({ update: false, payload: "", home: "", rest: ["--home"] });
});

test("commands and usage", async () => {
  for (const c of ["", "start", "stop", "restart", "update", "keys", "install", "setup", "rebuild", "upgrade", "game-control", "game-control-setup", "run", "ps", "uninstall", "status", "vpn", "help", "-h", "--help"]) expect(commands.has(c)).toBe(true);
  expect(commands.has("serve")).toBe(false);
  expect(usageText.startsWith("usage: phos             the cli")).toBe(true);
  expect(await main("help", [])).toBe(0);
});

test("version reads the home's VERSION, else dev", () => {
  expect(version()).toBe("dev");
  expect(base.home).toBe(dir);
  writeFileSync(join(dir, "VERSION"), "1.2.3\n");
  expect(version()).toBe("1.2.3");
});

test("launchd plist as Go rendered it, xml escaped", () => {
  const p = plistText("/Users/a&b/Library/Phosphorus/bin/phosphorus", "/Users/a&b/Library/Phosphorus", "/Users/a&b/Library/Phosphorus/state/phosphorus.log");
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
  expect(escapeArg(String.raw`C:\Users\x\phosphorus\bin\phosphorus.exe`)).toBe(String.raw`C:\Users\x\phosphorus\bin\phosphorus.exe`);
  expect(escapeArg(String.raw`C:\Program Files\x`)).toBe(String.raw`"C:\Program Files\x"`);
  expect(escapeArg('a"b')).toBe(String.raw`a\"b`);
  expect(escapeArg(String.raw`a\"b`)).toBe(String.raw`a\\\"b`);
  expect(escapeArg("a b\\")).toBe('"a b\\\\"');
  expect(escapeArg("a\\b c")).toBe('"a\\b c"');
  expect(psq("it's")).toBe("'it''s'");
});

test("the play/stop key's authorized_keys line and what's kept around it", () => {
  const pub = "ssh-ed25519 AAAAC3 phosphorus-game-control\n";
  const line = gameKeyLine("/var/lib/phosphorus/bin/phosphorus", "/var/lib/phosphorus", pub);
  expect(line).toBe('restrict,command="/var/lib/phosphorus/bin/phosphorus game-control --home /var/lib/phosphorus" ssh-ed25519 AAAAC3 phosphorus-game-control');
  expect(gameKeyLine(String.raw`C:\p\bin\phosphorus.exe`, String.raw`C:\p`, pub)).toBe(String.raw`restrict,command="C:\\p\\bin\\phosphorus.exe game-control --home C:\\p" ssh-ed25519 AAAAC3 phosphorus-game-control`);
  const keyPart = "ssh-ed25519 AAAAC3";
  // already there: nothing to write
  expect(authorizedKeysKept("ssh-rsa X me\n" + line + "\n", line, keyPart)).toBeUndefined();
  // an older line for the key, a stale script line and blanks dropped; others kept
  const old = 'command="/old/game.sh" ssh-ed25519 AAAAC3 phosphorus-game-control';
  expect(authorizedKeysKept(`ssh-rsa X me\n\n${old}\nrestrict ssh-ed25519 AAAAC3 other\nssh-rsa Y you\n`, line, keyPart)).toEqual(["ssh-rsa X me", "ssh-rsa Y you"]);
  expect(authorizedKeysKept("", line, keyPart)).toEqual([]);
});

test("phos ps as a tree by role, with totals", () => {
  const p = (pid: number, ppid: number, role: string, rss: number, cmd: string) => ({ pid, ppid, role, rss, cmd, name: "llama-server", cpu: 0 });
  expect(psText([])).toBe("no phosphorus processes running\n");
  const out = psText([p(30, 10, "frontend", 100 << 20, "phosphorus serve"), p(10, 1, "run", 50 << 20, "phosphorus run"), p(40, 10, "llama-server", 3 * 1024 * 1024 * 1024, "llama-server -m x"), p(41, 40, "llama-server", 1 << 20, "")]);
  expect(out).toBe(
    [
      "ROLE                 PID      RSS  COMMAND",
      "run                   10      50M  phosphorus run",
      "frontend              30     100M    phosphorus serve",
      "llama-server          40    3072M    llama-server -m x",
      "llama-server          41       1M      llama-server",
      "",
      "phosphorus                   150M",
      "llama-server                3073M",
      "total                       3223M",
      "",
    ].join("\n"),
  );
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
  expect(absTo("/h", " x/ ")).toBe("/h/x");
  expect(absTo("/h", "/abs/")).toBe("/abs");
});

test("bakeEnv from phosphorus.ini, missing share dirs skipped", () => {
  setHome(dir);
  mkdirSync(join(dir, "config"), { recursive: true });
  mkdirSync(join(dir, "share"), { recursive: true });
  writeFileSync(join(dir, "config", "phosphorus.ini"), "[files]\ndir = share/, nope, /\npriv = r,,rw\n[model]\nhost = true\n");
  const m = bakeEnv(join(dir, "files"));
  expect(m.PHOSPHORUS_HOME).toBe(dir);
  expect(m.STATE_DIR).toBe(join(dir, "state"));
  expect(m.HOME_FS).toBe(join(dir, "files"));
  expect(m.PHOSPHORUS_FILES_DIRS).toBe(join(dir, "share"));
  expect(m.PHOSPHORUS_FILES_PERMS).toBe("r");
  if (process.platform === "linux") expect(m.GIT_USER).toBe("phosphorus-git");
  const s1 = signature(m);
  expect(s1).toBe(signature({ ...m }));
  expect(signature({ ...m, X: "1" })).not.toBe(s1);
  expect(s1).toMatch(/^[0-9a-f]{64}$/);
});

test("syncPayload copies the release, keeps this host's config, prunes the last release's files", () => {
  const src = join(dir, "payload"), dst = join(dir, "home");
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
  expect(readFileSync(join(dst, ".phosphorus-manifest"), "utf8")).toBe(`VERSION\n${process.platform === "win32" ? "bin/phos.exe\nbin/phosphorus.exe" : "bin/phosphorus"}\nconfig/phosphorus.ini\nconfig/services.export\nweb/assets/a.js\n`);
  expect(kept("config/services.export")).toBe(true);
  expect(kept("files/a/b")).toBe(true);
  expect(kept("web/a")).toBe(false);
});

test("small helpers", () => {
  expect(field("phosphorus:\n  Installed: 1.0\n  Candidate: 1.1\n", "Candidate:")).toBe("1.1");
  expect(field("x", "Installed:")).toBe("");
  expect(lastLine("a\nE: bad\nok\n", /ERROR|E:/)).toBe("E: bad");
  expect(lastLine("a\nb\n")).toBe("b");
  expect(lastLine("", /x/)).toBe("");
  expect(keySet({ TS_AUTHKEY: "k", BASE_DOMAIN: "" })).toEqual({ TS_AUTHKEY: true, BASE_DOMAIN: false, TUNNEL_TOKEN: false, TS_API_KEY: false, ADMIN_PASS: false });
  expect(durText(5000)).toBe("5s");
  expect(durText(60_000)).toBe("1m0s");
  expect(splitLines("a\r\nb\n")).toEqual(["a", "b"]);
  expect(sshInclude()).toBe(`Include "${join(dir, "state", "ssh_config").replaceAll("\\", "/")}"`);
});
