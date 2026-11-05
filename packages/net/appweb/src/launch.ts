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
  // a display of its own, nothing drawn on the host's screen: a private Xvfb with its own
  // cookie, as afterglow's; headless Ozone without it, which segfaults on a second window
  const run = [exe, ...all].map(shq).join(" ");
  const sh = `echo "phos-pid $$" >&2
x=
if command -v Xvfb >/dev/null 2>&1 && command -v xauth >/dev/null 2>&1; then
  d=$(mktemp -d "\${XDG_RUNTIME_DIR:-/tmp}/phos-aw-XXXXXX") && a="$d/Xauthority" && n=90
  while [ -e /tmp/.X11-unix/X$n ] || [ -e /tmp/.X$n-lock ]; do n=$((n+1)); done
  xauth -q -f "$a" add :$n . "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \\n')" 2>/dev/null
  Xvfb :$n -screen 0 1920x1080x24 -auth "$a" -nolisten tcp -noreset >/dev/null 2>&1 &
  xp=$!
  i=0
  while [ ! -e /tmp/.X11-unix/X$n ] && [ $i -lt 50 ] && kill -0 $xp 2>/dev/null; do sleep 0.1; i=$((i+1)); done
  if [ -e /tmp/.X11-unix/X$n ]; then
    x=1
    export DISPLAY=:$n XAUTHORITY="$a"
  else
    kill $xp 2>/dev/null; rm -rf "$d"
  fi
fi
# the display gone with the app: the app takes this shell's pid, watched from beside it
if [ -n "$x" ]; then
  ap=$$
  (trap '' HUP; while kill -0 $ap 2>/dev/null; do sleep 2; done; kill $xp 2>/dev/null; rm -rf "$d") >/dev/null 2>&1 </dev/null &
  exec ${run} --ozone-platform=x11
fi
exec ${run} --ozone-platform=headless`;
  return `sh -c ${shq(sh)}`;
}

export async function start(host: Host, exe: string, args: string[], lingerMs = 120_000): Promise<Started> {
  const proc = await host.run(commandOf(host.os, exe, args));
  let log = "";
  let pid = "";
  try {
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
        pid ||= /phos-pid (\d+)/.exec(log)?.[1] ?? "";
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
  } catch (e) {
    // a start that failed left nothing running: an ssh channel's close doesn't end it
    if (pid && host.os === "linux")
      void host.run(`kill ${pid}`).then(
        (p) => p.close(),
        () => {},
      );
    proc.close();
    throw e;
  }
}
