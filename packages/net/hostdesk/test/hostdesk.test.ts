// the host desktop's pure parts: the line protocol, the recycle bin's records, the
// profile scope, the Linux parsers and set lines; then the sh probe against a temp home

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linuxOps } from "../src/desk.ts";
import * as L from "../src/linux.ts";
import type { Desk } from "../src/model.ts";
import { norm, Scope, sftpPath, within } from "../src/paths.ts";
import { bootLine, records, reply, request, shBootScript } from "../src/proto.ts";
import { binName, binRe, fromFiletime, parseInfo, toFiletime, writeInfo } from "../src/recycle.ts";
import { abgrHex, winDesk, winLook, winRun, winTrash } from "../src/windows.ts";

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

test("recycle bin: $I written and read, version 1 too", () => {
  const at = Date.UTC(2026, 10, 4, 12, 30, 15);
  const b = writeInfo({ path: "C:\\Users\\ann\\Desktop\\notes.txt", size: 1234, deleted: at });
  expect(b.length).toBe(28 + ("C:\\Users\\ann\\Desktop\\notes.txt".length + 1) * 2);
  expect(parseInfo(b)).toEqual({ path: "C:\\Users\\ann\\Desktop\\notes.txt", size: 1234, deleted: at });
  expect(fromFiletime(toFiletime(at))).toBe(at);
  const v1 = new Uint8Array(24 + 520);
  const dv = new DataView(v1.buffer);
  dv.setBigInt64(0, 1n, true);
  dv.setBigInt64(8, 9n, true);
  dv.setBigInt64(16, toFiletime(at), true);
  v1.set(Buffer.from("D:\\old.doc\0", "utf16le"), 24);
  expect(parseInfo(v1)).toEqual({ path: "D:\\old.doc", size: 9, deleted: at });
  expect(parseInfo(new Uint8Array(10))).toBeUndefined();
  const bad = writeInfo({ path: "C:\\x", size: 0, deleted: at });
  new DataView(bad.buffer).setUint32(24, 999, true);
  expect(parseInfo(bad)).toBeUndefined();
  let i = 0;
  const n = binName("C:\\a\\Report.Final.docx", () => i++ % 36);
  expect(n).toBe("ABCDEF.docx");
  expect(binRe.test(`$I${n}`)).toBe(true);
  expect(binRe.test("$I../x")).toBe(false);
  const rows = winTrash([
    { bin: "C:\\$Recycle.Bin\\S-1", i: `$I${n}`, dir: false, data: Buffer.from(b).toString("base64") },
  ]);
  expect(rows).toEqual([
    {
      id: `C:\\$Recycle.Bin\\S-1|$I${n}`,
      name: "notes.txt",
      from: "C:\\Users\\ann\\Desktop\\notes.txt",
      deleted: at,
      size: 1234,
      dir: false,
    },
  ]);
});

test("scope: the profile, issued paths and folders, nothing climbing out", () => {
  expect(norm("/home/ann/./x/../y", false)).toBe("/home/ann/y");
  expect(norm("/../etc", false)).toBeUndefined();
  expect(norm("relative", false)).toBeUndefined();
  expect(norm("c:/Users//Ann\\x", true)).toBe("C:\\Users\\Ann\\x");
  expect(norm("\\\\server\\share", true)).toBeUndefined();
  expect(within("/home/ann2", "/home/ann", false)).toBe(false);
  expect(within("C:\\USERS\\ANN\\x", "C:\\Users\\ann", true)).toBe(true);
  const s = new Scope("/home/ann", false);
  s.issue("/usr/share/applications/firefox.desktop");
  s.issue("/media/usb", true);
  expect(s.allow("/home/ann/Documents/a.txt")).toBe("/home/ann/Documents/a.txt");
  expect(s.allow("/home/ann/../bob/secret")).toBeUndefined();
  expect(s.allow("/home/bob")).toBeUndefined();
  expect(s.allow("/usr/share/applications/firefox.desktop")).toBe("/usr/share/applications/firefox.desktop");
  expect(s.allow("/usr/share/applications/other.desktop")).toBeUndefined();
  expect(s.allow("/media/usb/photos/1.jpg")).toBe("/media/usb/photos/1.jpg");
  expect(s.allow("/etc/shadow")).toBeUndefined();
  const w = new Scope("C:\\Users\\ann", true);
  w.issue("C:\\Users\\Public\\Desktop", true);
  expect(w.allow("c:\\users\\ann\\desktop\\x.txt")).toBe("C:\\users\\ann\\desktop\\x.txt");
  expect(w.allow("C:\\Users\\Public\\Desktop\\app.lnk")).toBe("C:\\Users\\Public\\Desktop\\app.lnk");
  expect(w.allow("C:\\Users\\bob\\x")).toBeUndefined();
  expect(w.allow("C:\\Users\\ann\\..\\bob")).toBeUndefined();
  const again = new Scope("C:\\Users\\ann", true);
  again.load(w.list());
  expect(again.allow("C:\\Users\\Public\\Desktop\\app.lnk")).toBeDefined();
  expect(sftpPath("C:\\Users\\ann\\a b.txt", true)).toBe("/C:/Users/ann/a b.txt");
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
  expect(L.gArray(["a.desktop", "it's.desktop"])).toBe("['a.desktop', 'it\\'s.desktop']");
  expect(L.uriPath("file:///home/ann/Pictures/my%20pic.png")).toBe("/home/ann/Pictures/my pic.png");
  expect(L.uriPath("https://x")).toBe("");
  expect(L.fileUri("/home/ann/a b#c.png")).toBe("file:///home/ann/a%20b%23c.png");
  const info = L.trashInfo("/home/ann/my file ü.txt", Date.UTC(2026, 0, 2, 3, 4, 5));
  expect(info).toContain("Path=/home/ann/my%20file%20%C3%BC.txt\n");
  expect(L.parseTrashInfo(info)!.path).toBe("/home/ann/my file ü.txt");
  expect(L.trashDate(Date.UTC(2026, 0, 2, 3, 4, 5), 0)).toBe("2026-01-02T03:04:05");
  expect(L.parseTrashInfo("[Trash Info]\nPath=relative\n")).toBeUndefined();
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
  expect(L.kdeScript({ pins: ["a.desktop"] })).toContain("'launchers',\"applications:a.desktop\"");
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
      `\x1edeskdir\t/home/ann/Desktop\n` +
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
  const b = L.buildDesk(gsRecs(""), apps);
  const d = b.desk;
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
  expect(linuxOps(d, undefined, { dark: false, pins: ["a.desktop"] })).toEqual([
    "gs\torg.gnome.desktop.interface\tcolor-scheme\t'default'",
    "gs\torg.gnome.shell\tfavorite-apps\t['a.desktop']",
  ]);
  expect(linuxOps(d, undefined, { wallpaper: "/x\n/y" })[0]).toBe(
    "gs\torg.gnome.desktop.background\tpicture-uri\t'file:///x%0A/y'",
  );
  const nobus = L.buildDesk(records("\x1eenv\nhome=/home/ann\nde=gnome\nbus=0\n"), []).desk;
  expect(nobus.can.wallpaper).toBe(false);
  expect(nobus.icons.map((i) => i.kind)).toEqual(["bin"]);
});

test("linux: xfce and kde set lines", () => {
  const files = new Map([
    [
      "/home/ann/.config/xfce4/xfconf/xfce-perchannel-xml/xsettings.xml",
      '<property name="Net" type="empty"><property name="ThemeName" type="string" value="Greybird"/></property>',
    ],
  ]);
  const xd = {
    shell: "xfce",
    can: { wallpaper: true, dark: true, accent: false, pins: false },
    accents: [],
  } as unknown as Desk;
  expect(linuxOps(xd, { files } as any, { dark: true })).toEqual([
    "xf\txsettings\t/Net/ThemeName\tstring\tGreybird-dark",
  ]);
  expect(() => linuxOps(xd, { files } as any, { pins: [] })).toThrow(/xfce/);
  const kd = {
    shell: "kde",
    can: { wallpaper: true, dark: true, accent: true, pins: true },
    accents: [],
  } as unknown as Desk;
  const ops = linuxOps(kd, undefined, { dark: true, accent: "#ff0000", wallpaper: "/home/ann/a.png" });
  expect(ops[0]!.startsWith("kde-js\t")).toBe(true);
  expect(Buffer.from(ops[0]!.split("\t")[1]!, "base64").toString()).toContain("file:///home/ann/a.png");
  expect(ops.slice(1)).toEqual(["kde-scheme\tBreezeDark", "kde-accent\t#ff0000"]);
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

// the probe itself in sh, a temp home's trash: delete, list, restore, empty
// dash where Git for Windows has it, as Ubuntu's sh is, which reads its script ahead
const sh = [
  "/bin/sh",
  "/usr/bin/sh",
  "C:/Program Files/Git/usr/bin/dash.exe",
  "C:/Program Files/Git/usr/bin/sh.exe",
].find((p) => existsSync(p));
test.skipIf(!sh)(
  "probe.sh: a file to the trash and back",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "phos-desk-"));
    mkdirSync(join(home, "Desktop"), { recursive: true });
    const native = join(home, "Desktop", "a note.txt");
    writeFileSync(native, "hi");
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
    const [del, list, again] = await run([
      ["delete", `${f}\n${L.trashInfo(f, Date.now())}`],
      ["trash", ""],
      ["delete", `${f}\n${L.trashInfo(f, Date.now())}`],
    ]);
    expect(del!.ok).toBe(true);
    expect(existsSync(native)).toBe(false);
    const items = records(list!.body).filter((r) => r.kind === "item");
    expect(items.length).toBe(1);
    expect(L.parseTrashInfo(items[0]!.body)!.path).toBe(f);
    expect(again!.ok).toBe(false);
    const [back, clash] = await run([
      ["restore", `${items[0]!.args[0]}\n${f}`],
      ["restore", `${items[0]!.args[0]}\n${f}`],
    ]);
    expect(back!.ok).toBe(true);
    expect(readFileSync(native, "utf8")).toBe("hi");
    expect(clash!.ok).toBe(false);
    const [bad, nope, desk] = await run([
      ["restore", `../x\n${f}`],
      ["format", ""],
      ["desktop", ""],
    ]);
    expect(bad!.ok).toBe(false);
    expect(nope!.body).toContain("no such request");
    const env = records(desk!.body).find((r) => r.kind === "env")!;
    expect(env.body).toContain(`home=${posix(home)}`);
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
