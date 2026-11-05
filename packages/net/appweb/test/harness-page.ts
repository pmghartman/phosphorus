// the harness's page: a bare desktop of plain boxes for the app's windows
import { AppViewer, type Shell, type ShellWin } from "../src/web/viewer.ts";

const desk = document.getElementById("desk")!;
let z = 1;
const log = (s: string) => {
  const p = document.getElementById("log")!;
  p.textContent = `${s}\n${p.textContent}`.slice(0, 4000);
};

const shell: Shell = {
  window(s, ev) {
    const node = document.createElement("div");
    node.className = "win";
    node.hidden = true;
    const head = document.createElement("div");
    head.className = "head";
    const title = document.createElement("span");
    title.textContent = s.title;
    const close = document.createElement("button");
    close.textContent = "x";
    close.onclick = () => ev.close();
    head.append(title, close);
    const body = document.createElement("div");
    body.className = "body";
    node.append(head, body);
    desk.append(node);
    let b = { x: 20, y: 20, width: Math.min(s.bounds.width, innerWidth - 40), height: Math.min(s.bounds.height, innerHeight - 60) };
    const place = () => {
      node.style.left = `${b.x}px`;
      node.style.top = `${b.y}px`;
      node.style.width = `${b.width}px`;
      node.style.height = `${b.height}px`;
    };
    place();
    queueMicrotask(() => ev.bounds(b));
    let o = { x: 0, y: 0 };
    let dragging = false;
    const w: ShellWin = {
      body,
      title: (t) => {
        title.textContent = t;
      },
      bounds: (nb) => {
        b = { ...b, ...nb };
        place();
      },
      show: () => {
        node.hidden = false;
        node.style.zIndex = String(++z);
      },
      hide: () => {
        node.hidden = true;
      },
      focus: () => {
        node.style.zIndex = String(++z);
      },
      minimize: () => {},
      maximize: () => {},
      restore: () => {},
      fullscreen: () => {},
      frameless: (on) => {
        head.style.display = on ? "none" : "";
        body.style.top = on ? "0" : "";
      },
      background: (c) => {
        body.style.background = c;
      },
      flash: () => {},
      close: () => node.remove(),
      drag: (dx, dy) => {
        if (!dragging) {
          dragging = true;
          o = { x: b.x, y: b.y };
        }
        b.x = o.x + dx;
        b.y = o.y + dy;
        place();
      },
      dragEnd: () => {
        dragging = false;
        ev.bounds(b);
      },
      toggleMax: () => {},
    };
    return w;
  },
  async menu(_w, items) {
    log(`menu: ${items.map((i) => i.label).join(" | ")}`);
    return null;
  },
  async message(_w, o) {
    log(`message: ${o.message}`);
    return { response: o.cancelId ?? 0, checkboxChecked: false };
  },
  async openDialog(_w, o) {
    log(`open dialog: ${JSON.stringify(o).slice(0, 200)}`);
    const p = "D:/phosphorus/packages/net/appweb";
    return p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] };
  },
  async saveDialog() {
    return { canceled: true, filePath: "" };
  },
  tell(kind, data) {
    log(`tell ${kind}: ${JSON.stringify(data).slice(0, 200)}`);
  },
  status(s) {
    log(`status ${JSON.stringify(s)}`);
  },
};

const t0 = performance.now();
(window as any).viewer = new AppViewer(`ws://${location.host}/ws?w=${innerWidth}&h=${innerHeight}&dpr=${devicePixelRatio}`, shell, !location.search.includes("isolate=0"));
(window as any).t0 = t0;
