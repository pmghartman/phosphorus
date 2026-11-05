// the first script in an app window's page: Electron's renderer side as the app's own preload
// sees it (ipcRenderer, contextBridge, webFrame, process), its IPC carried by the phosphorus
// page around it; the app's own URLs (vscode-file:, app:, file:) taken to the server's

function phosRuntime(CFG, phosCodec, ops) {
  const C = phosCodec(false);
  const W = window;
  const wcId = CFG.wc;

  // --- the app's URLs as the server's ---------------------------------------------------

  const base = CFG.base;
  const schemes = new Set(CFG.schemes);
  const docUrl = new URL(CFG.doc);
  const docRoot = `${base}${docUrl.protocol.slice(0, -1)}/${docUrl.host || "_"}/`;
  const ownPath = new URL(base).pathname.split("/").slice(0, 3).join("/");
  const schemeRe = new RegExp(`^(${[...schemes].map((s) => s.replace(/[-.+]/g, "\\$&")).join("|")}):(//)?`, "i");

  function mapUrl(u) {
    if (typeof u !== "string") {
      if (u && typeof u === "object" && "href" in u) u = String(u.href);
      else u = String(u);
    }
    const m = schemeRe.exec(u);
    if (m) {
      const scheme = m[1].toLowerCase();
      let rest = u.slice(m[0].length);
      if (!m[2]) rest = `/${rest}`;
      // scheme://host/path, host empty for file:///
      if (rest.startsWith("/")) rest = `_${rest}`;
      return `${base}${scheme}/${rest}`;
    }
    if (u.length > 1 && u[0] === "/" && u[1] !== "/" && !u.startsWith(ownPath)) return docRoot + u.slice(1);
    return u;
  }
  const mapped = (u) => {
    try {
      return mapUrl(u);
    } catch {
      return u;
    }
  };
  // the app's own URL for one of ours: location and import.meta stay as the app wrote them
  function appUrl(u) {
    if (!u.startsWith(base)) return u;
    const rest = u.slice(base.length);
    const i = rest.indexOf("/");
    const j = rest.indexOf("/", i + 1);
    const host = rest.slice(i + 1, j);
    return `${rest.slice(0, i)}://${host === "_" ? "" : host}${rest.slice(j)}`;
  }
  const NURL = W.URL;
  // what the server wraps each dynamic import() in: the app's schemes to the server's
  W.__phosMap = (u) => {
    const x = typeof u === "string" ? u : u instanceof NURL ? u.href : u;
    return typeof x === "string" && schemeRe.test(x) ? mapUrl(x) : u;
  };
  const cssUrlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const mapCss = (t) =>
    typeof t === "string" && t.includes("url(") ? t.replace(cssUrlRe, (a, q, u) => `url(${q}${mapped(u)}${q})`) : t;

  // trusted types, where the page enforces them: a policy of ours for the values we remake
  let tt = null;
  try {
    if (W.trustedTypes)
      tt = W.trustedTypes.createPolicy("phosphorus", {
        createHTML: (s) => s,
        createScript: (s) => s,
        createScriptURL: (s) => s,
      });
  } catch {}
  const tScript = (s) => (tt ? tt.createScriptURL(s) : s);

  function hookProp(proto, prop, wrap) {
    const d = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) return;
    Object.defineProperty(proto, prop, {
      ...d,
      set(v) {
        return d.set.call(this, wrap(v, this));
      },
    });
  }
  const urlish = (v) => {
    const s = String(v);
    const m = mapped(s);
    return m === s ? v : m;
  };
  const scriptish = (v) => {
    const s = String(v);
    const m = mapped(s);
    return m === s ? v : tScript(m);
  };
  hookProp(HTMLScriptElement.prototype, "src", scriptish);
  hookProp(HTMLLinkElement.prototype, "href", urlish);
  hookProp(HTMLImageElement.prototype, "src", urlish);
  hookProp(HTMLIFrameElement.prototype, "src", urlish);
  hookProp(HTMLMediaElement.prototype, "src", urlish);
  hookProp(HTMLSourceElement.prototype, "src", urlish);
  hookProp(HTMLEmbedElement.prototype, "src", urlish);
  hookProp(HTMLObjectElement.prototype, "data", urlish);
  hookProp(HTMLInputElement.prototype, "src", urlish);
  hookProp(HTMLImageElement.prototype, "srcset", (v) =>
    String(v)
      .split(",")
      .map((p) => {
        const t = p.trim().split(/\s+/);
        t[0] = mapped(t[0]);
        return t.join(" ");
      })
      .join(", "),
  );
  const attrs = new Set(["src", "href", "data", "xlink:href", "poster", "action"]);
  const setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (n, v) {
    const k = String(n).toLowerCase();
    if (attrs.has(k) && v != null) {
      const s = String(v);
      const m = mapped(s);
      if (m !== s) v = this instanceof HTMLScriptElement ? tScript(m) : m;
    } else if (k === "style" && v != null) v = mapCss(String(v));
    return setAttr.call(this, n, v);
  };
  const setAttrNS = Element.prototype.setAttributeNS;
  Element.prototype.setAttributeNS = function (ns, n, v) {
    if (attrs.has(String(n).toLowerCase()) && v != null) v = mapped(String(v));
    return setAttrNS.call(this, ns, n, v);
  };
  const setProp = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function (p, v, pr) {
    return setProp.call(this, p, mapCss(v), pr);
  };
  hookProp(CSSStyleDeclaration.prototype, "cssText", mapCss);
  for (const p of ["background", "backgroundImage", "maskImage", "webkitMaskImage", "listStyleImage", "content"])
    hookProp(CSSStyleDeclaration.prototype, p, mapCss);
  const ins = CSSStyleSheet.prototype.insertRule;
  CSSStyleSheet.prototype.insertRule = function (r, i) {
    return ins.call(this, mapCss(r), i);
  };
  const rs = CSSStyleSheet.prototype.replaceSync;
  if (rs)
    CSSStyleSheet.prototype.replaceSync = function (t) {
      return rs.call(this, mapCss(t));
    };
  const ra = CSSStyleSheet.prototype.replace;
  if (ra)
    CSSStyleSheet.prototype.replace = function (t) {
      return ra.call(this, mapCss(t));
    };
  // style text set any other way, and attributes the parser or innerHTML set, caught after
  const fixNode = (n) => {
    if (n.nodeType === 3 && n.parentNode && n.parentNode.nodeName === "STYLE") {
      const t = mapCss(n.data);
      if (t !== n.data) n.data = t;
      return;
    }
    if (n.nodeType !== 1) return;
    if (n.nodeName === "STYLE") {
      const t = mapCss(n.textContent);
      if (t !== n.textContent) n.textContent = t;
    }
    for (const a of ["src", "href", "poster"]) {
      const v = n.getAttribute && n.getAttribute(a);
      if (v && (schemeRe.test(v) || (v[0] === "/" && v[1] !== "/" && !v.startsWith(ownPath)))) n.setAttribute(a, v);
    }
    const st = n.getAttribute && n.getAttribute("style");
    if (st && st.includes("url(")) {
      const t = mapCss(st);
      if (t !== st) setAttr.call(n, "style", t);
    }
  };
  new MutationObserver((list) => {
    for (const r of list) {
      if (r.type === "characterData") fixNode(r.target);
      else if (r.type === "attributes") fixNode(r.target);
      else
        for (const n of r.addedNodes) {
          fixNode(n);
          if (n.querySelectorAll) for (const c of n.querySelectorAll("style,[src],[href],[style]")) fixNode(c);
        }
    }
  }).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["src", "href", "style"],
  });

  const ofetch = W.fetch;
  W.fetch = function (input, init) {
    if (typeof input === "string" || input instanceof URL) return ofetch.call(this, mapped(String(input)), init);
    if (input instanceof Request) {
      const m = mapped(input.url);
      if (m !== input.url) return ofetch.call(this, new Request(m, input), init);
    }
    return ofetch.call(this, input, init);
  };
  const xopen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    return xopen.call(this, m, mapped(String(u)), ...rest);
  };

  // a worker of the app's own: started from a blob that maps its URLs the same way
  const workerPrelude = (u, module) => `
    const base = ${JSON.stringify(base)}, docRoot = ${JSON.stringify(docRoot)}, ownPath = ${JSON.stringify(ownPath)};
    const re = new RegExp(${JSON.stringify(schemeRe.source)}, "i");
    const map = (u) => { u = String(u); const m = re.exec(u); if (m) { let r = u.slice(m[0].length); if (!m[2]) r = "/" + r;
      if (r.startsWith("/")) r = "_" + r; return base + m[1].toLowerCase() + "/" + r; }
      if (u.length > 1 && u[0] === "/" && u[1] !== "/" && !u.startsWith(ownPath)) return docRoot + u.slice(1); return u; };
    self.__phosMap = (u) => { const x = typeof u === "string" ? u : u instanceof URL ? u.href : u; return typeof x === "string" && re.test(x) ? map(x) : u; };
    const f = self.fetch; self.fetch = (i, o) => f(typeof i === "string" || i instanceof URL ? map(i) : i, o);
    const xo = XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open = function (m, u, ...r) { return xo.call(this, m, map(u), ...r); };
    ${module ? "" : "const is = self.importScripts; self.importScripts = (...a) => is(...a.map(map));"}
    ${module ? `import(${JSON.stringify(u)});` : `self.importScripts(${JSON.stringify(u)});`}`;
  const blobUrls = new Map();
  const workerUrl = (u, module) => {
    const m = mapped(String(u));
    if (/^(blob|data):/i.test(m)) return u;
    const key = `${module ? "m" : "c"}${m}`;
    let b = blobUrls.get(key);
    if (!b) {
      const hash = m.indexOf("#");
      const clean = hash < 0 ? m : m.slice(0, hash);
      b = URL.createObjectURL(new Blob([workerPrelude(clean, module)], { type: "text/javascript" }));
      blobUrls.set(key, b);
    }
    return tScript(b);
  };
  for (const name of ["Worker", "SharedWorker"]) {
    const Orig = W[name];
    if (!Orig) continue;
    const Wrapped = function (u, opts) {
      const module = opts && typeof opts === "object" && opts.type === "module";
      return new Orig(workerUrl(u, module), opts);
    };
    Wrapped.prototype = Orig.prototype;
    W[name] = Wrapped;
  }

  // the page's storage: an opaque origin has none, so the app's lives in memory here
  class Mem {
    constructor() {
      this._m = new Map();
    }
    get length() {
      return this._m.size;
    }
    key(i) {
      return [...this._m.keys()][i] ?? null;
    }
    getItem(k) {
      return this._m.has(String(k)) ? this._m.get(String(k)) : null;
    }
    setItem(k, v) {
      this._m.set(String(k), String(v));
    }
    removeItem(k) {
      this._m.delete(String(k));
    }
    clear() {
      this._m.clear();
    }
  }
  for (const k of ["localStorage", "sessionStorage"]) {
    let ok = true;
    try {
      void W[k].length;
    } catch {
      ok = false;
    }
    if (!ok)
      try {
        Object.defineProperty(W, k, { value: new Mem(), configurable: true });
      } catch {}
  }
  try {
    void document.cookie;
  } catch {
    let jar = "";
    Object.defineProperty(Document.prototype, "cookie", {
      configurable: true,
      get: () => jar,
      set: (v) => {
        jar = String(v).split(";")[0];
      },
    });
  }

  // --- the link to the phosphorus page around us -------------------------------------------

  let port = null;
  const early = [];
  function up(b) {
    const buf = b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer : b.slice().buffer;
    if (port) port.postMessage(buf, [buf]);
    else early.push(buf);
  }
  const frame = (op, id, v) => up(C.frame(op, wcId, id, v));
  const wev = (name, data) => frame(ops.wev, 0, [name, data]);

  // --- ipcRenderer ----------------------------------------------------------------------

  class Emitter {
    constructor() {
      this._l = new Map();
    }
    on(ch, f) {
      if (!this._l.has(ch)) this._l.set(ch, []);
      this._l.get(ch).push(f);
      return this;
    }
    addListener(ch, f) {
      return this.on(ch, f);
    }
    prependListener(ch, f) {
      if (!this._l.has(ch)) this._l.set(ch, []);
      this._l.get(ch).unshift(f);
      return this;
    }
    once(ch, f) {
      const g = (...a) => {
        this.removeListener(ch, g);
        f.apply(this, a);
      };
      g.listener = f;
      return this.on(ch, g);
    }
    off(ch, f) {
      return this.removeListener(ch, f);
    }
    removeListener(ch, f) {
      const l = this._l.get(ch);
      if (!l) return this;
      const i = l.findIndex((x) => x === f || x.listener === f);
      if (i >= 0) l.splice(i, 1);
      if (!l.length) this._l.delete(ch);
      return this;
    }
    removeAllListeners(ch) {
      if (ch === undefined) this._l.clear();
      else this._l.delete(ch);
      return this;
    }
    listenerCount(ch) {
      return (this._l.get(ch) || []).length;
    }
    listeners(ch) {
      return (this._l.get(ch) || []).map((x) => x.listener || x);
    }
    rawListeners(ch) {
      return [...(this._l.get(ch) || [])];
    }
    eventNames() {
      return [...this._l.keys()];
    }
    setMaxListeners() {
      return this;
    }
    getMaxListeners() {
      return 0;
    }
    emit(ch, ...a) {
      const l = this._l.get(ch);
      if (!l || !l.length) return false;
      for (const f of [...l]) {
        try {
          f.apply(this, a);
        } catch (e) {
          console.error(e);
        }
      }
      return true;
    }
  }

  let seq = 1;
  const waiting = new Map();
  const ports = new Map();
  let portSeq = 0x80000000;

  // a port of the app's main process: one end of a channel here, given to the page
  function portIn(id) {
    const mc = new MessageChannel();
    ports.set(id, mc.port2);
    mc.port2.onmessage = (e) => frame(ops.port, id, e.data);
    if ("onclose" in mc.port2)
      mc.port2.onclose = () => {
        if (ports.delete(id)) frame(ops.portClose, id);
      };
    return mc.port1;
  }
  // a port the page hands the main process
  function portOut(p) {
    const id = portSeq++;
    ports.set(id, p);
    p.onmessage = (e) => frame(ops.port, id, e.data);
    if ("onclose" in p)
      p.onclose = () => {
        if (ports.delete(id)) frame(ops.portClose, id);
      };
    return id;
  }

  const ipc = new Emitter();
  Object.assign(ipc, {
    send(ch, ...args) {
      frame(ops.send, 0, [String(ch), args]);
    },
    invoke(ch, ...args) {
      const id = seq++;
      return new Promise((ok, no) => {
        waiting.set(id, [ok, no]);
        frame(ops.invoke, id, [String(ch), args]);
      });
    },
    sendSync(ch, ...args) {
      const x = new XMLHttpRequest();
      xopen.call(x, "POST", CFG.sync, false);
      x.overrideMimeType("text/plain; charset=x-user-defined");
      x.send(C.frame(ops.sync, wcId, seq++, [String(ch), args]));
      if (x.status !== 200) return undefined;
      const s = x.responseText;
      const b = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
      const r = C.body(b) || {};
      return r.result;
    },
    postMessage(ch, message, transfer) {
      const ids = (transfer || []).filter((p) => p instanceof MessagePort).map(portOut);
      frame(ops.post, 0, [String(ch), message, ids]);
    },
    sendToHost(ch, ...args) {
      frame(ops.send, 0, [String(ch), args]);
    },
  });

  // --- what comes down ----------------------------------------------------------------------

  const cssKeys = new Map();
  function down(buf) {
    const b = new Uint8Array(buf);
    const h = C.head(b);
    switch (h.op) {
      case ops.msg: {
        const [ch, args, ids] = C.body(b);
        const ev = { sender: ipc, senderId: 0, ports: (ids || []).map(portIn) };
        ipc.emit(ch, ev, ...(args || []));
        return;
      }
      case ops.reply: {
        const w = waiting.get(h.id);
        if (!w) return;
        waiting.delete(h.id);
        const r = C.body(b) || {};
        if (r.error !== undefined) w[1](new Error(String(r.error)));
        else w[0](r.result);
        return;
      }
      case ops.port: {
        const p = ports.get(h.id);
        if (p) p.postMessage(C.body(b));
        return;
      }
      case ops.portClose: {
        const p = ports.get(h.id);
        ports.delete(h.id);
        if (p) p.close();
        return;
      }
      case ops.call: {
        const [m, args] = C.body(b);
        return callHere(m, args || []);
      }
      case ops.ask: {
        const [kind, d] = C.body(b);
        if (kind !== "exec") return;
        Promise.resolve()
          .then(() => (0, eval)(String(d.code)))
          .then(
            (r) => frame(ops.reply, h.id, { result: r }),
            (e) => frame(ops.reply, h.id, { error: String(e) }),
          );
        return;
      }
    }
  }

  function callHere(m, a) {
    switch (m) {
      case "reload":
        return location.reload();
      case "css": {
        const [key, css] = a;
        const old = cssKeys.get(key);
        if (old) old.remove();
        cssKeys.delete(key);
        if (css != null) {
          const s = document.createElement("style");
          s.textContent = css;
          (document.head || document.documentElement).append(s);
          cssKeys.set(key, s);
        }
        return;
      }
      case "edit":
        try {
          document.execCommand(a[0] === "pasteAndMatchStyle" ? "paste" : a[0]);
        } catch {}
        return;
    }
  }

  // --- Electron's renderer modules ------------------------------------------------------------

  let zoom = CFG.zoom || 1;
  const setZoom = (f) => {
    zoom = Math.max(0.25, Math.min(5, Number(f) || 1));
    parentTell("zoom", zoom);
  };
  const webFrame = {
    routingId: 1,
    setZoomLevel: (l) => setZoom(1.2 ** (Number(l) || 0)),
    getZoomLevel: () => Math.log(zoom) / Math.log(1.2),
    setZoomFactor: (f) => setZoom(f),
    getZoomFactor: () => zoom,
    setVisualZoomLevelLimits() {},
    setSpellCheckProvider() {},
    insertCSS(css) {
      const s = document.createElement("style");
      s.textContent = css;
      (document.head || document.documentElement).append(s);
      const key = `w${seq++}`;
      cssKeys.set(key, s);
      return key;
    },
    removeInsertedCSS(key) {
      callHere("css", [key, null]);
    },
    executeJavaScript: (code) => Promise.resolve((0, eval)(String(code))),
    executeJavaScriptInIsolatedWorld: (_id, scripts) =>
      Promise.resolve((0, eval)((scripts || []).map((s) => s.code).join(";\n"))),
    getResourceUsage: () => ({}),
    clearCache() {},
    getFrameForSelector: () => null,
    findFrameByName: () => null,
    findFrameByRoutingId: () => null,
    get top() {
      return webFrame;
    },
    get parent() {
      return null;
    },
  };
  const contextBridge = {
    exposeInMainWorld(key, api) {
      Object.defineProperty(W, key, { value: api, enumerable: true, configurable: true, writable: false });
    },
    exposeInIsolatedWorld(_id, key, api) {
      contextBridge.exposeInMainWorld(key, api);
    },
    executeInMainWorld: ({ func, args }) => func(...(args || [])),
  };
  const webUtils = { getPathForFile: (f) => (f && f.path) || "" };
  const nativeImage = {
    createEmpty: () => ({ isEmpty: () => true, toDataURL: () => "", getSize: () => ({ width: 0, height: 0 }) }),
    createFromDataURL: (u) => ({ isEmpty: () => !u, toDataURL: () => u, getSize: () => ({ width: 0, height: 0 }) }),
  };
  const electron = {
    ipcRenderer: ipc,
    contextBridge,
    webFrame,
    webUtils,
    nativeImage,
    crashReporter: { start() {}, addExtraParameter() {}, removeExtraParameter() {}, getParameters: () => ({}) },
  };

  const proc = new Emitter();
  const argv = [CFG.execPath, "--type=renderer", ...(CFG.args || [])];
  const t0 = performance.now();
  Object.assign(proc, {
    argv,
    execArgv: [],
    env: { ...(CFG.env || {}) },
    platform: CFG.platform,
    arch: CFG.arch,
    versions: { ...(CFG.versions || {}) },
    version: `v${(CFG.versions || {}).node || "0"}`,
    execPath: CFG.execPath,
    pid: CFG.pid || 0,
    type: "renderer",
    title: "",
    sandboxed: CFG.sandbox !== false,
    contextIsolated: CFG.isolation !== false,
    resourcesPath: CFG.resourcesPath || "",
    cwd: () => CFG.cwd || "",
    nextTick: (f, ...a) => queueMicrotask(() => f(...a)),
    hrtime: Object.assign(
      (prev) => {
        const n = performance.now() * 1e6;
        const s = Math.floor(n / 1e9);
        const ns = Math.floor(n % 1e9);
        return prev ? [s - prev[0], ns - prev[1]] : [s, ns];
      },
      { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) },
    ),
    uptime: () => (performance.now() - t0) / 1000,
    getProcessMemoryInfo: () => Promise.resolve({ private: 0, shared: 0, residentSet: 0 }),
    getHeapStatistics: () => ({}),
    getBlinkMemoryInfo: () => ({}),
    getSystemMemoryInfo: () => ({ total: 0, free: 0 }),
    getSystemVersion: () => "",
    getCPUUsage: () => ({ percentCPUUsage: 0, idleWakeupsPerSecond: 0 }),
    getCreationTime: () => performance.timeOrigin,
    memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
    crash() {},
    hang() {},
    exit() {},
  });

  class Buf extends Uint8Array {
    static from(v, enc) {
      if (typeof v === "string") {
        if (enc === "base64") {
          const s = atob(v);
          const b = new Buf(s.length);
          for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
          return b;
        }
        const e = new TextEncoder().encode(v);
        return new Buf(e.buffer, e.byteOffset, e.byteLength);
      }
      if (v instanceof ArrayBuffer) return new Buf(v);
      return new Buf(v);
    }
    static alloc(n) {
      return new Buf(n);
    }
    static isBuffer(v) {
      return v instanceof Buf;
    }
    static concat(list) {
      const n = list.reduce((a, b) => a + b.length, 0);
      const out = new Buf(n);
      let at = 0;
      for (const b of list) {
        out.set(b, at);
        at += b.length;
      }
      return out;
    }
    toString(enc) {
      if (enc === "base64") {
        let s = "";
        for (let i = 0; i < this.length; i++) s += String.fromCharCode(this[i]);
        return btoa(s);
      }
      return new TextDecoder().decode(this);
    }
  }

  const events = Object.assign(Emitter, { EventEmitter: Emitter, default: Emitter });
  const builtins = {
    electron,
    events,
    timers: { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate: (f, ...a) => setTimeout(f, 0, ...a) },
    url: {
      URL: NURL,
      URLSearchParams,
      pathToFileURL: (p) => new NURL(`file:///${String(p).replace(/\\/g, "/").replace(/^\/+/, "")}`),
      fileURLToPath: (u) => decodeURIComponent(new NURL(u).pathname).replace(/^\/([a-z]:)/i, "$1"),
    },
  };
  function req(name) {
    const n = String(name).replace(/^node:/, "");
    if (n in builtins) return builtins[n];
    throw new Error(`module not found: ${name}; phosphorus runs this app's renderer in the browser`);
  }

  // --- the app's preloads, before any of its page's scripts ---------------------------------

  W.global = W.global || W;
  for (const p of CFG.preloads || []) {
    try {
      const module = { exports: {} };
      const f = new Function(
        "require",
        "process",
        "Buffer",
        "global",
        "setImmediate",
        "clearImmediate",
        "exports",
        "module",
        "__filename",
        "__dirname",
        `${p.text}\n//# sourceURL=${p.path.replace(/\s/g, "%20")}`,
      );
      f.call(
        W,
        req,
        proc,
        Buf,
        W,
        builtins.timers.setImmediate,
        clearTimeout,
        module.exports,
        module,
        p.path,
        p.path.replace(/[\\/][^\\/]*$/, ""),
      );
    } catch (e) {
      console.error(`preload ${p.path}:`, e);
    }
  }

  // --- the page's life told to the app ---------------------------------------------------------

  function parentTell(kind, data) {
    parentPost({ phosAppweb: "tell", kind, data });
  }
  function parentPost(m) {
    try {
      W.parent.postMessage({ ...m, nonce: CFG.nonce }, "*");
    } catch {}
  }

  W.addEventListener("message", (e) => {
    if (e.source !== W.parent || !e.data || e.data.phosAppweb !== "port" || e.data.nonce !== CFG.nonce) return;
    port = e.ports[0];
    port.onmessage = (m) => {
      try {
        down(m.data);
      } catch (err) {
        console.error(err);
      }
    };
    for (const b of early.splice(0)) port.postMessage(b, [b]);
  });
  parentPost({ phosAppweb: "hello", nonce: CFG.nonce, wc: wcId });

  wev("loading");
  document.addEventListener("DOMContentLoaded", () => wev("dom-ready"));
  W.addEventListener("load", () => {
    wev("loaded");
    wev("title", document.title);
    parentTell("chrome", { drag: hasDrag() });
  });
  W.addEventListener("pagehide", () => wev("unload"));
  let lastTitle = "";
  new MutationObserver(() => {
    if (document.title !== lastTitle) {
      lastTitle = document.title;
      wev("title", lastTitle);
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
  W.addEventListener("focus", () => wev("focus", true));
  W.addEventListener("blur", () => wev("focus", false));
  const clip = () => {
    const s = String(W.getSelection ? W.getSelection() : "");
    if (s) wev("clip", s);
  };
  document.addEventListener("copy", clip, true);
  document.addEventListener("cut", clip, true);

  const oopen = W.open;
  W.open = (u, name, features) => {
    if (u === undefined || u === "") return oopen.call(W, u, name, features);
    wev("open", { url: String(u), name: name ? String(name) : "", features: features ? String(features) : "" });
    return null;
  };
  // links out of the app: the app's own window.open handler decides, as Electron's would
  document.addEventListener(
    "click",
    (e) => {
      const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
      if (!a || e.defaultPrevented) return;
      const href = a.getAttribute("href") || "";
      if (!/^(https?|mailto):/i.test(href)) return;
      e.preventDefault();
      wev("open", { url: href, name: a.target || "", features: "", disposition: "foreground-tab" });
    },
    false,
  );

  // the app's own title bar: its drag regions move the window, as the OS would
  const dragOf = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const r = cs.getPropertyValue("app-region") || cs.getPropertyValue("-webkit-app-region");
      if (r === "drag") return true;
      if (r === "no-drag") return false;
    }
    return false;
  };
  const interactive = (el) => !!(el.closest && el.closest("button,input,select,textarea,a[href],[contenteditable]"));
  function hasDrag() {
    try {
      for (const s of document.styleSheets) {
        let rules;
        try {
          rules = s.cssRules;
        } catch {
          continue;
        }
        for (const r of rules) if (/app-region\s*:\s*drag/.test(r.cssText)) return true;
      }
    } catch {}
    return false;
  }
  W.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0 || interactive(e.target) || !dragOf(e.target)) return;
      const sx = e.screenX;
      const sy = e.screenY;
      const t = e.target;
      let moved = false;
      try {
        t.setPointerCapture(e.pointerId);
      } catch {}
      const move = (ev) => {
        const dx = ev.screenX - sx;
        const dy = ev.screenY - sy;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        parentPost({ phosAppweb: "drag", dx, dy, x: ev.screenX, y: ev.screenY });
      };
      const up = () => {
        t.removeEventListener("pointermove", move);
        t.removeEventListener("pointerup", up);
        t.removeEventListener("pointercancel", up);
        if (moved) parentPost({ phosAppweb: "drag", end: true });
      };
      t.addEventListener("pointermove", move);
      t.addEventListener("pointerup", up);
      t.addEventListener("pointercancel", up);
    },
    true,
  );
  // where a menu with no place of its own opens: the last press
  const at = (e) => parentTell("pointer", { x: e.clientX, y: e.clientY });
  W.addEventListener("contextmenu", at, true);
  W.addEventListener("pointerdown", at, true);
  W.addEventListener(
    "dblclick",
    (e) => {
      if (!interactive(e.target) && dragOf(e.target)) parentPost({ phosAppweb: "dblbar" });
    },
    true,
  );

  W.__phosAppUrl = appUrl;
}
