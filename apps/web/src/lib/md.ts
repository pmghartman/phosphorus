// markdown as the server renders it (packages/web-md: markdown-it, highlight.js, sanitize-html), the page
// adding only katex for math, fetched on first use
import type { MdBlock } from '@phosphorus/wire';

// the server's html for a text, by breaks and text
const cache = new Map<string, string>();
const CACHE_MAX = 4000;
// asked of the server together, a tick after the first
interface Queued {
  el: HTMLElement;
  src: string;
  breaks: boolean;
  key: string;
}
let queue: Queued[] = [];
let queued: ReturnType<typeof setTimeout> | 0 = 0;

const keyOf = (src: string, breaks: boolean) => `${breaks ? 'b' : 'p'}\n${src}`;

function remember(key: string, html: string) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, html);
}

// el's text as markdown: html given (a chat line's own) used at once, a known
// text from the cache, anything else plain until the server's render lands
export function renderMd(el: HTMLElement, src: string, breaks = true, html: string | null | undefined = null): void {
  const key = keyOf(src, breaks);
  if (typeof html === 'string') remember(key, html);
  el.classList.add('md');
  el.dataset.md = key;
  const known = cache.get(key);
  if (known !== undefined) {
    paint(el, known);
    return;
  }
  el.textContent = src;
  queue.push({ el, src, breaks, key });
  queued ||= setTimeout(flush, 0);
}

// several texts in one round trip
async function flush() {
  const batch = queue;
  queue = [];
  queued = 0;
  const items: { text: string; breaks: boolean }[] = [];
  const seen = new Map<string, number>();
  for (const q of batch)
    if (!seen.has(q.key)) {
      seen.set(q.key, items.length);
      items.push({ text: q.src, breaks: q.breaks });
    }
  let out: unknown[] = [];
  try {
    const r = await fetch('/api/md', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    if (r.ok) out = (await r.json()).html || [];
  } catch {}
  for (const q of batch) {
    const html = out[seen.get(q.key)!];
    if (typeof html !== 'string') continue;
    remember(q.key, html);
    if (q.el.isConnected && q.el.dataset.md === q.key) paint(q.el, html);
  }
}

// a document's top-level blocks, each with where its source sits and its html
export async function mdBlocks(text: string): Promise<MdBlock[]> {
  try {
    const r = await fetch('/api/md', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, blocks: true }),
    });
    if (r.ok) return (await r.json()).blocks || [];
  } catch {}
  return text ? [{ from: 0, raw: text, html: null }] : [];
}

function paint(el: HTMLElement, html: string) {
  el.innerHTML = html;
  for (const a of el.querySelectorAll('a[href]')) {
    (a as HTMLAnchorElement).target = '_blank';
    (a as HTMLAnchorElement).rel = 'noopener noreferrer';
  }
  for (const box of el.querySelectorAll('input')) box.setAttribute('disabled', '');
  if (el.querySelector('.math')) drawMath(el);
  el.dispatchEvent(new CustomEvent('md-painted', { bubbles: true }));
}

// --- math -------------------------------------------------------------------

type Katex = typeof import('katex').default;
let katexLoad: Promise<Katex> | null = null;
const loadKatex = () =>
  (katexLoad ||= (async () => {
    const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: __ASSETS__['katex.css'] });
    document.head.appendChild(css);
    const k = (await import('katex')).default;
    (globalThis as unknown as { katex: Katex }).katex = k;
    await import('katex/contrib/mhchem');
    return k;
  })().catch((e) => {
    katexLoad = null;
    throw e;
  }));

async function drawMath(el: HTMLElement) {
  let k: Katex;
  try {
    k = await loadKatex();
  } catch {
    return;
  }
  for (const s of el.querySelectorAll<HTMLElement>('span.math[data-tex]')) {
    try {
      s.innerHTML = k.renderToString(s.dataset.tex!, {
        displayMode: s.dataset.display === '1',
        throwOnError: false,
        output: 'html',
      });
      s.classList.add('math-done');
    } catch {}
  }
  fitMath(el);
}

// math wider than its line shrunk to fit, to half size at most, display math
// scrolling past that, inline math breaking only between its bases
const MATH_EM = 1.05;
export function fitMath(el: HTMLElement): void {
  const line = el.closest('.bubble') || el.closest('li') || el;
  if (!line.clientWidth) return;
  for (const k of el.querySelectorAll<HTMLElement>('.katex')) {
    k.style.fontSize = '';
    const disp = k.closest('.katex-display');
    const bases = [...k.querySelectorAll('.katex-html > *')].map((b) => b.getBoundingClientRect().width);
    const wide = disp ? bases.reduce((a, w) => a + w, 0) : Math.max(0, ...bases);
    const room = (disp || line).clientWidth - 2;
    if (wide > room) k.style.fontSize = `${MATH_EM * Math.max(0.5, room / wide)}em`;
  }
}
