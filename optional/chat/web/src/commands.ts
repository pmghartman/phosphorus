// commands

import { cancelCompose, composeVars, editing, paintAtts, paintBar, startEdit, typingTick } from "./compose.ts";
import { channels, chOf, convHint, convsVars, dmWith, leftChannels, saveChannels, topicOf } from "./convs.ts";
import { el } from "./dom.ts";
import { setConv } from "./files.ts";
import { chatNote, convLines, keyOf } from "./lines.ts";
import { convMenu, leaveChannel } from "./menus.ts";
import { putSending } from "./socket.ts";
import {
  type ChatLine,
  COLOR_NAMES,
  chatChip,
  chatCmds,
  chatCompose,
  chatForm,
  chatSend,
  chatText,
  chatTitle,
  joined,
  NAME_COLORS,
  send,
  st,
  stateVars,
  wsOpen,
} from "./state.ts";

// a channel opened or made from the conversations' +, a topic after its name
export function joinChannel(arg: string) {
  const [raw, ...topic] = arg.trim().split(/\s+/);
  const ch = (raw || "").replace(/^#/, "").toLowerCase();
  if (ch === "mesh") {
    setConv("mesh");
    return;
  }
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(ch)) {
    chatNote("bad name");
    return;
  }
  if (!convsVars.myChannels.includes(ch)) convsVars.myChannels.push(ch);
  delete leftChannels[ch];
  saveChannels();
  const fresh = !convLines.get(`ch:${ch}`)?.length;
  setConv(`ch:`);
  if (fresh || topic.length) send({ type: "topic", ch, text: topic.join(" ") });
}

export function runCommand(input: string) {
  const [cmd, ...rest] = input.trim().split(/\s+/);
  const arg = rest.join(" ").trim();

  if (cmd === "/dm") {
    const to = nameIn(arg);
    if (!to || to === st.name) {
      chatNote("usage: /dm name [message]");
      return;
    }
    const text = arg.slice(to.length).trim();
    setConv(`dm:`);
    if (text) send({ type: "dm", to, text });
    return;
  }
  if (cmd === "/chat") {
    setConv("mesh");
    return;
  }
  if (cmd === "/leave" && chOf(convsVars.conv)) {
    leaveChannel(chOf(convsVars.conv));
    return;
  }
  // asked once more in the menu, never closed on one keystroke
  if (cmd === "/close" && chOf(convsVars.conv)) {
    convMenu(convsVars.conv, chatTitle, true);
    return;
  }
  if (cmd === "/topic" && chOf(convsVars.conv)) {
    send({ type: "topic", ch: chOf(convsVars.conv), text: arg });
    return;
  }
  if (cmd === "/recolor") {
    const idx = arg ? COLOR_NAMES.indexOf(arg.toLowerCase()) : -1;
    if (arg && idx === -1) {
      chatNote(`usage: /recolor ${COLOR_NAMES.join("|")}`);
      return;
    }
    st.color = idx !== -1 ? NAME_COLORS[idx]! : NAME_COLORS[Math.floor(Math.random() * NAME_COLORS.length)]!;
    localStorage.setItem("phosphorus-chat-color", st.color);
    send({ type: "recolor", color: st.color });
    return;
  }
  if (dmWith(convsVars.conv)) {
    chatNote("not here");
    return;
  }
  // the mesh channel's own, everyone's, not a local scrollback wipe
  if (cmd === "/clear" && convsVars.conv === "mesh") {
    send({ type: "clear" });
    return;
  }
  chatNote(`unknown ${cmd}`);
}

// every name this browser knows of, and the longest of them an argument starts
// with, names with spaces included
export const knownNames = () =>
  [...new Set([...stateVars.people.map((p) => p.name), ...[...convLines.keys()].map(dmWith).filter(Boolean)])].filter(
    (n) => n !== st.name,
  );
export const nameIn = (arg: string) =>
  knownNames()
    .sort((a, b) => b.length - a.length)
    .find((n) => arg === n || arg.startsWith(`${n} `)) || arg.split(/\s+/)[0]!;

// a command's hit: its label, what it is, and what picking it does
export interface ChatHit {
  label: string;
  what: string;
  cmd?: boolean;
  pick: () => void;
}

// the choices a command's words already have: people, open files, channels, colours
export function argHints(): ChatHit[] {
  const cmd = chatChip.textContent;
  const v = chatText.value;
  const online = (n: string) => (stateVars.people.some((p) => p.name === n) ? "online" : "offline");
  let prefix = "";
  let list: [string, string][] = [];
  if (cmd === "/dm") {
    const who = knownNames()
      .sort((a, b) => b.length - a.length)
      .find((n) => v.startsWith(` `));
    if (!who) list = knownNames().map((n) => [n, online(n)]);
  } else if (cmd === CHANNEL_CHIP[0]) list = channels().map((c) => [c, topicOf(`ch:${c}`) || "channel"]);
  else if (cmd === "/recolor") list = COLOR_NAMES.map((c) => [c, ""]);
  const token = v.slice(prefix.length).toLowerCase();
  return list
    .filter(([x]) => x.toLowerCase().includes(token) && x.toLowerCase() !== token)
    .slice(0, 8)
    .map(([x, what]) => ({
      label: x,
      what,
      pick: () => {
        chatText.value = `${prefix}${x}${cmd === "/recolor" || prefix ? "" : " "}`;
        chatText.setSelectionRange(chatText.value.length, chatText.value.length);
        autoGrowChatText();
      },
    }));
}

// name, what it does, and the box's placeholder once chosen, none for a
// command that takes nothing
export type Cmd = [string, string, string];
export const DM_CMD: Cmd = ["/dm", "message one person directly", "name, then the message"];
// not a command: the conversations' + asking for a channel's name
export const CHANNEL_CHIP: Cmd = ["#", "open or make a channel", "channel name, then a topic"];
export const BACK_CMD: Cmd = ["/chat", "back to #mesh", ""];
export const ME_CMDS: Cmd[] = [["/recolor", "change your colour", COLOR_NAMES.join(", ")]];
export function commands(): Cmd[] {
  if (dmWith(convsVars.conv)) return [BACK_CMD, DM_CMD];
  return [
    DM_CMD,
    ...(chOf(convsVars.conv)
      ? ([
          ["/topic", "describe this channel", "topic"],
          ["/leave", "hide it from your list", ""],
          ["/close", "close it for everyone", ""],
          BACK_CMD,
        ] as Cmd[])
      : ([["/clear", "clear #mesh for everyone", ""]] as Cmd[])),
    ...ME_CMDS,
  ];
}
export let chatHits: ChatHit[] = [];
export let chatHit = 0;

// a command that takes words, held beside the box rather than in it, so
// spellcheck never underlines it and it keeps its colour
export function setChatChip(cmd: string) {
  const spec = [CHANNEL_CHIP, ...commands()].find(([c]) => c === cmd);
  chatChip.textContent = cmd || "";
  chatChip.hidden = !cmd;
  chatText.placeholder = spec ? spec[2] : convHint();
}

// a command picked from outside the box, its words typed next
export function startCommand(cmd: string) {
  if (!joined()) return;
  setChatChip(cmd);
  chatText.value = "";
  autoGrowChatText();
  chatText.focus();
}

// while the first word is a command in the making, the ones it could be,
// one lit for tab or enter
export function renderChatCmds() {
  const m = chatText.value.match(/^(\/\S*)$/);
  const hits: ChatHit[] = editing
    ? []
    : chatChip.textContent
      ? argHints()
      : m
        ? commands()
            .filter(([c]) => c.startsWith(m[1]!.toLowerCase()))
            .map(([c, what]) => ({ label: c, what, cmd: true, pick: () => pickChatCmd(c) }))
        : [];
  if (hits.map((h) => h.label).join() !== chatHits.map((h) => h.label).join()) chatHit = 0;
  chatHits = hits;
  chatCmds.hidden = !hits.length;
  chatCmds.replaceChildren(
    ...hits.map((h, i) => {
      const li = el("li", i === chatHit ? "on" : "");
      li.append(el("span", h.cmd ? "cmd" : "cmd hint", h.label), el("span", "cmd-what", h.what));
      li.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keeps the box focused
        h.pick();
      });
      return li;
    }),
  );
}

// a command taking words as the chip, one taking none run
export function pickChatCmd(cmd: string) {
  const spec = commands().find(([c]) => c === cmd);
  if (spec && !spec[2]) {
    chatText.value = cmd;
    chatForm.requestSubmit();
    return;
  }
  setChatChip(cmd);
  chatText.value = "";
  chatText.dispatchEvent(new Event("input"));
}

export const uploading = () => composeVars.atts.some((a) => a.state === "up");
export function syncSend() {
  chatSend.disabled =
    !chatText.value.trim() && !chatChip.textContent && !composeVars.atts.some((a) => a.state === "done");
}

// the box grown to its text, the arrow lit only once there is something to send
export function autoGrowChatText() {
  chatText.style.height = "auto";
  chatText.style.height = `${chatText.scrollHeight}px`;
  syncSend();
  renderChatCmds();
}

chatText.addEventListener("input", () => {
  // a command typed out in full, then a space: into the chip
  const typed = !chatChip.textContent && !editing && chatText.value.match(/^(\/\S+)\s/);
  const spec = typed && commands().find(([c, , takes]) => c === typed[1]!.toLowerCase() && takes);
  if (spec) {
    setChatChip(spec[0]);
    chatText.value = chatText.value.slice(typed[0].length);
  }
  autoGrowChatText();
  typingTick();
});
chatText.addEventListener("blur", () => {
  if (composeVars.typingSent) {
    composeVars.typingSent = "";
    send({ type: "typing", conv: "" });
  }
});

chatText.addEventListener("keydown", (e) => {
  if (chatHits.length && ["ArrowDown", "ArrowUp"].includes(e.key)) {
    e.preventDefault();
    chatHit = (chatHit + (e.key === "ArrowDown" ? 1 : chatHits.length - 1)) % chatHits.length;
    renderChatCmds();
    return;
  }
  if (chatHits.length && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
    e.preventDefault();
    chatHits[chatHit]!.pick();
    return;
  }
  if (e.key === "Escape" && chatHits.length) {
    e.preventDefault();
    chatHits = [];
    chatCmds.hidden = true;
    return;
  }
  // esc: a reply or edit dropped first, the box left only after
  if (e.key === "Escape" && (composeVars.replyTo || editing)) {
    e.preventDefault();
    cancelCompose();
    return;
  }
  // ↑ in an empty box: your last line here, to edit
  if (e.key === "ArrowUp" && !chatText.value && !chatChip.textContent) {
    const m = (convLines.get(convsVars.conv) || []).findLast(
      (x) => x.name === st.name && (!x.kind || x.kind === "dm") && !x.gone,
    );
    if (m) {
      e.preventDefault();
      startEdit(m);
    }
    return;
  }
  // backspace at the very start: the chip back as text
  if (e.key === "Backspace" && chatChip.textContent && chatText.selectionStart === 0 && chatText.selectionEnd === 0) {
    e.preventDefault();
    const cmd = chatChip.textContent;
    setChatChip("");
    chatText.value = `${cmd}${chatText.value}`;
    chatText.setSelectionRange(cmd.length, cmd.length);
    autoGrowChatText();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = `${chatChip.textContent} ${chatText.value}`.trim();
  if (!wsOpen()) {
    chatNote("reconnecting");
    return;
  }
  if (editing) {
    if (text) send({ type: "edit", ref: keyOf(editing), text });
    cancelCompose();
    chatText.value = "";
    autoGrowChatText();
    return;
  }
  const files = composeVars.atts.filter((a) => a.state === "done").map((a) => a.meta!);
  if (!text && !files.length) return;
  if (uploading()) {
    chatNote("uploading");
    return;
  }
  chatText.value = "";
  setChatChip("");
  autoGrowChatText();
  typingTick();
  if (text.startsWith(`${CHANNEL_CHIP[0]} `) && !files.length) {
    joinChannel(text.slice(CHANNEL_CHIP[0].length));
    return;
  }
  if (text.startsWith("/") && !files.length) {
    runCommand(text);
    return;
  }
  const re = composeVars.replyTo ? keyOf(composeVars.replyTo) : undefined;
  composeVars.replyTo = null;
  paintBar();
  composeVars.atts = [];
  paintAtts();
  const files1 = files.length ? files : undefined;
  if (dmWith(convsVars.conv)) {
    send({ type: "dm", to: dmWith(convsVars.conv), text, files, re });
    putSending({ kind: "dm", dm: dmWith(convsVars.conv), text, files: files1, re });
  } else {
    send({ type: "message", text, files, re, ch: chOf(convsVars.conv) || undefined });
    putSending({ text, files: files1, re, ch: chOf(convsVars.conv) || undefined });
  }
});
