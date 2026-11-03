// the mesh chat: this host's own lines, every host's merged, who's on, and what
// each browser gets of it. Lines live in this host's folder (own.json, merged.json);
// a channel's meta, a clear and a person's deleted dms in the store's slice
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AppContext, AppSocket } from "@phosphorus/app-sdk";
import { markdown } from "@phosphorus/web-md";
import { clean as cleanFiles } from "./media.ts";
import {
  clipU,
  isFinite,
  jsString,
  type Msg,
  marshal,
  now,
  num,
  obj,
  readJSON,
  soon,
  str,
  truthy,
  writeJSON,
} from "./util.ts";

export type { Msg };

const maxMessages = 1000;
export const maxTextLen = 2000;
export const maxModelTextLen = 8000;
export const maxNameLen = 32;
// an agent's lines, in the agents' colour
export const modelColor = "#d2a8ff";
const clearRel = "clear";
const typingMS = 6000;
const rejoinGrace = 20 * 1000;
const bootQuiet = 20 * 1000;

const nameColors = [
  "#4f9eff",
  "#3fb950",
  "#f0883e",
  "#d2a8ff",
  "#ff7b72",
  "#79c0ff",
  "#ffa657",
  "#e3b341",
  "#ff9bce",
  "#39c5cf",
  "#db61a2",
  "#7ee787",
  "#d4a72c",
  "#ffa198",
];
export const validColors = new Set(nameColors);
export const reactions = ["+1", "✓", "✗", "?", "!", "♡"];
const channelRe = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const refRe = /^[a-z0-9][a-z0-9-]{0,62}:\d+$/;
export const typingRe = /^(mesh|ch:[a-z0-9][a-z0-9-]{0,23}|dm:.{1,32})$/;
const chHostRe = /^[a-z0-9][a-z0-9-]{0,62}$/;
const chFileRe = /^ch\/([a-z0-9-]+)$/;
const dmFileRe = /^dm\/[0-9a-f]+$/;

// the page's own hash over the name's UTF-16 units
export function colorForName(n: string): string {
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (Math.imul(h, 31) + n.charCodeAt(i)) >>> 0;
  return nameColors[h % nameColors.length]!;
}

export type ChatClient = { ws: AppSocket; name: string; color: string; typing: string; typingAt: number };

let ctx: AppContext;
let ownChat: Msg[] = [];
let ownSeq = 0;
export let mergedChat: Msg[] = [];
export const clients = new Set<ChatClient>();
let peerPresence: Record<string, Msg[]> = {};
let shownClear = 0;
const shownClose: Record<string, number> = {};
const shownMeta: Record<string, string> = {};
const pendingLeave = new Map<string, ReturnType<typeof setTimeout>>();
let bootQuietEnd = 0;
let lastPresSent = "";
let ownFile = "";
let mergedSoon: ReturnType<typeof soon>;
// this host's own lines to every other host, set by the mesh
let pushOwnLines: (lines: Msg[]) => void = () => {};
export const onOwnLines = (fn: (lines: Msg[]) => void) => void (pushOwnLines = fn);

const chRel = (ch: string) => "ch/" + ch;

export const chMeta = (ch: string): Msg => obj(ctx.store.read(chRel(ch))) ?? {};

const clearedAt = () => num(obj(ctx.store.read(clearRel))?.at);

const closedOf = (ch: string) => num(chMeta(ch).closedAt);

export function channels(): Record<string, any> {
  const out: Record<string, any> = {};
  for (const ch of ctx.store.list("ch")) out[ch] = chMeta(ch);
  return out;
}

function closedAll(): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [ch, m] of Object.entries(channels())) {
    const at = obj(m)?.closedAt;
    if (truthy(at)) out[ch] = at;
  }
  return out;
}

export function setClear(at: number, by: string) {
  if (Number.isFinite(at) && at > clearedAt()) ctx.store.write(clearRel, { at, by });
}

export function setChannel(ch: string, fields: Record<string, any>) {
  ctx.store.write(chRel(ch), { ...chMeta(ch), ...fields });
}

export const isDm = (m: Msg) => typeof m.dm === "string" && m.dm !== "";

// one person's deleted dms: the other end -> when, theirs alone
const dmRel = (name: string) => "dm/" + createHash("sha256").update(name).digest("hex").slice(0, 32);

function dmHidden(name: string): Record<string, number> | undefined {
  const hid = obj(obj(ctx.store.read(dmRel(name)))?.hid);
  if (!hid) return;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(hid)) out[k] = num(v);
  return out;
}

export function hideDm(name: string, withName: string) {
  const hid = dmHidden(name) ?? {};
  hid[withName] = nextClearTimestamp();
  ctx.store.write(dmRel(name), { name, hid });
}

function survives(m: Msg): boolean {
  if (isDm(m)) return true;
  const ch = str(m.ch);
  if (ch) return num(m.timestamp) > closedOf(ch);
  return num(m.timestamp) > clearedAt();
}

export const sees = (c: ChatClient, m: Msg) => seesDm(c, m, undefined);

// hid: c's deleted dms, read once by a caller going over many lines
function seesDm(c: ChatClient, m: Msg, hid: Record<string, number> | undefined): boolean {
  if (!isDm(m)) return true;
  if (c.name === "" || (c.name !== m.name && c.name !== m.dm)) return false;
  hid ??= dmHidden(c.name);
  let withName = str(m.name);
  if (withName === c.name) withName = str(m.dm);
  return num(m.timestamp) > (hid?.[withName] ?? 0);
}

function refillMerged(kept: Msg[]) {
  if (kept.length === mergedChat.length) return;
  mergedChat = kept;
  mergedSoon.write(mergedChat);
}

// this host's own lines written at once: a seq lost to a crash would be used again
function saveOwn() {
  try {
    writeJSON(ownFile, ownChat);
  } catch (e) {
    ctx.log("couldn't write %s: %s", ownFile, e);
  }
}

function refillOwn(kept: Msg[]) {
  if (kept.length === ownChat.length) return;
  ownChat = kept;
  saveOwn();
}

function pushOwn(e: Msg) {
  ownChat.push(e);
  if (ownChat.length > maxMessages) ownChat = ownChat.slice(-maxMessages);
  saveOwn();
}

function dropUnder() {
  refillMerged(mergedChat.filter(survives));
  refillOwn(ownChat.filter(survives));
}

function onStoreChange(rel: string) {
  if (rel === clearRel) {
    const c = obj(ctx.store.read(clearRel));
    const at = num(c?.at);
    if (!c || !(at > shownClear)) return;
    shownClear = at;
    dropUnder();
    broadcast({ type: "clear", by: str(c.by), at });
    ctx.log("cleared up to %s%s", new Date(at).toISOString(), str(c.by) ? " by " + str(c.by) : "");
    return;
  }
  if (dmFileRe.test(rel)) {
    const name = obj(ctx.store.read(rel))?.name;
    const cs = [...clients].filter((c) => typeof name === "string" && name !== "" && c.name === name && c.ws.open);
    for (const c of cs) sendHistory(c);
    return;
  }
  const mm = chFileRe.exec(rel);
  if (!mm) return;
  const ch = mm[1]!;
  const m = chMeta(ch);
  const j = marshal(m);
  if (j === shownMeta[ch]) return;
  shownMeta[ch] = j;
  if (num(m.closedAt) > (shownClose[ch] ?? 0)) {
    shownClose[ch] = num(m.closedAt);
    dropUnder();
    broadcast({ type: "close", ch, by: str(m.closedBy), at: m.closedAt });
    ctx.log("#%s closed%s", ch, str(m.closedBy) ? " by " + str(m.closedBy) : "");
  }
  broadcast({ type: "channel", ch, meta: m });
}

const isClearEntry = (m: Msg | undefined) => !!m && m.kind === "clear";
const isClose = (m: Msg | undefined) => !!m && m.kind === "close";
export const isRetract = (m: Msg | undefined) => !!m && m.kind === "retract";
export const isMark = (m: Msg) => m.kind === "react" || m.kind === "edit" || m.kind === "delete";

export function channelOf(v: unknown): string {
  return typeof v === "string" && channelRe.test(v) && v !== "mesh" ? v : "";
}

export const keyOf = (m: Msg) => jsString(m.host) + ":" + jsString(m.seq);

function dropOrphanMarks() {
  const lines = mergedChat.filter((m) => !isMark(m));
  if (!lines.length) return;
  const held = new Set(lines.map(keyOf));
  const oldest = num(lines[0]!.timestamp);
  const kept = mergedChat.filter((m) => !isMark(m) || held.has(str(m.ref)) || num(m.timestamp) >= oldest);
  if (kept.length !== mergedChat.length) refillMerged(kept);
}

export function mergeChatMessages(newMsgs: Msg[]): Msg[] {
  for (const m of newMsgs) {
    const h = str(m.host);
    if (num(m.seq) > (heldSeq.get(h) ?? 0)) heldSeq.set(h, num(m.seq));
  }
  for (const m of newMsgs) {
    if (isClearEntry(m)) setClear(num(m.timestamp), str(m.name));
    else if (isClose(m) && num(m.timestamp) > closedOf(str(m.ch)))
      setChannel(str(m.ch), { closedAt: m.timestamp, closedBy: m.name });
  }
  const gone = new Set<string>();
  const goneOrder: string[] = [];
  for (const m of newMsgs) {
    if (!isRetract(m)) continue;
    const k = jsString(m.host) + ":" + jsString(m.target);
    if (!gone.has(k)) {
      gone.add(k);
      goneOrder.push(k);
    }
  }
  const seen = new Set(mergedChat.map(keyOf));
  const added: Msg[] = [];
  for (const m of newMsgs) {
    if (isClearEntry(m) || isClose(m) || isRetract(m) || !survives(m)) continue;
    const k = keyOf(m);
    if (seen.has(k) || gone.has(k)) continue;
    seen.add(k);
    mergedChat.push(m);
    added.push(m);
  }
  const kept = mergedChat.filter((m) => !gone.has(keyOf(m)));
  const pulled = kept.length !== mergedChat.length;
  if (!added.length && !pulled) return added;
  if (pulled) refillMerged(kept);
  mergedChat.sort((a, b) => num(a.timestamp) - num(b.timestamp));
  if (mergedChat.length > maxMessages) mergedChat = mergedChat.slice(-maxMessages);
  dropOrphanMarks();
  mergedSoon.write(mergedChat);
  for (const m of added) {
    const out = forBrowser(m);
    out.type = "message";
    broadcast(out, (c) => sees(c, m));
  }
  for (const k of goneOrder) {
    const i = k.lastIndexOf(":");
    broadcast({ type: "retract", host: k.slice(0, i), seq: Number(k.slice(i + 1)) || 0 });
  }
  return added;
}

export function postOwn(fields: Msg): Msg {
  ownSeq++;
  const e: Msg = { host: ctx.host, seq: ownSeq, timestamp: now(), ...fields };
  pushOwn(e);
  mergeChatMessages([e]);
  pushOwnLines([e]);
  return e;
}

// the seq of this host's newest line, said with its presence
export const ownHead = () => ownSeq;

// this host's lines after seq, for a peer catching up
export const ownChatSince = (since: number): Msg[] => ownChat.filter((m) => num(m.seq) > since);

// the highest seq of a host's lines held here, or merged and since dropped (a
// retract, a clear), what a catch-up asks from
const heldSeq = new Map<string, number>();
export function peerSeq(host: string): number {
  let top = heldSeq.get(host) ?? 0;
  for (const m of mergedChat) if (m.host === host && num(m.seq) > top) top = num(m.seq);
  return top;
}

export function nextClearTimestamp(): number {
  let newest = now();
  for (const m of mergedChat) {
    const t = num(m.timestamp);
    if (t >= newest) newest = t + 1;
  }
  return newest;
}

function validChatMessage(m: Msg | undefined): m is Msg {
  if (
    !m ||
    typeof m.host !== "string" ||
    m.host === "" ||
    !isFinite(m.seq) ||
    typeof m.name !== "string" ||
    !isFinite(m.timestamp)
  )
    return false;
  if (isClearEntry(m)) return true;
  if (isClose(m)) return channelOf(m.ch) !== "";
  if (isRetract(m) && !isFinite(m.target)) return false;
  if ((m.kind === "dm" || m.kind === "show") && !isDm(m)) return false;
  if (isMark(m) && !refRe.test(str(m.ref))) return false;
  return typeof m.color === "string" && typeof m.text === "string";
}

export function fileOf(v: unknown): Record<string, any> | undefined {
  const f = obj(v);
  if (!f || typeof f.host !== "string" || !chHostRe.test(f.host)) return;
  const share = f.share !== undefined && f.share !== null ? clipU(jsString(f.share), 64) : "";
  const p = clipU(str(f.path), 1024);
  if (!p) return;
  const label = str(f.label) || p;
  return { host: f.host, share, path: p, label: clipU(label, 300) };
}

function cleanChatMessage(m: Msg): Msg {
  const out: Msg = { ...m };
  const fs = cleanFiles(m.files);
  if (fs) out.files = fs;
  else delete out.files;
  const ch = channelOf(m.ch);
  if (ch) out.ch = ch;
  else delete out.ch;
  const f = fileOf(m.file);
  if (f) out.file = f;
  else delete out.file;
  if (typeof m.re !== "string" || !refRe.test(m.re)) delete out.re;
  if (m.kind === "react" && !reactions.some((r) => m.emoji === r)) out.emoji = reactions[0];
  return out;
}

// another host's lines, as it pushed them or a catch-up got them
export function mergeFromPeers(messages: unknown[]) {
  const valid: Msg[] = [];
  for (const x of messages) {
    const m = obj(x);
    if (validChatMessage(m)) valid.push(cleanChatMessage(m));
  }
  if (valid.length !== messages.length)
    ctx.log("dropped %d of %d incoming lines, wrong shape", messages.length - valid.length, messages.length);
  mergeChatMessages(valid);
}

// a line with its markdown rendered, for a browser only, never stored or peered
export function forBrowser(m: Msg): Msg {
  const out: Msg = { ...m };
  const k = typeof m.kind === "string" ? m.kind : "";
  const text = m.text;
  if (typeof text !== "string" || text === "") return out;
  if (k !== "" && k !== "dm" && k !== "model" && k !== "edit") return out;
  out.html = markdown(text, true);
  return out;
}

// --- presence ---------------------------------------------------------------

export function typingOf(c: ChatClient): string {
  return c.typing !== "" && now() - c.typingAt < typingMS ? c.typing : "";
}

// who's on here
export function presence(): Msg[] {
  const people: Msg[] = [];
  for (const c of clients) {
    if (!c.ws.open || c.name === "") continue;
    const p: Msg = { name: c.name, color: c.color, host: ctx.host };
    const t = typingOf(c);
    if (t) p.typing = t;
    people.push(p);
  }
  people.sort((a, b) => (str(a.name) < str(b.name) ? -1 : str(a.name) > str(b.name) ? 1 : 0));
  return people;
}

// every other host's people, as the mesh last heard them
export function mergePeerPresence(peers: Record<string, unknown[]>) {
  peerPresence = {};
  for (const [host, people] of Object.entries(peers)) {
    const list: Msg[] = [];
    for (const x of people) {
      const p = obj(x);
      if (!p || typeof p.name !== "string" || p.name === "") continue;
      let col = typeof p.color === "string" ? p.color : "";
      if (!validColors.has(col)) col = colorForName(p.name);
      const row: Msg = { name: clipU(p.name, maxNameLen), color: col };
      if (typeof p.typing === "string" && typingRe.test(p.typing)) row.typing = p.typing;
      list.push(row);
    }
    if (list.length) peerPresence[host] = list;
  }
  broadcastPresence();
}

export function allPresence(): Msg[] {
  const people = presence();
  for (const h of Object.keys(peerPresence).sort()) for (const p of peerPresence[h]!) people.push({ ...p, host: h });
  return people;
}

export function presenceFor(c: ChatClient, people: Msg[]): Msg[] {
  return people.map((p) => {
    const t = str(p.typing);
    if (t && t.startsWith("dm:") && t.slice(3) !== c.name) return { name: p.name, color: p.color, host: p.host };
    return p;
  });
}

export function broadcast(payload: Msg, to?: (c: ChatClient) => boolean) {
  const data = marshal(payload);
  for (const c of [...clients]) if (c.ws.open && (!to || to(c))) c.ws.send(data);
}

// told of the change in who's on, the mesh too
let presenceChanged: () => void = () => {};
export const onPresence = (fn: () => void) => void (presenceChanged = fn);

export function broadcastPresence() {
  const people = allPresence();
  const j = marshal(people);
  if (j === lastPresSent) return;
  lastPresSent = j;
  for (const c of [...clients]) if (c.ws.open) c.ws.send({ type: "presence", people: presenceFor(c, people) });
  presenceChanged();
}

export function sendHistory(c: ChatClient) {
  const hid = dmHidden(c.name) ?? {};
  const msgs = mergedChat.filter((m) => seesDm(c, m, hid)).map(forBrowser);
  c.ws.send({ type: "history", me: c.name, messages: msgs, closed: closedAll(), channels: channels() });
}

// a user, someone on now, or anyone the chat has seen
export function knownPerson(name: string): boolean {
  if (!name) return false;
  if (ctx.isUser(name)) return true;
  if (allPresence().some((p) => p.name === name)) return true;
  return mergedChat.some((m) => m.name === name);
}

type Res = [number, any];

// a line from by, via the agent that sent it on their key when one did
export function postAs(by: string, to: string, text: string, via: string): Res {
  const body = clipU(text, maxModelTextLen).trim();
  if (!body) return [400, { error: "nothing to send" }];
  const dm = clipU(to.trim(), maxNameLen);
  const who: Msg = { name: by, color: modelColor, text: body };
  if (via) who.via = clipU(via, 24);
  if (dm) {
    who.kind = "dm";
    who.dm = dm;
  } else who.kind = "model";
  const m = postOwn(who);
  const online = dm === "" || allPresence().some((p) => p.name === dm);
  const out: Msg = { sent: dm ? "to " + dm : "to the group chat", seq: m.seq };
  if (!online) out.note = dm + " isn't online, it waits in their chat";
  return [200, out];
}

export function announceJoin(name: string) {
  const t = pendingLeave.get(name);
  if (t) {
    clearTimeout(t);
    pendingLeave.delete(name);
    return;
  }
  if (now() < bootQuietEnd) return;
  broadcast({ type: "system", text: name + " joined" });
}

export function announceLeave(name: string) {
  if (pendingLeave.has(name)) return;
  if (presence().some((p) => p.name === name)) return;
  pendingLeave.set(
    name,
    setTimeout(() => {
      pendingLeave.delete(name);
      broadcast({ type: "system", text: name + " left" });
    }, rejoinGrace),
  );
}

// the line ref names, no mark; undefined for none
export const lineOf = (ref: string) => mergedChat.find((m) => keyOf(m) === ref && !isMark(m));

// a line of user's edited or deleted, as the chat's own edit and delete do
export function chatEditAs(user: string, ref: string, action: string, text: string): Res {
  if (!refRe.test(ref)) return [400, { error: "ref is host:seq, as chat_history gives it" }];
  const line = lineOf(ref);
  if (!line) return [404, { error: "no line " + ref }];
  if (line.name !== user) return [403, { error: "only your own lines" }];
  const base: Msg = { name: user, color: line.color, kind: action, ref, text: "" };
  if (isDm(line)) base.dm = line.dm;
  const ch = str(line.ch);
  if (ch) base.ch = ch;
  switch (action) {
    case "delete":
      break;
    case "edit": {
      const k = str(line.kind);
      if (k !== "" && k !== "dm" && k !== "model") return [400, { error: "only messages are edited" }];
      base.text = clipU(text.trim(), maxModelTextLen);
      if (base.text === "") return [400, { error: "nothing to change it to, delete it instead" }];
      break;
    }
    default:
      return [400, { error: "action is edit or delete" }];
  }
  postOwn(base);
  return [200, { ok: true, ref, action }];
}

// --- startup ----------------------------------------------------------------

function readLog(file: string): Msg[] {
  const raw = readJSON(file);
  if (!Array.isArray(raw)) return [];
  return raw.map(obj).filter((m): m is Msg => !!m);
}

// the lines back from this host's folder; stop() saves them
export function start(c: AppContext): { stop: () => void } {
  ctx = c;
  ownFile = join(ctx.dataDir, "own.json");
  mergedSoon = soon(join(ctx.dataDir, "merged.json"), (e) => ctx.log("couldn't write merged.json: %s", e));
  ownChat = readLog(ownFile);
  if (ownChat.length) ownSeq = num(ownChat[ownChat.length - 1]!.seq);
  mergedChat = readLog(join(ctx.dataDir, "merged.json"));
  shownClear = clearedAt();
  for (const [ch, at] of Object.entries(closedAll())) shownClose[ch] = num(at);
  for (const [ch, m] of Object.entries(channels())) shownMeta[ch] = marshal(m);
  ctx.store.watch(onStoreChange);
  bootQuietEnd = now() + bootQuiet;
  const tick = setInterval(() => {
    let changed = false;
    for (const c of clients) {
      if (c.typing !== "" && typingOf(c) === "") {
        c.typing = "";
        changed = true;
      }
    }
    if (changed) broadcastPresence();
  }, 1000);
  return {
    stop() {
      clearInterval(tick);
      for (const t of pendingLeave.values()) clearTimeout(t);
      mergedSoon.flush();
    },
  };
}
