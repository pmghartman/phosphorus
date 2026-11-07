import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "phos-host-"));
process.env.PHOSPHORUS_HOME = dir;
const { commands, main, parse, usageText, version } = await import("@phosphorus/host");
const base = await import("../src/base.ts");
const { durText, lastLine, setHome, splitLines, sshInclude } = base;
const { plistPath, plistText, xmlEsc } = await import("../src/darwin.ts");
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

test("the LaunchDaemon's plist: root's run of the home, xml escaped", () => {
  const p = plistText(
    "/Library/Phos&phorus/bin/phosphorus",
    "/Library/Phos&phorus",
    "/Library/Phos&phorus/state/log/phosphorus.log",
  );
  expect(p).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>dev.phosphorus.host</string>
	<key>ProgramArguments</key>
	<array><string>/Library/Phos&amp;phorus/bin/phosphorus</string><string>run</string><string>--home</string><string>/Library/Phos&amp;phorus</string></array>
	<key>EnvironmentVariables</key>
	<dict><key>PHOSPHORUS_HOME</key><string>/Library/Phos&amp;phorus</string></dict>
	<key>WorkingDirectory</key><string>/Library/Phos&amp;phorus</string>
	<key>UserName</key><string>root</string>
	<key>GroupName</key><string>wheel</string>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>5</integer>
	<key>ExitTimeOut</key><integer>150</integer>
	<key>StandardOutPath</key><string>/Library/Phos&amp;phorus/state/log/phosphorus.log</string>
	<key>StandardErrorPath</key><string>/Library/Phos&amp;phorus/state/log/phosphorus.log</string>
</dict>
</plist>
`);
  expect(xmlEsc("<a&b>")).toBe("&lt;a&amp;b&gt;");
  // the system domain's, root's file
  expect(plistPath).toBe("/Library/LaunchDaemons/dev.phosphorus.host.plist");
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
      "    http://box/  on the mesh",
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
  const { ensurePin, pins, Wintun } = await import("../src/tools.ts");
  const { os } = await import("../src/os.ts");
  const names = (p: { files: Record<string, string> }[]) => p.flatMap((x) => Object.keys(x.files));
  expect(names(pins("linux", "x64"))).toEqual([]);
  expect(names(pins("darwin", "arm64"))).toEqual([]);
  expect(names(pins("win32", "x64"))).toEqual(["wintun.dll"]);
  expect(pins("win32", "arm64")[0]!.files).toEqual({ "wintun.dll": "wintun/bin/arm64/wintun.dll" });
  expect(pins("win32", "x64")[0]!.url).toContain(`wintun-${Wintun}.zip`);

  // the pin's file here at its version: nothing fetched
  const lib = os.libexec();
  mkdirSync(lib, { recursive: true });
  const pin = pins("win32", "x64")[0]!;
  for (const f of Object.keys(pin.files)) writeFileSync(join(lib, f), "x");
  writeFileSync(join(lib, "versions.json"), JSON.stringify({ [pin.name]: pin.ver }));
  const real = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = (async () => {
    asked++;
    return new Response("not wintun");
  }) as unknown as typeof fetch;
  try {
    await ensurePin(pin);
    expect(asked).toBe(0);
    // a moved pin fetched, the wrong bytes refused
    writeFileSync(join(lib, "versions.json"), JSON.stringify({ wintun: "old" }));
    await expect(ensurePin(pin)).rejects.toThrow(/checksum mismatch/);
    expect(asked).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(join(lib, "versions.json"), "utf8")).wintun).toBe("old");
  } finally {
    globalThis.fetch = real;
  }
  expect(Wintun).toMatch(/^\d+\.\d+\.\d+$/);
}, 30_000);

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
  const token = "0a1b2c3d.abcdefghijklmnopqrstuvwxyz012345";
  const k = envfile.formatMeshKey({ url: "https://philab.io", token });
  expect(k.startsWith("phos.")).toBe(true);
  expect(envfile.parseMeshKey(` "${k}"\n`)).toEqual({ url: "https://philab.io", token });
  expect(envfile.parseMeshKey("tskey-auth-abc")).toBeUndefined();
  expect(envfile.parseMeshKey("phos.notbase64json")).toBeUndefined();
  // the old headscale key and a plain http url, refused
  expect(
    envfile.parseMeshKey("phos1." + Buffer.from('{"u":"https://hs.x","k":"k"}').toString("base64url")),
  ).toBeUndefined();
  expect(envfile.parseMeshKey(envfile.formatMeshKey({ url: "http://philab.io", token }))).toBeUndefined();
  expect(envfile.parseMeshKey(envfile.formatMeshKey({ url: "https://philab.io", token: "short" }))).toBeUndefined();
});

test("the net child's plan: the hub carries every host and device, a host the hub and direct paths", async () => {
  const { plan } = await import("../src/net/plan.ts");
  const hosts = new Map([
    ["vps", { ip: "100.64.0.1", key: "H".repeat(43) + "=", endpoint: "203.0.113.5:41641" }],
    ["alpha", { ip: "100.64.0.2", key: "A".repeat(43) + "=", lan: ["192.168.1.2:41641"] }],
    ["bravo", { ip: "100.64.0.3", key: "B".repeat(43) + "=" }],
    ["gone", { ip: "100.64.0.9", key: "G".repeat(43) + "=", removed: true }],
  ]);
  const devices = new Map([
    ["phone", { ip: "100.64.0.4", key: "P".repeat(43) + "=" }],
    ["old-phone", { ip: "100.64.0.5", key: "" }],
  ]);
  const view = { hosts, devices, control: "vps", domain: "philab.io", seen: { bravo: "198.51.100.7:5555" } };
  const hub = plan({ ...view, self: "vps" });
  expect(hub.hub).toBe(true);
  expect(hub.ip).toBe("100.64.0.1");
  expect(hub.peers.map((p) => p.allowed[0])).toEqual(["100.64.0.2/32", "100.64.0.3/32", "100.64.0.4/32"]);
  const a = plan({ ...view, self: "alpha" });
  expect(a.hub).toBe(false);
  expect(a.hubIP).toBe("100.64.0.1");
  expect(a.peers[0]).toEqual({
    key: "H".repeat(43) + "=",
    allowed: ["100.64.0.0/10"],
    endpoints: ["203.0.113.5:41641", "relay"],
    keepalive: 25,
  });
  // bravo direct at the address the hub saw
  expect(a.peers.slice(1)).toEqual([
    { key: "B".repeat(43) + "=", allowed: ["100.64.0.3/32"], endpoints: ["198.51.100.7:5555"], direct: true },
  ]);
  // a host just joined, the store not synced yet: its join's word
  const fresh = plan({
    ...view,
    hosts: new Map(),
    control: "",
    self: "charlie",
    joined: {
      name: "charlie",
      ip: "100.64.0.6",
      hub: { name: "vps", ip: "100.64.0.1", key: "H".repeat(43) + "=", endpoint: "203.0.113.5:41641" },
      domain: "philab.io",
    },
  });
  expect(fresh.ip).toBe("100.64.0.6");
  expect(fresh.hubIP).toBe("100.64.0.1");
  expect(fresh.peers[0]!.endpoints).toEqual(["203.0.113.5:41641", "relay"]);
});
