// a picture: fit to the window, zoomed with the wheel, the keys or the bar about
// where it's pointed at, dragged about when bigger; a click between fit and its own size

import { button, el, type Shown, say } from "./dom.ts";

const MIN = 0.02;
const MAX = 32;

export function showImage(main: HTMLElement, tools: HTMLElement, src: string, name: string): Shown {
  const box = el("div", "vw-img");
  const img = Object.assign(el("img"), { src, alt: name, draggable: false });
  box.append(img);
  main.replaceChildren(box);

  let fit = true;
  // the scale shown
  let cur = 1;
  // a picture with no size of its own (an svg without one) the window's
  const natural = () => [img.naturalWidth || box.clientWidth, img.naturalHeight || box.clientHeight] as const;
  // measured with the picture out of the way, so no scrollbar of its own counts
  const fitScale = () => {
    img.style.width = img.style.height = "0";
    const [w, h] = natural();
    return Math.min(1, box.clientWidth / w, box.clientHeight / h);
  };

  const pct = button("", "fit to the window, or its own size (0, 1)", () => (fit ? zoom(1) : toFit()));
  pct.classList.add("vw-pct");
  tools.replaceChildren(
    button("−", "zoom out (-)", () => zoom(cur / 1.25)),
    pct,
    button("+", "zoom in (+)", () => zoom(cur * 1.25)),
  );

  function paint(s: number) {
    cur = s;
    const [w, h] = natural();
    img.style.width = `${w * s}px`;
    img.style.height = `${h * s}px`;
    pct.textContent = fit ? "fit" : `${Math.round(s * 100)}%`;
    box.classList.toggle("big", w * s > box.clientWidth + 1 || h * s > box.clientHeight + 1);
    box.classList.toggle("px", s >= 3);
  }

  // to s, the point at x,y in the window (its middle by default) kept where it is
  function zoom(s: number, x = box.clientWidth / 2, y = box.clientHeight / 2) {
    const cx = (box.scrollLeft + x - img.offsetLeft) / cur;
    const cy = (box.scrollTop + y - img.offsetTop) / cur;
    fit = false;
    paint(Math.min(MAX, Math.max(MIN, s)));
    box.scrollLeft = cx * cur + img.offsetLeft - x;
    box.scrollTop = cy * cur + img.offsetTop - y;
  }
  function toFit() {
    fit = true;
    paint(fitScale());
  }

  img.addEventListener("load", () => {
    toFit();
    say(`${img.naturalWidth}×${img.naturalHeight}`);
  });
  img.addEventListener("error", () => say("this picture can't be shown", true));
  new ResizeObserver(() => fit && img.naturalWidth && paint(fitScale())).observe(box);

  box.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const r = box.getBoundingClientRect();
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoom(cur * Math.exp(-d * 0.0015), e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false },
  );

  // a drag pans; a click with no drag between fit and its own size, at the pointer
  let drag: { x: number; y: number; moved: boolean } | null = null;
  box.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, moved: false };
    box.setPointerCapture(e.pointerId);
  });
  box.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    box.classList.add("drag");
    box.scrollLeft -= dx;
    box.scrollTop -= dy;
    drag.x = e.clientX;
    drag.y = e.clientY;
  });
  box.addEventListener("pointerup", (e) => {
    const was = drag;
    drag = null;
    box.classList.remove("drag");
    if (!was || was.moved) return;
    const r = box.getBoundingClientRect();
    if (fit && cur < 1) zoom(1, e.clientX - r.left, e.clientY - r.top);
    else toFit();
  });
  box.addEventListener("pointercancel", () => {
    drag = null;
    box.classList.remove("drag");
  });

  return {
    unsaved: () => false,
    key: (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      if (e.key === "+" || e.key === "=") zoom(cur * 1.25);
      else if (e.key === "-") zoom(cur / 1.25);
      else if (e.key === "0") toFit();
      else if (e.key === "1") zoom(1);
      else return false;
      return true;
    },
  };
}
