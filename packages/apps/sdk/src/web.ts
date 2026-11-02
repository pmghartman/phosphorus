// an installable app's page in its desktop window: what it asks of the desktop,
// by postMessage to the window around it, and the desktop's theme pushed back

export type Ask =
  | { kind: "terminal"; host: string }
  | { kind: "notify"; title: string; body?: string }
  | { kind: "open"; id: string; query?: Record<string, string> }
  | { kind: "title"; title: string }
  // the page listening, the theme sent at once
  | { kind: "ready" };

// what the desktop sends: its theme's tokens and mode, on load and on each change
export type Theme = { kind: "theme"; vars: Record<string, string>; scheme: string };

const inDesk = () => typeof window !== "undefined" && window.parent !== window;

export function ask(a: Ask): boolean {
  if (!inDesk()) return false;
  window.parent.postMessage({ phos: 1, ...a }, location.origin);
  return true;
}

// the theme applied to this page's root as it comes, fn told of each
export function followTheme(fn?: (t: Theme) => void): void {
  if (!inDesk()) return;
  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin || e.source !== window.parent) return;
    const t = e.data as Theme;
    if (t?.kind !== "theme" || typeof t.vars !== "object") return;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(t.vars)) if (k.startsWith("--")) root.style.setProperty(k, v);
    if (t.scheme) root.dataset.theme = t.scheme;
    else delete root.dataset.theme;
    fn?.(t);
  });
  ask({ kind: "ready" });
}
