// render
import { base, bg, c, caret, fit, max0, pal, selMark, size, surface, wrap } from "./draw.ts";
import { ui, updateTab } from "./state.ts";
import { currentView, hints, k, topBar } from "./views.ts";
import { out } from "./api.ts";

// selAt the last frame's selected body line, -1 for none
export let selAt = -1;

// glow the header line alone redrawn, its wordmark's bands slid on
export function glow() {
  const [cols] = size();
  out.write("\x1b[H" + base + fit(topBar(cols), cols) + "\x1b[K");
}

export function render() {
  const [cols, rows] = size();
  let global: ReturnType<typeof k>[] = [];
  if (!ui.form && !ui.keysOnly) {
    global = [k("u update", "quiet"), k("k keys", "quiet"), k("q quit", "quiet")];
    if (ui.tab === updateTab) global = [k("esc back", "quiet"), k("q quit", "quiet")];
  }
  let status = "";
  let hint: ReturnType<typeof k>[] | undefined;
  if (ui.prompt) {
    const p = ui.prompt;
    let label = c("muted")(p.label);
    if (p.err !== "") label = c("offmesh")(p.err);
    status = " " + label + " " + surface(pal.card!)(" " + "•".repeat([...p.value].length) + caret() + bg(pal.card!) + " ");
    hint = [k("enter send", "primary"), k("esc cancel")];
  } else if (ui.confirm) {
    status = " " + ui.confirm.text;
    hint = [k("y yes", ui.confirm.danger ? "danger" : "primary"), k("n no")];
  } else if (ui.flash !== "" && Date.now() - ui.flashAt < 8000) status = " " + ui.flash;
  // a view drawn again if the footer's rows moved its room
  let v = currentView();
  const footer = () => {
    const f = status !== "" ? wrap(status, cols, 1) : [];
    f.push(hint ? hints(hint, [], cols) : hints(v.keys, global, cols));
    // a blank row under the bar, so a window's edge never cuts it
    f.push("");
    return f;
  };
  let foot = footer();
  const head = [topBar(cols), ""];
  let room = rows - head.length - foot.length - 1;
  if (room < 1) room = 1;
  if (room !== ui.room) {
    ui.room = room;
    v = currentView();
    foot = footer();
  }
  let body = v.lines.map((l) => " " + l);
  // past the room: scrolled, the selected row kept in view, an arrow where more is
  let at = -1;
  body = body.map((l, i) => {
    if (!l.includes(selMark)) return l;
    if (at < 0) at = i;
    return l.replace(selMark, "");
  });
  if (body.length > room) {
    // followed only when it moved, pgup and pgdn free to look past it
    if (at >= 0 && at !== selAt && room > 2) {
      ui.scroll = Math.min(ui.scroll, at - 1);
      ui.scroll = Math.max(ui.scroll, at - room + 2);
    }
    ui.scroll = max0(Math.min(ui.scroll, body.length - room));
    const more = body.length - ui.scroll - room;
    body = body.slice(ui.scroll, ui.scroll + room);
    if (ui.scroll > 0 && room > 1) body[0] = " " + c("muted")("↑ more, pgup");
    if (more > 0 && room > 1) body[room - 1] = " " + c("muted")(`↓ ${more + 1} more, pgdn`);
  } else ui.scroll = 0;
  selAt = at;
  const lines = [...head, ...body];
  while (lines.length < rows - foot.length) lines.push("");
  lines.push(...foot);
  if (lines.length > rows) lines.length = rows;
  let b = "\x1b[H";
  lines.forEach((l, i) => {
    if (i > 0) b += "\x1b[K\r\n";
    b += base + fit(l, cols);
  });
  out.write(b + "\x1b[K\x1b[J");
}
