// the mesh tools' host operations: health, power, terminals, run
// here or on a peer through /internal/op, every peer call carrying a sealed grant
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { calls as mcpCalls, watch as mcpWatch } from "@phosphorus/mcp";
import * as peers from "@phosphorus/peers";
import { health } from "@phosphorus/services";
import { close as termClose } from "@phosphorus/term";
import type { Chain } from "@phosphorus/update";
import { HasMCPKey, OpenGrant, SealGrant } from "@phosphorus/users";
import {
  errText,
  marshal,
  now,
  RepoDir,
  startDetached,
  TunnelMetrics,
  tailnetIP,
  writeJSONAtomic,
} from "@phosphorus/util";
import type { Conn } from "@phosphorus/wsock";
import { Client } from "ssh2";
import { hostSSHHost, hostSSHPort, selfHost, stateDir, Version } from "./config.ts";
import { onHost } from "./hostops.ts";
import type { Res } from "./http.ts";
import { decode, num, obj, str, utf8 } from "./js.ts";
import { execMax, shellExec } from "./mcpshell.ts";

// opOn op here when host is this one, else on the peer, the grant sealed for it
export async function opOn(host: string, op: string, p: Record<string, any> | undefined, waitMs: number): Promise<Res> {
  if (host === selfHost) return localOp(op, p ?? {});
  const grant = SealGrant({ op, p: p ?? null }, waitMs + 30000);
  return (await onHost(host, "/internal/op", { grant }, waitMs))!;
}

// peerOp an /internal/op body opened and run
export function peerOp(body: Record<string, any>): Promise<Res> {
  const g = OpenGrant(str(body.grant));
  if (!g) return Promise.resolve([403, { error: "bad grant" }]);
  return localOp(str(g.op), obj(g.p) ?? {});
}

async function localOp(op: string, p: Record<string, any>): Promise<Res> {
  switch (op) {
    case "health":
      return [200, await localHealth()];
    case "power":
      return hostPower(str(p.action));
    case "term_close":
      try {
        termClose(str(p.by), str(p.id));
      } catch (e) {
        return [404, { error: errText(e) }];
      }
      return [200, { closed: p.id }];
    case "exec":
      return localExec(str(p.user), str(p.pass), str(p.cmd), str(p.stdin), Math.trunc(num(p.timeout)));
    case "shell":
      return shellExec(
        str(p.user),
        str(p.pass),
        str(p.cmd),
        str(p.stdin),
        Math.trunc(num(p.timeout)),
        p.reset === true,
      );
    case "mcp_calls":
      return [200, mcpCalls(str(p.user))];
    case "service_health": {
      const ip = (await tailnetIP(selfHost)) || "127.0.0.1";
      const h = await health(str(p.name), ip);
      if (!h) return [404, { error: `${selfHost} declares no service ${str(p.name)}` }];
      h.host = selfHost;
      return [200, h];
    }
  }
  return [400, { error: "no op " + op }];
}

const started = now();

// localHealth this host's tunnel as cloudflared's /ready says, and its frontend
async function localHealth(): Promise<Record<string, any>> {
  let tunnel: Record<string, any> = { state: "off", why: "no TUNNEL_TOKEN, tailnet only" };
  if (process.env.TUNNEL_TOKEN) {
    tunnel = { state: "down", why: "cloudflared's metrics not answering on " + TunnelMetrics };
    try {
      const res = await fetch(`http://${TunnelMetrics}/ready`, { signal: AbortSignal.timeout(3000) });
      const r = obj(decode(await res.text()));
      const n = num(r?.readyConnections);
      tunnel = { state: "up", connections: n };
      if (res.status !== 200 || n === 0) tunnel = { state: "down", connections: n, why: "no edge connection ready" };
    } catch {}
  }
  return { host: selfHost, version: Version(), tunnel, uptimeSec: Math.trunc((now() - started) / 1000) };
}

// meshHealth every phosphorus host's health, with its round trip from here
export async function meshHealth(): Promise<any[]> {
  const hosts = [selfHost];
  for (const d of peers.tailnet()) {
    const n = str(d.name);
    if (n !== selfHost && (d.phosphorus === true || d.phosphorusSeen === true)) hosts.push(n);
  }
  return Promise.all(
    hosts.map(async (h) => {
      const t0 = now();
      const [st, b] = await opOn(h, "health", undefined, 8000);
      const row: Record<string, any> = { host: h };
      if (st >= 300) {
        row.answering = false;
        row.error = str(obj(b)?.error);
      } else {
        Object.assign(row, obj(b) ?? {});
        row.answering = true;
        row.rttMs = now() - t0;
      }
      return row;
    }),
  );
}

// hostPower phosphorus restarted, or the machine rebooted, both detached and
// a moment late so this answer gets out first
function hostPower(action: string): Res {
  let argv: string[];
  switch (action) {
    case "restart":
      argv = [...binSelf(), "restart", "--home", RepoDir];
      break;
    case "reboot":
      argv =
        process.platform === "win32"
          ? ["shutdown", "/r", "/t", "5", "/c", "phosphorus: reboot asked over the mesh"]
          : ["sh", "-c", "sleep 3; shutdown -r now"];
      break;
    default:
      return [400, { error: "action is restart or reboot" }];
  }
  startDetached(argv, 2000);
  return [202, { host: selfHost, action, note: "under way, the host drops off the mesh and comes back" }];
}

// binSelf the installed phosphorus binary, else this one: the compiled
// executable, or bun with the entry script when run from source
function binSelf(): string[] {
  const p = join(RepoDir, "bin", process.platform === "win32" ? "phosphorus.exe" : "phosphorus");
  if (existsSync(p)) return [p];
  return /^bun(\.exe)?$/.test(basename(process.execPath)) ? [process.execPath, Bun.main] : [process.execPath];
}

const historyMax = 50;
const historyFile = () => join(stateDir, "update-history.json");

function readHistory(): any[] {
  try {
    const v = JSON.parse(readFileSync(historyFile(), "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// rememberChain a finished chain kept, the last fifty, newest last
export function rememberChain(c: Chain) {
  let all = readHistory();
  all.push({
    id: c.id,
    startedAt: c.startedAt,
    finishedAt: c.finishedAt,
    order: c.order,
    results: c.results,
    errors: c.errors,
    details: c.details ?? null,
    versions: c.versions,
    cancelled: c.cancelled,
    by: selfHost,
  });
  if (all.length > historyMax) all = all.slice(-historyMax);
  try {
    writeJSONAtomic(historyFile(), all);
  } catch {}
}

// chainHistory the chains started here, newest last
export function chainHistory(): Record<string, any> {
  return { host: selfHost, note: "chains started from this host; another host keeps its own", chains: readHistory() };
}

const execOutMax = 256 << 10;

// capped the first n bytes kept, the rest only marked cut
class Capped {
  chunks: Uint8Array[] = [];
  len = 0;
  cut = false;
  constructor(private n: number) {}
  write(p: Uint8Array) {
    const room = this.n - this.len;
    if (room > 0) {
      const c = p.subarray(0, Math.min(room, p.length));
      this.chunks.push(c);
      this.len += c.length;
    }
    if (this.len >= this.n) this.cut = true;
  }
  text() {
    return utf8(Buffer.concat(this.chunks));
  }
}

// localExec one command as user over this host's own sshd, no pty, stdin fed
// it: its exit code, stdout and stderr; killed past timeout seconds
async function localExec(user: string, pass: string, cmd: string, stdin: string, timeout: number): Promise<Res> {
  if (user === "" || cmd.trim() === "") return [400, { error: "a login and a command" }];
  if (timeout < 1 || timeout > execMax) timeout = 60;
  let c: Client;
  try {
    c = await new Promise<Client>((resolve, reject) => {
      const cl = new Client();
      cl.on("ready", () => resolve(cl));
      cl.on("error", (e) => {
        cl.end();
        reject(e);
      });
      cl.on("keyboard-interactive", (_n, _i, _l, prompts, finish) => finish(prompts.map(() => pass)));
      cl.connect({
        host: hostSSHHost,
        port: Number(hostSSHPort) || 22,
        username: user,
        password: pass,
        tryKeyboard: true,
        readyTimeout: 10_000,
      });
    });
  } catch (e) {
    const msg = errText(e);
    if (/authentication methods failed|unable to authenticate/i.test(msg))
      return [403, { error: `the saved login for ${selfHost} was refused` }];
    return [502, { error: `ssh to ${selfHost}: ${msg}` }];
  }
  c.on("error", () => {});
  const stdout = new Capped(execOutMax),
    stderr = new Capped(execOutMax);
  const t0 = now();
  let code = 0,
    timedOut = false;
  try {
    const st = await new Promise<import("ssh2").ClientChannel>((res, rej) =>
      c.exec(cmd, (err, s) => (err ? rej(err) : res(s))),
    );
    st.on("data", (b: Uint8Array) => stdout.write(b));
    st.stderr.on("data", (b: Uint8Array) => stderr.write(b));
    if (stdin !== "") st.write(stdin);
    st.end();
    const done = new Promise<number>((r) => {
      let got = -1;
      st.on("exit", (x: unknown) => void (typeof x === "number" && (got = x)));
      st.on("close", (x: unknown) => r(typeof x === "number" ? x : got));
    });
    const timer = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeout * 1000));
    const res = await Promise.race([done, timer]);
    if (res === "timeout") {
      try {
        st.signal("KILL");
      } catch {}
      timedOut = true;
    } else code = res;
  } catch (e) {
    code = -1;
    stderr.write(Buffer.from(errText(e)));
  } finally {
    c.end();
  }
  const out: Record<string, any> = {
    host: selfHost,
    user,
    exit: code,
    stdout: stdout.text(),
    stderr: stderr.text(),
    ms: now() - t0,
  };
  if (timedOut) {
    out.exit = null;
    out.timedOut = true;
  }
  if (stdout.cut || stderr.cut) out.truncated = true;
  return [200, out];
}

// mcpCallsMesh a user's agent calls from every host, a connector reaching
// whichever one its ingress picks: in flight from all, the recent merged newest first
// skewTimes a peer's call log shifted by d ms, its zero times left zero
function skewTimes(c: Record<string, any>, d: number) {
  if (d === 0 || num(c.now) === 0) return;
  const shift = (m: Record<string, any>, k: string) => {
    const v = num(m[k]);
    if (v !== 0) m[k] = v + d;
  };
  shift(c, "seen");
  shift(c, "at");
  for (const k of ["calls", "recent"]) {
    if (!Array.isArray(c[k])) continue;
    for (const x of c[k]) {
      const m = obj(x);
      if (m) {
        shift(m, "since");
        shift(m, "at");
      }
    }
  }
}

export async function mcpCallsMesh(user: string): Promise<Record<string, any>> {
  return mcpMerge(mcpCalls(user), await mcpPeers(user));
}

// mcpPeers every peer's calls for a user, their times already on this host's clock
async function mcpPeers(user: string): Promise<(Record<string, any> | undefined)[]> {
  const got = await Promise.all(
    Object.keys(peers.peerIPs()).map(async (h) => {
      const [st, b] = await opOn(h, "mcp_calls", { user }, 2500);
      return st < 300 ? obj(b) : undefined;
    }),
  );
  const at = now();
  for (const c of got) if (c) skewTimes(c, at - num(c.now));
  return got;
}

// mcpMerge this host's calls with the peers' fetched earlier
function mcpMerge(local: Record<string, any>, got: (Record<string, any> | undefined)[]): Record<string, any> {
  const out: Record<string, any> = obj(decode(marshal(local))) ?? {};
  let calls: any[] = Array.isArray(out.calls) ? out.calls : [];
  let recent: any[] = Array.isArray(out.recent) ? out.recent : [];
  let seen = num(out.seen);
  for (const c of got) {
    if (!c) continue;
    if (Array.isArray(c.calls)) calls = calls.concat(c.calls);
    if (Array.isArray(c.recent)) recent = recent.concat(c.recent);
    if (num(c.at) > num(out.at)) out.at = c.at;
    // the agent named by the host that heard it last
    const s = num(c.seen);
    if (s > seen) {
      seen = s;
      out.seen = c.seen;
      if (str(c.client) !== "") out.client = c.client;
    }
  }
  recent.sort((a, b) => num(obj(b)?.at) - num(obj(a)?.at));
  if (recent.length > 40) recent = recent.slice(0, 40);
  calls.sort((a, b) => num(obj(a)?.since) - num(obj(b)?.since));
  out.calls = calls;
  out.recent = recent;
  return out;
}

// mcpPeerLook how often the peers' calls are looked at while a page watches
const mcpPeerLook = 5000;

// mcpSocket pushes a user's agent status only when it changes: this host's calls at
// once, the peers' on a slow look, nothing while it holds still
export async function mcpSocket(ws: Conn, user: string) {
  // nothing is read, as Go drained it
  ws.onMessage(() => {});
  let peers = await mcpPeers(user);
  let last = "";
  const push = () => {
    if (!ws.open()) return;
    const out = mcpMerge(mcpCalls(user), peers);
    out.configured = HasMCPKey(user);
    // the clock ticks every call, so left out of the comparison
    const at = out.now;
    delete out.now;
    const sig = marshal(out);
    if (sig === last) return;
    last = sig;
    out.now = at;
    ws.json(out);
  };
  let poked: ReturnType<typeof setTimeout> | undefined;
  // a burst of calls one message
  const stop = mcpWatch(user, () => {
    if (poked) return;
    poked = setTimeout(() => {
      poked = undefined;
      push();
    }, 100);
  });
  const tick = setInterval(async () => {
    peers = await mcpPeers(user);
    push();
  }, mcpPeerLook);
  ws.onClose(() => {
    stop();
    clearInterval(tick);
    clearTimeout(poked);
  });
  push();
}
