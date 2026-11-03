// what came while this page wasn't being read: the desktop's bell told, the
// window's title counting it, and the browser's own notification when the bell
// in the header is on and the page is open on its own
import { ask } from "@phosphorus/app-sdk/web";

// away: another tab, minimized, or another window in front of this one
export const away = () => document.hidden || !document.hasFocus();

// the desktop's own notifications read the same switch
const BELL_KEY = "phosphorus-chat-notify";
const chatBell = document.getElementById("chat-bell") as HTMLButtonElement;
const canNotify = "Notification" in window;
const granted = () => canNotify && Notification.permission === "granted";
const bellOn = () => granted() && localStorage.getItem(BELL_KEY) === "1";

function paintBell() {
  chatBell.setAttribute("aria-pressed", String(bellOn()));
  chatBell.title = bellOn() ? "desktop notifications on, click to mute" : "notify me when someone chats";
}
if (canNotify) {
  chatBell.hidden = false;
  paintBell();
}
// permission asked on the click, the gesture browsers want
chatBell.addEventListener("click", async () => {
  if (bellOn()) {
    localStorage.setItem(BELL_KEY, "0");
    paintBell();
    return;
  }
  let perm = Notification.permission;
  if (perm === "default") perm = await Notification.requestPermission();
  if (perm === "granted") localStorage.setItem(BELL_KEY, "1");
  paintBell();
});

// one entry: the desktop's bell, else the browser's notification while away
export function notifyChat(title: string, body: string): void {
  if (ask({ kind: "notify", title, body }) || !away() || !bellOn()) return;
  try {
    const n = new Notification(title, { body, tag: "phosphorus-chat", silent: true });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {}
}

// lines unseen while away, and the conversations' news, in the title
let unread = 0;
let news = 0;
function paintTitle() {
  const n = unread || news;
  const t = n ? `(${n > 99 ? "99+" : n}) chat` : "chat";
  if (document.title === t) return;
  document.title = t;
  ask({ kind: "title", title: t });
}
export function bumpUnread(): void {
  if (!away()) return;
  unread += 1;
  paintTitle();
}
export function dropUnread(): void {
  if (away() || !unread) return;
  unread = 0;
  paintTitle();
}
export function newsTotal(n: number): void {
  news = n;
  paintTitle();
}
