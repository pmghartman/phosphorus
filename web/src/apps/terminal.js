import {
  ASSETS,
  copyText,
  cssVar,
  hostUrl,
  name,
} from '#host';

// --- terminals --------------------------------------------------------------

// xterm with this chunk's prefetch, its own chunks
let xtermLoaded = null;
let Terminal = null;
let FitAddon = null;
let WebglAddon = null;
function loadXterm() {
  if (xtermLoaded) return xtermLoaded;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = ASSETS['xterm.css'];
  document.head.appendChild(css);
  xtermLoaded = Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/addon-webgl')])
    .then(([x, f, g]) => { Terminal = x.Terminal; FitAddon = f; WebglAddon = g; })
    .catch((e) => { xtermLoaded = null; throw e; });
  return xtermLoaded;
}

// server's close codes: session gone for good, or taken by another tab
const TERM_ENDED = 4000;
// cmd+c and cmd+v a mac's own, its ctrl+c always ^C
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform || '');
const TERM_TAKEN = 4001;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 10000;
// the sixteen ANSI colors from the page's own tokens, so a restyle reaches
// terminals too: magenta the accent, yellow its orange, blue the sky
const TERM_HUES = {
  red: '--offmesh', green: '--online', yellow: '--accent-2',
  blue: '--sky', magenta: '--accent', cyan: '--teal',
};

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mixHex = (a, b, t) => `#${hexRgb(a).map((v, i) => Math.round(v + (hexRgb(b)[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;

// read fresh each time so a theme switch reaches open terminals,
// light's tokens already inked for white, only its brights darker;
// from: the element whose tokens it takes, clear: no background of its own
function termTheme(from = document.documentElement, clear = false) {
  const css = getComputedStyle(from.isConnected ? from : document.documentElement);
  const cssVar = (name) => css.getPropertyValue(name).trim();
  // a window may set its own scheme, a theme's terminal dark on a light desktop
  const scheme = cssVar('--term-scheme');
  const light = scheme ? scheme === 'light' : document.documentElement.dataset.theme === 'light';
  const fg = cssVar('--fg');
  const theme = {
    background: clear ? '#00000000' : cssVar('--bg'), foreground: fg,
    cursor: cssVar('--accent'), cursorAccent: cssVar('--bg'),
    selectionBackground: `${cssVar('--accent')}59`,
    black: light ? fg : cssVar('--border'),
    brightBlack: light ? cssVar('--muted') : mixHex(cssVar('--dim'), cssVar('--muted'), 0.5),
    white: light ? cssVar('--dim') : mixHex(cssVar('--muted'), fg, 0.5),
    brightWhite: light ? cssVar('--border') : fg,
  };
  for (const [name, token] of Object.entries(TERM_HUES)) {
    const hue = cssVar(token);
    const bright = `bright${name[0].toUpperCase()}${name.slice(1)}`;
    theme[name] = hue;
    theme[bright] = light ? mixHex(hue, fg, 0.25) : mixHex(hue, '#ffffff', 0.25);
  }
  return theme;
}
// each open terminal and where its colors come from
const liveTerms = new Map();
const looks = (opts) => ({ from: opts.themeFrom || document.documentElement, clear: !!opts.transparent });
// the mono of where its colors come from, a theme's terminal its own face
const monoOf = (from) => getComputedStyle(from?.isConnected ? from : document.documentElement).getPropertyValue('--mono').trim();

// /api/term/<host>: keystrokes and output as binary frames, resize as JSON,
// a dropped socket's rejoin by sid, until the server's ENDED
// login: {user, pass} typed into the host's prompts, unseen
// opts: fontSize, and onEnd once the session's gone for good
function startTerminal(view, host, sid, resume, shared = false, login = null, opts = {}) {
  let term = null;
  let fit = null;
  let ws = null;
  let observer = null;
  let retry = null;

  const ready = loadXterm().then(() => {
    term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: opts.fontSize || 14,
      fontFamily: monoOf(looks(opts).from),
      lineHeight: 1,
      letterSpacing: 0,
      allowTransparency: !!opts.transparent,
      theme: termTheme(looks(opts).from, looks(opts).clear),
    });
    liveTerms.set(term, looks(opts));
    // shift+esc left to the page, which unfocuses, plain esc the terminal's;
    // off a mac ctrl+c copies a selection (else ^C) and ctrl+v pastes, as Windows Terminal
    term.attachCustomKeyEventHandler((e) => {
      if (e.key === 'Escape' && e.shiftKey) return false;
      if (IS_MAC || e.type !== 'keydown' || !e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return true;
      const k = e.key.toLowerCase();
      if (k === 'c' && term.hasSelection()) {
        copyText(term.getSelection()).catch(() => {});
        term.clearSelection();
        e.preventDefault();
        return false;
      }
      // the browser's own paste event, into xterm's textarea, instead of ^V
      if (k === 'v') return false;
      return true;
    });
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    liveTerms.get(term).fit = fit;
    term.open(view);
    // pixel exact block and box glyphs, DOM renderer if no WebGL2 or the panel shows through
    if (!opts.transparent) {
      try {
        const gl = new WebglAddon.WebglAddon();
        gl.onContextLoss(() => gl.dispose());
        term.loadAddon(gl);
      } catch {}
    }
    // 0x0 for hidden views, skipped by fit
    observer = new ResizeObserver(() => fit.fit());
    observer.observe(view);

    const sendSize = () => ws?.readyState === WebSocket.OPEN
      && ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    const enc = new TextEncoder();
    term.onResize(sendSize);
    term.onData((d) => ws?.readyState === WebSocket.OPEN && ws.send(enc.encode(d)));

    // bytes so far, so a rejoin replays only what's missing, 0 after a reload
    let got = 0;
    let delay = RETRY_MIN_MS;
    const connect = () => {
      const q = new URLSearchParams({ sid, since: got });
      if (resume) q.set('resume', '1');
      // a saved login on its way: the server waits for it, its prompts never drawn
      else if (login) q.set('auto', '1');
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${hostUrl(host, `/api/term/${encodeURIComponent(host)}`)}?${q}`);
      ws.binaryType = 'arraybuffer';
      // the share said again on every join, so a reload's choice holds; a saved
      // login handed to the server once, its prompts answered there, never by screen
      ws.onopen = () => {
        delay = RETRY_MIN_MS;
        sendSize();
        ws.send(JSON.stringify({ type: 'share', on: shared, by: name }));
        if (login && !resume) ws.send(JSON.stringify({ type: 'login', user: login.user, pass: login.pass, run: login.run || '' }));
        login = null;
      };
      ws.onmessage = (e) => {
        resume = true;
        got += e.data.byteLength;
        term.write(new Uint8Array(e.data));
      };
      ws.onclose = (e) => {
        if (e.code === TERM_TAKEN) {
          term.write('\r\n\x1b[2m[opened in another tab]\x1b[0m\r\n');
          opts.onEnd?.();
          return;
        }
        if (e.code === TERM_ENDED || !resume) {
          term.write('\r\n\x1b[2m[connection closed]\x1b[0m\r\n');
          opts.onEnd?.();
          return;
        }
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      };
    };
    connect();
    fit.fit();
    term.focus();
  }).catch((err) => { view.textContent = err.message; });

  return {
    show: () => ready.then(() => { fit?.fit(); term?.focus(); }),
    focus: () => term?.focus(),
    // typed in as if at the keyboard, false while the socket's down
    send: (text) => {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(new TextEncoder().encode(text));
      return true;
    },
    clear: () => term?.clear(),
    fit: () => fit?.fit(),
    close: () => ready.then(() => {
      observer?.disconnect();
      clearTimeout(retry);
      if (ws) {
        ws.onclose = null;
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'close' }));
        ws.close();
      }
      liveTerms.delete(term);
      term?.dispose();
    }),
  };
}

// the agent's console on a host: read only, its commands and their output as written
function agentConsole(view) {
  let term = null;
  let observer = null;
  const queued = [];
  const ready = loadXterm().then(() => {
    term = new Terminal({
      disableStdin: true, cursorBlink: false, cursorStyle: 'bar', cursorInactiveStyle: 'none', convertEol: true,
      fontSize: 13, lineHeight: 1, scrollback: 5000,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim(),
      theme: termTheme(),
    });
    liveTerms.set(term, looks({}));
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    liveTerms.get(term).fit = fit;
    term.open(view);
    observer = new ResizeObserver(() => fit.fit());
    observer.observe(view);
    fit.fit();
    for (const t of queued.splice(0)) term.write(t);
  }).catch((err) => { view.textContent = err.message; });
  return {
    write: (t) => { if (term) term.write(t); else queued.push(t); },
    close: () => ready.then(() => { observer?.disconnect(); liveTerms.delete(term); term?.dispose(); }),
  };
}

// a task on a host through /api/sulfur/run, a build or a run: its output as a
// terminal's, keys passed in while it runs, its exit told once it's over;
// opts: fontSize, banner, onText (its output as text, for problem matchers), onExit
function taskTerminal(view, host, task, opts = {}) {
  let term = null;
  let fit = null;
  let ws = null;
  let observer = null;
  let ended = false;
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const end = (code, why) => {
    if (ended) return;
    ended = true;
    if (why) term?.write(`\r\n\x1b[31m${why}\x1b[0m`);
    term?.write(`\r\n\x1b[2m[${code === 0 ? 'done' : code === -1 ? 'stopped' : `exited with ${code}`}]\x1b[0m\r\n`);
    opts.onExit?.(code, why || '');
  };
  const ready = loadXterm().then(() => {
    term = new Terminal({
      cursorBlink: false, cursorStyle: 'bar', fontSize: opts.fontSize || 14, lineHeight: 1, scrollback: 20000,
      fontFamily: monoOf(looks(opts).from),
      allowTransparency: !!opts.transparent, theme: termTheme(looks(opts).from, looks(opts).clear),
    });
    liveTerms.set(term, looks(opts));
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    liveTerms.get(term).fit = fit;
    term.open(view);
    if (!opts.transparent) {
      try {
        const gl = new WebglAddon.WebglAddon();
        gl.onContextLoss(() => gl.dispose());
        term.loadAddon(gl);
      } catch {}
    }
    observer = new ResizeObserver(() => fit.fit());
    observer.observe(view);
    fit.fit();
    if (opts.banner) term.write(opts.banner);
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${hostUrl(host, '/api/sulfur/run')}`);
    ws.binaryType = 'arraybuffer';
    let heard = false;
    ws.onopen = () => ws.send(JSON.stringify({ host, task: { ...task, cols: term.cols, rows: term.rows } }));
    ws.onmessage = (e) => {
      heard = true;
      if (typeof e.data === 'string') {
        let m = null;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'exit') end(m.code, m.error);
        return;
      }
      const b = new Uint8Array(e.data);
      term.write(b);
      opts.onText?.(dec.decode(b, { stream: true }));
    };
    // closed before a word: the host has no runs to give, most likely a Phosphorus older than this Sulfur
    ws.onclose = () => end(-1, heard ? 'the connection closed' : `${host} didn't take the run: its Phosphorus is likely older than this Sulfur. Update the mesh (the status app's update, or phos update all), then run it again.`);
    term.onData((d) => { if (!ended && ws?.readyState === WebSocket.OPEN) ws.send(enc.encode(d)); });
    term.onResize(() => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); });
  }).catch((err) => { view.textContent = err.message; end(-1, err.message); });
  return {
    show: () => ready.then(() => { fit?.fit(); term?.focus(); }),
    focus: () => term?.focus(),
    fit: () => fit?.fit(),
    clear: () => term?.clear(),
    ended: () => ended,
    send: (text) => {
      if (ended || ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(enc.encode(text));
      return true;
    },
    // a stop asked of the host, the socket closed after so nothing's left
    kill: () => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'kill' })); },
    close: () => ready.then(() => {
      observer?.disconnect();
      if (ws) { ws.onclose = null; try { ws.close(); } catch {} }
      liveTerms.delete(term);
      term?.dispose();
    }),
  };
}

// re-coloured with the page's theme
// a theme's own mono too, the cells measured again for it
function termsRetheme() {
  for (const [t, l] of liveTerms) {
    const font = monoOf(l.from);
    t.options.theme = termTheme(l.from, l.clear);
    if (font && t.options.fontFamily !== font) { t.options.fontFamily = font; l.fit?.fit(); }
  }
}

export { agentConsole, startTerminal, taskTerminal, termsRetheme };
