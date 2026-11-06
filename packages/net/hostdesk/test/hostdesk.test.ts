// the host desktop's pure parts: the line protocol, the recycle bin's records, the
// paths, the Linux parsers; then the sh probe against a temp home

import "./env.ts";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDf } from "../src/desk.ts";
import * as L from "../src/linux.ts";
import { norm, sftpPath } from "../src/paths.ts";
import { bootLine, records, reply, request, shBootScript } from "../src/proto.ts";
import { binName, writeInfo } from "../src/recycle.ts";
import { abgrHex, winDesk, winItem, winLook, winRun } from "../src/windows.ts";

test("protocol: a request and its reply", () => {
  expect(request(7, "icon", "a\tb")).toBe(`7\ticon\t${Buffer.from("a\tb").toString("base64")}\n`);
  const body = Buffer.from('{"x":1}').toString("base64");
  expect(reply(`3\tok\t${body}\r`)).toEqual({ id: 3, ok: true, body: '{"x":1}' });
  expect(reply("4\terr\t")).toEqual({ id: 4, ok: false, body: "" });
  expect(reply("Windows PowerShell banner")).toBeUndefined();
  const recs = records("\x1eenv\nuser=ann\n\x1efile\t/a b\t12\n[x]\nk=v\n\x1eent\t/d\td\t1\t0");
  expect(recs).toEqual([
    { kind: "env", args: [], body: "user=ann" },
    { kind: "file", args: ["/a b", "12"], body: "[x]\nk=v" },
    { kind: "ent", args: ["/d", "d", "1", "0"], body: "" },
  ]);
});

test("recycle bin: a version 2 $I written, the name its $R shares", () => {
  const at = Date.UTC(2026, 10, 4, 12, 30, 15);
  const path = "C:\\Users\\ann\\Desktop\\notes.txt";
  const b = writeInfo({ path, size: 1234, deleted: at });
  expect(b.length).toBe(28 + (path.length + 1) * 2);
  const v = new DataView(b.buffer);
  expect(v.getBigInt64(0, true)).toBe(2n);
  expect(v.getBigInt64(8, true)).toBe(1234n);
  expect(v.getBigInt64(16, true)).toBe(BigInt(at) * 10000n + 116444736000000000n);
  expect(v.getUint32(24, true)).toBe(path.length + 1);
  expect(Buffer.from(b.subarray(28)).toString("utf16le")).toBe(`${path}\0`);
  let i = 0;
  expect(binName("C:\\a\\Report.Final.docx", () => i++ % 36)).toBe("ABCDEF.docx");
  expect(binName("C:\\a\\README", () => 0)).toBe("AAAAAA");
});

test("paths: made clean, nothing climbing above the root", () => {
  expect(norm("/home/ann/./x/../y", false)).toBe("/home/ann/y");
  expect(norm("/../etc", false)).toBeUndefined();
  expect(norm("relative", false)).toBeUndefined();
  expect(norm("/", false)).toBe("/");
  expect(norm("/etc/shadow", false)).toBe("/etc/shadow");
  expect(norm("c:/Users//Ann\\x", true)).toBe("C:\\Users\\Ann\\x");
  expect(norm("D:\\", true)).toBe("D:\\");
  expect(norm("C:\\Users\\ann\\..\\..\\..", true)).toBeUndefined();
  expect(norm("\\\\server\\share", true)).toBeUndefined();
  expect(sftpPath("C:\\Users\\ann\\a b.txt", true)).toBe("/C:/Users/ann/a b.txt");
});

test("roots: the root first, each disk's mount, loops and boot left out", () => {
  const df = [
    "Filesystem     1024-blocks      Used Available Capacity Mounted on",
    "udev               8000000         0   8000000       0% /dev",
    "/dev/nvme0n1p2   490000000 200000000 265000000      43% /",
    "/dev/nvme0n1p1      524000      6000    518000       2% /boot/efi",
    "/dev/loop3           65000     65000         0     100% /snap/core20/2318",
    "/dev/sdb1       1900000000 900000000 1000000000     48% /mnt/big disk",
    "tmpfs              1600000      2000   1598000       1% /run",
  ].join("\n");
  expect(parseDf(df)).toEqual([
    { name: "/", path: "/", label: "/dev/nvme0n1p2", size: 490000000 * 1024, free: 265000000 * 1024 },
    {
      name: "/mnt/big disk",
      path: "/mnt/big disk",
      label: "/dev/sdb1",
      size: 1900000000 * 1024,
      free: 1000000000 * 1024,
    },
  ]);
  expect(parseDf("")).toEqual([{ name: "/", path: "/", label: "", size: 0, free: 0 }]);
});

const firefox = `[Desktop Entry]
Name=Firefox
Exec=firefox %u
Icon=firefox
Type=Application
Categories=Network;WebBrowser;`;

test("linux: desktop entries, gsettings values, uris, trashinfo", () => {
  const e = L.parseEntry(`${firefox}\n[Desktop Action new]\nName=New Window\nExec=firefox --new`)!;
  expect([e.name, e.exec, e.icon, e.terminal, L.groupOf(e.categories)]).toEqual([
    "Firefox",
    "firefox %u",
    "firefox",
    false,
    "internet",
  ]);
  expect(L.entryKind(e)).toBe("gui");
  const htop = L.parseEntry("[Desktop Entry]\nName=Htop\nExec=htop\nTerminal=true\nType=Application")!;
  expect(L.entryKind(htop)).toBe("cli");
  expect(L.stripExec('vim %F --title "a %% b" %i')).toBe('vim --title "a % b"');
  expect(L.parseEntry("[Desktop Entry]\nType=Link\nName=Docs\nURL=https://x.test")!.url).toBe("https://x.test");
  expect(L.shown(L.parseEntry("[Desktop Entry]\nName=K\nOnlyShowIn=KDE;")!, "gnome")).toBe(false);
  expect(L.shown(L.parseEntry("[Desktop Entry]\nName=G\nNoDisplay=true")!, "gnome")).toBe(false);
  expect(L.desktopId("/usr/share/applications/kde4/kate.desktop", "/usr/share/applications")).toBe("kde4-kate.desktop");
  expect(L.unescape("a\\sb\\\\c")).toBe("a b\\c");
  expect(L.gStr("'file:///usr/share/backgrounds/a b.jpg'")).toBe("file:///usr/share/backgrounds/a b.jpg");
  expect(L.gStr("'it\\'s'")).toBe("it's");
  expect(L.gList("['firefox.desktop', 'org.gnome.Nautilus.desktop']")).toEqual([
    "firefox.desktop",
    "org.gnome.Nautilus.desktop",
  ]);
  expect(L.gList("@as []")).toEqual([]);
  expect(L.uriPath("file:///home/ann/Pictures/my%20pic.png")).toBe("/home/ann/Pictures/my pic.png");
  expect(L.uriPath("https://x")).toBe("");
  const info = L.trashInfo("/home/ann/my file ü.txt", Date.UTC(2026, 0, 2, 3, 4, 5));
  expect(info).toContain("Path=/home/ann/my%20file%20%C3%BC.txt\n");
  expect(L.trashDate(Date.UTC(2026, 0, 2, 3, 4, 5), 0)).toBe("2026-01-02T03:04:05");
});

test("linux: kde and xfce config", () => {
  const appletsrc = `[Containments][1]
plugin=org.kde.plasma.folder
wallpaperplugin=org.kde.image

[Containments][1][Wallpaper][org.kde.image][General]
Image=file:///usr/share/wallpapers/Mountain

[Containments][2]
plugin=org.kde.panel

[Containments][2][Applets][5]
plugin=org.kde.plasma.icontasks

[Containments][2][Applets][5][Configuration][General]
launchers=applications:systemsettings.desktop,preferred://filemanager,applications:org.kde.konsole.desktop
`;
  const a = L.kdeApplets(appletsrc);
  expect(a.image).toBe("file:///usr/share/wallpapers/Mountain");
  expect(a.launchers).toEqual(["systemsettings.desktop", "org.kde.konsole.desktop"]);
  const lists = new Map([
    ["/usr/share/wallpapers/Mountain/contents/images", ["1280x800.png", "5120x2880.png", "1920x1080.png"]],
  ]);
  expect(L.kdeImage(a.image, lists, false)).toBe("/usr/share/wallpapers/Mountain/contents/images/5120x2880.png");
  expect(L.kdeImage("/home/ann/a.jpg", lists, false)).toBe("/home/ann/a.jpg");
  expect(L.rgbHex("61,174,233")).toBe("#3daee9");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-desktop" version="1.0">
  <property name="backdrop" type="empty">
    <property name="screen0" type="empty">
      <property name="monitorHDMI-1" type="empty">
        <property name="workspace0" type="empty">
          <property name="last-image" type="string" value="/usr/share/backgrounds/xfce/a&amp;b.png"/>
          <property name="image-style" type="int" value="5"/>
        </property>
      </property>
    </property>
  </property>
</channel>`;
  const x = L.xfconf(xml);
  expect(x.get("/backdrop/screen0/monitorHDMI-1/workspace0/last-image")).toBe("/usr/share/backgrounds/xfce/a&b.png");
});

const gsRecs = (extra: string) =>
  records(
    `\x1eenv\nuser=ann\nhome=/home/ann\nde=gnome\nbus=1\nbinfull=1\n` +
      `\x1egs\torg.gnome.desktop.background picture-uri\n'file:///usr/share/backgrounds/light.jpg'\n` +
      `\x1egs\torg.gnome.desktop.background picture-uri-dark\n'file:///usr/share/backgrounds/dark.jpg'\n` +
      `\x1egs\torg.gnome.desktop.background picture-options\n'zoom'\n` +
      `\x1egs\torg.gnome.desktop.interface color-scheme\n'prefer-dark'\n` +
      `\x1egs\torg.gnome.desktop.interface accent-color\n'teal'\n` +
      `\x1egs\torg.gnome.desktop.interface icon-theme\n'Yaru'\n` +
      `\x1egs\torg.gnome.shell favorite-apps\n['firefox.desktop', 'gone.desktop']\n` +
      `\x1egs\torg.gnome.shell enabled-extensions\n['ding@rastersoft.com', 'ubuntu-dock@ubuntu.com']\n` +
      `\x1eent\t/home/ann/Desktop/notes.pdf\tf\t100\t5\n` +
      `\x1eent\t/home/ann/Desktop/Projects\td\t100\t0\n${extra}`,
  );

test("linux: a gnome desktop built, its pins out of the apps", () => {
  const apps = L.parseApps(
    records(
      `\x1edir\t/home/ann/.local/share/applications\n\x1efile\t/home/ann/.local/share/applications/firefox.desktop\t9\n${firefox.replace("Name=Firefox", "Name=My Firefox")}\n` +
        `\x1edir\t/usr/share/applications\n\x1efile\t/usr/share/applications/firefox.desktop\t1\n${firefox}\n` +
        `\x1efile\t/usr/share/applications/hidden.desktop\t1\n[Desktop Entry]\nName=H\nNoDisplay=true\n`,
    ),
    "gnome",
    "Yaru",
  );
  expect(apps.map((a) => [a.id, a.name])).toEqual([["firefox.desktop", "My Firefox"]]);
  const d = L.buildDesk(gsRecs(""), apps);
  expect([d.shell, d.dark, d.accent, d.wallpaper.path, d.wallpaper.fit, d.dock, d.ding]).toEqual([
    "gnome",
    true,
    "#2190a4",
    "/usr/share/backgrounds/dark.jpg",
    "cover",
    "left",
    true,
  ]);
  expect(d.pins.map((p) => p.id)).toEqual(["firefox.desktop"]);
  expect(d.icons.map((i) => [i.name, i.kind])).toEqual([
    ["trash", "bin"],
    ["Projects", "folder"],
    ["notes.pdf", "file"],
  ]);
  expect(d.icons[0]!.icon).toBe("x:Yaru|user-trash-full,user-trash");
  expect(d.can).toEqual({ wallpaper: true, dark: true, accent: true, pins: true });
  const nobus = L.buildDesk(records("\x1eenv\nhome=/home/ann\nde=gnome\nbus=0\n"), []);
  expect(nobus.can.wallpaper).toBe(false);
  expect(nobus.icons.map((i) => i.kind)).toEqual(["bin"]);
});

test("windows: a desktop and what its console apps type", () => {
  expect(winRun("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-NoExit", true)).toBe(
    "powershell -NoExit",
  );
  expect(winRun("C:\\Program Files\\Git\\bin\\git's.exe", "", true)).toBe(
    "& 'C:\\Program Files\\Git\\bin\\git''s.exe'",
  );
  expect(winRun("C:\\tools\\x.exe", "-v", false)).toBe('"C:\\tools\\x.exe" -v');
  expect(abgrHex(4292114432)).toBe("#0078d4".replace("#0078d4", abgrHex(4292114432)));
  expect(abgrHex(0xffd47800)).toBe("#0078d4");
  const d = winDesk(
    {
      user: "ann",
      home: "C:\\Users\\ann",
      build: 26200,
      wallpaper: "C:\\w.jpg",
      style: "6",
      tile: "0",
      bg: "0 0 0",
      light: 0,
      appsLight: 0,
      accent: 0xffd47800,
      align: 0,
      bin: true,
      binFull: false,
      icons: [
        {
          name: "pwsh",
          kind: "cli",
          path: "C:\\Users\\ann\\Desktop\\pwsh.lnk",
          target: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
          args: "",
        },
      ],
      pins: [],
      sshShell: "",
    },
    false,
  );
  expect([d.shell, d.dark, d.accent, d.align, d.wallpaper.fit, d.sshShell]).toEqual([
    "win11",
    true,
    "#0078d4",
    "left",
    "contain",
    "cmd",
  ]);
  expect(d.icons.map((i) => [i.kind, i.run ?? ""])).toEqual([
    ["bin", ""],
    ["cli", "pwsh"],
  ]);
});

// the probe itself in sh, a temp home's trash: a delete, then one refused
// dash where Git for Windows has it, as Ubuntu's sh is, which reads its script ahead
const sh = [
  "/bin/sh",
  "/usr/bin/sh",
  "C:/Program Files/Git/usr/bin/dash.exe",
  "C:/Program Files/Git/usr/bin/sh.exe",
].find((p) => existsSync(p));
test.skipIf(!sh)(
  "probe.sh: a file to the trash",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "phos-desk-"));
    mkdirSync(join(home, "Desktop"), { recursive: true });
    const native = join(home, "Desktop", "a note.txt");
    writeFileSync(native, "hi");
    const pic = join(home, "Desktop", "pic.bin");
    writeFileSync(pic, "not a picture");
    // the path as sh sees it, git bash's /c/... on Windows
    const posix = (p: string) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);
    const f = posix(native);
    const probe = readFileSync(join(import.meta.dir, "../src/probe.sh"), "utf8");
    const run = async (reqs: [string, string][]) => {
      const p = Bun.spawn([sh!, "-c", shBootScript], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: posix(home), XDG_DATA_HOME: "" },
      });
      // the script and every request at once, as a fast link lands them
      p.stdin.write(bootLine(probe));
      reqs.forEach(([c, a], i) => p.stdin.write(request(i + 1, c, a)));
      p.stdin.end();
      const out = await new Response(p.stdout).text();
      return out
        .split("\n")
        .map((l) => reply(l))
        .filter((r) => !!r);
    };
    const [del, again, nope, desk, wall, noWall] = await run([
      ["delete", `${f}\n${L.trashInfo(f, Date.now())}`],
      ["delete", `${f}\n${L.trashInfo(f, Date.now())}`],
      ["format", ""],
      ["desktop", ""],
      ["wall", posix(pic)],
      ["wall", `${f}.missing`],
    ]);
    expect(del!.ok).toBe(true);
    expect(existsSync(native)).toBe(false);
    const bin = join(home, ".local", "share", "Trash");
    expect(readFileSync(join(bin, "files", "a note.txt"), "utf8")).toBe("hi");
    expect(readFileSync(join(bin, "info", "a note.txt.trashinfo"), "utf8")).toContain(`Path=${L.pctPath(f)}\n`);
    expect(again!.ok).toBe(false);
    expect(nope!.body).toContain("no such request");
    const env = records(desk!.body).find((r) => r.kind === "env")!;
    expect(env.body).toContain(`home=${posix(home)}`);
    // the wallpaper scaled by a converter the host has, or left to a raw read: an ok either way
    expect(wall!.ok).toBe(true);
    expect(wall!.body === "" || wall!.body.startsWith("/9j/")).toBe(true);
    expect(noWall!.ok).toBe(false);
  },
  60000,
);

test("windows: the taskbar, clock and icons as the registry has them", () => {
  // win11 defaults: search icon, task view, widgets, 12 hour clock
  expect(winLook({}, true)).toEqual({
    iconSize: 48,
    clock: { h24: false, seconds: false, weekday: false },
    transparent: true,
    search: "icon",
    taskView: true,
    widgets: true,
    small: false,
    edge: "bottom",
  });
  const l = winLook(
    { iconSize: 32, time: "HH:mm", seconds: 1, transparent: 0, search: 2, taskView: 0, small: 1, edge: 1 },
    false,
  );
  expect(l).toMatchObject({
    iconSize: 32,
    transparent: false,
    search: "box",
    taskView: false,
    small: true,
    edge: "top",
  });
  expect(l.clock).toEqual({ h24: true, seconds: true, weekday: false });
  // no widgets on win10, no side taskbar on win11
  expect(l.widgets).toBe(false);
  expect(winLook({ edge: 0, search: 0 }, true)).toMatchObject({ edge: "bottom", search: "" });
  expect(winDesk({ build: 22631, search: 3 }, false).look.search).toBe("box");
});

test("a shortcut's own file kept beside the target it names, for a delete to take", () => {
  const lnk = "C:\\Users\\ann\\Desktop\\notes.lnk";
  const file = winItem({ name: "notes", kind: "file", path: lnk, target: "C:\\Users\\ann\\notes.txt" }, true);
  expect(file).toMatchObject({ path: "C:\\Users\\ann\\notes.txt", file: lnk });
  const dir = winItem(
    { name: "proj", kind: "folder", path: "C:\\Users\\ann\\proj", file: "C:\\Users\\ann\\Desktop\\proj.lnk" },
    true,
  );
  expect(dir).toMatchObject({ path: "C:\\Users\\ann\\proj", file: "C:\\Users\\ann\\Desktop\\proj.lnk" });
  // a plain launcher's file is its path
  const app = winItem(
    { name: "app", kind: "gui", path: "C:\\Users\\ann\\Desktop\\app.lnk", target: "C:\\a\\app.exe" },
    true,
  );
  expect(app.file).toBeUndefined();
  expect(app.path).toBe("C:\\Users\\ann\\Desktop\\app.lnk");
});
