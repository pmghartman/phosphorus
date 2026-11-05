// the browser's side of a host app: one socket to the server, each of the app's windows a
// sandboxed frame in a window of the desktop's own, the frames' IPC passed straight through.
// The desktop gives the windows (Shell); this keeps them in step with the app

import codecSrc from "../inject/codec.js" with { type: "text" };
import opsSrc from "../inject/ops.js" with { type: "text" };

type Codec = {
  frame(op: number, wc: number, id: number, v?: unknown): Uint8Array;
  head(b: Uint8Array): { op: number; wc: number; id: number };
  body(b: Uint8Array): any;
};
const C: Codec = new Function(`${codecSrc}\nreturn phosCodec(false);`)();
const O: Record<string, number> = new Function(`${opsSrc}\nreturn phosOps;`)();

export type Bounds = { x: number; y: number; width: number; height: number };
export type Overlay = { height?: number; color?: string; symbolColor?: string };
export type MenuEntry = {
  id: string;
  label: string;
  type: string;
  enabled: boolean;
  visible: boolean;
  checked: boolean;
  accel: string;
  role: string;
  sub: string;
  items?: MenuEntry[];
};

export type WinState = {
  id: number;
  url: string;
  title: string;
  bounds: Bounds;
  visible: boolean;
  focused: boolean;
  minimized: boolean;
  maximized: boolean;
  fullscreen: boolean;
  zoom: number;
  frame: boolean;
  overlay: Overlay | null;
  parent: number;
  modal: boolean;
  bg: string;
  kind: string;
  resizable: boolean;
  min: { w: number; h: number } | null;
};

// what the desktop does with one of the app's windows
export interface ShellWin {
  // where the frame goes; sized to the app's content
  body: HTMLElement;
  title(t: string): void;
  bounds(b: Partial<Bounds>): void;
  show(focus: boolean): void;
  hide(): void;
  focus(): void;
  minimize(): void;
  maximize(on: boolean): void;
  restore(): void;
  fullscreen(on: boolean): void;
  frameless(on: boolean, overlay: Overlay | null): void;
  background(c: string): void;
  flash(): void;
  close(): void;
  // a drag from the app's own title bar: screen deltas as the pointer moves, then its end
  drag(dx: number, dy: number, at: { x: number; y: number }): void;
  dragEnd(): void;
  toggleMax(): void;
  // each new frame of the app's, for the desktop to mark as its own
  framed?(f: HTMLIFrameElement): void;
  // where the pointer last pressed in the app's page, in its own pixels
  pointer?(x: number, y: number): void;
}

export type WinEvents = {
  // the user asked to close it, the app decides
  close(): void;
  focus(on: boolean): void;
  bounds(b: Bounds): void;
  state(s: { minimized?: boolean; maximized?: boolean; fullscreen?: boolean; visible?: boolean }): void;
};

export interface Shell {
  window(s: WinState, ev: WinEvents): ShellWin;
  menu(w: ShellWin | null, items: MenuEntry[], at: { x?: number; y?: number }): Promise<string | null>;
  message(w: ShellWin | null, o: any): Promise<{ response: number; checkboxChecked: boolean }>;
  openDialog(w: ShellWin | null, o: any): Promise<{ canceled: boolean; filePaths: string[] }>;
  saveDialog(w: ShellWin | null, o: any): Promise<{ canceled: boolean; filePath: string }>;
  tell(kind: string, data: any): void;
  // the session's own word: opening, ended, errors
  status(s: { t: string; [k: string]: unknown }): void;
}

type Win = {
  s: WinState;
  shell: ShellWin;
  frame?: HTMLIFrameElement;
  port?: MessagePort;
  nonce: string;
  queue: ArrayBuffer[];
  zoom: number;
  appDrawn: boolean;
};

const rnd = () => {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return [...a].map((x) => x.toString(16).padStart(2, "0")).join("");
};

export class AppViewer {
  private ws?: WebSocket;
  private wins = new Map<number, Win>();
  private base = "";
  private schemes: string[] = ["file"];
  private outq: Uint8Array[] = [];
  private outN = 0;
  private flushing = false;
  private ended = false;
  id = "";
  name = "";

  constructor(
    private url: string,
    private shell: Shell,
    // the app's pages on an origin of their own (sandboxed, no cookies): off only for a
    // browser that refuses such frames
    private isolate = true,
  ) {
    addEventListener("message", this.onWindowMessage);
    this.connect();
  }

  private connect() {
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onmessage = (e) => {
      if (typeof e.data === "string") return this.control(JSON.parse(e.data));
      this.frames(new Uint8Array(e.data));
    };
    ws.onclose = () => {
      if (!this.ended) this.shell.status({ t: "lost" });
      this.end();
    };
  }

  private control(m: any) {
    if (m.t === "ready") {
      this.base = m.base;
      this.id = m.id;
    }
    if (m.t === "ended" || m.t === "taken") this.end();
    this.shell.status(m);
  }

  // every frame in one message, each length prefixed
  private frames(b: Uint8Array) {
    const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (let at = 0; at + 4 <= b.length; ) {
      const len = d.getUint32(at, true);
      const f = b.subarray(at + 4, at + 4 + len);
      at += 4 + len;
      try {
        this.frame(f);
      } catch (e) {
        console.error("[appweb]", e);
      }
    }
  }

  private frame(f: Uint8Array) {
    const h = C.head(f);
    const w = this.wins.get(h.wc);
    switch (h.op) {
      case O.ready: {
        const r = C.body(f);
        this.schemes = r.schemes ?? ["file"];
        this.name = r.name ?? "";
        for (const s of r.windows ?? []) {
          this.ensure(s);
          if (s.url) this.load(s.id, s.url);
        }
        return;
      }
      case O.win:
        return void this.ensure(C.body(f));
      case O.load: {
        const [url] = C.body(f);
        return this.load(h.wc, url);
      }
      case O.call: {
        if (!w) return;
        const [m, a] = C.body(f);
        return this.call(w, m, a ?? [], f);
      }
      case O.gone:
        if (!w) return;
        this.wins.delete(h.wc);
        w.shell.close();
        return;
      case O.ask:
        return void this.ask(w, h, C.body(f), f);
      case O.tell: {
        const [kind, data] = C.body(f);
        return this.shell.tell(kind, data);
      }
      default:
        // ipc, ports, replies: the frame's own
        if (w) this.toFrame(w, f);
    }
  }

  private ensure(s: WinState): Win {
    let w = this.wins.get(s.id);
    if (w) return w;
    const id = s.id;
    const shell = this.shell.window(s, {
      close: () => this.wev(id, "close"),
      focus: (on) => this.wev(id, "focus", on),
      bounds: (b) => this.wev(id, "bounds", b),
      state: (st) => this.wev(id, "state", st),
    });
    w = { s, shell, nonce: "", queue: [], zoom: s.zoom || 1, appDrawn: false };
    this.wins.set(id, w);
    if (!s.frame) shell.frameless(true, s.overlay);
    if (s.bg) shell.background(s.bg);
    if (s.visible) shell.show(s.focused);
    return w;
  }

  // the app's URL as the server's
  private mapUrl(u: string): string {
    const m = /^([a-z][a-z0-9+.-]*):(\/\/)?/i.exec(u);
    if (!m || !this.schemes.includes(m[1]!.toLowerCase())) return u;
    let rest = u.slice(m[0].length);
    if (!m[2]) rest = `/${rest}`;
    if (rest.startsWith("/")) rest = `_${rest}`;
    return `${this.base}${m[1]!.toLowerCase()}/${rest}`;
  }

  private load(wc: number, url: string) {
    const w = this.wins.get(wc);
    if (!w || !this.base) return;
    w.s.url = url;
    w.nonce = rnd();
    w.port?.close();
    w.port = undefined;
    w.queue = [];
    const mapped = this.mapUrl(url);
    // a page of its own making: shown as it is, with no bridge to the app
    if (/^(data|about|blob):/i.test(url)) {
      w.frame?.remove();
      const f = document.createElement("iframe");
      f.className = "aw-frame";
      f.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
      f.style.cssText = "position:absolute;inset:0;border:0;width:100%;height:100%;background:#fff";
      f.src = url;
      w.frame = f;
      w.shell.framed?.(f);
      w.shell.body.append(f);
      return;
    }
    if (/^https?:/i.test(url) && mapped === url) {
      // a website: the app's window can't hold it in a frame; it opens as itself
      this.shell.tell("open", url);
      return;
    }
    const u = new URL(mapped, location.href);
    u.searchParams.set("phos-w", String(wc));
    u.searchParams.set("phos-n", w.nonce);
    const old = w.frame;
    const f = document.createElement("iframe");
    f.className = "aw-frame";
    f.setAttribute(
      "sandbox",
      `allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock${this.isolate ? "" : " allow-same-origin"}`,
    );
    f.setAttribute("allow", "clipboard-read; clipboard-write; fullscreen; autoplay");
    f.style.cssText = "position:absolute;inset:0;border:0;width:100%;height:100%;background:transparent";
    f.src = u.href;
    w.frame = f;
    w.shell.framed?.(f);
    this.applyZoom(w);
    w.shell.body.append(f);
    old?.remove();
  }

  private applyZoom(w: Win) {
    const f = w.frame;
    if (!f) return;
    const z = w.zoom;
    if (z === 1) {
      f.style.width = "100%";
      f.style.height = "100%";
      f.style.transform = "";
      return;
    }
    f.style.width = `${100 / z}%`;
    f.style.height = `${100 / z}%`;
    f.style.transformOrigin = "0 0";
    f.style.transform = `scale(${z})`;
  }

  private call(w: Win, m: string, a: any[], f: Uint8Array) {
    const sh = w.shell;
    switch (m) {
      case "show":
        w.s.visible = true;
        return sh.show(true);
      case "showInactive":
        w.s.visible = true;
        return sh.show(false);
      case "hide":
        w.s.visible = false;
        return sh.hide();
      case "focus":
        sh.show(true);
        return sh.focus();
      case "blur":
        return;
      case "minimize":
        return sh.minimize();
      case "restore":
        return sh.restore();
      case "maximize":
        return sh.maximize(true);
      case "unmaximize":
        return sh.maximize(false);
      case "fullscreen":
        return sh.fullscreen(!!a[0]);
      case "title":
        w.s.title = String(a[0] ?? "");
        return sh.title(w.s.title);
      case "bounds":
        return sh.bounds(a[0] ?? {});
      case "center":
        return;
      case "overlay":
        w.s.overlay = { ...(w.s.overlay ?? {}), ...(a[0] ?? {}) };
        if (!w.s.frame || w.appDrawn) sh.frameless(true, w.s.overlay);
        return;
      case "bg":
        return sh.background(String(a[0] ?? ""));
      case "flash":
        return sh.flash();
      case "zoom":
        w.zoom = Number(a[0]) || 1;
        return this.applyZoom(w);
      case "devtools":
        return this.shell.tell("note", "developer tools: open the browser's own on this window's frame");
      default:
        // reload, css, edit: the page's own
        this.toFrame(w, f);
    }
  }

  private async ask(w: Win | undefined, h: { wc: number; id: number }, [kind, d]: [string, any], f: Uint8Array) {
    const reply = (v: unknown) => this.send(C.frame(O.reply!, h.wc, h.id, v));
    const sh = w?.shell ?? null;
    try {
      switch (kind) {
        case "exec":
          if (w) this.toFrame(w, f);
          else reply({ error: "no window" });
          return;
        case "menu":
          return reply({ result: { id: await this.shell.menu(sh, d.items ?? [], { x: d.x, y: d.y }) } });
        case "message":
          return reply({ result: await this.shell.message(sh, d) });
        case "open":
          return reply({ result: await this.shell.openDialog(sh, d) });
        case "save":
          return reply({ result: await this.shell.saveDialog(sh, d) });
        default:
          return reply({ error: `unknown ask ${kind}` });
      }
    } catch (e) {
      reply({ error: String(e) });
    }
  }

  private wev(wc: number, name: string, data?: unknown) {
    this.send(C.frame(O.wev!, wc, 0, [name, data]));
  }

  private toFrame(w: Win, f: Uint8Array) {
    const b = f.slice().buffer;
    if (w.port) w.port.postMessage(b, [b]);
    else if (w.queue.length < 10_000) w.queue.push(b);
  }

  // frames out, every one made in this turn in one message
  private send(f: Uint8Array) {
    this.outq.push(f);
    this.outN += 4 + f.length;
    if (this.flushing) return;
    this.flushing = true;
    queueMicrotask(() => {
      this.flushing = false;
      const b = new Uint8Array(this.outN);
      const d = new DataView(b.buffer);
      let at = 0;
      for (const x of this.outq) {
        d.setUint32(at, x.length, true);
        b.set(x, at + 4);
        at += 4 + x.length;
      }
      this.outq = [];
      this.outN = 0;
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(b);
    });
  }

  private onWindowMessage = (e: MessageEvent) => {
    const m = e.data;
    if (!m || typeof m !== "object" || !m.phosAppweb) return;
    let w: Win | undefined;
    for (const x of this.wins.values()) if (x.frame && x.frame.contentWindow === e.source) w = x;
    if (!w || m.nonce !== w.nonce) return;
    switch (m.phosAppweb) {
      case "hello": {
        const mc = new MessageChannel();
        w.port = mc.port1;
        const win = w;
        mc.port1.onmessage = (ev) => this.send(new Uint8Array(ev.data));
        w.frame!.contentWindow!.postMessage({ phosAppweb: "port", nonce: w.nonce }, "*", [mc.port2]);
        for (const b of win.queue.splice(0)) mc.port1.postMessage(b, [b]);
        return;
      }
      case "tell":
        if (m.kind === "zoom") {
          w.zoom = Number(m.data) || 1;
          this.applyZoom(w);
        } else if (m.kind === "pointer") {
          w.shell.pointer?.(Number(m.data?.x) * w.zoom || 0, Number(m.data?.y) * w.zoom || 0);
        } else if (m.kind === "chrome" && m.data?.drag) {
          w.appDrawn = true;
          w.shell.frameless(true, w.s.overlay);
        }
        return;
      case "drag":
        if (m.end) return w.shell.dragEnd();
        return w.shell.drag(Number(m.dx) || 0, Number(m.dy) || 0, { x: Number(m.x) || 0, y: Number(m.y) || 0 });
      case "dblbar":
        return w.shell.toggleMax();
    }
  };

  end() {
    if (this.ended) return;
    this.ended = true;
    removeEventListener("message", this.onWindowMessage);
    try {
      this.ws?.close();
    } catch {}
    for (const w of this.wins.values()) w.shell.close();
    this.wins.clear();
  }
}
