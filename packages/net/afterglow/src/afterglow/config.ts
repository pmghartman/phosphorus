// afterglow's files as the app that installs it writes them: its config, the link file
// the driver reads to find it, its Windows service line or Linux systemd unit. Plain
// text and paths, so a host app's installer is tested anywhere; installing the service
// and the SudoVDA driver is the host app's own (phosphorus: packages/host/host/src/win/afterglow.ts)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LinkAddr } from "./link.ts";

// the link's port on 127.0.0.1
export const linkPort = 47100;

export type AfterglowPaths = { data: string; conf: string; apps: string; link: string; log: string };

export const pathsOf = (data: string): AfterglowPaths => ({
  data,
  conf: join(data, "afterglow.conf"),
  apps: join(data, "apps.json"),
  link: join(data, "link.json"),
  log: join(data, "afterglow.log"),
});

// the config: the link on, the log beside it, and an app's virtual display made the
// primary one while it streams so its windows open there. The host (host/src/conf.rs)
// reads these keys and ignores any others, so a config written for the C++ host still works
export function confText(p: AfterglowPaths, port: number, token: string): string {
  const kv: [string, string | number][] = [
    ["phos_link_port", port],
    ["phos_link_token", token],
    ["log_path", p.log],
    ["min_log_level", "info"],
    ["dd_configuration_option", "ensure_primary"],
  ];
  return `# written by phosphorus: changes here are put back on its next start\r\n${kv.map(([k, v]) => `${k} = ${v}`).join("\r\n")}\r\n`;
}

// no apps of its own: the driver names each one as it launches it. The host no longer
// reads it; kept so an installer that writes it builds unchanged
export const appsText = () => `${JSON.stringify({ env: {}, apps: [] }, null, 2)}\n`;

export const linkText = (port: number, token: string) => `${JSON.stringify({ port, token })}\n`;

// the service's command line: its program, then the config it starts afterglow with
export const svcBinPath = (root: string, conf: string) => `"${join(root, "tools", "afterglowsvc.exe")}" "${conf}"`;

// Linux: the systemd unit that keeps afterglow running, as the user its apps run as.
// It needs no desktop session: each app gets an Xvfb of its own. Stopping it lets
// afterglow close the app and its display before anything is killed
export function unitText(bin: string, conf: string, user: string): string {
  return [
    "[Unit]",
    "Description=afterglow, phosphorus's streaming host",
    "After=network.target",
    "",
    "[Service]",
    `ExecStart="${bin}" "${conf}"`,
    `User=${user}`,
    "Restart=on-failure",
    "RestartSec=3",
    "KillMode=mixed",
    "TimeoutStopSec=15",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

// a token from a link file, kept across starts so a running afterglow and the
// frontend agree on it; a fresh one when there's none worth keeping
export function tokenOf(linkFileText: string, fresh: () => string): string {
  try {
    const t = String(JSON.parse(linkFileText)?.token ?? "");
    if (/^[0-9a-f]{32,}$/.test(t)) return t;
  } catch {}
  return fresh();
}

// the INF's DriverVer: which SudoVDA the release carries
export function driverVer(inf: string): string {
  return /^\s*DriverVer\s*=\s*([^\r\n;]+)/im.exec(inf)?.[1]?.trim() ?? "";
}

// the link's address out of a link file, undefined when afterglow isn't set up there
export function readLink(file: string): LinkAddr | undefined {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    const port = Number(j?.port);
    const token = String(j?.token ?? "");
    if (!Number.isInteger(port) || port < 1 || port > 65535 || token.length < 16) return undefined;
    return { port, token };
  } catch {
    return undefined;
  }
}
