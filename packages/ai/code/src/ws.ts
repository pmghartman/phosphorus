// a page's socket on a session: the log replayed past since, then live
import { marshal, sleep } from "@phosphorus/util";
import { type Conn, of, queueHigh, type Sub } from "./claude.ts";

// attach a socket to the user's session till done settles, false for no such session
export async function attach(c: Conn, done: Promise<void>, user: string, id: string, since: number): Promise<boolean> {
  const s = of(user, id);
  if (!s || s.deleted) return false;
  const x: Sub = { c, ready: false, backlog: [], seqs: [] };
  s.subs.set(c, x);
  try {
    let top = since;
    const past: [number, string][] = [];
    s.log.each(since, (seq, line) => past.push([seq, line]));
    for (const [seq, line] of past) {
      while (c.open() && c.queued() > queueHigh) await sleep(10);
      if (c.open()) {
        c.text(line);
        top = Math.max(top, seq);
      }
    }
    // a line logged while the replay went out sent once
    x.backlog.forEach((b, i) => {
      const q = x.seqs[i]!;
      if (q === 0 || q > top) c.text(b);
    });
    x.backlog = [];
    x.seqs = [];
    x.ready = true;
    c.text(marshal({ seq: 0, kind: "status", record: s.rec }));
    await done;
    return true;
  } finally {
    s.subs.delete(c);
  }
}
