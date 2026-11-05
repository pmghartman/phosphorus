// afterglow's files as phosphorus writes them: its config, its empty app list and the
// link file the frontend reads. afterglow (native/afterglow) is phosphorus's fork of
// Apollo, shipped in every Windows release under afterglow/ and set up on each host
// by win/afterglow.ts; these are the parts that don't touch Windows, so they're tested
// anywhere
import { join } from "node:path";

// the link's port: one of its own, clear of GameStream's 47984-48010 should the
// host also run a Sunshine or Apollo
export const linkPort = 47100;

export type AfterglowPaths = { data: string; conf: string; apps: string; link: string; log: string };

export const pathsOf = (data: string): AfterglowPaths => ({
  data,
  conf: join(data, "afterglow.conf"),
  apps: join(data, "apps.json"),
  link: join(data, "link.json"),
  log: join(data, "afterglow.log"),
});

// the config: phosphorus's link on, nothing of GameStream's listening, the
// encoders' lowest latency presets, and an app's virtual display made the primary
// one while it streams so its windows open there, put back after
export function confText(p: AfterglowPaths, port: number, token: string): string {
  const kv: [string, string | number][] = [
    ["sunshine_name", "phosphorus-afterglow"],
    ["phos_link_port", port],
    ["phos_link_token", token],
    ["address_family", "ipv4"],
    ["upnp", "off"],
    ["origin_web_ui_allowed", "pc"],
    ["system_tray", "disabled"],
    ["file_apps", p.apps],
    ["file_state", join(p.data, "state.json")],
    ["credentials_file", join(p.data, "creds.json")],
    ["pkey", join(p.data, "key.pem")],
    ["cert", join(p.data, "cert.pem")],
    ["log_path", p.log],
    ["min_log_level", "info"],
    ["dd_configuration_option", "ensure_primary"],
    ["sw_preset", "ultrafast"],
    ["sw_tune", "zerolatency"],
    ["nvenc_preset", 1],
    ["nvenc_twopass", "disabled"],
    ["qsv_preset", "veryfast"],
    ["amd_usage", "ultralowlatency"],
    ["amd_quality", "speed"],
  ];
  return `# written by phosphorus: changes here are put back on its next start\r\n${kv.map(([k, v]) => `${k} = ${v}`).join("\r\n")}\r\n`;
}

// no apps of its own: phosphorus names each one as it launches it
export const appsText = () => `${JSON.stringify({ env: {}, apps: [] }, null, 2)}\n`;

export const linkText = (port: number, token: string) => `${JSON.stringify({ port, token })}\n`;

// the service's command line: its program, then the config it starts afterglow with
export const svcBinPath = (root: string, conf: string) => `"${join(root, "tools", "afterglowsvc.exe")}" "${conf}"`;

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
