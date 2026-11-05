// afterglow set up on this Windows host: phosphorus's fork of Apollo, which the
// release carries under afterglow/ (synced into the home with the rest of it). Run by
// the elevated setup and by every rebuild (the service's, as SYSTEM), each step done
// only when it isn't already: its data folder for SYSTEM and administrators alone,
// its config and the link file the frontend reads, the SudoVDA virtual display driver
// (so a host with no monitor streams), and the PhosphorusAfterglow service, restarted
// when a release brings a new afterglow.exe
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appsText, confText, driverVer, linkPort, linkText, pathsOf, svcBinPath, tokenOf } from "../afterglow.ts";
import { at, fileExists, output, quiet, run, say } from "../base.ts";
import { ps } from "./setup.ts";

export const afterglowSvc = "PhosphorusAfterglow";

export const afterglowRoot = () => at("afterglow");
const dataDir = () => at("state", "data", "afterglow");

// the service's state by sc's number, 0 when there's no such service
async function state(): Promise<number> {
  const m = /STATE\s*:\s*(\d+)/.exec(await output("sc", "query", afterglowSvc));
  return m ? Number(m[1]) : 0;
}

async function waitState(want: number, ms: number) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(250)) if ((await state()) === want) return true;
  return false;
}

const writeIfChanged = (p: string, text: string) => {
  try {
    if (readFileSync(p, "utf8") === text) return false;
  } catch {}
  writeFileSync(p, text, { mode: 0o600 });
  return true;
};

// an INF's text: SudoVDA's is UTF-16 with a byte order mark
const infText = (p: string) => {
  const b = readFileSync(p);
  return b[0] === 0xff && b[1] === 0xfe ? b.subarray(2).toString("utf16le") : b.toString("utf8");
};

// the virtual display driver: installed from the release's copy when this host has
// no SudoVDA yet (one an Apollo install put here is used as it is), or when the
// release carries a newer one than phosphorus installed
async function ensureDriver(root: string, data: string) {
  const dir = join(root, "drivers", "sudovda");
  const inf = join(dir, "SudoVDA.inf");
  if (!fileExists(inf) || !fileExists(join(dir, "SudoVDA.dll")) || !fileExists(join(dir, "nefconc.exe"))) return;
  const want = driverVer(infText(inf));
  const mark = join(data, "driver.txt");
  const had = existsSync(mark) ? readFileSync(mark, "utf8").trim() : "";
  if (had === want) return;
  const present =
    (await ps(
      "@(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.HardwareID -contains 'root\\sudomaker\\sudovda' }).Count",
    )) !== "0";
  if (present && !had) {
    say("afterglow: using the SudoVDA virtual display driver already on this host");
  } else {
    say(`afterglow: installing the SudoVDA virtual display driver ${want}`);
    if (!(await run("cmd.exe", "/d", "/c", join(dir, "install.bat")))) {
      say("afterglow: the virtual display driver didn't install; apps stream from the monitor that's on");
      return;
    }
  }
  writeFileSync(mark, `${want}\n`, { mode: 0o600 });
}

// everything afterglow needs, done once; quiet when there's no afterglow in this release
export async function ensureAfterglow(): Promise<void> {
  const root = afterglowRoot();
  const exe = join(root, "afterglow.exe");
  if (!fileExists(exe) || !fileExists(join(root, "tools", "afterglowsvc.exe"))) return;
  if (!(await quiet("net", "session"))) {
    // a rebuild from an ordinary shell: the service's own rebuild sets it up later
    if ((await state()) === 0) say("afterglow: needs admin to set up; phos setup does it");
    return;
  }
  const p = pathsOf(dataDir());
  mkdirSync(p.data, { recursive: true });
  // its token and config for SYSTEM and administrators only: whoever reads the token
  // can type into the console's session
  for (const a of [
    ["/reset", "/T", "/C"],
    ["/setowner", "*S-1-5-32-544", "/T", "/C"],
    ["/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"],
  ])
    await quiet("icacls", p.data, ...a);
  const token = tokenOf(existsSync(p.link) ? readFileSync(p.link, "utf8") : "", () => randomBytes(24).toString("hex"));
  let changed = writeIfChanged(p.conf, confText(p, linkPort, token));
  changed = writeIfChanged(p.apps, appsText()) || changed;
  writeIfChanged(p.link, linkText(linkPort, token));

  await ensureDriver(root, p.data);

  // the service: created, or pointed at this home's copy
  const bin = svcBinPath(root, p.conf);
  if ((await state()) === 0) {
    say("afterglow: installing the PhosphorusAfterglow service");
    if (
      !(await run(
        "sc",
        "create",
        afterglowSvc,
        "binPath=",
        bin,
        "start=",
        "auto",
        "DisplayName=",
        "Phosphorus Afterglow",
      ))
    ) {
      say("afterglow: couldn't install its service");
      return;
    }
    await quiet(
      "sc",
      "description",
      afterglowSvc,
      "afterglow: phosphorus's streaming host, forked from Apollo; streams this machine's apps to phosphorus",
    );
    await quiet("sc", "failure", afterglowSvc, "reset=", "0", "actions=", "restart/3000");
  } else if (!(await output("sc", "qc", afterglowSvc)).includes(join(root, "tools", "afterglowsvc.exe"))) {
    await quiet("sc", "config", afterglowSvc, "binPath=", bin, "start=", "auto");
    changed = true;
  }

  // a new afterglow.exe (the release's, copied over the running one's moved-aside
  // copy) or config: restarted to take it up
  const st = statSync(exe);
  const stamp = `${st.size} ${Math.round(st.mtimeMs)}`;
  const stampFile = join(p.data, "installed.txt");
  if (writeIfChanged(stampFile, `${stamp}\n`)) changed = true;
  const s = await state();
  if (s === 4 /* RUNNING */ && !changed) return;
  if (s !== 1 /* STOPPED */) {
    await quiet("sc", "stop", afterglowSvc);
    await waitState(1, 30_000);
  }
  if (!(await quiet("sc", "start", afterglowSvc)))
    say("afterglow: its service didn't start; see %SYSTEMROOT%\\Temp\\afterglow.log");
}

// the service gone, the driver left to whatever else may use it (an Apollo install)
export async function removeAfterglow() {
  if ((await state()) === 0) return;
  await quiet("sc", "stop", afterglowSvc);
  await waitState(1, 30_000);
  await quiet("sc", "delete", afterglowSvc);
}
