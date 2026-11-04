// a headless GameStream host of phosphorus's own: a Sunshine (or Apollo) binary run
// with a config phosphorus writes, on ports of its own, our certificate already among
// its paired clients (no PIN, no pairing round trips), and on Linux its own Xvfb, so
// an app streams from a machine with no monitor, no desktop and no one signed in.
// Tuned for loopback: the least FEC the host allows, its encoders' fastest presets

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Identity } from "./cert.ts";
import { addClient } from "./host.ts";
import type { Host } from "./lumen.ts";

export type InstanceOpts = {
  bin: string;
  dir: string;
  // the HTTP port; the host takes ports around it (https -5, rtsp +21, video +9, control +10, audio +11)
  port: number;
  id: Identity;
  apps: { name: string; cmd: string }[];
  // our certificate already among its paired clients (the default); false leaves it to pair
  trust?: boolean;
  // Linux: the X display to capture, made here when not given
  display?: string;
  screen?: { w: number; h: number };
  encoder?: "software" | "nvenc" | "vaapi" | "quicksync" | "amdvce";
  env?: Record<string, string>;
  log?: "verbose" | "debug" | "info" | "warning" | "error";
};

export type Instance = {
  host: Host;
  display: string;
  stop(): Promise<void>;
  restart(): Promise<void>;
  readonly pid: number;
};

// the config: everything at the host's lowest latency for a loopback client
export function confOf(o: InstanceOpts): string {
  const d = o.dir;
  const kv: Record<string, string | number> = {
    sunshine_name: "phosphorus-glow",
    port: o.port,
    address_family: "ipv4",
    upnp: "off",
    origin_web_ui_allowed: "pc",
    system_tray: "disabled",
    file_apps: join(d, "apps.json"),
    file_state: join(d, "state.json"),
    credentials_file: join(d, "creds.json"),
    pkey: join(d, "key.pem"),
    cert: join(d, "cert.pem"),
    log_path: join(d, "host.log"),
    min_log_level: o.log ?? "warning",
    // parity the least the host allows: on loopback nothing is lost
    fec_percentage: 1,
    sw_preset: "ultrafast",
    sw_tune: "zerolatency",
    nvenc_preset: 1,
    nvenc_twopass: "disabled",
    qsv_preset: "veryfast",
    amd_usage: "ultralowlatency",
    amd_quality: "speed",
  };
  if (o.encoder) kv.encoder = o.encoder;
  if (process.platform === "linux") kv.capture = "x11";
  return `${Object.entries(kv)
    .map(([k, v]) => `${k} = ${v}`)
    .join("\n")}\n`;
}

const freeDisplay = () => {
  for (let n = 140; n < 400; n++) if (!existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`)) return n;
  throw new Error("no free X display");
};

async function upAt(port: number, ms: number, alive: () => boolean) {
  const end = Date.now() + ms;
  while (Date.now() < end && alive()) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/serverinfo`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return true;
    } catch {}
    await Bun.sleep(100);
  }
  return false;
}

export async function startInstance(o: InstanceOpts): Promise<Instance> {
  if (await upAt(o.port, 1, () => true)) throw new Error(`port ${o.port} is taken by another host already`);
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(o.dir, "sunshine.conf"), confOf(o));
  writeFileSync(
    join(o.dir, "apps.json"),
    JSON.stringify({ env: {}, apps: o.apps.map((a) => ({ ...a, "auto-detach": "false" })) }),
  );
  const st = join(o.dir, "state.json");
  if (o.trust !== false) writeFileSync(st, addClient(existsSync(st) ? readFileSync(st, "utf8") : "", o.id.cert).text);
  let xvfb: ReturnType<typeof Bun.spawn> | undefined;
  let display = o.display ?? "";
  if (process.platform === "linux" && !display) {
    const n = freeDisplay();
    const sc = o.screen ?? { w: 1920, h: 1080 };
    xvfb = Bun.spawn(["Xvfb", `:${n}`, "-screen", "0", `${sc.w}x${sc.h}x24`, "-nolisten", "tcp", "-noreset"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    display = `:${n}`;
    for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${n}`); i++) await Bun.sleep(50);
  }
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: o.dir, ...o.env };
  if (display) env.DISPLAY = display;
  let p: ReturnType<typeof Bun.spawn>;
  let exited = false;
  const spawnHost = async () => {
    p = Bun.spawn([o.bin, join(o.dir, "sunshine.conf")], { env, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    exited = false;
    const me = p;
    void me.exited.then(() => {
      if (p === me) exited = true;
    });
    if (!(await upAt(o.port, 20_000, () => !exited))) {
      await stopHost();
      const log = existsSync(join(o.dir, "host.log")) ? readFileSync(join(o.dir, "host.log"), "utf8").slice(-600) : "";
      throw new Error(`the headless host didn't start${log ? `: ${log}` : ""}`);
    }
  };
  const stopHost = async () => {
    p.kill("SIGTERM");
    const t = setTimeout(() => p.kill("SIGKILL"), 3000);
    await p.exited;
    clearTimeout(t);
  };
  try {
    await spawnHost();
  } catch (e) {
    xvfb?.kill();
    throw e;
  }
  const inst: Instance = {
    host: { addr: "127.0.0.1", http: o.port, https: o.port - 5, cert: readFileSync(join(o.dir, "cert.pem"), "utf8") },
    display,
    get pid() {
      return p.pid;
    },
    // the host started again over the files as they are now: its apps and paired clients re-read
    async restart() {
      await stopHost();
      await spawnHost();
    },
    async stop() {
      await stopHost();
      xvfb?.kill();
    },
  };
  return inst;
}
