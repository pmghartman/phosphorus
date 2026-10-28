// each OS's side of the app: where its home, host binary and release payload
// are, dialogs, the browser, the admin steps, the login item, one instance per
// user, and a downloaded release swapped in for this one

import { dlopen } from "bun:ffi";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { errText, run } from "@phosphorus/util";
import { wstr } from "./tray.ts";

export const darwin = process.platform === "darwin";

// a file's trimmed text, "" when unreadable
export function read(p: string): string {
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

// a child left to run on its own, this process's exit no end to it
const detach = (argv: string[]) =>
  Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true }).unref();

// the tray as the login item launches it: bun with the script in a dev run; the
// binary, which is the host's too, with tray; on Windows the launcher beside it, a
// window-less start of the same, when it's there
function appArgv(): string[] {
  if (process.execPath.replace(/\.exe$/i, "").endsWith("bun")) return [process.execPath, Bun.main, "tray"];
  const launcher = join(exe, "Phosphorus.exe");
  if (!darwin && existsSync(launcher)) return [launcher];
  return [process.execPath, "tray"];
}

// where the app's binary is: Phosphorus.app/Contents/MacOS or the install dir;
// PHOSPHORUS_APP_DIR for a bare dev run beside a built host
function exeDir(): string {
  if (process.env.PHOSPHORUS_APP_DIR) return process.env.PHOSPHORUS_APP_DIR;
  try {
    return dirname(realpathSync(process.execPath));
  } catch {
    return dirname(process.execPath);
  }
}

function homeDir(): string {
  if (process.env.PHOSPHORUS_HOME) return process.env.PHOSPHORUS_HOME;
  // not %LOCALAPPDATA%\Phosphorus: the app's own install dir, wiped by its uninstaller
  if (!darwin) return join(process.env.USERPROFILE ?? "", "phosphorus");
  return join(process.env.HOME ?? "", "Library/Phosphorus");
}

const exe = exeDir();
// this binary, symlinks resolved: the host's commands are its own
function self(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}
// the app's places: the host binary, this same one, and the release payload it ships;
// PHOSPHORUS_HOST_BIN a built host for a bare dev run of the tray script
export const app = {
  exe,
  home: homeDir(),
  host:
    process.env.PHOSPHORUS_HOST_BIN ||
    (Bun.main.endsWith(".ts") ? join(exe, darwin ? "phosphorus-host" : "phosphorus-host.exe") : self()),
  // not "phosphorus": beside the Phosphorus binary on a case-insensitive disk
  payload: darwin ? join(exe, "../Resources/release") : join(exe, "release"),
};

// the app bundle this runs from, "" when run bare
function bundle(): string {
  const d = join(app.exe, "../..");
  return d.endsWith(".app") ? d : "";
}

const sq = (s: string) => "'" + s.replaceAll("'", `'\\''`) + "'";
// an AppleScript string literal
const asq = (s: string) => '"' + s.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';

// one host command, its ok
const hostOK = async (...args: string[]) => (await run([app.host, ...args, "--home", app.home])).ok;

export type OS = {
  // where this app runs from, for a service updating it with no one signed in
  noteAppDir(): void;
  // one tray per user: a lock held while this runs, false when another holds it
  singleInstance(): boolean;
  notify(text: string): Promise<void>;
  alert(text: string): Promise<void>;
  // yes on the last button, the first cancelling
  confirm(text: string, yes: string, no: string): Promise<boolean>;
  openURL(u: string): void;
  // the admin-only steps behind the system's own prompt, once
  adminSetup(): Promise<void>;
  // one host command as root behind the system's prompt
  asAdmin(...args: string[]): Promise<void>;
  // the login item: this app at login, its tray alone
  setAutostart(on: boolean): void;
  // the app removed once this process is gone
  removeApp(): Promise<void>;
  // the release's download installed in this app's place and started once this one exits
  installDownloaded(file: string): Promise<void>;
};

// the lock's fd or handle, held open for the process's life
let lock: number | bigint | undefined;

const mac: OS = {
  noteAppDir() {},
  singleInstance() {
    mkdirSync(join(app.home, "state"), { recursive: true });
    const { flock } = libc();
    let fd: number;
    try {
      fd = openSync(join(app.home, "state/tray.lock"), "a+");
    } catch {
      return true;
    }
    if (flock(fd, 2 | 4 /* LOCK_EX|LOCK_NB */) !== 0) {
      closeSync(fd);
      return false;
    }
    lock = fd;
    return true;
  },
  notify: (text) => dialog(text, "note", "OK").then(() => {}),
  alert: (text) => dialog(text, "stop", "OK").then(() => {}),
  confirm: (text, yes, no) => dialog(text, "caution", no, yes),
  openURL(u) {
    detach(["/usr/bin/open", u]);
  },
  async adminSetup() {
    if (await hostOK("setup", "--check")) return;
    await mac.asAdmin("setup");
  },
  async asAdmin(...args) {
    const sh = [sq(app.host), ...args, "--home", sq(app.home)].join(" ");
    await run(["/usr/bin/osascript", "-e", "do shell script " + asq(sh) + " with administrator privileges"]);
  },
  setAutostart(on) {
    const p = join(process.env.HOME ?? "", "Library/LaunchAgents/Phosphorus.plist");
    if (!on) return void rmSync(p, { force: true });
    const args = [...appArgv(), "--background"].map((s) => `<string>${xmlEsc(s)}</string>`).join("");
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>Phosphorus</string>
  <key>ProgramArguments</key><array>${args}</array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
    if (read(p) === plist.trim()) return;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, plist);
  },
  async removeApp() {
    const b = bundle();
    if (b) detach(["/bin/sh", "-c", `sleep 2; rm -rf ${sq(b)}`]);
  },
  // the release's Phosphorus.app.tar.gz unpacked beside this bundle, swapped in
  // for it, then started once this one exits
  async installDownloaded(file) {
    const b = bundle();
    if (!b) throw new Error("not running from Phosphorus.app");
    let stage: string;
    try {
      stage = mkdtempSync(join(dirname(b), ".phosphorus-update-"));
    } catch (e) {
      throw new Error(`can't write beside ${b}: ${errText(e)}`);
    }
    try {
      const r = await run(["/usr/bin/tar", "-xzf", file, "-C", stage]);
      if (!r.ok) throw new Error("unpacking: " + r.output.trim());
      const name = readdirSync(stage).find((n) => n.endsWith(".app"));
      if (!name) throw new Error("no app in the download");
      const fresh = join(stage, name),
        old = join(stage, "old.app");
      renameSync(b, old);
      try {
        renameSync(fresh, b);
      } catch (e) {
        renameSync(old, b);
        throw e;
      }
      detach(["/bin/sh", "-c", `sleep 1; /usr/bin/open ${sq(b)} --args --background`]);
      if (typeof lock === "number") closeSync(lock);
      lock = undefined;
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  },
};

// osascript's display dialog: true when its last button was pressed, the first of
// several cancelling (osascript fails on it)
async function dialog(text: string, icon: string, ...buttons: string[]): Promise<boolean> {
  let script = `display dialog ${asq(text)} with title "Phosphorus" buttons {${buttons.map(asq).join(", ")}} default button ${asq(buttons.at(-1)!)} with icon ${icon}`;
  if (buttons.length > 1) script += " cancel button 1";
  return (await run(["/usr/bin/osascript", "-e", script])).ok;
}

const xmlEsc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const MB_OK = 0,
  MB_OKCANCEL = 1,
  MB_ICONERROR = 0x10,
  MB_ICONWARNING = 0x30,
  MB_ICONINFORMATION = 0x40,
  MB_DEFBUTTON2 = 0x100;
const MB_SETFOREGROUND = 0x10000,
  MB_TOPMOST = 0x40000,
  IDOK = 1;

const windows: OS = {
  noteAppDir() {
    mkdirSync(join(app.home, "state"), { recursive: true });
    writeFileSync(join(app.home, "state", "app-dir"), app.exe + "\n");
  },
  // the lock file opened with no sharing: a second open fails while this one holds it
  singleInstance() {
    mkdirSync(join(app.home, "state"), { recursive: true });
    const { CreateFileW } = kernel32();
    const h = CreateFileW(
      wstr(join(app.home, "state/tray.lock")),
      0x40000000 /* GENERIC_WRITE */,
      0,
      0n,
      4 /* OPEN_ALWAYS */,
      0x80 /* FILE_ATTRIBUTE_NORMAL */,
      0n,
    );
    if (BigInt(h) === 0xffffffffffffffffn) return false;
    lock = h;
    return true;
  },
  notify: async (text) => void box(text, MB_OK | MB_ICONINFORMATION),
  alert: async (text) => void box(text, MB_OK | MB_ICONERROR),
  // Windows' own buttons: OK for yes, Cancel for no
  confirm: async (text) => box(text, MB_OKCANCEL | MB_ICONWARNING | MB_DEFBUTTON2) === IDOK,
  openURL(u) {
    detach(["rundll32", "url.dll,FileProtocolHandler", u]);
  },
  // raised by the host binary itself
  async adminSetup() {},
  async asAdmin() {},
  setAutostart(on) {
    const key = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;
    if (!on) return void run(["reg", "delete", key, "/v", "Phosphorus", "/f"]);
    const cmd = [...appArgv().map((s) => `"${s}"`), "--background"].join(" ");
    void run(["reg", "add", key, "/v", "Phosphorus", "/t", "REG_SZ", "/d", cmd, "/f"]);
  },
  // the installer's uninstaller run once this process is gone
  async removeApp() {
    const un = join(app.exe, "uninstall.exe");
    if (!existsSync(un)) return;
    await afterExit(`"${un}" /S`);
  },
  // the release's setup run silently once this process is gone; it starts the new app
  async installDownloaded(file) {
    await afterExit(`"${file}" /S /R`);
  },
};

const psq = (s: string) => "'" + s.replaceAll("'", "''") + "'";

// a command line run hidden 2s on, started via WMI: outside this process's job
// (a scheduled task's, Bun's own), which this one's exit would kill
async function afterExit(line: string) {
  const script =
    "$s = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; " +
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${psq("cmd /c ping -n 3 127.0.0.1 >nul & " + line)}; ProcessStartupInformation=$s}; ` +
    "exit $r.ReturnValue";
  const r = await run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script]);
  if (!r.ok) throw new Error(`couldn't start ${line}: ${r.output.trim() || "WMI refused"}`);
}

// a modal box, the thread's messages pumped by it meanwhile
function box(text: string, flags: number): number {
  return user32().MessageBoxW(0n, wstr(text), wstr("Phosphorus"), flags | MB_SETFOREGROUND | MB_TOPMOST);
}

// the system libraries opened on first use, so this module loads on either OS
const lazy = <T>(f: () => T) => {
  let v: T | undefined;
  return () => (v ??= f());
};
const libc = lazy(() => dlopen("libSystem.B.dylib", { flock: { args: ["i32", "i32"], returns: "i32" } }).symbols);
const kernel32 = lazy(
  () =>
    dlopen("kernel32.dll", { CreateFileW: { args: ["ptr", "u32", "u32", "u64", "u32", "u32", "u64"], returns: "u64" } })
      .symbols,
);
const user32 = lazy(
  () => dlopen("user32.dll", { MessageBoxW: { args: ["u64", "ptr", "ptr", "u32"], returns: "i32" } }).symbols,
);

export const os: OS = darwin ? mac : windows;
