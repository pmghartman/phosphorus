// markdown rendered by the app's server half (markdown-it, highlight.js,
// sanitize-html), several texts asked for together a tick after the first
import { API } from "./dom.ts";

const cache = new Map<string, string>();
const CACHE_MAX = 4000;
interface Queued {
  el: HTMLElement;
  src: string;
  key: string;
}
let queue: Queued[] = [];
let queued: ReturnType<typeof setTimeout> | 0 = 0;

function remember(key: string, html: string) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, html);
}

// el's text as markdown: a known text from the cache, anything else plain until
// the server's render lands
export function renderMd(el: HTMLElement, src: string): void {
  el.classList.add("md");
  el.dataset.md = src;
  const known = cache.get(src);
  if (known !== undefined) {
    paint(el, known);
    return;
  }
  el.textContent = src;
  queue.push({ el, src, key: src });
  queued ||= setTimeout(flush, 0);
}

async function flush() {
  const batch = queue;
  queue = [];
  queued = 0;
  const texts = [...new Set(batch.map((q) => q.key))];
  let out: unknown[] = [];
  try {
    const r = await fetch(`${API}/md`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts }),
    });
    if (r.ok) out = (await r.json()).html || [];
  } catch {}
  texts.forEach((t, i) => typeof out[i] === "string" && remember(t, out[i] as string));
  for (const q of batch) {
    const html = cache.get(q.key);
    if (html !== undefined && q.el.isConnected && q.el.dataset.md === q.key) paint(q.el, html);
  }
}

function paint(el: HTMLElement, html: string) {
  el.innerHTML = html;
  for (const a of el.querySelectorAll("a[href]")) {
    (a as HTMLAnchorElement).target = "_blank";
    (a as HTMLAnchorElement).rel = "noopener noreferrer";
  }
  for (const box of el.querySelectorAll("input")) box.setAttribute("disabled", "");
}
