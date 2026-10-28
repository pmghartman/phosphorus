// addresses and the tailnet: loopback and tailnet ranges, the hosts' IPv4s as
// discovery last listed them
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
let knownIPs = new Map<string, string>();

// host -> IPv4, as mesh's discovery last listed them
export function noteTailnetIPs(ips: Record<string, string>) {
  knownIPs = new Map(Object.entries(ips).filter(([, ip]) => isIPv4(ip)));
}

// a host's tailnet IPv4, blank when unknown
export async function tailnetIP(name: string): Promise<string> {
  const ip = knownIPs.get(name);
  if (ip) return ip;
  const r = await run(["tailscale", "ip", "-4", name], { timeoutMs: 3000 });
  return r.ok ? r.stdout.trim() : "";
}
