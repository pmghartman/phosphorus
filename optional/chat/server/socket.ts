// the chat socket: a logged in browser's join, lines, marks and presence
import type { AppSocket, Who } from "@phosphorus/app-sdk";
import {
  allPresence,
  announceJoin,
  announceLeave,
  broadcastPresence,
  type ChatClient,
  channelOf,
  chMeta,
  clients,
  colorForName,
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
} from "./log.ts";
import { clean as cleanFiles } from "./media.ts";
import { clipU, now, num, obj, str, truthy } from "./util.ts";

export function onChat(ws: AppSocket, who: Who | undefined) {
  const user = who?.user ?? "";
  if (!user) return ws.close(4401, "log in first");
  const c: ChatClient = { ws, name: "", color: "", typing: "", typingAt: 0 };
  clients.add(c);
  ws.send({ type: "presence", people: presenceFor(c, allPresence()) });
  ws.onClose(() => {
    clients.delete(c);
    if (c.name !== "") {
      announceLeave(c.name);
      broadcastPresence();
    }
  });
  ws.onMessage((raw) => {
    const msg = obj(raw);
    if (msg) onChatMessage(c, user, msg);
  });
}

export function onChatMessage(c: ChatClient, user: string, msg: Msg) {
  const t = str(msg.type);
  if (t === "ping") {
    c.ws.send({ type: "pong" });
    return;
  }
  if (t === "join") {
    let col = typeof msg.color === "string" ? msg.color : "";
    if (!validColors.has(col)) col = colorForName(user);
    c.name = user;
    c.color = col;
    sendHistory(c);
    announceJoin(user);
    broadcastPresence();
    c.ws.send({ type: "presence", people: presenceFor(c, allPresence()) });
    return;
  }
  if (c.name === "") return;
  switch (t) {
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
