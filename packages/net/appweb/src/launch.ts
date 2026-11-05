// an Electron app started on its host for the browser: its own binary, waiting at its first
// line for the hook, then let go; what comes back is the link to its main process

import { inject, inspectorOf } from "./inspector.ts";
import type { Host, Pipe, Proc } from "./pipe.ts";

export type Started = { proc: Proc; link: Pipe; pid: number; token: string; log: () => string };

const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// the command that starts it: its stderr ours, so the inspector's line is read
export function commandOf(os: "windows" | "linux", exe: string, args: string[]): string {
  const all = ["--inspect-brk=127.0.0.1:0", ...args];
  if (os === "windows") {
    const ps =
      "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" +
      `$i = New-Object System.Diagnostics.ProcessStartInfo ${psq(exe)};` +
      `$i.Arguments = ${psq(all.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" "))};` +
      "$i.UseShellExecute = $false;" +
      "$p = [Diagnostics.Process]::Start($i); $p.WaitForExit()";
    return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(ps, "utf16le").toString("base64")}`;
  }
  // a display of its own: headless Ozone, nothing drawn on the host's screen
  return `exec ${[exe, ...all, "--ozone-platform=headless"].map(shq).join(" ")}`;
}

export async function start(host: Host, exe: string, args: string[], lingerMs = 120_000): Promise<Started> {
  const proc = await host.run(commandOf(host.os, exe, args));
  let log = "";
  const at = await new Promise<{ host: string; port: number; path: string }>((ok, no) => {
    const t = setTimeout(
      () =>
        no(
          new Error(
            log.includes("--inspect")
              ? "the app refuses to be inspected"
              : `the app never let phosphorus in${log.trim() ? `: ${log.trim().split("\n").pop()}` : ""}`,
          ),
        ),
      15_000,
    );
    proc.onErr((b) => {
      log += Buffer.from(b).toString("utf8");
      if (log.length > 64 << 10) log = log.slice(-32 << 10);
      const i = inspectorOf(log);
      if (i) {
        clearTimeout(t);
        ok(i);
      }
    });
    proc.onData((b) => {
      log += Buffer.from(b).toString("utf8");
    });
    proc.onClose(() => {
      clearTimeout(t);
      no(new Error(`the app ended before it started${log.trim() ? `: ${log.trim().split("\n").pop()}` : ""}`));
    });
  });
  const insp = await host.connect(at.port);
  const h = await inject(insp, at, lingerMs);
  const link = await host.connect(h.port);
  return { proc, link, pid: h.pid, token: h.token, log: () => log };
}
