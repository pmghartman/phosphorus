// addresses and the tailnet: loopback and tailnet ranges, the hosts' IPv4s as
// discovery last listed them
import { networkInterfaces } from "node:os";
import { run } from "./proc.ts";

// 127.0.0.1 or ::1
export const isLoopbackAddr = (a: string) => a === "127.0.0.1" || a === "::1";

// 100.64.0.0/10
export function isTailnetAddr(a: string): boolean {
  if (!a.startsWith("100.")) return false;
  const n = Number(a.split(".")[1]);
  return Number.isInteger(n) && n >= 64 && n <= 127;
}

export const isIPv4 = (s: string) => /^\d+\.\d+\.\d+\.\d+$/.test(s);

// an IPv4 routed on the internet: not private, CGNAT, link-local, loopback or reserved
export function isPublicIPv4(a: string): boolean {
  if (!isIPv4(a)) return false;
  const [x, y] = a.split(".").map(Number) as [number, number];
  if (x === 0 || x === 10 || x === 127 || x >= 224) return false;
  if (x === 100 && y >= 64 && y <= 127) return false;
  if (x === 169 && y === 254) return false;
  if (x === 172 && y >= 16 && y <= 31) return false;
  if (x === 192 && y === 168) return false;
  return true;
}

// the public IPv4 on one of this machine's own interfaces, blank behind NAT
export function publicIPv4(): string {
  for (const list of Object.values(networkInterfaces()))
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal && isPublicIPv4(i.address)) return i.address;
  return "";
}
let knownIPs = new Map<string, string>();

// host -> IPv4, as mesh's discovery last listed them
export function noteTailnetIPs(ips: Record<string, string>) {
  knownIPs = new Map(Object.entries(ips).filter(([, ip]) => isIPv4(ip)));
}

let magic = "";

// the tailnet's MagicDNS suffix, from this host's own DNS name as discovery read it
export function noteMagicDNS(selfDNS: string) {
  const name = selfDNS.toLowerCase().replace(/\.$/, "");
  const i = name.indexOf(".");
  if (i > 0) magic = name.slice(i + 1);
}

// the MagicDNS suffix, blank until discovered
export const magicDNS = () => magic;

// a host's tailnet IPv4, blank when unknown
export async function tailnetIP(name: string): Promise<string> {
  const ip = knownIPs.get(name);
  if (ip) return ip;
  const r = await run(["tailscale", "ip", "-4", name], { timeoutMs: 3000 });
  return r.ok ? r.stdout.trim() : "";
}
