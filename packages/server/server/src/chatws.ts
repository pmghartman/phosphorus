// the chat socket: a browser's join, lines, marks and presence
import { clean as cleanFiles } from "@phosphorus/chatmedia";
import type { Session } from "@phosphorus/users";
import { now } from "@phosphorus/util";
import type { Conn } from "@phosphorus/wsock";
import {
  allPresence,
  announceJoin,
  announceLeave,
  broadcast,
  broadcastPresence,
  type ChatClient,
  channelOf,
  chMeta,
  clients,
  colorForName,
  fileOf,
  hideDm,
  isDm,
  lineOf,
  type Msg,
  maxNameLen,
  maxTextLen,
  nextClearTimestamp,
  postOwn,
  presenceFor,
  reactions,
  refRe,
  sees,
  sendHistory,
  setChannel,
  setClear,
  typingRe,
  validColors,
} from "./chat.ts";
import { clipU, decode, num, obj, str, truthy } from "./js.ts";

// --- the socket ---------------------------------------------------------------

export function onChat(ws: Conn, s: Session | undefined) {
  const user = s && !s.boot ? s.user : "";
  const c: ChatClient = { ws, name: "", color: "", typing: "", typingAt: 0 };
  clients.add(c);
  ws.json({ type: "presence", people: presenceFor(c, allPresence()) });
  ws.onClose(() => {
    clients.delete(c);
    if (c.name !== "") {
      announceLeave(c.name);
      broadcastPresence();
    }
  });
  ws.onMessage((raw) => {
    const msg = obj(decode(raw));
    if (!msg) return;
    onChatMessage(c, user, msg);
  });
}

export function onChatMessage(c: ChatClient, user: string, msg: Msg) {
  const t = str(msg.type);
  if (t === "ping") {
    c.ws.json({ type: "pong" });
    return;
  }
  if (t === "join") {
    let name = user;
    if (name === "") {
      name = clipU(str(msg.name).trim(), maxNameLen);
      if (msg.name === null || msg.name === undefined || name === "") name = "anon";
    }
    let col = typeof msg.color === "string" ? msg.color : "";
    if (!validColors.has(col)) col = colorForName(name);
    c.name = name;
    c.color = col;
    sendHistory(c);
    announceJoin(name);
    broadcastPresence();
    c.ws.json({ type: "presence", people: presenceFor(c, allPresence()) });
    return;
  }
  if (c.name === "") return;
  switch (t) {
    case "rename": {
      const n = clipU(str(msg.name).trim(), maxNameLen);
      if (n === "" || n === c.name || user !== "") return;
      broadcast({ type: "system", text: c.name + " renamed to " + n });
      c.name = n;
      sendHistory(c);
      broadcastPresence();
      return;
    }
    case "recolor": {
      const col = typeof msg.color === "string" ? msg.color : "";
      if (!validColors.has(col)) return;
      c.color = col;
      broadcastPresence();
      return;
    }
    case "clear":
      setClear(nextClearTimestamp(), c.name);
      return;
    case "hide-dm": {
      const w = clipU(str(msg.with).trim(), maxNameLen);
      if (w !== "" && w !== c.name) hideDm(c.name, w);
      return;
    }
    case "close": {
      const ch = channelOf(msg.ch);
      if (ch) setChannel(ch, { closedAt: nextClearTimestamp(), closedBy: c.name });
      return;
    }
    case "typing": {
      const where = typeof msg.conv === "string" && typingRe.test(msg.conv) ? msg.conv : "";
      if (where === c.typing && where !== "") {
        c.typingAt = now();
        return;
      }
      c.typing = where;
      c.typingAt = now();
      broadcastPresence();
      return;
    }
    case "show": {
      const to = clipU(str(msg.to).trim(), maxNameLen);
      const file = fileOf(msg.file);
      if (to !== "" && to !== c.name && file)
        postOwn({ name: c.name, color: c.color, kind: "show", dm: to, text: file.label, file });
      return;
    }
    case "react":
    case "edit":
    case "delete":
      markLine(c, msg);
      return;
  }
  const text = clipU(str(msg.text), maxTextLen);
  const fs = cleanFiles(msg.files);
  const ch = channelOf(msg.ch);
  if (t === "topic") {
    if (!ch) return;
    const topic = clipU(text.trim(), 200);
    const m = chMeta(ch);
    const fresh = !truthy(m.created) || num(m.closedAt) >= num(m.created);
    const fields: Record<string, any> = {};
    if (fresh) {
      fields.created = now();
      fields.createdBy = c.name;
    }
    if (topic !== "" || fresh) {
      fields.topic = topic;
      fields.topicBy = c.name;
    }
    setChannel(ch, fields);
    postOwn({ name: c.name, color: c.color, kind: "topic", ch, text: topic });
    return;
  }
  if (text.trim() === "" && !fs) return;
  const extra: Msg = {};
  if (fs) extra.files = fs;
  if (typeof msg.re === "string" && refRe.test(msg.re)) extra.re = msg.re;
  const wasTyping = c.typing !== "";
  c.typing = "";
  if (wasTyping) broadcastPresence();
  if (t === "dm") {
    const to = clipU(str(msg.to).trim(), maxNameLen);
    if (to !== "" && to !== c.name) postOwn({ name: c.name, color: c.color, kind: "dm", dm: to, text, ...extra });
    return;
  }
  if (t !== "message") return;
  const e: Msg = { name: c.name, color: c.color, text, ...extra };
  if (ch) e.ch = ch;
  postOwn(e);
}

function markLine(c: ChatClient, msg: Msg) {
  const ref = typeof msg.ref === "string" ? msg.ref : "";
  if (!refRe.test(ref)) return;
  const line = lineOf(ref);
  if (!line || !sees(c, line)) return;
  const own = line.name === c.name;
  const t = str(msg.type);
  const base: Msg = { name: c.name, color: c.color, kind: t, ref, text: "" };
  if (isDm(line)) base.dm = own ? line.dm : line.name;
  const ch = str(line.ch);
  if (ch) base.ch = ch;
  switch (t) {
    case "react": {
      const e = typeof msg.emoji === "string" ? msg.emoji : "";
      if (!reactions.some((r) => e === r)) return;
      base.emoji = e;
      base.on = msg.on !== false;
      postOwn(base);
      break;
    }
    case "edit": {
      const text = clipU(str(msg.text), maxTextLen);
      const k = str(line.kind);
      if (own && text.trim() !== "" && (k === "" || k === "dm")) {
        base.text = text;
        postOwn(base);
      }
      break;
    }
    default:
      if (own) postOwn(base);
  }
}
