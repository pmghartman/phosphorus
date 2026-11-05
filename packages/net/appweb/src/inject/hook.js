// run inside the app's own main process, before its code: each window it opens becomes a page
// in the viewer's browser running the app's own renderer, its IPC, ports, protocols, dialogs and
// menus carried over one link to phosphorus; the native window kept hidden, never painted

function phosHook(require, cfg, phosCodec, ops) {
  const C = phosCodec(true);
  const electron = require("electron");
  const { app, ipcMain, BrowserWindow, webContents, MessageChannelMain, dialog, Menu, shell, clipboard } = electron;
  const net = require("net");
  const crypto = require("crypto");
  const fs = require("fs");
  const path = require("path");
  const url = require("url");
  const win32 = process.platform === "win32";

  const wins = new Map();
  const ports = new Map();
  let portSeq = 1;
  let askSeq = 1;
  const asks = new Map();
  let link = null;
  let lingerT = null;
  const schemes = new Set(["file"]);
  const fileRoots = new Set();
  let viewer = { w: 1920, h: 1080, dpr: 1, dark: false, x: 0, y: 0 };
  let focusedId = 0;
  let clipText = "";

  const log = (...a) => {
    try {
      process.stderr.write(`[phosphorus] ${a.join(" ")}\n`);
    } catch {}
  };

  // --- the link ---------------------------------------------------------------------

  const queue = [];
  let flushing = false;
  function out(b) {
    if (!link) return;
    queue.push(b);
    if (flushing) return;
    flushing = true;
    // every frame made in one turn written in one go
    setImmediate(() => {
      flushing = false;
      if (!link) return void (queue.length = 0);
      let n = 0;
      for (const f of queue) n += 4 + f.byteLength;
      const buf = Buffer.allocUnsafe(n);
      let at = 0;
      for (const f of queue) {
        buf.writeUInt32LE(f.byteLength, at);
        buf.set(f, at + 4);
        at += 4 + f.byteLength;
      }
      queue.length = 0;
      link.write(buf);
    });
  }
  const send = (op, wc, id, v) => out(C.frame(op, wc, id, v));

  const token = Buffer.from(cfg.token, "hex");
  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    let authed = false;
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (buf.length < 4 + len) break;
        const f = new Uint8Array(buf.buffer, buf.byteOffset + 4, len);
        buf = buf.subarray(4 + len);
        if (!authed) {
          const h = C.head(f);
          const b = h.op === ops.hello ? C.body(f) : null;
          const t = b && typeof b.token === "string" ? Buffer.from(b.token, "hex") : Buffer.alloc(0);
          if (t.length !== token.length || !crypto.timingSafeEqual(t, token)) return sock.destroy();
          authed = true;
          if (link && link !== sock) link.destroy();
          link = sock;
          clearTimeout(lingerT);
          hello(b);
          continue;
        }
        try {
          onFrame(f);
        } catch (e) {
          log("frame:", e && e.stack);
        }
      }
    });
    const gone = () => {
      if (link !== sock) return;
      link = null;
      queue.length = 0;
      clearTimeout(lingerT);
      // nobody back in time: the app quits as if its windows closed
      lingerT = setTimeout(() => {
        app.quit();
        setTimeout(() => app.exit(0), 10_000).unref();
      }, cfg.lingerMs || 120_000);
    };
    sock.on("close", gone);
    sock.on("error", gone);
  });

  // --- windows ------------------------------------------------------------------------

  const vOf = (wc) => (wc && !wc.isDestroyed?.() ? wins.get(wc.id) : undefined);
  const vOfWin = (w) => {
    try {
      return w && w.webContents ? wins.get(w.webContents.id) : undefined;
    } catch {
      return undefined;
    }
  };
  const vById = (id) => wins.get(id);

  function stateOf(v) {
    return {
      id: v.id,
      url: v.url,
      title: v.title,
      bounds: v.bounds,
      visible: v.visible,
      focused: v.focused,
      minimized: v.minimized,
      maximized: v.maximized,
      fullscreen: v.fullscreen,
      zoom: v.zoom,
      frame: v.frame,
      overlay: v.overlay,
      parent: v.parent,
      modal: v.modal,
      bg: v.bg,
      kind: v.kind,
      resizable: v.resizable,
      min: v.min,
      prefs: v.prefs,
    };
  }

  // the options a window and its contents were made with: Electron reads them natively, so a
  // getter on a key it reads that apps never set catches the object as it's read
  let capPrefs = null;
  let capWin = null;
  function trap(keys, put) {
    for (const k of keys) {
      if (k in Object.prototype) continue;
      Object.defineProperty(Object.prototype, k, {
        configurable: true,
        enumerable: false,
        get() {
          if (this && typeof this === "object" && this !== Object.prototype) put(this);
          return undefined;
        },
        set(x) {
          Object.defineProperty(this, k, { value: x, writable: true, enumerable: true, configurable: true });
        },
      });
    }
  }
  trap(
    ["navigateOnDragDrop", "disableHtmlFullscreenWindowResize", "enablePreferredSizeMode", "imageAnimationPolicy"],
    (o) => {
      capPrefs = o;
    },
  );
  trap(["__ELECTRON_NATIVE_WINDOW__", "enableLargerThanScreen", "backgroundMaterial"], (o) => {
    capWin = o;
  });

  function prefsOf(wc, p) {
    p = p || {};
    const preloads = [];
    try {
      const own = wc._getPreloadScript && wc._getPreloadScript();
      const f = own && (typeof own === "string" ? own : own.filePath);
      if (f) preloads.push(f);
      else if (p.preload) preloads.push(p.preload);
    } catch {}
    try {
      const ses = wc.session;
      const list = ses.getPreloadScripts
        ? ses
            .getPreloadScripts()
            .filter((s) => s.type === "frame" || s.type === "both")
            .map((s) => s.filePath)
        : ses.getPreloads();
      for (const f of list) if (!preloads.includes(f)) preloads.unshift(f);
    } catch {}
    const sources = [];
    for (const f of preloads) {
      try {
        sources.push({ path: f, text: fs.readFileSync(f, "utf8") });
      } catch (e) {
        log("preload unreadable:", f, e.message);
      }
    }
    return {
      preloads: sources,
      args: Array.isArray(p.additionalArguments) ? p.additionalArguments.map(String) : [],
      sandbox: p.sandbox !== false && !p.nodeIntegration,
      isolation: p.contextIsolation !== false,
      node: !!p.nodeIntegration,
      zoom: typeof p.zoomFactor === "number" ? p.zoomFactor : 1,
    };
  }

  function track(wc) {
    let kind = "";
    try {
      kind = wc.getType();
    } catch {}
    if (kind !== "window" && kind !== "browserView") return;
    const v = {
      id: wc.id,
      wc,
      win: null,
      kind,
      url: "",
      title: "",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: false,
      focused: false,
      minimized: false,
      maximized: false,
      fullscreen: false,
      zoom: 1,
      frame: true,
      overlay: null,
      parent: 0,
      modal: false,
      bg: "",
      resizable: true,
      min: null,
      loaded: false,
      loads: [],
      prefs: null,
      openHandler: null,
      css: new Map(),
      wp: capPrefs,
    };
    capPrefs = null;
    wins.set(wc.id, v);
    patchContents(v);
    wc.once("destroyed", () => {
      wins.delete(v.id);
      for (const l of v.loads) l[1](new Error("destroyed"));
      send(ops.gone, v.id, 0);
    });
  }

  function adopt(win) {
    const v = vOfWin(win);
    if (!v) return;
    v.win = win;
    const o = orig.win;
    try {
      v.bounds = o.getBounds.call(win);
      v.visible = o.isVisible.call(win);
      v.title = o.getTitle.call(win);
      v.resizable = o.isResizable.call(win);
      // a frame of its own: the native content smaller than the window; the page also
      // tells once it sees the app's own drag regions
      const c = o.getContentBounds.call(win);
      v.frame = c.height < v.bounds.height - 4 || c.width < v.bounds.width - 4;
      const m = o.getMinimumSize.call(win);
      if (m && (m[0] || m[1])) v.min = { w: m[0], h: m[1] };
    } catch {}
    try {
      const p = win.getParentWindow && o.getParentWindow.call(win);
      v.parent = p && p.webContents ? p.webContents.id : 0;
      v.modal = o.isModal ? o.isModal.call(win) : false;
    } catch {}
    v.prefs = prefsOf(v.wc, v.wp);
    v.zoom = v.prefs.zoom;
    const opts = capWin;
    capWin = null;
    if (opts) {
      // Electron shows a window at once unless told not to
      if (opts.show !== false) v.visible = true;
      if (opts.frame === false || /^hidden/.test(String(opts.titleBarStyle || ""))) v.frame = false;
      // the options decide: with no window manager (a private Xvfb) every window measures bare
      else v.frame = true;
      if (opts.titleBarOverlay)
        v.overlay = typeof opts.titleBarOverlay === "object" ? { ...opts.titleBarOverlay } : { height: 32 };
      if (opts.backgroundColor) v.bg = String(opts.backgroundColor);
      if (opts.minWidth || opts.minHeight) v.min = { w: opts.minWidth || 0, h: opts.minHeight || 0 };
    }
    // the native window never seen
    try {
      if (o.isVisible.call(win)) o.hide.call(win);
      o.setSkipTaskbar && o.setSkipTaskbar.call(win, true);
    } catch {}
    if (v.visible) v.focused = true;
    send(ops.win, v.id, 0, stateOf(v));
  }

  const orig = { win: {}, wc: {}, frame: {} };

  function patchProto(proto, store, names, make) {
    for (const name of names) {
      let p = proto;
      while (p && !Object.prototype.hasOwnProperty.call(p, name)) p = Object.getPrototypeOf(p);
      if (!p) continue;
      const fn = p[name];
      if (typeof fn !== "function") continue;
      store[name] = fn;
      p[name] = make(name, fn);
    }
  }

  const emitEv = (target, name, ...a) => {
    const ev = {
      sender: target,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    try {
      target.emit(name, ev, ...a);
    } catch (e) {
      log(name, "listener:", e && e.stack);
    }
    return ev;
  };

  const call = (v, method, ...args) => send(ops.call, v.id, 0, [method, args]);
  const clampB = (b, v) => ({
    x: Math.round(b.x ?? v.bounds.x),
    y: Math.round(b.y ?? v.bounds.y),
    width: Math.max(1, Math.round(b.width ?? v.bounds.width)),
    height: Math.max(1, Math.round(b.height ?? v.bounds.height)),
  });

  function setFocused(v, on) {
    if (v.focused === on) return;
    v.focused = on;
    if (on) {
      for (const o of wins.values())
        if (o !== v && o.focused) {
          o.focused = false;
          if (o.win) emitEv(o.win, "blur");
        }
      focusedId = v.id;
    } else if (focusedId === v.id) focusedId = 0;
    if (v.win) {
      emitEv(v.win, on ? "focus" : "blur");
      if (on) emitEv(app, "browser-window-focus", v.win);
      else emitEv(app, "browser-window-blur", v.win);
    }
    emitEv(v.wc, on ? "focus" : "blur");
  }

  function patchWindows() {
    const winMethods = {
      show(v) {
        v.visible = true;
        v.minimized = false;
        call(v, "show");
        emitEv(v.win, "show");
        setFocused(v, true);
      },
      showInactive(v) {
        v.visible = true;
        call(v, "showInactive");
        emitEv(v.win, "show");
      },
      hide(v) {
        v.visible = false;
        call(v, "hide");
        emitEv(v.win, "hide");
      },
      isVisible: (v) => v.visible,
      focus(v) {
        v.visible = true;
        v.minimized = false;
        call(v, "focus");
        setFocused(v, true);
      },
      blur(v) {
        call(v, "blur");
        setFocused(v, false);
      },
      isFocused: (v) => v.focused,
      moveTop(v) {
        call(v, "focus");
      },
      minimize(v) {
        v.minimized = true;
        call(v, "minimize");
        emitEv(v.win, "minimize");
      },
      restore(v) {
        v.minimized = false;
        v.visible = true;
        call(v, "restore");
        emitEv(v.win, "restore");
      },
      isMinimized: (v) => v.minimized,
      maximize(v) {
        v.maximized = true;
        v.visible = true;
        call(v, "maximize");
        emitEv(v.win, "maximize");
      },
      unmaximize(v) {
        v.maximized = false;
        call(v, "unmaximize");
        emitEv(v.win, "unmaximize");
      },
      isMaximized: (v) => v.maximized,
      isNormal: (v) => !v.maximized && !v.minimized && !v.fullscreen,
      setFullScreen(v, on) {
        v.fullscreen = !!on;
        call(v, "fullscreen", !!on);
        emitEv(v.win, on ? "enter-full-screen" : "leave-full-screen");
      },
      isFullScreen: (v) => v.fullscreen,
      setSimpleFullScreen(v, on) {
        winMethods.setFullScreen(v, on);
      },
      isSimpleFullScreen: (v) => v.fullscreen,
      setTitle(v, t) {
        v.title = String(t);
        call(v, "title", v.title);
      },
      getTitle: (v) => v.title,
      setBounds(v, b) {
        v.bounds = clampB(b, v);
        call(v, "bounds", v.bounds);
      },
      getBounds: (v) => ({ ...v.bounds }),
      getNormalBounds: (v) => ({ ...v.bounds }),
      getContentBounds: (v) => ({ ...v.bounds }),
      setContentBounds(v, b) {
        winMethods.setBounds(v, b);
      },
      getSize: (v) => [v.bounds.width, v.bounds.height],
      setSize(v, w, h) {
        winMethods.setBounds(v, { width: w, height: h });
      },
      getContentSize: (v) => [v.bounds.width, v.bounds.height],
      setContentSize(v, w, h) {
        winMethods.setBounds(v, { width: w, height: h });
      },
      getPosition: (v) => [v.bounds.x, v.bounds.y],
      setPosition(v, x, y) {
        winMethods.setBounds(v, { x, y });
      },
      center(v) {
        call(v, "center");
      },
      setMinimumSize(v, w, h) {
        v.min = { w, h };
        call(v, "min", v.min);
      },
      setResizable(v, on) {
        v.resizable = !!on;
        call(v, "resizable", !!on);
      },
      isResizable: (v) => v.resizable,
      setAlwaysOnTop(v, on) {
        call(v, "top", !!on);
      },
      setBackgroundColor(v, c) {
        v.bg = String(c);
        call(v, "bg", v.bg);
      },
      setTitleBarOverlay(v, o) {
        v.overlay = { ...(v.overlay || {}), ...(o || {}) };
        call(v, "overlay", v.overlay);
      },
      flashFrame(v, on) {
        if (on) call(v, "flash");
      },
      setProgressBar() {},
      setOverlayIcon() {},
      setThumbarButtons: () => true,
      setIcon() {},
      setSkipTaskbar() {},
      setHasShadow() {},
      setOpacity() {},
      setVibrancy() {},
      setBackgroundMaterial() {},
      setRepresentedFilename() {},
      setDocumentEdited(v, on) {
        call(v, "edited", !!on);
      },
    };
    const names = Object.keys(winMethods);
    patchProto(
      BrowserWindow.prototype,
      orig.win,
      names,
      (name, fn) =>
        function (...a) {
          const v = vOfWin(this);
          if (!v || !v.win) return fn.apply(this, a);
          return winMethods[name](v, ...a);
        },
    );
    // what adopt reads, kept as Electron has them
    patchProto(
      BrowserWindow.prototype,
      orig.win,
      ["getParentWindow", "isModal", "close", "destroy", "getMinimumSize"],
      (_n, fn) => fn,
    );
    const gf = BrowserWindow.getFocusedWindow;
    BrowserWindow.getFocusedWindow = function () {
      const v = focusedId && vById(focusedId);
      if (v && v.win && !v.win.isDestroyed()) return v.win;
      return link ? null : gf.call(this);
    };
    const gfw = webContents.getFocusedWebContents;
    if (gfw)
      webContents.getFocusedWebContents = function () {
        const v = focusedId && vById(focusedId);
        return v ? v.wc : gfw.call(this);
      };
  }

  // --- a window's contents ------------------------------------------------------------

  function patchContents(v) {
    const wc = v.wc;
    const keep = (name) => {
      const fn = wc[name];
      return typeof fn === "function" ? fn.bind(wc) : () => {};
    };
    const o = {
      loadURL: keep("loadURL"),
      setWindowOpenHandler: keep("setWindowOpenHandler"),
    };
    v.o = o;
    wc.loadURL = (u, _opts) => {
      v.url = String(u);
      v.loaded = false;
      if (v.url.startsWith("file:")) {
        try {
          fileRoots.add(path.dirname(url.fileURLToPath(v.url)));
        } catch {}
      }
      if (!v.prefs) v.prefs = prefsOf(wc, v.wp);
      send(ops.load, v.id, 0, [v.url, v.prefs]);
      emitEv(wc, "did-start-loading");
      return new Promise((ok, no) => v.loads.push([ok, no]));
    };
    wc.loadFile = (f, opts) => {
      const u = url.pathToFileURL(path.resolve(String(f)));
      if (opts && opts.query) u.search = new URLSearchParams(opts.query).toString();
      if (opts && opts.search) u.search = opts.search;
      if (opts && opts.hash) u.hash = opts.hash;
      return wc.loadURL(u.toString());
    };
    wc.reload = () => call(v, "reload");
    wc.reloadIgnoringCache = () => call(v, "reload");
    wc.getURL = () => v.url;
    wc.getTitle = () => v.title;
    wc.isLoading = () => !v.loaded && !!v.url;
    wc.isLoadingMainFrame = () => !v.loaded && !!v.url;
    wc.isWaitingForResponse = () => false;
    wc.send = (ch, ...args) => msg(v, ch, args, []);
    wc.sendToFrame = (_f, ch, ...args) => msg(v, ch, args, []);
    wc.postMessage = (ch, message, transfer) => msg(v, ch, [message], transfer || []);
    wc.executeJavaScript = (code) => ask(v, "exec", { code: String(code) });
    wc.executeJavaScriptInIsolatedWorld = (_w, scripts) =>
      ask(v, "exec", { code: (scripts || []).map((s) => s.code).join(";\n") });
    wc.insertCSS = (css) => {
      const key = `css${++askSeq}`;
      call(v, "css", key, String(css));
      return Promise.resolve(key);
    };
    wc.removeInsertedCSS = (key) => {
      call(v, "css", key, null);
      return Promise.resolve();
    };
    wc.setZoomFactor = (f) => {
      v.zoom = Number(f) || 1;
      call(v, "zoom", v.zoom);
    };
    wc.getZoomFactor = () => v.zoom;
    wc.setZoomLevel = (l) => wc.setZoomFactor(1.2 ** (Number(l) || 0));
    wc.getZoomLevel = () => Math.log(v.zoom) / Math.log(1.2);
    wc.focus = () => {
      call(v, "focus");
      setFocused(v, true);
    };
    wc.isFocused = () => v.focused;
    wc.openDevTools = () => call(v, "devtools");
    wc.closeDevTools = () => {};
    wc.isDevToolsOpened = () => false;
    wc.toggleDevTools = () => call(v, "devtools");
    wc.capturePage = () => Promise.resolve(electron.nativeImage.createEmpty());
    wc.setWindowOpenHandler = (h) => {
      v.openHandler = h;
      return o.setWindowOpenHandler(h);
    };
    for (const cmd of ["undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "delete", "selectAll", "unselect"])
      wc[cmd] = () => call(v, "edit", cmd);
    wc.print = (_o, cb) => {
      call(v, "print");
      if (cb) cb(true, "");
    };
  }

  // --- ipc ----------------------------------------------------------------------------

  function portOut(v, p) {
    const id = portSeq++;
    ports.set(id, p);
    p.on("message", (e) => send(ops.port, v.id, id, e.data));
    p.on("close", () => {
      if (ports.delete(id)) send(ops.portClose, v.id, id);
    });
    p.start();
    return id;
  }

  function msg(v, ch, args, transfer) {
    const ids = [];
    for (const p of transfer || []) ids.push(portOut(v, p));
    send(ops.msg, v.id, 0, [String(ch), args, ids]);
  }

  function frameOf(v) {
    let mf = null;
    try {
      mf = v.wc.mainFrame;
    } catch {}
    const u = v.url;
    let origin = "null";
    try {
      origin = new URL(u).origin;
    } catch {}
    const fake = { url: u, origin, parent: null, top: null, frames: [], framesInSubtree: [], name: "", routingId: 1 };
    if (!mf) return fake;
    return new Proxy(mf, {
      get(t, k) {
        if (k === "url") return u;
        if (k === "origin") return origin;
        if (k === "parent") return null;
        if (k === "top") return t;
        if (k === "send") return (ch, ...a) => msg(v, ch, a, []);
        if (k === "postMessage") return (ch, m, tr) => msg(v, ch, [m], tr || []);
        const x = Reflect.get(t, k, t);
        return typeof x === "function" ? x.bind(t) : x;
      },
    });
  }

  function evOf(v, extra) {
    const wc = v.wc;
    let pid = 0;
    try {
      pid = wc.getProcessId();
    } catch {}
    const frame = frameOf(v);
    const ev = {
      type: "frame",
      sender: wc,
      senderFrame: frame,
      frameId: frame.routingId || 1,
      processId: pid,
      ports: [],
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      reply: (ch, ...a) => msg(v, ch, a, []),
    };
    return Object.assign(ev, extra);
  }

  function emitters(v) {
    const out = [];
    try {
      const f = v.wc.mainFrame;
      if (f && f.ipc) out.push(f.ipc);
    } catch {}
    if (v.wc.ipc) out.push(v.wc.ipc);
    out.push(ipcMain);
    return out;
  }

  function dispatch(v, ch, args, ev) {
    try {
      v.wc.emit("ipc-message", ev, ch, ...args);
    } catch (e) {
      log("ipc-message:", e && e.stack);
    }
    for (const t of emitters(v)) {
      try {
        t.emit(ch, ev, ...args);
      } catch (e) {
        log(`ipc ${ch}:`, e && e.stack);
      }
    }
  }

  async function invoke(v, ch, args) {
    const ev = evOf(v);
    const t = emitters(v).find((e) => e && e._invokeHandlers && e._invokeHandlers.has(ch));
    if (!t) throw new Error(`No handler registered for '${ch}'`);
    return await t._invokeHandlers.get(ch)(ev, ...args);
  }

  function sync(v, ch, args) {
    let value;
    let set = false;
    const ev = evOf(v);
    Object.defineProperty(ev, "returnValue", {
      set(x) {
        value = x;
        set = true;
      },
      get: () => value,
    });
    try {
      v.wc.emit("ipc-message-sync", ev, ch, ...args);
    } catch {}
    for (const t of emitters(v)) {
      try {
        t.emit(ch, ev, ...args);
      } catch (e) {
        log(`ipc sync ${ch}:`, e && e.stack);
      }
    }
    return set ? value : undefined;
  }

  // --- what the page sends --------------------------------------------------------------

  function onFrame(f) {
    const h = C.head(f);
    switch (h.op) {
      case ops.hello:
        return hello(C.body(f));
      case ops.send: {
        const v = vById(h.wc);
        if (!v) return;
        const [ch, args] = C.body(f);
        return dispatch(v, ch, args || [], evOf(v));
      }
      case ops.invoke: {
        const v = vById(h.wc);
        const [ch, args] = C.body(f);
        if (!v) return send(ops.reply, h.wc, h.id, { error: "the window is gone" });
        invoke(v, ch, args || []).then(
          (r) => {
            try {
              send(ops.reply, h.wc, h.id, { result: r });
            } catch (e) {
              send(ops.reply, h.wc, h.id, { error: `Error invoking remote method '${ch}': ${e}` });
            }
          },
          (e) => {
            log(`Error occurred in handler for '${ch}':`, e && e.stack);
            send(ops.reply, h.wc, h.id, { error: `Error invoking remote method '${ch}': ${e}` });
          },
        );
        return;
      }
      case ops.sync: {
        const v = vById(h.wc);
        const [ch, args] = C.body(f);
        let r;
        try {
          r = v ? sync(v, ch, args || []) : undefined;
        } catch {}
        return send(ops.reply, h.wc, h.id, { result: r });
      }
      case ops.post: {
        const v = vById(h.wc);
        if (!v) return;
        const [ch, message, ids] = C.body(f);
        const evPorts = [];
        for (const id of ids || []) {
          const mc = new MessageChannelMain();
          ports.set(id, mc.port1);
          mc.port1.on("message", (e) => send(ops.port, v.id, id, e.data));
          mc.port1.on("close", () => {
            if (ports.delete(id)) send(ops.portClose, v.id, id);
          });
          mc.port1.start();
          evPorts.push(mc.port2);
        }
        return dispatch(v, ch, [message], evOf(v, { ports: evPorts }));
      }
      case ops.port: {
        const p = ports.get(h.id);
        if (p) p.postMessage(C.body(f));
        return;
      }
      case ops.portClose: {
        const p = ports.get(h.id);
        ports.delete(h.id);
        if (p) p.close();
        return;
      }
      case ops.wev: {
        const v = vById(h.wc);
        if (!v) return;
        const [name, data] = C.body(f);
        return pageEvent(v, name, data);
      }
      case ops.fetch: {
        const [u, method, headers] = C.body(f);
        return void resource(h.id, h.wc, u, method, headers);
      }
      case ops.reply: {
        const a = asks.get(h.id);
        if (!a) return;
        asks.delete(h.id);
        const b = C.body(f) || {};
        if (b.error !== undefined) a[1](new Error(String(b.error)));
        else a[0](b.result);
        return;
      }
    }
  }

  function ask(v, kind, data) {
    const id = askSeq++;
    return new Promise((ok, no) => {
      asks.set(id, [ok, no]);
      if (!link) {
        asks.delete(id);
        return no(new Error("no viewer"));
      }
      send(ops.ask, v ? v.id : 0, id, [kind, data]);
    });
  }
  const tell = (v, kind, data) => send(ops.tell, v ? v.id : 0, 0, [kind, data]);

  function hello(b) {
    if (b && b.viewer) viewer = { ...viewer, ...b.viewer };
    themeTold();
    const list = [];
    for (const v of wins.values()) if (v.win || v.kind === "window") list.push(stateOf(v));
    send(ops.ready, 0, 0, {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
      execPath: process.execPath,
      pid: process.pid,
      env: { ...process.env },
      versions: { ...process.versions },
      schemes: [...schemes],
      sep: path.sep,
      windows: list,
    });
  }

  function pageEvent(v, name, d) {
    switch (name) {
      case "loading":
        v.loaded = false;
        emitEv(v.wc, "did-start-loading");
        return;
      case "dom-ready":
        emitEv(v.wc, "dom-ready");
        return;
      case "loaded": {
        const first = !v.everLoaded;
        v.loaded = true;
        v.everLoaded = true;
        const loads = v.loads.splice(0);
        for (const l of loads) l[0]();
        emitEv(v.wc, "did-navigate", v.url, 200, "OK");
        emitEv(v.wc, "did-frame-finish-load", true, 1, 1);
        emitEv(v.wc, "did-finish-load");
        emitEv(v.wc, "did-stop-loading");
        if (first && v.win) emitEv(v.win, "ready-to-show");
        return;
      }
      case "failed": {
        const loads = v.loads.splice(0);
        for (const l of loads) l[1](new Error(`ERR_FAILED (-2) loading '${v.url}'`));
        emitEv(v.wc, "did-fail-load", -2, String(d || "failed"), v.url, true, 1, 1);
        return;
      }
      case "title": {
        v.title = String(d);
        const ev = emitEv(v.wc, "page-title-updated", v.title, true);
        if (v.win) {
          const ev2 = emitEv(v.win, "page-title-updated", v.title, true);
          if (!ev.defaultPrevented && !ev2.defaultPrevented) call(v, "title", v.title);
        }
        return;
      }
      case "focus":
        return setFocused(v, !!d);
      case "bounds": {
        const nb = clampB(d || {}, v);
        const moved = nb.x !== v.bounds.x || nb.y !== v.bounds.y;
        const sized = nb.width !== v.bounds.width || nb.height !== v.bounds.height;
        v.bounds = nb;
        if (v.win && sized) {
          emitEv(v.win, "resize");
          emitEv(v.win, "resized");
        }
        if (v.win && moved) {
          emitEv(v.win, "move");
          emitEv(v.win, "moved");
        }
        return;
      }
      case "state": {
        const s = d || {};
        const was = { min: v.minimized, max: v.maximized, full: v.fullscreen, vis: v.visible };
        if ("minimized" in s) v.minimized = !!s.minimized;
        if ("maximized" in s) v.maximized = !!s.maximized;
        if ("fullscreen" in s) v.fullscreen = !!s.fullscreen;
        if ("visible" in s) v.visible = !!s.visible;
        if (!v.win) return;
        if (was.min !== v.minimized) emitEv(v.win, v.minimized ? "minimize" : "restore");
        if (was.max !== v.maximized) emitEv(v.win, v.maximized ? "maximize" : "unmaximize");
        if (was.full !== v.fullscreen) emitEv(v.win, v.fullscreen ? "enter-full-screen" : "leave-full-screen");
        if (was.vis !== v.visible) emitEv(v.win, v.visible ? "show" : "hide");
        return;
      }
      case "close":
        // as the native close button: the app may keep it open to ask first
        if (v.win && !v.win.isDestroyed()) orig.win.close.call(v.win);
        return;
      case "clip":
        clipText = String(d || "");
        try {
          orig.clip.writeText(clipText);
        } catch {}
        return;
      case "open":
        return windowOpen(v, d || {});
      case "unload":
        emitEv(v.wc, "did-start-navigation", v.url, false, true, 1, 1);
        return;
    }
  }

  // the page asked for window.open: the app's handler decides, as Electron's would
  function windowOpen(v, d) {
    const details = {
      url: String(d.url || "about:blank"),
      frameName: String(d.name || ""),
      features: String(d.features || ""),
      disposition: d.disposition || "new-window",
      referrer: { url: v.url, policy: "strict-origin-when-cross-origin" },
      postBody: undefined,
    };
    let r = { action: "allow" };
    if (v.openHandler) {
      try {
        r = v.openHandler(details) || { action: "deny" };
      } catch (e) {
        log("window open handler:", e && e.stack);
        r = { action: "deny" };
      }
    }
    if (r.action !== "allow") return;
    if (/^https?:/i.test(details.url) && !r.overrideBrowserWindowOptions) return tell(v, "open", details.url);
    const w = new BrowserWindow({ show: true, ...(r.overrideBrowserWindowOptions || {}) });
    w.loadURL(details.url);
    emitEv(v.wc, "did-create-window", w, details);
  }

  // --- resources --------------------------------------------------------------------------

  const types = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".cjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".map": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".wasm": "application/wasm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".txt": "text/plain; charset=utf-8",
  };
  const typeOf = (p) => types[path.extname(p).toLowerCase()] || "application/octet-stream";

  const norm = (p) => (win32 ? path.resolve(p).toLowerCase() : path.resolve(p));
  function fileOK(p) {
    const n = norm(p);
    const roots = [app.getAppPath(), process.resourcesPath, ...fileRoots];
    return roots.some((r) => {
      if (!r) return false;
      const nr = norm(r);
      return n === nr || n.startsWith(nr + path.sep);
    });
  }

  const chunk = 256 << 10;
  const etagOf = (st) => `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  async function diskOf(u) {
    try {
      let p = decodeURIComponent(new URL(u).pathname);
      if (win32) p = p.replace(/^\/([a-z]:)/i, "$1");
      const st = await fs.promises.stat(p);
      return st.isFile() ? st : null;
    } catch {
      return null;
    }
  }
  async function resource(id, wcId, u, method, headers) {
    let headed = false;
    const head = (status, hs) => {
      headed = true;
      send(ops.resHead, 0, id, [status, hs || {}]);
    };
    const end = () => send(ops.resEnd, 0, id, null);
    const bytes = (b) => {
      for (let at = 0; at < b.byteLength; at += chunk) out(C.raw(ops.resBody, 0, id, b.subarray(at, at + chunk)));
    };
    const pump = async (body) => {
      if (!body) return;
      if (typeof body.getReader === "function") {
        const rd = body.getReader();
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          bytes(value);
        }
        return;
      }
      for await (const b of body) bytes(typeof b === "string" ? Buffer.from(b) : b);
    };
    const file = async (p, status, hs) => {
      let st = await fs.promises.stat(p).catch(() => null);
      if (st && st.isDirectory()) {
        p = path.join(p, "index.html");
        st = await fs.promises.stat(p).catch(() => null);
      }
      if (!st || !st.isFile()) return (head(404), end());
      const tag = etagOf(st);
      if (headers && headers["if-none-match"] === tag) return (head(304, { etag: tag }), end());
      head(status || 200, { "content-type": typeOf(p), "content-length": String(st.size), etag: tag, ...(hs || {}) });
      await pump(fs.createReadStream(p, { highWaterMark: chunk }));
      end();
    };
    try {
      const scheme = u.slice(0, u.indexOf(":")).toLowerCase();
      const v = vById(wcId);
      const ses = (v && v.wc.session) || electron.session.defaultSession;
      const h = handlerOf(ses, scheme);
      if (!h && scheme === "file") {
        const p = url.fileURLToPath(u.replace(/[?#].*$/, ""));
        if (!fileOK(p)) return (head(403), end());
        return await file(p);
      }
      // a path on disk behind it: its tag, and no body when the browser has it
      const disk = await diskOf(u);
      const tag = disk ? etagOf(disk) : "";
      if (tag && headers && headers["if-none-match"] === tag) return (head(304, { etag: tag }), end());
      const withTag = (hs) => (tag ? { ...hs, etag: tag } : hs);
      if (h && h.kind === "handle") {
        const r = await h.fn(new Request(u, { method: method || "GET", headers: headers || {} }));
        const hs = {};
        if (r && r.headers) r.headers.forEach((val, k) => (hs[k] = val));
        if (!hs["content-type"]) hs["content-type"] = typeOf(new URL(u).pathname);
        head((r && r.status) || 200, r && r.status === 200 ? withTag(hs) : hs);
        await pump(r && r.body);
        return end();
      }
      if (h) {
        const req = { url: u, method: method || "GET", referrer: "", headers: headers || {}, uploadData: [] };
        const res = await new Promise((ok) => {
          try {
            h.fn(req, ok);
          } catch (e) {
            ok({ error: -2, why: e && e.message });
          }
        });
        const o = res && typeof res === "object" && !Buffer.isBuffer(res) && !res.pipe ? res : { data: res, path: res };
        if (o.error) return (head(o.error === -6 ? 404 : 502), end());
        const hs = { ...(o.headers || {}) };
        const mime = o.mimeType ? `${o.mimeType}${o.charset ? `; charset=${o.charset}` : ""}` : "";
        switch (h.kind) {
          case "file":
            return await file(
              typeof res === "string" ? res : o.path,
              o.statusCode,
              mime ? { ...hs, "content-type": mime } : hs,
            );
          case "buffer":
          case "string": {
            const d = typeof o.data === "string" ? Buffer.from(o.data, o.charset || "utf8") : o.data || Buffer.alloc(0);
            head(o.statusCode || 200, withTag({ "content-type": mime || typeOf(new URL(u).pathname), ...hs }));
            bytes(d);
            return end();
          }
          case "stream": {
            head(o.statusCode || 200, withTag({ "content-type": mime || typeOf(new URL(u).pathname), ...hs }));
            await pump(o.data && o.data.pipe ? o.data : res);
            return end();
          }
          case "http": {
            const r = await electron.net.fetch(o.url, { method: o.method || "GET" });
            const rh = {};
            r.headers.forEach((val, k) => (rh[k] = val));
            head(r.status, rh);
            await pump(r.body);
            return end();
          }
        }
      }
      const doFetch = ses.fetch ? ses.fetch.bind(ses) : electron.net.fetch;
      const r = await doFetch(u, { method: method || "GET", headers: headers || {} });
      const hs = {};
      r.headers.forEach((val, k) => (hs[k] = val));
      if (!hs["content-type"]) hs["content-type"] = typeOf(new URL(u).pathname);
      head(r.status, r.status === 200 ? withTag(hs) : hs);
      await pump(r.body);
      end();
    } catch (e) {
      log("resource", u, e && e.message);
      if (!headed) head(502);
      end();
    }
  }

  // --- dialogs, menus, the shell, the clipboard, the screen, the theme ------------------------

  const winArg = (a) => (a[0] && typeof a[0] === "object" && a[0].webContents ? [a[0], a[1]] : [null, a[0]]);
  const vOfDialog = (w) => vOfWin(w) || (focusedId && vById(focusedId)) || null;

  function patchDialogs() {
    orig.dialog = {};
    const asyncOne = (name, kind, cancel) => {
      orig.dialog[name] = dialog[name];
      dialog[name] = (...a) => {
        const [w, opts] = winArg(a);
        const v = vOfDialog(w);
        if (!link) return orig.dialog[name].apply(dialog, a);
        return ask(v, kind, { ...(opts || {}), icon: undefined }).catch(() => cancel(opts || {}));
      };
    };
    asyncOne("showMessageBox", "message", (o) => ({ response: o.cancelId ?? 0, checkboxChecked: false }));
    asyncOne("showOpenDialog", "open", () => ({ canceled: true, filePaths: [] }));
    asyncOne("showSaveDialog", "save", () => ({ canceled: true, filePath: "" }));
    // a sync dialog can't wait on the network: its safe answer
    const syncOne = (name, answer) => {
      orig.dialog[name] = dialog[name];
      dialog[name] = (...a) => {
        if (!link) return orig.dialog[name].apply(dialog, a);
        const [w, opts] = winArg(a);
        tell(vOfDialog(w), "dialog", { ...(opts || {}), icon: undefined });
        return answer(opts || {});
      };
    };
    syncOne("showMessageBoxSync", (o) => o.cancelId ?? (Array.isArray(o.buttons) ? o.buttons.length - 1 : 0));
    syncOne("showOpenDialogSync", () => undefined);
    syncOne("showSaveDialogSync", () => undefined);
    orig.dialog.showErrorBox = dialog.showErrorBox;
    dialog.showErrorBox = (title, content) => {
      if (!link) return orig.dialog.showErrorBox.call(dialog, title, content);
      tell(null, "error", { title: String(title), content: String(content) });
    };
  }

  function menuOf(m, ids, prefix) {
    const out = [];
    m.items.forEach((it, i) => {
      const key = prefix ? `${prefix}.${i}` : String(i);
      ids.set(key, it);
      const x = {
        id: key,
        label: it.label || "",
        type: it.type,
        enabled: it.enabled !== false,
        visible: it.visible !== false,
        checked: !!it.checked,
        accel: it.accelerator ? String(it.accelerator) : "",
        role: it.role || "",
        sub: it.sublabel || "",
      };
      if (it.submenu) x.items = menuOf(it.submenu, ids, key);
      out.push(x);
    });
    return out;
  }

  function patchMenus() {
    const pop = Menu.prototype.popup;
    orig.popup = pop;
    Menu.prototype.popup = function (opts) {
      const o = opts || {};
      const w = o.window || BrowserWindow.getFocusedWindow();
      const v = vOfWin(w) || (focusedId && vById(focusedId));
      if (!link || !v) return pop.call(this, opts);
      const ids = new Map();
      const items = menuOf(this, ids, "");
      try {
        this.emit("menu-will-show", {});
      } catch {}
      ask(v, "menu", { items, x: o.x, y: o.y })
        .then((r) => {
          const it = r && r.id ? ids.get(String(r.id)) : null;
          if (it && it.enabled !== false) {
            if (it.type === "checkbox") it.checked = !it.checked;
            if (it.type === "radio") it.checked = true;
            if (typeof it.click === "function") it.click({}, v.win || undefined, v.wc);
          }
        })
        .catch(() => {})
        .finally(() => {
          try {
            this.emit("menu-will-close", {});
          } catch {}
          if (typeof o.callback === "function") o.callback();
        });
    };
    const cp = Menu.prototype.closePopup;
    Menu.prototype.closePopup = function (w) {
      if (!link) return cp.call(this, w);
    };
  }

  function patchShell() {
    const oe = shell.openExternal;
    shell.openExternal = (u, o) => {
      if (!link) return oe.call(shell, u, o);
      tell(focusedId && vById(focusedId), "open", String(u));
      return Promise.resolve();
    };
    const op = shell.openPath;
    shell.openPath = (p) => {
      if (!link) return op.call(shell, p);
      tell(focusedId && vById(focusedId), "path", String(p));
      return Promise.resolve("");
    };
    const sf = shell.showItemInFolder;
    shell.showItemInFolder = (p) => {
      if (!link) return sf.call(shell, p);
      tell(focusedId && vById(focusedId), "reveal", String(p));
    };
    shell.beep = () => {};
  }

  function patchClipboard() {
    orig.clip = { writeText: clipboard.writeText.bind(clipboard) };
    clipboard.writeText = (t, type) => {
      clipText = String(t);
      try {
        orig.clip.writeText(clipText, type);
      } catch {}
      if (link) tell(focusedId && vById(focusedId), "clip", clipText);
    };
    const rt = clipboard.readText.bind(clipboard);
    clipboard.readText = (type) => {
      try {
        const t = rt(type);
        if (t) return t;
      } catch {}
      return clipText;
    };
  }

  function patchNotifications() {
    const N = electron.Notification;
    if (!N || !N.prototype) return;
    const show = N.prototype.show;
    N.prototype.show = function () {
      if (!link) return show.call(this);
      tell(focusedId && vById(focusedId), "notify", { title: this.title || "", body: this.body || "" });
      try {
        this.emit("show", {});
      } catch {}
    };
  }

  function display() {
    const w = Math.round(viewer.w);
    const h = Math.round(viewer.h);
    return {
      id: 1,
      label: "phosphorus",
      bounds: { x: 0, y: 0, width: w, height: h },
      workArea: { x: 0, y: 0, width: w, height: h },
      size: { width: w, height: h },
      workAreaSize: { width: w, height: h },
      scaleFactor: viewer.dpr || 1,
      rotation: 0,
      internal: false,
      touchSupport: "unknown",
      monochrome: false,
      accelerometerSupport: "unknown",
      colorDepth: 24,
      colorSpace: "",
      depthPerComponent: 8,
      displayFrequency: 60,
      detected: true,
    };
  }

  function patchScreen() {
    let s;
    try {
      s = electron.screen;
    } catch {
      return;
    }
    const keep = {};
    for (const k of ["getPrimaryDisplay", "getAllDisplays", "getDisplayNearestPoint", "getDisplayMatching"]) {
      keep[k] = s[k] && s[k].bind(s);
    }
    s.getPrimaryDisplay = () => (link ? display() : keep.getPrimaryDisplay());
    s.getAllDisplays = () => (link ? [display()] : keep.getAllDisplays());
    s.getDisplayNearestPoint = (p) => (link ? display() : keep.getDisplayNearestPoint(p));
    s.getDisplayMatching = (r) => (link ? display() : keep.getDisplayMatching(r));
  }

  let themeHooked = false;
  function themeTold() {
    const nt = electron.nativeTheme;
    if (!nt) return;
    if (!themeHooked) {
      themeHooked = true;
      try {
        Object.defineProperty(nt, "shouldUseDarkColors", {
          configurable: true,
          get: () => (nt.themeSource === "dark" ? true : nt.themeSource === "light" ? false : !!viewer.dark),
        });
      } catch {}
    }
    try {
      nt.emit("updated");
    } catch {}
  }

  // each session's protocol handlers, as the app registered them, called as Chromium would
  const handlers = new WeakMap();
  function handlerOf(ses, scheme) {
    const own = handlers.get(ses.protocol);
    const def = handlers.get(electron.session.defaultSession.protocol);
    return (own && own.get(scheme)) || (def && def.get(scheme)) || null;
  }
  function patchProtocols() {
    const p = electron.protocol;
    const reg = p.registerSchemesAsPrivileged;
    p.registerSchemesAsPrivileged = (list) => {
      for (const s of list || []) if (s && s.scheme) schemes.add(String(s.scheme));
      return reg.call(p, list);
    };
  }
  // every session's protocol shares one prototype, reachable once the app is ready
  function patchHandlers() {
    const proto = Object.getPrototypeOf(electron.session.defaultSession.protocol);
    const kinds = {
      handle: "handle",
      registerFileProtocol: "file",
      registerBufferProtocol: "buffer",
      registerStringProtocol: "string",
      registerStreamProtocol: "stream",
      registerHttpProtocol: "http",
      interceptFileProtocol: "file",
      interceptBufferProtocol: "buffer",
      interceptStringProtocol: "string",
      interceptStreamProtocol: "stream",
      interceptHttpProtocol: "http",
    };
    for (const [name, kind] of Object.entries(kinds)) {
      const fn = proto[name];
      if (typeof fn !== "function") continue;
      proto[name] = function (scheme, handler, ...rest) {
        let m = handlers.get(this);
        if (!m) handlers.set(this, (m = new Map()));
        const k = String(scheme).toLowerCase();
        const had = m.get(k);
        if (!(had && had.kind === "handle" && kind !== "handle")) m.set(k, { kind, fn: handler });
        if (!name.startsWith("intercept") && k !== "http" && k !== "https") schemes.add(k);
        return fn.call(this, scheme, handler, ...rest);
      };
    }
    for (const name of ["unhandle", "unregisterProtocol", "uninterceptProtocol"]) {
      const fn = proto[name];
      if (typeof fn !== "function") continue;
      proto[name] = function (scheme, ...rest) {
        const m = handlers.get(this);
        if (m) m.delete(String(scheme).toLowerCase());
        return fn.call(this, scheme, ...rest);
      };
    }
  }

  // --- in ---------------------------------------------------------------------------------

  patchWindows();
  patchDialogs();
  patchMenus();
  patchShell();
  patchClipboard();
  patchNotifications();
  patchProtocols();
  app.on("web-contents-created", (_e, wc) => track(wc));
  app.on("browser-window-created", (_e, w) => adopt(w));
  app.prependOnceListener("ready", () => {
    patchHandlers();
    patchScreen();
  });
  // Chromium's own GPU and sandbox left to the native app; the page paints
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  for (const wc of webContents.getAllWebContents()) track(wc);

  return new Promise((ok, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", () => ok({ port: server.address().port, pid: process.pid }));
  });
}
