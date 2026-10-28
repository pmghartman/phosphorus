// the chat as a caller may read it, and a wait on it for a reply
import { jsNumber } from "@phosphorus/files";
import { obj, sleep } from "@phosphorus/util";
import { jsString, type Meta, num, numOr, src, str } from "./common.ts";

export const chatWaitMax = 300;

// chatRows the chat as a caller may read it: channels, and a key's own direct messages
export function chatRows(m: Meta, want: string): Record<string, any>[] {
  const me = m.caller?.user ?? "";
  const out: Record<string, any>[] = [];
  const all = src.chat();
  // edits and deletes folded in, each by its own author only
  const authors = new Map<string, unknown>();
  for (const x of all) authors.set(`${jsString(x.host)}:${jsString(x.seq)}`, x.name);
  const gone = new Set<string>(),
    edited = new Map<string, string>();
  for (const x of all) {
    const ref = str(x.ref);
    if (authors.get(ref) !== x.name) continue;
    if (str(x.kind) === "delete") gone.add(ref);
    else if (str(x.kind) === "edit") edited.set(ref, str(x.text));
  }
  for (const x of all) {
    const k = str(x.kind);
    if (k && k !== "model" && k !== "dm") continue;
    let ch = str(x.ch) || "mesh";
    const dm = str(x.dm);
    if (dm) {
      if (!me || (dm !== me && str(x.name) !== me)) continue;
      ch = "dm:" + (dm === me ? str(x.name) : dm);
    }
    if (want && ch !== want) continue;
    const ts = Math.trunc(num(x.timestamp));
    const ref = `${jsString(x.host)}:${jsString(x.seq)}`;
    if (gone.has(ref)) continue;
    const row: Record<string, any> = {
      at: new Date(ts).toISOString(),
      ms: ts,
      channel: ch,
      name: x.name,
      text: x.text,
      ref,
    };
    const t = edited.get(ref);
    if (t !== undefined) {
      row.text = t;
      row.edited = true;
    }
    const v = str(x.via);
    if (v) row.via = v;
    if (Array.isArray(x.files)) row.files = x.files.map((f: unknown) => obj(f)?.name ?? null);
    out.push(row);
  }
  return out;
}

// chatWait chat lines after since in want, as soon as one lands or after wait_s with none
export async function chatWait(a: Record<string, any>, m: Meta, want: string): Promise<Record<string, any>> {
  // only a missing since means now, 0 the whole history
  let since = Date.now();
  if (a.since !== undefined && a.since !== null) since = Math.trunc(jsNumber(a.since));
  const end = Date.now() + Math.min(chatWaitMax, Math.max(1, numOr(a.wait_s, 60))) * 1000;
  for (;;) {
    const fresh = chatRows(m, want).filter((r) => r.ms > since);
    if (fresh.length || Date.now() > end) return { lines: fresh, now: Date.now() };
    await sleep(1000);
  }
}
