// the net child's word on the mesh tunnel, in state/run/net.json every few seconds
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RunDir } from "@phosphorus/util";

export const netStatusFile = () => join(RunDir, "net.json");

// one peer as the status file lists it
export type NetPeer = {
  name: string;
  key: string;
  endpoint: string;
  up: boolean;
  handshakeAgoMs: number;
  rx: number;
  tx: number;
  // a direct path to another host, else the hub or a peer on it
  direct: boolean;
};

export type NetStatus = {
  at: number;
  ip: string;
  hub: boolean;
  // the tunnel's name once it's up; waiting says on what until then
  tun: string;
  waiting: string;
  port: number;
  relay: boolean;
  peers: NetPeer[];
};

// the status written in the last half minute, undefined when the child isn't running
export function readNetStatus(): NetStatus | undefined {
  try {
    const s = JSON.parse(readFileSync(netStatusFile(), "utf8")) as NetStatus;
    return typeof s?.at === "number" && Date.now() - s.at < 30_000 ? s : undefined;
  } catch {
    return;
  }
}

// the tunnel up, its hub answering (or this host the hub)
export function meshUp(s = readNetStatus()): boolean {
  if (!s?.tun) return false;
  return s.hub || s.peers.some((p) => !p.direct && p.up);
}
