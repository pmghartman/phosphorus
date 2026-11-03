// the page's small helpers: a tag made with a class and text, a text box no
// password manager fills, html escaped
import { ask } from "@phosphorus/app-sdk/web";

export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string | number | null,
): HTMLElementTagNameMap[K] =>
  Object.assign(
    document.createElement(tag),
    cls ? { className: cls } : {},
    text != null ? { textContent: String(text) } : {},
  );

// a plain text box: a saved login never offered for it, secret dotting what's typed
export function noFill(input: HTMLInputElement, secret?: boolean): HTMLInputElement {
  Object.assign(input, { type: "text", autocomplete: "off", name: `nf-${Math.random().toString(36).slice(2)}` });
  for (const [k, v] of [
    ["data-1p-ignore", ""],
    ["data-lpignore", "true"],
    ["data-bwignore", ""],
    ["data-form-type", "other"],
  ] as const)
    input.setAttribute(k, v);
  if (secret) input.classList.add("no-fill-secret");
  return input;
}

export const esc = (t: unknown) =>
  String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// where the page's calls go: the app's api beside the page, its sockets the same host's
export const API = "/api/app/code";
export const wsBase = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

// a terminal on host from the desktop around the page, run typed into it; false
// opened on its own, with no desktop to ask
export const inDesk = () => window.parent !== window;
export const terminal = (host: string, run: string) => ask({ kind: "terminal", host, run });
