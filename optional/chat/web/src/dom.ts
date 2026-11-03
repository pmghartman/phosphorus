// the page's small helpers: elements, copying, sizes, what this browser keeps

export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string | number | null,
): HTMLElementTagNameMap[K] =>
  Object.assign(
    document.createElement(tag),
    cls ? { className: cls } : {},
    text != null ? { textContent: String(text) } : {},
  );

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

// copy, or the tick once copied
function copyIcon(kind: "copy" | "check"): SVGElement {
  const icon = svgEl("svg", { viewBox: "0 0 10 10", "aria-hidden": "true" });
  if (kind === "copy") {
    icon.appendChild(svgEl("rect", { x: 3.5, y: 3.5, width: 5, height: 5, class: "stroke" }));
    icon.appendChild(svgEl("path", { d: "M 1.5 6.5 V 1.5 H 6.5", class: "stroke" }));
  } else icon.appendChild(svgEl("path", { d: "M 1.5 5.5 L 4 8 L 8.5 2", class: "stroke" }));
  return icon;
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {}
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("copy failed");
}

// each code block with its copy button in the corner
export function codeCopies(root: HTMLElement): void {
  for (const pre of root.querySelectorAll("pre")) {
    if (pre.parentElement?.classList.contains("code-wrap")) continue;
    const wrap = el("div", "code-wrap");
    pre.replaceWith(wrap);
    const copy = Object.assign(el("button", "code-copy"), { type: "button", title: "copy", ariaLabel: "copy" });
    copy.appendChild(copyIcon("copy"));
    copy.addEventListener("click", (e) => {
      e.stopPropagation();
      copyText(pre.innerText.replace(/\n$/, ""))
        .then(() => {
          copy.replaceChildren(copyIcon("check"));
          setTimeout(() => copy.replaceChildren(copyIcon("copy")), 1200);
        })
        .catch(() => {});
    });
    wrap.append(pre, copy);
  }
}

export function humanSize(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  const u = ["b", "k", "m", "g", "t"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i ? v.toFixed(1) : v}${u[i]}`;
}

export const loadJson = <T>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key)!) ?? fallback;
  } catch {
    return fallback;
  }
};

export const saveJson = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
};
