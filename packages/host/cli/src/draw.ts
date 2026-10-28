// the web's look, from the theme library: colours as ANSI, text measured past
// its codes, wrapped, tabled and framed as the desktop's windows
import { load } from "@phosphorus/theme";
import { env } from "@phosphorus/util";

type Palette = Record<string, string>;

// the cli's names for the library's tokens
const cliTokens: Record<string, string> = {
  bg: "--bg", fg: "--fg", muted: "--muted", accent: "--accent", accent2: "--accent-2", dim: "--dim",
  glyphPurple: "--glyph-purple", glyphOrange: "--glyph-orange", border: "--border", card: "--card", tabbar: "--tabbar",
  online: "--online", offmesh: "--offmesh", warn: "--warn",
  teal: "--teal", sage: "--sage", sky: "--sky", rose: "--rose", sand: "--sand",
};

function paletteOf(id: string, mode: string): Palette {
  const t = load().tokens(id, mode);
  const p: Palette = {};
  for (const [k, v] of Object.entries(cliTokens)) p[k] = t[v] ?? "";
  return p;
}

// PHOSPHORUS_THEME any of the library's themes, the mesh's own unless set
const dark = paletteOf(env("PHOSPHORUS_THEME"), "dark");
const light = paletteOf(env("PHOSPHORUS_THEME"), "light");

export let pal = dark;
const truecolor =
  /truecolor|24bit/i.test(env("COLORTERM")) ||
  ["iTerm.app", "WezTerm", "vscode", "ghostty", "Hyper", "Tabby"].includes(env("TERM_PROGRAM"));
export let base = "";
export let off = "";

export const page = "\x1b[49m";

export type RGB = [number, number, number];

export function rgb(hex: string): RGB {
  const out: RGB = [0, 0, 0];
  for (let i = 0; i < 3; i++) out[i] = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) || 0;
  return out;
}

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, "0");
export const hexOf = (c: RGB) => "#" + hex2(c[0]) + hex2(c[1]) + hex2(c[2]);

export function mix(a: string, b: string, t: number): string {
  const x = rgb(a), y = rgb(b);
  return hexOf([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

const levels = [0, 95, 135, 175, 215, 255];

export function to256(v: RGB): number {
  const idx = v.map((x) => (x < 48 ? 0 : x < 115 ? 1 : Math.floor((x - 35) / 40)));
  const g = Math.max(0, Math.min(23, Math.round((v[0] + v[1] + v[2]) / 3 / 10 - 0.8)));
  const dist = (w: number[]) => w.reduce((n, x, i) => n + (x - v[i]!) * (x - v[i]!), 0);
  const grey = 8 + 10 * g;
  if (dist([grey, grey, grey]) < dist(idx.map((i) => levels[i]!))) return 232 + g;
  return 16 + 36 * idx[0]! + 6 * idx[1]! + idx[2]!;
}

function color(layer: number, h: string): string {
  const c = rgb(h);
  if (truecolor) return `\x1b[${layer};2;${Math.trunc(c[0])};${Math.trunc(c[1])};${Math.trunc(c[2])}m`;
  return `\x1b[${layer};5;${to256(c)}m`;
}

export const fg = (h: string) => color(38, h);
export const bg = (h: string) => color(48, h);

// c one helper per token, back to the page's fg after
export const c = (token: string) => (s: string) => fg(pal[token]!) + s + fg(pal.fg!);

export function setTheme(isLight: boolean) {
  pal = isLight ? light : dark;
  base = "\x1b[0m" + page + fg(pal.fg!);
  off = mix(pal.muted!, pal.border!, 0.45);
}

export const bold = (s: string) => "\x1b[1m" + s + "\x1b[22m";
export const strike = (s: string) => "\x1b[9m" + s + "\x1b[29m";

// surface a span on its own background, then the page's again
export function surface(bgHex: string, fgHex?: string): (s: string) => string {
  const f = fgHex ?? pal.fg!;
  return (s) => (bgHex === pal.bg ? page : bg(bgHex)) + fg(f) + s + page + fg(pal.fg!);
}

export const caret = () => surface(pal.accent!)(" ");

// shift the bands' offset now: the web glyph's 6s ease out and back
function shift(): number {
  let t = (Date.now() % 6000) / 3000;
  if (t > 1) t = 2 - t;
  return t * t * (3 - 2 * t);
}

export function gradient(s: string, span: number): string {
  const chars = [...s];
  if (span === 0) span = chars.length;
  const o = shift();
  let b = "";
  chars.forEach((ch, i) => {
    let t = o;
    if (span > 1) t += i / (span - 1);
    t -= Math.floor(t);
    const u = t >= 0.5 ? (1 - t) * 2 : t * 2;
    b += fg(mix(pal.glyphPurple!, pal.glyphOrange!, u)) + ch;
  });
  return b + fg(pal.fg!);
}

const ansiRe = /\x1b\[[0-9;?]*[A-Za-z]/g;

export const vlen = (s: string) => [...s.replace(ansiRe, "")].length;

export function pad(s: string, w: number): string {
  const n = w - vlen(s);
  return n > 0 ? s + " ".repeat(n) : s;
}

// splitKeep s split around re's matches, the matches kept
function splitKeep(re: RegExp, s: string): string[] {
  const out: string[] = [];
  let last = 0;
  for (const m of s.matchAll(re)) {
    out.push(s.slice(last, m.index), m[0]);
    last = m.index + m[0].length;
  }
  out.push(s.slice(last));
  return out;
}

export function cut(s: string, w: number): string {
  let b = "";
  let n = 0;
  for (const part of splitKeep(ansiRe, s)) {
    if (part.startsWith("\x1b[")) {
      b += part;
      continue;
    }
    const r = [...part];
    const take = Math.min(Math.max(w - n, 0), r.length);
    b += r.slice(0, take).join("");
    n += take;
  }
  return b;
}

export const fit = (s: string, w: number) => cut(s, w) + base;

const wrapTok = /(\x1b\[[0-9;?]*[A-Za-z]| +)/g;
const softRe = /[^/.\-_:]*[/.\-_:]+|[^/.\-_:]+/g;

export function wrap(s: string, w: number, hang: number): string[] {
  if (vlen(s) <= w || w < 2) return [s];
  const out: string[] = [];
  let codes = "", line = "";
  let n = 0, room = w;
  const next = () => {
    out.push(line);
    line = " ".repeat(hang) + codes;
    n = 0;
    room = Math.max(w - hang, 1);
  };
  const toks: string[] = [];
  for (const tok of splitKeep(wrapTok, s)) {
    // a long word broken after its / . - _ : before mid-letter
    if (tok !== "" && tok[0] !== " " && !tok.startsWith("\x1b[")) toks.push(...(tok.match(softRe) ?? []));
    else toks.push(tok);
  }
  for (const tok of toks) {
    if (tok === "") continue;
    if (tok.startsWith("\x1b[")) {
      codes += tok;
      line += tok;
      continue;
    }
    const chars = [...tok];
    if (tok[0] === " ") {
      if (n + chars.length <= room) {
        line += tok;
        n += chars.length;
      } else if (n > 0) next();
      continue;
    }
    if (n + chars.length > room && n > 0) next();
    for (let i = 0; i < chars.length; i += room) {
      if (i > 0) next();
      const end = Math.min(i + room, chars.length);
      line += chars.slice(i, end).join("");
      n += end - i;
    }
  }
  out.push(line);
  return out;
}

export function size(): [number, number] {
  const cols = process.stdout.columns, rows = process.stdout.rows;
  if (!cols || !rows || cols <= 0 || rows <= 0) return [80, 24];
  return [cols, rows];
}

export function inner(): number {
  const [cols] = size();
  return cols - 5 < 20 ? 20 : cols - 5;
}

// Row one line of a view, a selected row drawn on the hover surface
export type Row = { text: string; sel?: boolean };

export const plainRows = (...ls: string[]): Row[] => ls.map((text) => ({ text }));

export function table(headers: string[], rows: string[][], sel: number, max: number): Row[] {
  const w = headers.map((h, i) => Math.max(vlen(h), ...rows.map((r) => (i < r.length ? vlen(r[i]!) : 0))));
  const mark = sel >= 0;
  let room = inner() - 2 * (w.length - 1);
  if (mark) room -= 2;
  const sum = w.reduce((a, x) => a + x, 0);
  for (let over = sum - room; over > 0; over--) {
    let mi = 0;
    w.forEach((x, i) => {
      if (x > w[mi]!) mi = i;
    });
    if (w[mi]! <= 4) break;
    w[mi]!--;
  }
  const lines = (cells: string[], on: boolean): string[] => {
    const parts = w.map((x, i) => wrap(i < cells.length ? cells[i]! : "", x, 0));
    const most = Math.max(1, ...parts.map((p) => p.length));
    const out: string[] = [];
    for (let k = 0; k < most; k++) {
      const lead = mark ? (on && k === 0 ? c("accent")("›") + " " : "  ") : "";
      out.push(lead + parts.map((p, i) => pad(k < p.length ? p[k]! : "", w[i]!)).join("  "));
    }
    return out;
  };
  let shownN = rows.length;
  if (max > 0 && rows.length > max) shownN = Math.max(max - 1, 1);
  let from = sel - Math.floor(shownN / 2);
  if (from > rows.length - shownN) from = rows.length - shownN;
  if (from < 0) from = 0;
  const out: Row[] = [];
  for (let i = from; i < from + shownN && i < rows.length; i++) {
    const on = i === sel;
    for (const l of lines(rows[i]!, on)) out.push({ text: l, sel: on });
  }
  const lead = mark ? "  " : "";
  if (shownN < rows.length) out.push({ text: c("muted")(`${lead}${from + 1}-${from + shownN} of ${rows.length}`) });
  const head = headers.map((h, i) => pad(cut(h, w[i]!), w[i]!));
  return [{ text: c("sage")(lead + head.join("  ")) }, ...out];
}

// selMark a selected row's tag, for render to scroll it into view; never written out
export const selMark = "\x1b[9999m";

// panel a window: its title bar, the lines framed under it
export function panel(title: string, lines: Row[], w: number): string[] {
  const b = c("border");
  // .dk-head: the window's title on its own bar, as the desktop's windows
  const head = cut(title, w - 1);
  let top = b("┌" + "─".repeat(w + 2) + "┐");
  if (title !== "") top = surface(pal.card!)(" " + c("sage")(head) + " ".repeat(max0(w + 3 - vlen(head))));
  const out = [top];
  for (const l of lines) {
    if (l.sel) {
      out.push(selMark + b("│") + surface(pal.border!)(" " + pad(l.text, w) + " ") + b("│"));
      continue;
    }
    for (const x of wrap(l.text, w, 0)) out.push(b("│") + " " + pad(x, w) + " " + b("│"));
  }
  out.push(b("└" + "─".repeat(w + 2) + "┘"));
  return out;
}

export const max0 = (n: number) => (n < 0 ? 0 : n);

export type Card = { title: string; lines: Row[] };

export function panels(...list: (Card | undefined)[]): string[] {
  const items = list.filter((x): x is Card => x !== undefined);
  // the width of the window, as the frontend's cards
  const w = inner();
  const out: string[] = [];
  items.forEach((it, i) => {
    if (i > 0) out.push("");
    out.push(...panel(it.title, it.lines, w));
  });
  return out;
}

// Key one of a view's buttons: label and kind
export type Key = { label: string; kind: string };
