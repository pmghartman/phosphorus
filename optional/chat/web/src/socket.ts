// incoming

import { chatReading, chOf, convsVars, news, noteNews, paintConvs, readAt, saveChannels, stampRead } from "./convs.ts";
import { paintFiles, paintStatus, renderConv } from "./files.ts";
import {
  chatNote,
  convLines,
  convOf,
  dropLine,
  fold,
  holdLine,
  keyOf,
  lines,
  MARKS,
  orphanMarks,
  putLine,
  redrawLine,
  sender,
  sysLine,
} from "./lines.ts";
import { channelClosed } from "./menus.ts";
import { bumpUnread, notifyChat } from "./notify.ts";
import { type ChatLine, chatCompose, chatLog, chatText, colorFor, send, st, stateVars, wsOpen } from "./state.ts";
import type { ChatWsMessage } from "./types.ts";

// a line in, live or from history: folded, held, drawn if on screen, noted if not
export function takeLine(m: ChatLine, live: boolean) {
  if (MARKS.includes(m.kind!)) {
    const t = fold(m);
    if (t && live && convOf(t) === convsVars.conv) redrawLine(t);
    if (t && live && m.kind === "react" && t.name === st.name && m.name !== st.name && m.on !== false)
      notifyChat(m.name, `reacted ${m.emoji}`);
    return;
  }
  if (live) m.live = true;
  const ghost =
    live && m.name === st.name && sendingLines.find((g) => g.text === (m.text || "") && convOf(g) === convOf(m));
  const c = holdLine(m);
  if (ghost) settleSending(ghost, m, c);
  if (!c || !live) return;
  if (c === convsVars.conv && !ghost) putLine(m, true);
  if (m.kind === "topic") {
    paintConvs();
    return;
  }
  if (m.files && c === convsVars.conv) paintFiles();
  if (m.name === st.name) {
    paintConvs();
    return;
  }
  noteNews(c);
  bumpUnread();
  if (chatReading(c)) return;
  const text = m.text || (m.files ? `shared ${m.files.map((f) => f.name).join(", ")}` : "");
  const atMe = st.name && new RegExp(`@${st.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(m.text || "");
  notifyChat(
    m.dm
      ? `${sender(m)} (direct)`
      : atMe
        ? `${sender(m)} mentioned you`
        : m.ch
          ? `${sender(m)} in #${m.ch}`
          : sender(m),
    text,
  );
}

// own lines drawn at once, swapped in place for the host's echo
export const sendingLines: ChatLine[] = [];
export const SENDING_MS = 10000;
export let sendingSeq = 0;
export function putSending(fields: Partial<ChatLine> & { text: string }) {
  const g: ChatLine = {
    host: "sending",
    seq: (sendingSeq += 1),
    timestamp: Date.now(),
    name: st.name,
    color: st.color || colorFor(st.name),
    sending: true,
    ...fields,
    text: fields.text.slice(0, 2000),
  };
  sendingLines.push(g);
  if (holdLine(g) === convsVars.conv) putLine(g, true).classList.add("sending");
  setTimeout(() => {
    if (!sendingLines.includes(g)) return;
    sendingLines.splice(sendingLines.indexOf(g), 1);
    dropLine(keyOf(g));
    chatNote(`not sent: ${g.text!.slice(0, 40)}`);
  }, SENDING_MS);
}
export function settleSending(g: ChatLine, m: ChatLine, c: string | null) {
  sendingLines.splice(sendingLines.indexOf(g), 1);
  const li = chatLog.querySelector(`li[data-key="${CSS.escape(keyOf(g))}"]`);
  if (li && c === convsVars.conv) putLine(m, true, li).style.animation = "none";
  dropLine(keyOf(g));
}

export function renderHistory(messages: ChatLine[], closed: Record<string, unknown> = {}) {
  lines.clear();
  convLines.clear();
  orphanMarks.clear();
  for (const m of messages) takeLine(m, false);
  // lines that came while this browser was away, counted past what it last saw;
  // a first visit has nothing to count
  for (const [c, list] of convLines) {
    if (readAt[c] === undefined || chatReading(c)) {
      stampRead(c);
      continue;
    }
    const fresh = list.filter(
      (m) => m.timestamp > readAt[c]! && m.name !== st.name && m.kind !== "sys" && m.kind !== "topic",
    );
    if (fresh.length) news.set(c, fresh.length);
    else news.delete(c);
  }
  // channels closed while this browser was away, unless opened again since
  const gone = Object.keys(closed).filter((ch) => !convLines.get(`ch:${ch}`)?.length);
  if (gone.some((ch) => convsVars.myChannels.includes(ch))) {
    convsVars.myChannels = convsVars.myChannels.filter((ch) => !gone.includes(ch));
    saveChannels();
  }
  if (gone.includes(chOf(convsVars.conv))) convsVars.conv = "mesh";
  renderConv();
  paintConvs();
  paintFiles();
}

// the chat socket proved alive: a ping when it's been quiet, on coming back
// and coming online, closed for a fresh one when no answer lands
export let chatHeard = 0;
export const CHAT_QUIET_MS = 25000;
export const CHAT_PONG_MS = 4000;
export function chatAwake(now = false) {
  if (!wsOpen() || (!now && Date.now() - chatHeard < CHAT_QUIET_MS)) return;
  const sock = st.ws!;
  const asked = Date.now();
  send({ type: "ping" });
  // a dead socket's own close can take minutes, so its close run now
  setTimeout(() => {
    if (st.ws !== sock || chatHeard >= asked) return;
    const closed = sock.onclose as unknown as () => void;
    sock.onclose = null;
    sock.onmessage = null;
    sock.close();
    closed();
  }, CHAT_PONG_MS);
}
setInterval(() => {
  if (!document.hidden) chatAwake();
}, 5000);
window.addEventListener("online", () => chatAwake(true));

// logged out: the socket refused, the page says so and asks once the person is back
const chatOut = document.getElementById("chat-out")!;
async function loggedIn(): Promise<boolean> {
  try {
    const r = await fetch("/api/me", { cache: "no-store" });
    await r.body?.cancel();
    return r.status !== 401;
  } catch {
    return true;
  }
}

export function connectChat() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/app/chat/ws`);
  st.ws = ws;
  ws.onopen = () => {
    stateVars.reconnectDelay = 300;
    chatHeard = Date.now();
    stateVars.chatOnline = true;
    chatOut.hidden = true;
    paintStatus();
    send({ type: "join", color: st.color || undefined });
  };
  ws.onclose = async () => {
    stateVars.people = [];
    stateVars.chatOnline = false;
    paintStatus();
    if (!(await loggedIn())) {
      chatOut.hidden = false;
      chatCompose.hidden = true;
    }
    setTimeout(connectChat, stateVars.reconnectDelay);
    stateVars.reconnectDelay = Math.min(stateVars.reconnectDelay * 1.5, 5000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    chatHeard = Date.now();
    let msg: ChatWsMessage;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "pong") return;
    if (msg.type === "history") {
      st.name = msg.me;
      chatCompose.hidden = false;
      convsVars.chMetas = msg.channels && typeof msg.channels === "object" ? msg.channels : {};
      renderHistory(msg.messages, msg.closed && typeof msg.closed === "object" ? msg.closed : {});
      if (!document.activeElement || document.activeElement === document.body) chatText.focus();
    } else if (msg.type === "message") {
      const { type, ...m } = msg;
      takeLine(m, true);
    } else if (msg.type === "retract") {
      dropLine(`${msg.host}:${msg.seq}`);
    } else if (msg.type === "presence") {
      stateVars.people = msg.people;
      paintStatus();
      paintConvs();
      paintFiles();
    } else if (msg.type === "system") {
      sysLine("mesh", msg.text);
    } else if (msg.type === "clear") {
      for (const m of [...(convLines.get("mesh") || [])]) lines.delete(keyOf(m));
      convLines.delete("mesh");
      if (convsVars.conv === "mesh") renderConv();
      sysLine("mesh", msg.by ? `chat cleared by ${msg.by}` : "chat cleared");
      paintFiles();
    } else if (msg.type === "close") {
      if (typeof msg.ch === "string") channelClosed(msg.ch, msg.by);
    } else if (msg.type === "channel") {
      if (typeof msg.ch === "string" && msg.meta && typeof msg.meta === "object") {
        convsVars.chMetas[msg.ch] = msg.meta;
        paintConvs();
      }
    }
  };
}
