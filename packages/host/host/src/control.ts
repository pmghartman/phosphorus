// phosphorus control, run's child on Linux: headscale served while the frontend
// names this host the mesh's control server, its config written from that ask
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ControlBehindPort,
  ControlDir,
  ControlSocket,
  type ControlSpec,
  ControlSpecFile,
  HeadscaleBin,
} from "@phosphorus/util";
import type { Subprocess } from "bun";
import { errText, homeDir, print, setHome, sleep } from "./base.ts";
import { ensurePin, headscalePin } from "./tools.ts";

// plain lines, run's own prefix tagging them
const log = (m: string) => print(m + "\n");

export const controlConfigFile = join(ControlDir, "config.json");
export const controlPolicyFile = join(ControlDir, "policy.json");

// the ask, undefined when there is none or it can't be read
export function readSpec(file = ControlSpecFile): ControlSpec | undefined {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    if (typeof s?.url !== "string" || !/^https:\/\/[^/\s]+$/.test(s.url)) return undefined;
    if (typeof s.baseDomain !== "string" || !s.baseDomain) return undefined;
    return {
      url: s.url,
      baseDomain: s.baseDomain,
      relay: s.relay === true,
      behind: s.behind === true,
      ipv4: typeof s.ipv4 === "string" ? s.ipv4 : undefined,
      ipv6: typeof s.ipv6 === "string" ? s.ipv6 : undefined,
    };
  } catch {
    return undefined;
  }
}

// every device reaches every other, as on the hosted tailnet; trust stays phosphorus's,
// tag:guest devices kept off its gates
export const controlPolicy = () => ({
  tagOwners: { "tag:host": ["mesh@"], "tag:guest": ["mesh@"] },
  acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
});

// headscale's config: TLS of its own by TLS-ALPN-01 on 443, or on loopback behind
// the edge's splitter; Tailscale's relays always, its own beside them when relay is on
export function controlConfig(spec: ControlSpec, dir = ControlDir, socket = ControlSocket) {
  const host = new URL(spec.url).hostname;
  return {
    server_url: spec.url,
    listen_addr: spec.behind ? `127.0.0.1:${ControlBehindPort}` : ":443",
    metrics_listen_addr: "127.0.0.1:9091",
    grpc_listen_addr: "127.0.0.1:50443",
    grpc_allow_insecure: false,
    trusted_proxies: [],
    noise: { private_key_path: join(dir, "noise_private.key") },
    prefixes: { v4: "100.64.0.0/10", v6: "fd7a:115c:a1e0::/48", allocation: "sequential" },
    derp: {
      server: {
        enabled: spec.relay,
        region_id: 999,
        region_code: "phosphorus",
        region_name: "phosphorus relay",
        verify_clients: true,
        stun_listen_addr: ":3478",
        private_key_path: join(dir, "derp_server_private.key"),
        automatically_add_embedded_derp_region: true,
        ...(spec.ipv4 ? { ipv4: spec.ipv4 } : {}),
        ...(spec.ipv6 ? { ipv6: spec.ipv6 } : {}),
      },
      urls: ["https://controlplane.tailscale.com/derpmap/default"],
      paths: [],
      auto_update_enabled: true,
      update_frequency: "3h",
    },
    disable_check_updates: true,
    node: { expiry: 0, ephemeral: { inactivity_timeout: "30m" } },
    database: { type: "sqlite", sqlite: { path: join(dir, "db.sqlite"), write_ahead_log: true } },
    acme_url: "https://acme-v02.api.letsencrypt.org/directory",
    acme_email: "",
    tls_letsencrypt_hostname: host,
    tls_letsencrypt_cache_dir: join(dir, "cache"),
    tls_letsencrypt_challenge_type: "TLS-ALPN-01",
    log: { level: "info", format: "text" },
    policy: { mode: "file", path: join(dir, "policy.json") },
    dns: {
      magic_dns: true,
      base_domain: spec.baseDomain,
      override_local_dns: false,
      nameservers: { global: [], split: {} },
      search_domains: [],
      extra_records: [],
    },
    unix_socket: socket,
    unix_socket_permission: "0700",
    logtail: { enabled: false },
    taildrop: { enabled: true },
  };
}

function writeConfig(spec: ControlSpec) {
  mkdirSync(ControlDir, { recursive: true, mode: 0o700 });
  writeFileSync(controlPolicyFile, JSON.stringify(controlPolicy(), null, 2) + "\n", { mode: 0o600 });
  writeFileSync(controlConfigFile, JSON.stringify(controlConfig(spec), null, 2) + "\n", { mode: 0o600 });
}

type Served = { proc: Subprocess; sig: string; started: number };

async function stopServed(s: Served) {
  s.proc.kill("SIGTERM");
  const done = await Promise.race([s.proc.exited.then(() => true), sleep(10_000).then(() => false)]);
  if (!done) {
    s.proc.kill("SIGKILL");
    await s.proc.exited;
  }
}

// the loop: the ask read every few seconds, headscale started, restarted on a new
// ask or a crash (slower each time), stopped when the ask goes
export async function controlMain(): Promise<number> {
  setHome(homeDir());
  let served: Served | undefined;
  let backoff = 0;
  let quiet = false;
  const end = async () => {
    if (served) await stopServed(served);
    process.exit(0);
  };
  process.on("SIGTERM", () => void end());
  process.on("SIGINT", () => void end());
  for (;;) {
    const spec = readSpec();
    const sig = spec ? JSON.stringify(spec) : "";
    if (served && served.proc.exitCode !== null) {
      const ran = Date.now() - served.started;
      backoff = ran > 5 * 60_000 ? 5000 : Math.min(Math.max(backoff * 2, 5000), 60_000);
      log(`headscale exited (${served.proc.exitCode}), again in ${backoff / 1000}s`);
      served = undefined;
      await sleep(backoff);
      continue;
    }
    if (served && served.sig !== sig) {
      log(spec ? "control settings changed, restarting headscale" : "no longer the control server, stopping headscale");
      await stopServed(served);
      served = undefined;
    }
    if (spec && !served) {
      try {
        await ensurePin(headscalePin());
        writeConfig(spec);
        served = {
          proc: Bun.spawn([HeadscaleBin, "serve", "-c", controlConfigFile], {
            stdin: "ignore",
            stdout: "inherit",
            stderr: "inherit",
          }),
          sig,
          started: Date.now(),
        };
        quiet = false;
        log(`headscale serving ${spec.url}${spec.relay ? " with the relay" : ""}`);
      } catch (e) {
        if (!quiet) log(`couldn't start headscale: ${errText(e)}`);
        quiet = true;
      }
    }
    await sleep(3000);
  }
}
