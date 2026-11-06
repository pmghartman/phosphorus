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
  // every command main handles taken by the binary's own list, or it never reaches main
  const src = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
  const body = src.slice(src.indexOf("export async function main("));
  for (const m of body.matchAll(/case "([\w-]*)":/g)) expect(commands.has(m[1]!)).toBe(true);
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
  expect(keySet({ MESH_KEY: "k", BASE_DOMAIN: "" })).toEqual({ MESH_KEY: true });
  expect(durText(5000)).toBe("5s");
  expect(durText(60_000)).toBe("1m0s");
  expect(splitLines("a\r\nb\n")).toEqual(["a", "b"]);
  expect(sshInclude()).toBe(`Include "${join(dir, "state", "ssh_config").replaceAll("\\", "/")}"`);
});

test("the tools pinned per OS, fetched only when a pin moves or a file is gone", async () => {
  const { ensurePin, pins, Tailscale } = await import("../src/tools.ts");
  const { os } = await import("../src/os.ts");
  const names = (p: { files: Record<string, string> }[]) => p.flatMap((x) => Object.keys(x.files));
  expect(names(pins("linux", "x64"))).toEqual(["tailscale", "tailscaled"]);
  expect(names(pins("linux", "arm64", false))).toEqual([]);
  expect(names(pins("darwin", "arm64"))).toEqual([]);
  expect(names(pins("win32", "x64"))).toEqual(["wintun.dll"]);
  expect(pins("win32", "arm64")[0]!.files).toEqual({ "wintun.dll": "wintun/bin/arm64/wintun.dll" });
  expect(pins("linux", "arm64")[0]!.url).toContain(`tailscale_${Tailscale}_arm64.tgz`);

  // the pin's file here at its version: nothing fetched
  const lib = os.libexec();
  mkdirSync(lib, { recursive: true });
  const pin = pins("linux", "x64")[0]!;
  for (const f of Object.keys(pin.files)) writeFileSync(join(lib, f), "x");
  writeFileSync(join(lib, "versions.json"), JSON.stringify({ [pin.name]: pin.ver }));
  const real = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = (async () => {
    asked++;
    return new Response("not tailscale");
  }) as unknown as typeof fetch;
  try {
    await ensurePin(pin);
    expect(asked).toBe(0);
    // a moved pin fetched, the wrong bytes refused
    writeFileSync(join(lib, "versions.json"), JSON.stringify({ tailscale: "old" }));
    await expect(ensurePin(pin)).rejects.toThrow(/checksum mismatch/);
    expect(asked).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(join(lib, "versions.json"), "utf8")).tailscale).toBe("old");
  } finally {
    globalThis.fetch = real;
  }
  expect(Tailscale).toMatch(/^\d+\.\d+\.\d+$/);
}, 30_000);

test("headscale pinned apart from every host's tools", async () => {
  const { headscalePin, Headscale, pins } = await import("../src/tools.ts");
  expect(pins("linux", "x64").some((p) => p.name === "headscale")).toBe(false);
  const p = headscalePin("arm64");
  expect(p.url).toBe(
    `https://github.com/juanfont/headscale/releases/download/v${Headscale}/headscale_${Headscale}_linux_arm64`,
  );
  expect(p.files).toEqual({ headscale: "" });
  expect(headscalePin("x64").sha256).toMatch(/^[0-9a-f]{64}$/);
});

// a zip of stored entries, enough for the .zip branch
function storedZip(files: [string, Uint8Array][]): Uint8Array {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let at = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name);
    const crc = Bun.hash.crc32(data);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0);
    l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(data.length, 18);
    l.writeUInt32LE(data.length, 22);
    l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(at, 42);
    locals.push(l, n, data);
    central.push(c, n);
    at += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(at, 16);
  return Buffer.concat([...locals, dir, end]);
}

test("a zip pin's member taken out of it", async () => {
  const { ensurePin } = await import("../src/tools.ts");
  const { os } = await import("../src/os.ts");
  const dll = Buffer.from("not really a dll");
  const zip = storedZip([
    ["wintun/LICENSE.txt", Buffer.from("license")],
    ["wintun/bin/amd64/wintun.dll", dll],
  ]);
  const sha256 = new Bun.CryptoHasher("sha256").update(zip).digest("hex");
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Uint8Array(zip))) as unknown as typeof fetch;
  try {
    const pin = {
      name: "ziptest",
      ver: "1",
      url: "https://example.invalid/ziptest.zip",
      sha256,
      files: { "ziptest.dll": "wintun/bin/amd64/wintun.dll" },
    };
    expect(await ensurePin(pin)).toBe(true);
    expect(readFileSync(join(os.libexec(), "ziptest.dll"), "utf8")).toBe("not really a dll");
    expect(await ensurePin(pin)).toBe(false);
  } finally {
    globalThis.fetch = real;
  }
});

test("a mesh join key round-trips, anything else refused", async () => {
  const envfile = await import("@phosphorus/envfile");
  const k = envfile.formatMeshKey({ url: "https://hs.mulab.dev", key: "hskey-auth-abc" });
  expect(k.startsWith("phos1.")).toBe(true);
  expect(envfile.parseMeshKey(` "${k}"\n`)).toEqual({ url: "https://hs.mulab.dev", key: "hskey-auth-abc" });
  expect(envfile.parseMeshKey("tskey-auth-abc")).toBeUndefined();
  expect(envfile.parseMeshKey("phos1.notbase64json")).toBeUndefined();
  const http = envfile.formatMeshKey({ url: "http://hs.mulab.dev", key: "k" });
  expect(envfile.parseMeshKey(http)).toBeUndefined();
});

test("headscale's config from the frontend's ask", async () => {
  const { controlConfig, controlPolicy, readSpec } = await import("../src/control.ts");
  const spec = { url: "https://hs.mulab.dev", baseDomain: "mesh.mulab.dev", relay: false, behind: false };
  const c = controlConfig(spec, "/d", "/s.sock");
  expect(c.server_url).toBe("https://hs.mulab.dev");
  expect(c.listen_addr).toBe(":443");
  // an edge host too: 443 is the splitter's, headscale behind it on loopback
  expect(controlConfig({ ...spec, behind: true }).listen_addr).toBe("127.0.0.1:8443");
  expect(c.tls_letsencrypt_hostname).toBe("hs.mulab.dev");
  expect(c.tls_letsencrypt_challenge_type).toBe("TLS-ALPN-01");
  expect(c.derp.server.enabled).toBe(false);
  expect(c.derp.urls).toEqual(["https://controlplane.tailscale.com/derpmap/default"]);
  expect(c.dns.base_domain).toBe("mesh.mulab.dev");
  expect(c.node.expiry).toBe(0);
  expect(c.policy.path).toBe(join("/d", "policy.json"));
  expect(controlConfig({ ...spec, relay: true }).derp.server.enabled).toBe(true);
  expect(Object.keys(controlPolicy().tagOwners)).toEqual(["tag:host", "tag:guest"]);
  const f = join(dir, "spec.json");
  writeFileSync(f, JSON.stringify({ url: "http://plain", baseDomain: "x" }));
  expect(readSpec(f)).toBeUndefined();
  writeFileSync(f, JSON.stringify({ ...spec, relay: "yes" }));
  expect(readSpec(f)).toEqual({ ...spec, relay: false, behind: false, ipv4: undefined, ipv6: undefined });
});
