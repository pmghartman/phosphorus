// log lines: timed where the log is run's file, journald timing them on Linux
import { format } from "node:util";

let stamped = process.platform !== "linux";
export const setLogStamps = (on: boolean) => void (stamped = on);

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} `;
};

// one line on stderr, printf-style
export function logf(fmt: string, ...args: unknown[]) {
  const line = format(fmt, ...args);
  process.stderr.write((stamped ? stamp() : "") + (line.endsWith("\n") ? line : line + "\n"));
}

// re-run every tick, logged only when a key's message changes
export class Notes {
  private last = new Map<string, string>();
  constructor(private tag: string) {}
  log(msg: string) {
    logf("[%s] %s", this.tag, msg);
  }
  note(key: string, msg: string) {
    if (this.last.get(key) === msg) return;
    this.last.set(key, msg);
    this.log(msg);
  }
  clear(key: string) {
    this.last.delete(key);
  }
  reset(prefix: string) {
    for (const k of [...this.last.keys()]) if (k.startsWith(prefix)) this.last.delete(k);
  }
}
