// a mesh of real hosts for the tests: each a node.ts process on its own
// loopback address, every package reading its own env; a fake tailscale on
// PATH lists them to one another from a status file per host
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../..");
const win = process.platform === "win32";

// 127.0.0.2 and up: every loopback address on Linux and Windows, only 127.0.0.1 on
// a Mac until lo0 is given aliases
const ipAt = (i: number) => `127.0.0.${2 + i}`;

const canBind = (ip: string, port: number) => {
  try {
    Bun.serve({ hostname: ip, port, fetch: () => new Response() }).stop(true);
    return true;
  } catch {
    return false;
  }
};

// why a mesh of n hosts can't run here, blank when it can
export function unavailable(n: number): string {
  const missing = Array.from({ length: n }, (_, i) => ipAt(i)).filter((ip) => !canBind(ip, 0));
  if (!missing.length) return "";
  const how =
    process.platform === "darwin"
      ? `: sudo ifconfig lo0 alias ${missing.join(" up; sudo ifconfig lo0 alias ")} up`
      : "";
  return `can't bind ${missing.join(", ")}${how}`;
}

// two ports free on every host's address, below the ephemeral range so a
// connection made meanwhile can't take one
function pickPorts(ips: string[]): [number, number] {
  for (;;) {
    const a = 20000 + Math.floor(Math.random() * 10000);
    const b = a + 1;
    if (ips.every((ip) => canBind(ip, a) && canBind(ip, b))) return [a, b];
  }
}

export type Host = { name: string; ip: string; proc: ReturnType<typeof Bun.spawn>; log: string[] };

export class Mesh {
  dir = mkdtempSync(join(tmpdir(), "phos-mesh-"));
  hosts = new Map<string, Host>();
  port: number;
  ctlPort: number;
  // tailscale's word on each host, as every host's status file lists it
  online = new Map<string, boolean>();
  gone = new Set<string>();

  constructor(private names: string[]) {
    [this.port, this.ctlPort] = pickPorts(names.map((n) => this.ipOf(n)));
    mkdirSync(join(this.dir, "bin"));
    if (win)
      writeFileSync(
        join(this.dir, "bin", "tailscale.cmd"),
        '@echo off\r\nif not exist "%TS_STATUS_FILE%" exit /b 1\r\ntype "%TS_STATUS_FILE%"\r\n',
      );
    else {
      writeFileSync(
        join(this.dir, "bin", "tailscale"),
        '#!/bin/sh\n[ -f "$TS_STATUS_FILE" ] || exit 1\ncat "$TS_STATUS_FILE"\n',
      );
      chmodSync(join(this.dir, "bin", "tailscale"), 0o755);
    }
    for (const n of names) this.online.set(n, true);
  }

  ipOf = (name: string) => ipAt(this.names.indexOf(name));
  statusFile = (name: string) => join(this.dir, `${name}.status.json`);

  // every host's status file written as tailscale would answer it there
  writeStatus() {
    for (const self of this.names) {
      const Peer: Record<string, unknown> = {};
      for (const n of this.names) {
        if (n === self || this.gone.has(n)) continue;
        Peer[`node-${n}`] = {
          DNSName: `${n}.tail1234.ts.net.`,
          TailscaleIPs: [this.ipOf(n)],
          Online: this.online.get(n) ?? false,
          OS: "linux",
        };
      }
      writeFileSync(
        this.statusFile(self),
        JSON.stringify({ Self: { DNSName: `${self}.tail1234.ts.net.`, TailscaleIPs: [this.ipOf(self)] }, Peer }),
      );
    }
  }

  // tailscale's flag for a host, as every other host reads it
  setOnline(name: string, on: boolean) {
    this.online.set(name, on);
    this.writeStatus();
  }
  // a host off the tailnet for good
  remove(name: string) {
    this.gone.add(name);
    this.writeStatus();
  }

  async start() {
    this.writeStatus();
    await Promise.all(this.names.map((n) => this.startHost(n)));
  }

  async startHost(name: string) {
    const home = join(this.dir, name);
    for (const d of ["state", "files"]) mkdirSync(join(home, d), { recursive: true });
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${join(this.dir, "bin")}${delimiter}${process.env.PATH ?? ""}`,
      TS_STATUS_FILE: this.statusFile(name),
      PHOSPHORUS_HOME: home,
      STATE_DIR: join(home, "state"),
      FILES_ROOT: join(home, "files"),
      HOME_FS: join(home, "files"),
      SERVICES_FILE: join(home, "none.export"),
      SELF_HOST: name,
      FRONTEND_BIND: this.ipOf(name),
      FRONTEND_PORT: String(this.port),
      CTL_PORT: String(this.ctlPort),
      INGRESS_PORT: "0",
      GAME_DNS_PORT: "0",
      POLL_HOT_MS: "600000",
    };
    for (const k of ["TS_API_KEY", "BASE_DOMAIN", "ADMIN_PASS", "PHOSPHORUS_UPDATE_PASSWORD", "TUNNEL_TOKEN"])
      delete env[k];
    const proc = Bun.spawn(["bun", join(import.meta.dir, "mesh-node.ts")], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const h: Host = { name, ip: this.ipOf(name), proc, log: [] };
    this.hosts.set(name, h);
    const ready = new Promise<void>((ok, fail) => {
      const read = async (s: ReadableStream<Uint8Array>) => {
        const dec = new TextDecoder();
        let buf = "";
        for await (const chunk of s) {
          buf += dec.decode(chunk);
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            h.log.push(line);
            if (line.startsWith("ready ")) ok();
          }
        }
      };
      void read(proc.stdout as ReadableStream<Uint8Array>);
      void read(proc.stderr as ReadableStream<Uint8Array>);
      void proc.exited.then(() => fail(new Error(`${name} exited:\n${h.log.join("\n")}`)));
    });
    await ready;
  }

  // one op on a host's control endpoint
  async call(name: string, op: string, args: Record<string, unknown> = {}): Promise<any> {
    const r = await fetch(`http://${this.ipOf(name)}:${this.ctlPort}/`, {
      method: "POST",
      body: JSON.stringify({ op, ...args }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`${name} ${op}: ${r.status} ${await r.text()}`);
    return r.json();
  }

  view = (name: string) => this.call(name, "view");

  // a condition met within ms, polled
  async until(cond: () => Promise<boolean> | boolean, what: string, ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await cond()) return;
      await Bun.sleep(50);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  stop() {
    for (const h of this.hosts.values()) h.proc.kill();
    rmSync(this.dir, { recursive: true, force: true });
  }

  logs = (name: string) => this.hosts.get(name)?.log.join("\n") ?? "";
}
