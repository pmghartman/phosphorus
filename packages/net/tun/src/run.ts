// a command run to its end, its output; a failure with what it said
import type { ReaderInit } from "./reader.ts";

export async function run(argv: string[]): Promise<string> {
  const p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${argv[0]} failed: ${(err || out).trim() || `exit ${code}`}`);
  return out.trim();
}

// one OS's open device: what the reader worker needs, how a packet goes out
export type Device = {
  name: string;
  reader: ReaderInit;
  unwrap: (b: Uint8Array) => Uint8Array;
  write(pkt: Uint8Array): boolean;
  close(): void;
};
