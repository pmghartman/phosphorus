// a line's markdown as the server rendered it (packages/core/web-md), the page
// adding only katex for math, its code and stylesheet fetched on first use

// el's text as markdown: the server's html when the line came with it, else plain
export function renderMd(el: HTMLElement, src: string, html: string | null | undefined): void {
  el.classList.add("md");
  if (typeof html !== "string") {
    el.textContent = src;
    return;
  }
  el.innerHTML = html;
  for (const a of el.querySelectorAll("a[href]")) {
    (a as HTMLAnchorElement).target = "_blank";
    (a as HTMLAnchorElement).rel = "noopener noreferrer";
  }
  for (const box of el.querySelectorAll("input")) box.setAttribute("disabled", "");
  if (el.querySelector(".math")) void drawMath(el);
  el.dispatchEvent(new CustomEvent("md-painted", { bubbles: true }));
}

type Katex = typeof import("katex").default;
let katexLoad: Promise<Katex> | null = null;
const loadKatex = () =>
  (katexLoad ||= (async () => {
    const { katexCss } = await import("./katexcss.ts");
    document.head.appendChild(Object.assign(document.createElement("style"), { textContent: katexCss() }));
    const k = (await import("katex")).default;
    (globalThis as unknown as { katex: Katex }).katex = k;
    await import("katex/contrib/mhchem");
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
  for (const s of el.querySelectorAll<HTMLElement>("span.math[data-tex]")) {
    try {
      s.innerHTML = k.renderToString(s.dataset.tex!, {
        displayMode: s.dataset.display === "1",
        throwOnError: false,
        output: "html",
      });
      s.classList.add("math-done");
    } catch {}
  }
  fitMath(el);
}

// math wider than its line shrunk to fit, to half size at most, display math
// scrolling past that, inline math breaking only between its bases
const MATH_EM = 1.05;
export function fitMath(el: HTMLElement): void {
  const line = el.closest(".bubble") || el.closest("li") || el;
  if (!line.clientWidth) return;
  for (const k of el.querySelectorAll<HTMLElement>(".katex")) {
    k.style.fontSize = "";
    const disp = k.closest(".katex-display");
    const bases = [...k.querySelectorAll(".katex-html > *")].map((b) => b.getBoundingClientRect().width);
    const wide = disp ? bases.reduce((a, w) => a + w, 0) : Math.max(0, ...bases);
    const room = (disp || line).clientWidth - 2;
    if (wide > room) k.style.fontSize = `${MATH_EM * Math.max(0.5, room / wide)}em`;
  }
}
