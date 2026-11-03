// the page's parts: the bar's, and making elements

export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) =>
  Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});

const $ = (id: string) => document.getElementById(id)!;
export const main = $("vw-main");
export const tools = $("vw-tools");
export const path = $("vw-path");
export const down = $("vw-down") as HTMLAnchorElement;
const note = $("vw-note");

// how it went, beside the path
export function say(text: string, bad = false) {
  note.textContent = text;
  note.classList.toggle("bad", bad);
}
export const said = () => note.textContent || "";

export const button = (text: string, title: string, fn: () => void) => {
  const b = Object.assign(el("button", "vw-btn", text), { type: "button", title, ariaLabel: title });
  b.addEventListener("click", fn);
  return b;
};

// what's on show: whether it has unsaved changes, and its own keys
export interface Shown {
  unsaved: () => boolean;
  key?: (e: KeyboardEvent) => boolean;
  focus?: () => void;
}
