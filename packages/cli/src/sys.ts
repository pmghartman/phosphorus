// what differs by platform: the resize and quit signals, a file's owner
// carried to its replacement, and a child left to outlive this process
import { chownSync, type Stats } from "node:fs";

const win = process.platform === "win32";

// no resize signal on Windows: the size polled by the loop's tick
export const sigResize: NodeJS.Signals | undefined = win ? undefined : "SIGWINCH";
export const quitSignals: NodeJS.Signals[] = win ? ["SIGINT", "SIGTERM"] : ["SIGTERM", "SIGHUP"];

export function chownLike(file: string, st: Stats) {
  if (!win) chownSync(file, st.uid, st.gid);
}

// argv started in its own session on unix, nothing of this process's handed
// to it, a failure to start ignored as Go's Start was
export function spawnDetached(argv: string[]) {
  try {
    Bun.spawn(argv, { detached: !win, stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true }).unref();
  } catch {}
}

// startDetached argv in its own session, run after delayMs, outliving this process
export function startDetached(argv: string[], delayMs: number) {
  setTimeout(() => spawnDetached(argv), delayMs);
}
