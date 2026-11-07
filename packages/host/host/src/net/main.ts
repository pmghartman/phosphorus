// the mesh's tunnel, inside run on every host: this host's own WireGuard and its
// tunnel device; on the control host the hub every other peer meets at
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { open as openTun, type Tun, WG_PORT } from "@phosphorus/tun";
import { Device } from "@phosphorus/wg";
import type { udp } from "bun";
import { at, errText, print, sleep, stamp } from "../base.ts";
import { os } from "../os.ts";
import { meshKey, readJoined } from "./key.ts";
import { leaveTailscale, tailscaleHere } from "./leave.ts";
import { type Plan, plan, RelayEndpoint, readView } from "./plan.ts";
import { Relay } from "./relay.ts";
import { routeZone } from "./resolver.ts";
import { type NetPeer, type NetStatus, netStatusFile } from "./status.ts";

const log = (m: string) => print(`${stamp()}[net] ${m}\n`);

const parseEndpoint = (to: string): [string, number] => {
  const i = to.lastIndexOf(":");
  return [to.slice(0, i).replace(/^\[|\]$/g, ""), Number(to.slice(i + 1))];
};

export type Net = { stop(): Promise<void> };

// the tunnel started, its loop running until stop
export async function startNet(): Promise<Net> {
  const self = process.env.SELF_HOST ?? "";
  const sys = process.env.PHOSPHORUS_SYS_DIR || at("sys");
  const key = meshKey();
  let sock: udp.Socket<"uint8array"> | undefined;
  let port = 0;
  let tun: Tun | undefined;
  let tunIP = "";
  let dev: Device | undefined;
  let devSig = "";
  let peersSig = "";
  let cur: Plan | undefined;
  let domain = "";
  let waiting = "";
  let routed = "";
  let stopping = false;

  const relay = new Relay(
    () => (domain ? `wss://${domain}/mesh/relay` : ""),
    (msg) => dev?.receive(msg, RelayEndpoint),
  );

  const send = (msg: Uint8Array, to: string) => {
    if (to === RelayEndpoint) return relay.send(msg);
    const [host, p] = parseEndpoint(to);
    if (sock && host && p) sock.send(msg, p, host);
  };

  // the port tailscale held, else any while it still does
  async function bind() {
    for (const want of port === WG_PORT ? [] : [WG_PORT, ...(sock ? [] : [0])]) {
      try {
        const s = await Bun.udpSocket<"uint8array">({
          port: want,
          binaryType: "uint8array",
          socket: { data: (_s, buf, p, addr) => dev?.receive(buf, `${addr}:${p}`) },
        });
        sock?.close();
        sock = s;
        port = s.port;
        log(`wireguard on udp ${port}`);
        return;
      } catch {}
    }
  }

  function device(p: Plan): Device {
    const sig = `${p.hub}:${p.ip}`;
    if (!dev || sig !== devSig) {
      dev = new Device({
        key: key.priv,
        address: p.ip || undefined,
        hub: p.hub,
        send,
        deliver: (pkt) => tun?.write(pkt),
      });
      devSig = sig;
      peersSig = "";
    }
    const ps = JSON.stringify(p.peers);
    if (ps !== peersSig) {
      dev.setPeers(p.peers);
      peersSig = ps;
    }
    return dev;
  }

  const hubUp = (p: Plan) => !!p.hubKey && !!dev?.status().find((s) => s.key === p.hubKey && s.up);

  async function bringUp(p: Plan) {
    if (tun && tunIP !== p.ip) {
      await tun.close();
      tun = undefined;
      routed = "";
    }
    if (tun || !p.ip) {
      waiting = p.ip ? "" : "this host's mesh address";
      return;
    }
    const ts = await tailscaleHere();
    // a host keeps Tailscale until the hub answers it, reachable all along
    if (ts && !p.hub && !hubUp(p)) {
      waiting = p.hubKey ? "the hub to answer" : "the hub's key";
      return;
    }
    if (ts) {
      const did = await leaveTailscale(os.libexec(), at());
      log(`left tailscale${did.length ? `: ${did.join(", ")}` : ""}`);
      await bind();
      await sleep(2000);
    }
    try {
      tun = await openTun({
        ip: p.ip,
        dll: join(os.libexec(), "wintun.dll"),
        port: WG_PORT,
        onPacket: (pkt) => dev?.send(pkt),
        onError: (e) => {
          log(`the tunnel failed: ${errText(e)}`);
          const t = tun;
          tun = undefined;
          void t?.close();
        },
      });
      tunIP = p.ip;
      waiting = "";
      log(`on the mesh as ${p.ip} over ${tun.name}${p.hub ? ", the hub" : ""}`);
    } catch (e) {
      waiting = `the tunnel: ${errText(e)}`;
    }
  }

  async function routeDNS(p: Plan) {
    if (!tun || !p.hubIP || !domain) return;
    const zone = `mesh.${domain}`;
    const sig = `${tun.name} ${zone} ${p.hubIP}`;
    if (sig === routed) return;
    if (await routeZone(tun.name, zone, p.hubIP)) {
      routed = sig;
      log(`${zone} asked of ${p.hubIP}`);
    }
  }

  function writeStatus() {
    if (!dev || !cur) return;
    const peers: NetPeer[] = dev.status().map((s) => ({
      ...s,
      name: cur?.names.get(s.key) ?? "",
      direct: !cur?.hub && s.key !== cur?.hubKey,
    }));
    const st: NetStatus = {
      at: Date.now(),
      ip: cur.ip,
      hub: cur.hub,
      tun: tun?.name ?? "",
      waiting,
      port,
      relay: relay.up,
      peers,
    };
    try {
      writeFileSync(netStatusFile(), JSON.stringify(st) + "\n", { mode: 0o644 });
    } catch {}
  }

  await bind();
  const ticker = setInterval(() => dev?.tick(), 1000);
  let lastBind = Date.now();
  const loop = (async () => {
    while (!stopping) {
      try {
        const view = readView(sys, self, readJoined());
        domain = view.domain || view.joined?.domain || "";
        cur = plan(view);
        device(cur);
        await bringUp(cur);
        await routeDNS(cur);
        if (port !== WG_PORT && tun && Date.now() - lastBind > 30_000) {
          lastBind = Date.now();
          await bind();
        }
        writeStatus();
      } catch (e) {
        log(`tunnel loop: ${errText(e)}`);
      }
      await sleep(3000);
    }
  })();
  return {
    async stop() {
      stopping = true;
      clearInterval(ticker);
      await loop;
      relay.close();
      sock?.close();
      await tun?.close();
    },
  };
}
