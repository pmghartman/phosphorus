// text: one file as plain text, as notepad: save (ctrl+s), where the caret is, its
// unsaved changes held against closing; binary or over 16MB refused, downloaded instead

import { ask } from "@phosphorus/app-sdk/web";
import { button, el, type Shown, said, say } from "./dom.ts";
import { type At, nameOf, readText, saveText } from "./files.ts";

export function showText(main: HTMLElement, tools: HTMLElement, at: At): Shown {
  const name = nameOf(at.path);
  const ta = Object.assign(el("textarea", "vw-ta"), { spellcheck: false, wrap: "off", disabled: true });
  const pos = el("span", "vw-pos");
  const save = button("save", "save (ctrl+s)", () => void put());
  save.disabled = true;
  tools.replaceChildren(pos, save);
  main.replaceChildren(ta);
  say("loading");

  let saved = "";
  let busy = false;
  let was = false;
  const dirty = () => !ta.disabled && ta.value !== saved;
  const mark = () => {
    const d = dirty();
    save.disabled = busy || !d;
    if (d === was) return;
    was = d;
    document.title = d ? `${name} •` : name;
    ask({ kind: "title", title: document.title });
    ask({ kind: "unsaved", on: d });
  };
  const caret = () => {
    const i = ta.selectionStart;
    const before = ta.value.slice(0, i);
    pos.textContent = `${before.split("\n").length}:${i - before.lastIndexOf("\n")}`;
  };

  async function put() {
    if (busy || !dirty()) return;
    busy = true;
    const text = ta.value;
    mark();
    say("saving");
    try {
      await saveText(at, text);
      saved = text;
      say("saved");
    } catch (e) {
      say((e as Error).message, true);
    }
    busy = false;
    mark();
  }

  readText(at).then(
    (r) => {
      if (r.binary || r.tooBig || r.text === undefined) {
        say(
          r.tooBig ? "over 16MB: too big to edit, download it instead" : "binary: not text, download it instead",
          true,
        );
        tools.replaceChildren();
        main.replaceChildren(el("p", "vw-empty", `${name} isn't opened as text`));
        return;
      }
      saved = r.text;
      ta.value = r.text;
      ta.disabled = false;
      ta.setSelectionRange(0, 0);
      say("");
      mark();
      caret();
      ta.focus();
    },
    (e) => say((e as Error).message, true),
  );

  ta.addEventListener("input", () => {
    if (said() === "saved") say("");
    mark();
    caret();
  });
  for (const ev of ["keyup", "click", "select"]) ta.addEventListener(ev, caret);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      ta.setRangeText("\t", ta.selectionStart, ta.selectionEnd, "end");
      ta.dispatchEvent(new Event("input"));
    }
  });

  return {
    unsaved: dirty,
    key: (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "s") return false;
      void put();
      return true;
    },
    focus: () => !ta.disabled && ta.focus(),
  };
}
