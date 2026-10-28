// a session's event log: one JSON message a line, each with its seq, the
// oldest dropped past logMax, read back from a seq on a socket's join
import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { marshal, obj } from "@phosphorus/util";

export const logMax = 5000;
// lineMax a line past this kept as a stub, its content too big to replay
export const lineMax = 1 << 20;

export class EvLog {
  seq = 0;
  lines = 0;

  // the log at file, its last seq and line count read back
  constructor(public file: string) {
    this.each(0, (seq) => {
      this.seq = Math.max(this.seq, seq);
      this.lines++;
    });
  }

  // each every line past since, in order
  each(since: number, fn: (seq: number, line: string) => void) {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let seq: unknown;
      try {
        seq = obj(JSON.parse(line))?.seq;
      } catch {
        continue;
      }
      if (typeof seq !== "number" || seq <= since) continue;
      fn(seq, line);
    }
  }

  // add m logged under the next seq: the line as sent
  add(m: Record<string, any>): string {
    m.seq = ++this.seq;
    let b = marshal(m);
    if (Buffer.byteLength(b) > lineMax) {
      const stub: Record<string, any> = { seq: this.seq, kind: m.kind, truncated: true };
      const ev = obj(m.ev);
      if (ev) stub.ev = { type: ev.type, subtype: ev.subtype };
      b = marshal(stub);
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      appendFileSync(this.file, b + "\n", { mode: 0o600 });
      this.lines++;
    } catch {}
    if (this.lines > logMax + logMax / 10) this.trim();
    return b;
  }

  // trim the oldest lines dropped, logMax kept
  private trim() {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    let lines = raw.replace(/\n+$/, "").split("\n");
    if (lines.length > logMax) lines = lines.slice(-logMax);
    try {
      writePrivate(this.file, lines.join("\n") + "\n");
      this.lines = lines.length;
    } catch {}
  }

  // last the newest seq
  last() {
    return this.seq;
  }

  remove() {
    try {
      unlinkSync(this.file);
    } catch {}
  }
}

// writePrivate temp then rename, owner only
export function writePrivate(file: string, b: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp";
  writeFileSync(tmp, b, { mode: 0o600 });
  renameSync(tmp, file);
}
