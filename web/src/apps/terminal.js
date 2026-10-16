import {
  ASSETS,
  copyText,
  cssVar,
  name,
} from '../app.js';

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
loadXterm().catch(() => {});

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
// light's tokens already inked for white, only its brights darker
function termTheme() {
  const css = getComputedStyle(document.documentElement);
  const cssVar = (name) => css.getPropertyValue(name).trim();
  const light = document.documentElement.dataset.theme === 'light';
  const fg = cssVar('--fg');
  const theme = {
    background: cssVar('--bg'), foreground: fg,
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
const liveTerms = new Set();

// /api/term/<host>: keystrokes and output as binary frames, resize as JSON,
// a dropped socket's rejoin by sid, until the server's ENDED
// login: {user, pass} typed into the host's prompts, unseen
function startTerminal(view, host, sid, resume, shared = false, login = null) {
  let term = null;
  let fit = null;
  let ws = null;
  let observer = null;
  let retry = null;

  // the page's font in before xterm measures its cells
  const fontIn = document.fonts.load('14px "Geist Mono Variable"').catch(() => {});
  const ready = Promise.all([loadXterm(), fontIn]).then(() => {
    term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 14,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font').trim(),
      lineHeight: 1,
      letterSpacing: 0,
      theme: termTheme(),
    });
    liveTerms.add(term);
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
    term.open(view);
    // pixel exact block and box glyphs, DOM renderer if no WebGL2
    try {
      const gl = new WebglAddon.WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      term.loadAddon(gl);
    } catch {}
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
    // true while the prompts are still being answered
    let seen = '';
    // the password's echoed line break dropped, the shell's first output at the top
    let trim = false;
    const loginStep = (data) => {
      seen += new TextDecoder().decode(data);
      if (/login: $/.test(seen)) { seen = ''; ws.send(enc.encode(`${login.user}\r`)); }
      else if (/password: $/.test(seen)) {
        ws.send(enc.encode(`${login.pass}\r`));
        // a command asked for, typed ahead of the shell's prompt
        if (login.run) ws.send(enc.encode(`${login.run}\r`));
        login = null;
        trim = true;
      }
      return true;
    };
    const trimStep = (data) => {
      const bytes = new Uint8Array(data);
      let i = 0;
      while (i < bytes.length && (bytes[i] === 13 || bytes[i] === 10)) i += 1;
      if (i < bytes.length) trim = false;
      return bytes.subarray(i);
    };
    let delay = RETRY_MIN_MS;
    const connect = () => {
      const q = new URLSearchParams({ sid, since: got });
      if (resume) q.set('resume', '1');
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/term/${encodeURIComponent(host)}?${q}`);
      ws.binaryType = 'arraybuffer';
      // the share said again on every join, so a reload's choice holds
      ws.onopen = () => { delay = RETRY_MIN_MS; sendSize(); ws.send(JSON.stringify({ type: 'share', on: shared, by: name })); };
      ws.onmessage = (e) => {
        resume = true;
        got += e.data.byteLength;
        if (login && loginStep(e.data)) return;
        term.write(trim ? trimStep(e.data) : new Uint8Array(e.data));
      };
      ws.onclose = (e) => {
        if (e.code === TERM_TAKEN) {
          term.write('\r\n\x1b[2m[opened in another tab]\x1b[0m\r\n');
          return;
        }
        if (e.code === TERM_ENDED || !resume) {
          term.write('\r\n\x1b[2m[connection closed]\x1b[0m\r\n');
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

// re-coloured with the page's theme
function termsRetheme() { for (const t of liveTerms) t.options.theme = termTheme(); }

export { startTerminal, termsRetheme };
