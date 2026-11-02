// the state sockets, each with the user whose page opened it: the state push to
// every page, a page action or a reply to one user's
import type { Conn } from "@phosphorus/wsock";

const pages = new Map<Conn, string>();

export const pageCount = () => pages.size;

export function addPage(ws: Conn, user: string) {
  pages.set(ws, user);
  ws.onClose(() => pages.delete(ws));
}

// text to every page
export function toPages(text: string) {
  for (const ws of [...pages.keys()]) ws.text(text);
}

// msg to user's pages on this host, true when one was open
export function toUser(user: string, msg: Record<string, any>): boolean {
  if (user === "") return false;
  let ok = false;
  for (const [ws, u] of [...pages])
    if (u === user && ws.open()) {
      ws.json(msg);
      ok = true;
    }
  return ok;
}
