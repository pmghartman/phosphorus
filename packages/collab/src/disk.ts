// the file under a session watched: another program's save folded into the
// text as an edit, or held for review when the editor has unsaved changes
import { type BigIntStats, statSync } from "node:fs";
import * as files from "@phosphorus/files";
import type { Share } from "@phosphorus/files";
import { type Client, history, lf, mu, sendTo, type Session, sessions } from "./collab.ts";
import { Builder, MapPos, type Op } from "./ot.ts";

// One watcher per host, only while editors are attached. Unchanged files cost
// metadata checks; contents are read only after a change or before a save.
let diskWatch: ReturnType<typeof setInterval> | undefined; // under mu
let diskBusy = false; // a slow sweep not overlapped by the next tick

export function diskStat(share: Share, rel: string): BigIntStats | undefined {
  const path = files.safePath(share, rel, true);
  if (!path) return;
  try {
    return statSync(path, { bigint: true });
  } catch {
    return;
  }
}

// the same file, unchanged: size, mtime and identity as os.SameFile's
export const sameDisk = (a: BigIntStats | undefined, b: BigIntStats | undefined) =>
  !!a && !!b && a.size === b.size && a.mtimeNs === b.mtimeNs && a.dev === b.dev && a.ino === b.ino;

export type DiskSnapshot = { info?: BigIntStats; text: string; problem: string; valid: boolean };

export async function readDisk(share: Share, rel: string): Promise<DiskSnapshot> {
  const before = diskStat(share, rel);
  const [status, value] = await files.read(share, rel);
  const after = diskStat(share, rel);
  const result: DiskSnapshot = { info: after, text: "", problem: "", valid: true };
  if (status !== 200) {
    result.problem = "The file is unavailable on disk. The editor version has been preserved.";
    return result;
  }
  // Retry an atomic replacement or an active write.
  if (!sameDisk(before, after)) {
    result.valid = false;
    return result;
  }
  // External editors can truncate and refill a file in several writes. Wait
  // for a quiet moment rather than publishing an intermediate empty buffer.
  if (Date.now() - Number(after!.mtimeNs / 1_000_000n) < 150) {
    result.valid = false;
    return result;
  }
  if (typeof value?.text !== "string") {
    result.problem = "The disk file is binary or too large to reload. The editor version has been preserved.";
    return result;
  }
  result.text = value.text;
  return result;
}

export function startDiskWatch() {
  if (diskWatch) return;
  diskWatch = setInterval(async () => {
    if (diskBusy) return;
    diskBusy = true;
    try {
      await sweep();
    } finally {
      diskBusy = false;
    }
  }, 1000);
}

async function sweep() {
  type Probe = { s: Session; info?: BigIntStats; version: number; problem: string; generation: number };
  const probes = await mu.run((): Probe[] => {
    const out: Probe[] = [];
    for (const s of sessions.values())
      if (s.clients.size > 0) out.push({ s, info: s.diskInfo, version: s.version, problem: s.diskProblem, generation: s.diskGeneration });
    if (!out.length) {
      clearInterval(diskWatch);
      diskWatch = undefined;
    }
    return out;
  });
  for (const p of probes) {
    const info = diskStat(p.s.share, p.s.rel);
    if (sameDisk(p.info, info) || (!info && p.problem !== "")) continue;
    const observed = await readDisk(p.s.share, p.s.rel);
    await mu.run(() => {
      if (sessions.get(p.s.key) === p.s && p.s.clients.size > 0 && p.s.version === p.version && p.s.diskGeneration === p.generation)
        observeDisk(p.s, observed);
    });
  }
}
const low = (u: number) => u >= 0xdc00 && u <= 0xdfff;

export function diskDiff(before: string, after: string): Op[] {
  let start = 0, tail = 0;
  while (start < before.length && start < after.length && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  // Inserted strings cross JSON as Unicode: never split a surrogate pair at
  // the retained prefix/suffix, even when two emoji share one surrogate.
  if (start > 0 && start < before.length && low(before.charCodeAt(start))) start--;
  while (tail < before.length - start && tail < after.length - start && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail++;
  if (tail > 0 && tail < after.length - start && low(after.charCodeAt(after.length - tail))) tail--;
  const b = new Builder();
  b.retain(start);
  b.insert(after.slice(start, after.length - tail));
  b.del(before.length - start - tail);
  b.retain(tail);
  return b.ops;
}

export const diskMessage = (s: Session) => ({ type: "disk", conflict: s.diskConflict, text: s.diskPending, problem: s.diskProblem, revision: s.diskRevision });

// Called under mu; disk changes use normal OT operations so pending client
// keystrokes, carets, undo history and language-server versions stay aligned.
export function observeDisk(s: Session, snapshot: DiskSnapshot) {
  if (!snapshot.valid) return;
  const text = lf(snapshot.text);
  if (s.diskConflict && s.diskPending === text && s.diskProblem === snapshot.problem && (sameDisk(s.diskInfo, snapshot.info) || (!s.diskInfo && !snapshot.info))) return;
  s.diskInfo = snapshot.info;
  s.diskGeneration++;
  const current = s.text;
  if (snapshot.problem === "" && (text === s.diskText || text === current)) {
    const was = s.diskConflict;
    s.diskConflict = false;
    s.diskProblem = "";
    s.diskPending = "";
    // the disk's line ending, unless one chosen in the editor is waiting to be written
    if (!s.eolPending) s.eol = snapshot.text.includes("\r\n") ? "\r\n" : "\n";
    if (text === current && s.saved !== s.version) {
      s.diskText = text;
      s.saved = s.version;
      s.toAll({ type: "saved", v: s.version, by: "disk" });
    }
    if (was) {
      s.toAll(diskMessage(s));
      if (s.saved !== s.version) s.saveSoon();
    }
    return;
  }
  if (snapshot.problem !== "" || s.saved !== s.version) {
    s.diskConflict = true;
    s.diskPending = text;
    s.diskProblem = snapshot.problem;
    s.diskRevision++;
    s.diskCRLF = snapshot.text.includes("\r\n");
    clearTimeout(s.autosave);
    s.toAll(diskMessage(s));
    return;
  }
  applyDiskText(s, text);
  // another program's save wins over a line ending chosen and not yet written
  s.eolPending = false;
  s.eol = snapshot.text.includes("\r\n") ? "\r\n" : "\n";
}

export function applyDiskText(s: Session, text: string) {
  const ops = diskDiff(s.text, text);
  s.text = text;
  s.version++;
  s.history.push(ops);
  if (s.history.length > history) s.history.shift();
  for (const c of s.order) c.pos = MapPos(ops, c.pos);
  s.diskText = text;
  s.diskConflict = false;
  s.diskProblem = "";
  s.saved = s.version;
  s.diskPending = "";
  s.toAll({ type: "op", v: s.version, ops, by: "disk" });
  s.toAll({ type: "saved", v: s.version, by: "disk" });
  s.toAll(diskMessage(s));
}

export async function resolveDisk(s: Session, c: Client, msg: Record<string, any>) {
  if (!s.diskConflict) return;
  const revision = typeof msg.revision === "number" ? msg.revision : undefined;
  const observed = await readDisk(s.share, s.rel);
  if (!observed.valid) return;
  observeDisk(s, observed);
  if (revision === undefined || revision !== s.diskRevision) return sendTo(c, diskMessage(s));
  if (!s.diskConflict) return;
  switch (msg.choice) {
    case "reload":
      if (s.diskProblem === "") {
        s.eol = s.diskCRLF ? "\r\n" : "\n";
        applyDiskText(s, s.diskPending);
      }
      return;
    case "keep": {
      if (!files.can(s.share, "w")) return;
      s.diskConflict = false;
      // The user reviewed this exact disk revision, including a deleted file.
      const [status] = await s.saveDisk("editor", true);
      if (status !== 200) {
        s.diskConflict = true;
        sendTo(c, { type: "error", error: `save failed (${status}); both versions retained` });
      }
      s.toAll(diskMessage(s));
    }
  }
}
