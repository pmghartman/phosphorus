// the root daemon's control socket on macOS, the tray's way to its host: one
// JSON line asked, one answered, then closed

import { createConnection } from "node:net";

export const sockPath = "/var/run/phosphorus.sock";

export type Reply = { ok: boolean; error?: string; dropped?: boolean; [k: string]: unknown };

// reply the last line of what came back, a dropped one when there's none
export function reply(text: string): Reply {
  const line = text.trim().split("\n").at(-1) ?? "";
  try {
    const v = JSON.parse(line);
    if (v && typeof v === "object" && typeof v.ok === "boolean") return v;
  } catch {}
  return { ok: false, dropped: true, error: "phosphorus's daemon didn't answer" };
}

// call one request, its reply; a dropped one when the daemon's gone or restarting
export function call(req: Record<string, unknown>, ms = 15_000, path = sockPath): Promise<Reply> {
  return new Promise((resolve) => {
    let text = "";
    let done = false;
    const s = createConnection(path);
    const end = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      s.destroy();
      resolve(reply(text));
    };
    const t = setTimeout(end, ms);
    s.setEncoding("utf8");
    s.on("connect", () => s.write(JSON.stringify(req) + "\n"));
    s.on("data", (d) => void (text += d));
    s.on("end", end);
    s.on("close", end);
    s.on("error", end);
  });
}
