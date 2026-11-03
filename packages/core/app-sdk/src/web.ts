// an installable app's page in its desktop window: what it asks of the desktop,
// by postMessage to the window around it, and the desktop's theme pushed back

export type Ask =
  // a terminal tab on host, run typed into it when given
  | { kind: "terminal"; host: string; run?: string }
  | { kind: "notify"; title: string; body?: string }
  | { kind: "open"; id: string; query?: Record<string, string> }
  | { kind: "title"; title: string }
  // changes not yet saved: the window asks before it closes while on
  | { kind: "unsaved"; on: boolean }
  // the page listening, the theme sent at once
  | { kind: "ready" }
  // the page taking what the desktop opens in it while it's up (onOpen)
  | { kind: "opens" };

// what the desktop sends: its theme's tokens and mode, on load and on each change
export type Theme = { kind: "theme"; vars: Record<string, string>; scheme: string };
// what it opens in a window already up: the query its url would carry
export type Opened = { kind: "open"; query: Record<string, string> };

const inDesk = () => typeof window !== "undefined" && window.parent !== window;

export function ask(a: Ask): boolean {
  if (!inDesk()) return false;
  window.parent.postMessage({ phos: 1, ...a }, location.origin);
  return true;
}

// the desktop's messages to this page
function fromDesk(fn: (d: any) => void) {
  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin || e.source !== window.parent) return;
    fn(e.data);
  });
}

// the theme applied to this page's root as it comes, fn told of each
export function followTheme(fn?: (t: Theme) => void): void {
  if (!inDesk()) return;
  fromDesk((t: Theme) => {
    if (t?.kind !== "theme" || typeof t.vars !== "object") return;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(t.vars)) if (k.startsWith("--")) root.style.setProperty(k, v);
    if (t.scheme) root.dataset.theme = t.scheme;
    else delete root.dataset.theme;
    fn?.(t);
  });
  ask({ kind: "ready" });
}

// what the desktop opens in this page while it's up, as its url's query would
// carry it (the first comes in the url); without onOpen the page is loaded anew
export function onOpen(fn: (query: Record<string, string>) => void): void {
  if (!inDesk()) return;
  fromDesk((o: Opened) => {
    if (o?.kind !== "open" || !o.query || typeof o.query !== "object") return;
    const q: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.query)) if (typeof v === "string") q[k] = v;
    fn(q);
  });
  ask({ kind: "opens" });
}
