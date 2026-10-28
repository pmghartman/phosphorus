// the TCP ports open on ip or every address: ss on Linux, lsof on macOS,
// netstat on Windows
import { run } from "@phosphorus/util";

const addrRe = /^(.*):(\d+)$/;

// the ports of the local addresses bound to ip or to every address
export function portsOf(addrs: Iterable<string>, ip: string): Set<number> {
  const ports = new Set<number>();
  for (const a of addrs) {
    const m = addrRe.exec(a);
    if (m && (m[1] === "0.0.0.0" || m[1] === "*" || m[1] === "[::]" || m[1] === "::" || m[1] === ip)) ports.add(Number(m[2]));
  }
  return ports;
}

// one tool's output, its local address in column col of every line with at
// least min fields, the listening ones alone
function column(out: string, col: number, min: number, listening?: (f: string[]) => boolean): string[] {
  const addrs: string[] = [];
  for (const line of out.split("\n")) {
    const f = line.split(/\s+/).filter(Boolean);
    if (f.length < min || (listening && !listening(f))) continue;
    addrs.push(f[col]!);
  }
  return addrs;
}

// undefined when the tool fails, as if nothing were known
export async function listening(ip: string): Promise<Set<number> | undefined> {
  if (process.platform === "linux") {
    const r = await run(["ss", "-Htln"], { timeoutMs: 2000 });
    return r.ok ? portsOf(column(r.stdout, 3, 4), ip) : undefined;
  }
  if (process.platform === "darwin") {
    // "node 123 user 20u IPv4 0x.. 0t0 TCP *:8080 (LISTEN)"
    const r = await run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"], { timeoutMs: 2000 });
    return r.ok ? portsOf(column(r.stdout, 8, 9), ip) : undefined;
  }
  // "  TCP    0.0.0.0:135    0.0.0.0:0    LISTENING    1234"
  const r = await run(["netstat", "-ano", "-p", "TCP"], { timeoutMs: 2000 });
  if (!r.ok) return undefined;
  const v6 = await run(["netstat", "-ano", "-p", "TCPv6"], { timeoutMs: 2000 });
  const isListen = (f: string[]) => f[0]!.toUpperCase().startsWith("TCP") && f[3] === "LISTENING";
  return portsOf(column(r.stdout + (v6.ok ? v6.stdout : ""), 1, 4, isListen), ip);
}
