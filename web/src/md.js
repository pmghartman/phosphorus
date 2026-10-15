// markdown as the server renders it (goldmark, chroma, bluemonday), the page
// adding only katex for math and mermaid for diagrams, both fetched on first use

// the server's html for a text, by breaks and text
const cache = new Map();
const CACHE_MAX = 4000;
// asked of the server together, a tick after the first
let queue = [];
let queued = 0;

const keyOf = (src, breaks) => `${breaks ? 'b' : 'p'}\n${src}`;

function remember(key, html) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, html);
}

// el's text as markdown: html given (a chat line's own) used at once, a known
// text from the cache, anything else plain until the server's render lands
export function renderMd(el, src, breaks = true, html = null) {
  const key = keyOf(src, breaks);
  if (typeof html === 'string') remember(key, html);
  el.classList.add('md');
  el.dataset.md = key;
  const known = cache.get(key);
  if (known !== undefined) { paint(el, known); return; }
  el.textContent = src;
  queue.push({ el, src, breaks, key });
  queued ||= setTimeout(flush, 0);
}

// several texts in one round trip
async function flush() {
  const batch = queue;
  queue = [];
  queued = 0;
  const items = [];
  const seen = new Map();
  for (const q of batch) if (!seen.has(q.key)) { seen.set(q.key, items.length); items.push({ text: q.src, breaks: q.breaks }); }
  let out = [];
  try {
    const r = await fetch('/api/md', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }) });
    if (r.ok) out = (await r.json()).html || [];
  } catch {}
  for (const q of batch) {
    const html = out[seen.get(q.key)];
    if (typeof html !== 'string') continue;
    remember(q.key, html);
    if (q.el.isConnected && q.el.dataset.md === q.key) paint(q.el, html);
  }
}

// a document's top-level blocks, each with where its source sits and its html
export async function mdBlocks(text) {
  try {
    const r = await fetch('/api/md', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, blocks: true }) });
    if (r.ok) return (await r.json()).blocks || [];
  } catch {}
  return text ? [{ from: 0, raw: text, html: null }] : [];
}

function paint(el, html) {
  el.innerHTML = html;
  for (const a of el.querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  for (const box of el.querySelectorAll('input')) box.setAttribute('disabled', '');
  if (el.querySelector('.math')) drawMath(el);
  for (const c of el.querySelectorAll('pre > code.language-mermaid')) drawMermaid(c.parentElement, c.textContent);
  el.dispatchEvent(new CustomEvent('md-painted', { bubbles: true }));
}

// --- math -------------------------------------------------------------------

let katexLoad = null;
const loadKatex = () => (katexLoad ||= (async () => {
  const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: __ASSETS__['katex.css'] });
  document.head.appendChild(css);
  const k = (await import('katex')).default;
  globalThis.katex = k;
  await import('katex/contrib/mhchem');
  return k;
})().catch((e) => { katexLoad = null; throw e; }));

async function drawMath(el) {
  let k;
  try { k = await loadKatex(); } catch { return; }
  for (const s of el.querySelectorAll('span.math[data-tex]')) {
    try {
      s.innerHTML = k.renderToString(s.dataset.tex, { displayMode: s.dataset.display === '1', throwOnError: false, output: 'html' });
      s.classList.add('math-done');
    } catch {}
  }
  fitMath(el);
}

// math wider than its line shrunk to fit, to half size at most, display math
// scrolling past that, inline math breaking only between its bases
const MATH_EM = 1.05;
export function fitMath(el) {
  const line = el.closest('.bubble') || el.closest('li') || el;
  if (!line.clientWidth) return;
  for (const k of el.querySelectorAll('.katex')) {
    k.style.fontSize = '';
    const disp = k.closest('.katex-display');
    const bases = [...k.querySelectorAll('.katex-html > *')].map((b) => b.getBoundingClientRect().width);
    const wide = disp ? bases.reduce((a, w) => a + w, 0) : Math.max(0, ...bases);
    const room = (disp || line).clientWidth - 2;
    if (wide > room) k.style.fontSize = `${MATH_EM * Math.max(0.5, room / wide)}em`;
  }
}

// --- diagrams -----------------------------------------------------------------
// a mermaid fence drawn in the palette, each drawing kept by theme and source

const mermaidSvgs = new Map();
let mermaidLoad = null;
let mermaidTheme = '';
let mermaidSeq = 0;
const loadMermaid = () => (mermaidLoad ||= new Promise((resolve, reject) => {
  const s = Object.assign(document.createElement('script'), { src: __ASSETS__['mermaid.js'] });
  s.onload = () => resolve(window.mermaid);
  s.onerror = () => { mermaidLoad = null; reject(new Error('mermaid failed to load')); };
  document.head.appendChild(s);
}));

function mermaidThemed(m) {
  const css = getComputedStyle(document.documentElement);
  const v = (k) => css.getPropertyValue(k).trim();
  const theme = [v('--bg'), v('--fg'), v('--accent')].join();
  if (theme === mermaidTheme) return theme;
  mermaidTheme = theme;
  m.initialize({
    startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'base',
    fontFamily: v('--font'),
    themeVariables: {
      background: v('--bg'), fontFamily: v('--font'), fontSize: '12px',
      primaryColor: v('--card'), primaryTextColor: v('--fg'), primaryBorderColor: v('--accent'),
      secondaryColor: v('--card'), secondaryTextColor: v('--fg'), secondaryBorderColor: v('--sky'),
      tertiaryColor: v('--bg'), tertiaryTextColor: v('--fg'), tertiaryBorderColor: v('--sage'),
      lineColor: v('--muted'), textColor: v('--fg'), mainBkg: v('--card'), nodeBorder: v('--accent'),
      clusterBkg: v('--bg'), clusterBorder: v('--border'), edgeLabelBackground: v('--bg'),
      noteBkgColor: v('--card'), noteTextColor: v('--fg'), noteBorderColor: v('--sand'),
      actorBkg: v('--card'), actorBorder: v('--accent'), actorTextColor: v('--fg'), signalColor: v('--muted'),
    },
  });
  return theme;
}

// the source stays up as code until the drawing lands, and if it won't parse
async function drawMermaid(pre, src) {
  pre.classList.add('mermaid-src');
  let m;
  try { m = await loadMermaid(); } catch { return; }
  const key = `${mermaidThemed(m)}\n${src}`;
  let svg = mermaidSvgs.get(key);
  if (svg === undefined) {
    try { svg = (await m.render(`mermaid-${mermaidSeq += 1}`, src)).svg; } catch { svg = ''; }
    mermaidSvgs.set(key, svg);
  }
  if (!svg || !pre.isConnected) return;
  const box = Object.assign(document.createElement('div'), { className: 'mermaid-box' });
  box.innerHTML = svg;
  pre.replaceWith(box);
}
