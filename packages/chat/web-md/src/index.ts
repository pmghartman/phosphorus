// the chat's markdown, rendered here so the browser holds no markdown parser,
// sanitizer or highlighter: markdown-it, highlight.js and sanitize-html where
// Go had goldmark, chroma and bluemonday
import { createHash } from "node:crypto";
import hljs from "highlight.js";
import MarkdownIt from "markdown-it";
import type { Token } from "markdown-it";
import sanitizeHtml from "sanitize-html";

// math: $$..$$ \[..\] display, \(..\) and $..$ inline, as the page had it
const mathRe = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(\S(?:\\\$|[^$\n])*?)\$/g;
const codeRe = /```[\s\S]*?(?:```|$)|`[^`\n]+`/g;

// Go's html.EscapeString
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#34;", "'": "&#39;" })[c]!);

// --- fenced code: highlight.js's own class names ----------------------------

// code as highlight.js-classed spans, escaped text when unknown
export function highlight(code: string, lang: string): string {
  if (!lang || !hljs.getLanguage(lang)) return escape(code);
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escape(code);
  }
}

const taskRe = /^\[([ xX])\][ \t]/;

function newMD(breaks: boolean) {
  const md = new MarkdownIt({ html: true, linkify: true, breaks });
  // unsafe links reach the sanitizer, which drops them as bluemonday did
  md.validateLink = () => true;
  md.renderer.rules.fence = (tokens, idx) => {
    const t = tokens[idx]!;
    const lang = (t.info.trim().split(/\s+/)[0] ?? "").toLowerCase();
    const cls = "hljs" + (lang ? " language-" + escape(lang) : "");
    return `<pre><code class="${cls}">${highlight(t.content, lang)}</code></pre>\n`;
  };
  // GFM task items: the box goldmark wrote, before the item's text; and a
  // table cell's alignment as goldmark's align attribute
  md.core.ruler.push("gfm", (state) => {
    const ts = state.tokens;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i]!;
      if (t.type === "th_open" || t.type === "td_open") {
        const style = t.attrGet("style");
        const m = typeof style === "string" ? /^text-align:(\w+)$/.exec(style) : null;
        if (m) {
          t.attrs = null;
          t.attrSet("align", m[1]!);
        }
        continue;
      }
      if (i < 2) continue;
      if (t.type !== "inline" || ts[i - 1]!.type !== "paragraph_open" || ts[i - 2]!.type !== "list_item_open" || !t.children) continue;
      const first = t.children[0];
      if (!first || first.type !== "text") continue;
      const m = taskRe.exec(first.content);
      if (!m) continue;
      first.content = first.content.slice(m[0].length);
      const box = new state.Token("html_inline", "", 0);
      box.content = m[1] === " " ? '<input disabled="" type="checkbox"> ' : '<input checked="" disabled="" type="checkbox"> ';
      t.children.unshift(box);
    }
  });
  return md;
}

const mdBreaks = newMD(true);
const mdPlain = newMD(false);

const schemeRe = /^(https?|mailto):/i;

const policy = {
  allowedTags: [
    "p", "br", "strong", "em", "del", "s", "code", "pre", "ul", "ol", "li", "blockquote", "hr",
    "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td",
    "details", "summary", "kbd", "sup", "sub", "mark", "ins", "abbr", "span", "a", "input",
  ],
  allowedAttributes: {
    "*": ["class", "title"],
    a: ["href", "rel", "target"],
    th: ["align", "colspan", "rowspan"],
    td: ["align", "colspan", "rowspan"],
    ol: ["start"],
    details: ["open"],
    span: ["data-tex", "data-display"],
    input: [{ name: "type", values: ["checkbox"] }, "checked", "disabled"],
  },
  allowedEmptyAttributes: ["checked", "disabled", "open"],
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesAppliedToAttributes: ["href"],
  allowProtocolRelative: false,
  transformTags: {
    // only absolute http(s) and mailto links kept, as noreferrer in a new tab;
    // a link left without an href dropped to its text
    a: (tagName, attribs): sanitizeHtml.Tag => {
      const href = (attribs.href ?? "").trim();
      if (!schemeRe.test(href)) return { tagName: "a-dropped", attribs: {} };
      return { tagName, attribs: { href, rel: "noreferrer noopener", target: "_blank" } };
    },
  },
} as sanitizeHtml.IOptions;

// bluemonday's serialization: void tags unslashed
const sanitize = (h: string) => sanitizeHtml(h, policy).replace(/ \/>/g, ">");

const cache = new Map<string, string>();

// a line's text as sanitized html, math left as spans for katex
export function markdown(src: string, breaks: boolean): string {
  const key = createHash("sha256").update((breaks ? "b" : "p") + src).digest("hex");
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const held: string[] = [];
  const code: string[] = [];
  let t = src.replace(codeRe, (m) => `\x02${code.push(m) - 1}\x02`);
  t = replaceMath(t, (tex, display) => {
    const d = display ? ' data-display="1"' : "";
    held.push(`<span class="math" data-tex="${escape(tex)}"${d}>${escape(tex)}</span>`);
    return `\x01${held.length - 1}\x01`;
  });
  t = t.replace(/\x02(\d+)\x02/g, (_, n) => code[Number(n)]!);
  let out: string;
  try {
    out = (breaks ? mdBreaks : mdPlain).render(t);
  } catch {
    return escape(src);
  }
  let clean = sanitize(out);
  clean = clean.replace(/\x01(\d+)\x01/g, (_, n) => sanitize(held[Number(n)]!));
  clean = tasks(clean);
  if (cache.size > 20000) cache.clear();
  cache.set(key, clean);
  return clean;
}

// a task's checkbox the only input, its li marked
const tasks = (h: string) => h.replace(/<li>(<p>)?<input/g, '<li class="task">$1<input');

// JS's lookbehind-free equivalent of the page's MATH_RE: a single-$ span must
// not end on a space or be followed by a digit
function replaceMath(s: string, fn: (tex: string, display: boolean) => string): string {
  let out = "";
  let last = 0;
  for (const m of s.matchAll(mathRe)) {
    const at = m.index;
    const end = at + m[0].length;
    if (at < last) continue;
    let tex: string;
    let display = true;
    if (m[1] !== undefined) tex = m[1];
    else if (m[2] !== undefined) tex = m[2];
    else if (m[3] !== undefined) [tex, display] = [m[3], false];
    else {
      [tex, display] = [m[4]!, false];
      const next = s.charCodeAt(end);
      if (tex.endsWith(" ") || tex.endsWith("\t") || (end < s.length && next >= 48 && next <= 57)) continue;
    }
    out += s.slice(last, at) + fn(tex, display);
    last = end;
  }
  return out + s.slice(last);
}

// one top-level markdown block and where its source sits
export type Block = { from: number; raw: string; html: string };

// a document's top-level blocks, each rendered, for the editor's view
export function blocks(src: string): Block[] {
  const lines = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) lines.push(i + 1);
  const starts: number[] = [];
  for (const t of mdPlain.parse(src, {}) as Token[]) if (t.level === 0 && t.nesting >= 0 && t.map) starts.push(lines[t.map[0]] ?? -1);
  const out: Block[] = [];
  starts.forEach((st, i) => {
    if (st < 0) return;
    const end = starts.slice(i + 1).find((x) => x >= 0) ?? src.length;
    if (st > end) return;
    const raw = src.slice(st, end);
    if (!raw.trim()) return;
    out.push({ from: st, raw, html: markdown(raw.replace(/\n+$/, ""), false) });
  });
  if (!out.length && src.trim()) out.push({ from: 0, raw: src, html: markdown(src, false) });
  if (out.length && out[0]!.from > 0) {
    out[0]!.raw = src.slice(0, out[0]!.from) + out[0]!.raw;
    out[0]!.from = 0;
  }
  return out;
}
