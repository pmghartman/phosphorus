// Phosphorus's menu bar and tray app, macOS and Windows: a role of the host binary
// (phosphorus-host tray, or Phosphorus.app opened), the release beside it; keys,
// install, start and stop, feed updates, the frontend opened in the default
// browser. The menu's logic is here once, the OS's icon and menu behind Tray
// (mac.ts, tray-win32.ts), the rest of the OS behind os.ts
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Feed, type Release } from "@phosphorus/appfeed";
import { errText, readJSON, sleep } from "@phosphorus/util";
import { frontendURL, hostCmd, hostRun, hostState, installedVersion, keyState, keysMissing, lastError, payloadVersion, report, updateAgentFile } from "./host.ts";
import { keysURL } from "./keys.ts";
import { app, darwin, os } from "./os.ts";
import type { Tray } from "./tray.ts";

// set at release by the build's --define: the app's version, the feed and the key
// its updates are signed with; unset (a dev build) there's no feed
import trayPng from "../assets/tray.png" with { type: "file" };
import iconIco from "../assets/icon.ico" with { type: "file" };

declare const PHOSPHORUS_APP_VERSION: string, PHOSPHORUS_FEED_URL: string, PHOSPHORUS_FEED_PUBKEY: string;
const defined = (f: () => string) => {
  try {
    return f();
  } catch {
    return "";
  }
};
const appVersion = defined(() => PHOSPHORUS_APP_VERSION);
const feed = new Feed(defined(() => PHOSPHORUS_FEED_URL), defined(() => PHOSPHORUS_FEED_PUBKEY));

// the OS's backend, loaded for this platform alone: each opens its libraries on import
async function openTray(icon: Uint8Array, tooltip: string): Promise<Tray> {
  if (darwin) return (await import("./mac.ts")).macTray(icon, tooltip);
  if (process.platform === "win32") return (await import("./tray-win32.ts")).win32Tray(icon, tooltip);
  throw new Error("the Phosphorus tray runs on macOS and Windows; here, use phos");
}

// one action at a time: starting, stopping, installing or uninstalling
let busy = false;
// the status line, the menu's first item and the icon's tooltip
let tip = "Phosphorus";
let startOn = false, stopOn = false;
let tray: Tray;

// the menu as the state has it: the status line, then the service's controls
function menu() {
  tray.setMenu([
    { label: tip, enabled: false },
    { separator: true },
    { label: "Open Phosphorus", onClick: () => void openMain() },
    { label: "Start", enabled: startOn, onClick: () => void hostAction("start", false) },
    { label: "Stop", enabled: stopOn, onClick: () => void hostAction("stop", false) },
    { label: "Check for Updates", onClick: () => void handleUpdate(`app-${Date.now()}`, true) },
    { separator: true },
    { label: "Edit Keys…", onClick: () => void openKeys() },
    { separator: true },
    { label: "Uninstall…", onClick: () => void uninstall() },
    { separator: true },
    { label: "Quit (stops phosphorus)", onClick: () => void quit() },
  ]);
}

function setTip(text: string) {
  tip = text;
  tray.setTooltip(text);
  menu();
}

async function statusTip(running: boolean, vpn: boolean): Promise<string> {
  const v = installedVersion();
  if (!v) return "Phosphorus not set up";
  if (await keysMissing()) return `Phosphorus ${v}: no keys yet`;
  return `Phosphorus ${v}: ${running ? "running" : "stopped"}, ${vpn ? "VPN on" : "VPN off"}`;
}

// the status line and items set from the host's state, all off while busy
async function refresh() {
  const b = busy;
  let running = false;
  if (!b) {
    const s = await hostState();
    running = s.running;
    setTip(await statusTip(running, s.vpn));
  }
  startOn = !b && !running;
  stopOn = !b && running;
  menu();
}

// start or stop, the status line following, a failure shown
async function hostAction(action: "start" | "stop", thenOpen: boolean) {
  if (busy) return;
  busy = true;
  if (action === "start") {
    if (await keysMissing()) {
      busy = false;
      await openKeys();
      return;
    }
    await os.adminSetup();
  }
  setTip(action === "start" ? "Phosphorus starting…" : "Phosphorus stopping…");
  await refresh();
  const r = await hostRun(action, action);
  busy = false;
  await refresh();
  if (!r.ok) await os.alert(lastError(r.output) || "failed, see state/ in the Phosphorus folder");
  else if (thenOpen) await openMain();
  else await os.notify(action === "start" ? "Phosphorus is running." : "Phosphorus stopped.");
}

// the feed's release when newer than this app, undefined when not or with no feed (a dev build)
const feedCheck = () => feed.check(appVersion || payloadVersion());

// the release downloaded, its signature checked, then handed to this OS's installer
async function installRelease(r: Release) {
  await os.installDownloaded(await feed.fetch(r));
}

// an update request: the feed's newer app installed and relaunched (finished on the
// next launch), else this release's images and config re-applied
async function handleUpdate(id: string, ask: boolean) {
  if (busy) {
    report(id, "failed", false, "", "busy starting, stopping or installing; try again once it's done");
    if (ask) await os.notify("Phosphorus is busy starting, stopping or installing; try again once it's done.");
    return;
  }
  busy = true;
  try {
    report(id, "running", false, "", "");
    setTip("Phosphorus checking for updates…");
    let rel: Release | undefined;
    try {
      rel = await feedCheck();
    } catch (e) {
      console.error("phosphorus: update feed:", errText(e));
    }
    if (rel) {
      if (ask && !(await os.confirm(`Phosphorus ${rel.version} is available. Updating restarts phosphorus on this host.`, "Update", "Later"))) {
        report(id, "failed", false, "", "update declined");
        return;
      }
      setTip(`Phosphorus downloading ${rel.version}…`);
      // running with the release named: the next launch finishes it
      report(id, "running", false, rel.version, "");
      try {
        await installRelease(rel);
      } catch (e) {
        report(id, "failed", false, "", errText(e));
        if (ask) await os.alert("update failed: " + errText(e));
        return;
      }
      // the new app relaunched in this one's place
      tray.quit();
      process.exit(0);
    }
    setTip("Phosphorus applying this release…");
    const r = await hostRun("install", "install", "--update", "--payload", app.payload);
    const v = payloadVersion();
    const current = r.output.includes("already up to date");
    if (!r.ok) return void report(id, "failed", false, "", lastError(r.output) || "install failed");
    report(id, "ok", current, v, "");
    if (ask) await os.notify(current ? `Phosphorus ${v} is up to date.` : `Phosphorus ${v} re-applied.`);
  } finally {
    busy = false;
    await refresh();
  }
}

// launch: a new release unpacked into home, a pending update's verdict written,
// the keys asked for when there are none, then the update requests watched
async function startup(background: boolean) {
  os.noteAppDir();
  const installed = installedVersion(), ver = payloadVersion();
  if (installed !== ver && !busy) {
    busy = true;
    setTip(`Phosphorus installing ${ver}…`);
    const args = ["install", "--payload", app.payload];
    if (installed) args.push("--update");
    const r = await hostRun("install", ...args);
    // an update this launch finishes: running, with the release it was for
    const p = readJSON<{ id?: string; state?: string; version?: string }>(updateAgentFile);
    if (p?.state === "running" && p.version && p.id) {
      if (r.ok) report(p.id, "ok", false, ver, "");
      else report(p.id, "failed", false, "", lastError(r.output));
    }
    busy = false;
  }
  // the menu's state beside the browser's opening, neither waiting on the other
  void refresh();
  // opened by hand: the frontend (or the keys); at login: the tray alone
  const { keys, domain } = await keyState();
  if (!keys.TS_AUTHKEY) await openKeys();
  else if (!background) os.openURL(frontendURL(domain));
  const req = join(app.home, "state/update-request.json");
  // the menu kept current with changes made elsewhere (the cli, the Tailscale app)
  for (let tick = 1; ; tick++) {
    await sleep(2000);
    if (tick % 10 === 0 && !busy) await refresh();
    const r = readJSON<{ id?: string }>(req);
    if (!r) continue;
    rmSync(req, { force: true });
    await handleUpdate(r.id ?? "", false);
  }
}

// the keys asked for first when there are none, else the frontend in the browser
async function openMain() {
  const { keys, domain } = await keyState();
  if (!keys.TS_AUTHKEY) return openKeys();
  os.openURL(frontendURL(domain));
}

// the keys form opened in the browser
async function openKeys() {
  let u: string;
  try {
    u = keysURL(startForKeys);
  } catch (e) {
    return os.alert("couldn't open the keys form: " + errText(e));
  }
  os.openURL(u);
}

// phosphorus (re)started on new keys, the tray following; its error, "" when up
async function startForKeys(): Promise<string> {
  while (busy) await sleep(500);
  busy = true;
  try {
    await os.adminSetup();
    setTip("Phosphorus starting…");
    const r = await hostRun("start", "start");
    if (r.ok) return "";
    return lastError(r.output) || "see state/ in the Phosphorus folder";
  } finally {
    busy = false;
    await refresh();
  }
}

// everything gone after a confirm: the host's service, setup and home, the
// login item, then the app
async function uninstall() {
  if (busy) return;
  busy = true;
  const what =
    `This removes Phosphorus from this computer: the host service, its setup and everything in ${app.home}, ` +
    "including this host's git data and shares. Other hosts keep the mesh.";
  if (!(await os.confirm(what, "Uninstall", "Cancel"))) {
    busy = false;
    return;
  }
  setTip("Phosphorus uninstalling…");
  await os.asAdmin("uninstall", "--admin");
  // not hostRun: its log would put the home back
  const r = await hostCmd(["uninstall"]);
  if (!r.ok) {
    busy = false;
    await refresh();
    await os.alert(lastError(r.output) || "uninstall failed");
    return;
  }
  os.setAutostart(false);
  await os.removeApp().catch((e) => os.alert(errText(e)));
  tray.quit();
  process.exit(0);
}

// phosphorus stopped first, then the app gone
async function quit() {
  if (busy) return;
  busy = true;
  setTip("Phosphorus stopping…");
  const r = await hostRun("stop", "stop");
  if (!r.ok) {
    busy = false;
    await refresh();
    await os.alert(lastError(r.output) || "couldn't stop phosphorus, see state/ in the Phosphorus folder");
    return;
  }
  tray.quit();
  process.exit(0);
}

const background = process.argv.includes("--background");
// opened again: the running one's frontend brought up instead
if (!os.singleInstance()) {
  await openMain();
  process.exit(0);
}
// the white glyph as a template on macOS, the .ico on Windows; file imports, so
// a compiled binary carries them
const icon = readFileSync(darwin ? trayPng : iconIco);
try {
  tray = await openTray(icon, "Phosphorus");
} catch (e) {
  console.error(errText(e));
  process.exit(1);
}
menu();
tray.run();
// a host stays up across logins
os.setAutostart(true);
void startup(background);
