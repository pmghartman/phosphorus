// the viewer's page: the file its url names (host, share, path) shown by its kind;
// another the desktop opens in this window shown in its place, unsaved text asked about first

import { ask, followTheme, onOpen } from "@phosphorus/app-sdk/web";
import { down, el, main, path, type Shown, say, tools } from "./dom.ts";
import { type At, fileSrc, kindOf, nameOf } from "./files.ts";
import { showImage } from "./image.ts";
import { showText } from "./text.ts";

let shown: Shown | null = null;
let at: At | null = null;

// the browser's own player: video, sound, a pdf
function showMedia(kind: string, src: string, name: string): Shown {
  tools.replaceChildren();
  if (kind === "pdf") {
    main.replaceChildren(Object.assign(el("iframe", "vw-frame"), { src, title: name }));
    return { unsaved: () => false };
  }
  const box = el("div", `vw-media ${kind}`);
  const m = Object.assign(el(kind === "video" ? "video" : "audio"), { src, controls: true, autoplay: true });
  m.addEventListener("error", () => say("this browser can't play it: download it instead", true));
  box.append(m);
  main.replaceChildren(box);
  return { unsaved: () => false, focus: () => m.focus() };
}

function show(q: Record<string, string>) {
  if (!q.host || !q.path) {
    main.replaceChildren(el("p", "vw-empty", "open a picture, a video, a pdf or a text file from Files"));
    return;
  }
  if (shown?.unsaved() && !confirm(`${nameOf(at!.path)} has unsaved changes. Open ${nameOf(q.path)} without saving?`))
    return;
  at = { host: q.host, share: q.share || "0", path: q.path };
  const name = nameOf(at.path);
  history.replaceState(null, "", `?${new URLSearchParams(at)}`);
  document.title = name;
  ask({ kind: "title", title: name });
  ask({ kind: "unsaved", on: false });
  path.textContent = `${at.share === "home" ? "home" : at.host} · ${at.path}`;
  path.title = path.textContent;
  Object.assign(down, { href: fileSrc(at, false), download: name, hidden: false });
  say("");
  const kind = kindOf(at.path);
  if (kind === "image") shown = showImage(main, tools, fileSrc(at, true), name);
  else if (kind === "text") shown = showText(main, tools, at);
  else shown = showMedia(kind, fileSrc(at, true), name);
  shown.focus?.();
}

followTheme();
onOpen(show);
show(Object.fromEntries(new URLSearchParams(location.search)));

document.addEventListener("keydown", (e) => {
  if (shown?.key?.(e)) e.preventDefault();
});
// the page's own tab closing or reloading with unsaved text
addEventListener("beforeunload", (e) => {
  if (shown?.unsaved()) e.preventDefault();
});
