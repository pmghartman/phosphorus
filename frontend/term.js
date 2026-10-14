'use strict';
// terminal tab: an ssh2 session per browser tab into the host sshd, or a hop
// to the owning peer, binary frames for bytes, text for JSON resize and close

const { Client } = require('ssh2');
const { Terminal } = require('@xterm/headless');
const WebSocket = require('ws');

const LOGIN_TIMEOUT_MS = 120000;
const MAX_TRIES = 3;
const MAX_FIELD = 256;
// a dropped socket's shell, held for the tab to rejoin
const GRACE_MS = 10 * 60000;
// output kept for a rejoin's replay
const REPLAY_MAX = 256 * 1024;
// close code for a session gone for good, no retry from the tab
const ENDED = 4000;
// close code for a socket another tab took the session from
const TAKEN = 4001;
// a peer's hop, given up on past this
const HOP_TIMEOUT_MS = 10000;
// a shared screen's lines handed to phosphorus, scrollback included
const SCREEN_LINES = 120;
// a command's output taken as done once quiet this long
const SETTLE_MS = 1500;
const MAX_COMMAND = 2000;
// never typed: newlines and control keys, so only the owner's Enter runs it
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
// the screen asking for a secret: nothing typed into it by phosphorus
const SECRET_PROMPT = /pass(word|phrase)|token|secret|\bpin\b|\[sudo\]/i;

const dim = (n, fallback) => (Number.isInteger(n) && n > 0 && n <= 1000 ? n : fallback);

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(typeof data === 'string' ? Buffer.from(data) : data);
}

// sid -> session, for as long as its shell or login lives
const sessions = new Map();

// output numbered from the session's first byte, for the tab's since
function createSession(sid) {
  const s = {
    sid, ws: null, client: null, stream: null, onInput: null, shared: false, owner: '',
    cols: 80, rows: 24, seq: 0, base: 0, chunks: [], graceTimer: null, lastOut: 0, waiter: null,
  };

  s.out = (data) => {
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    s.chunks.push(buf);
    s.seq += buf.length;
    s.lastOut = Date.now();
    let kept = s.seq - s.base;
    while (kept - s.chunks[0].length >= REPLAY_MAX) {
      kept -= s.chunks[0].length;
      s.base += s.chunks.shift().length;
    }
    send(s.ws, buf);
  };

  s.end = () => {
    if (!sessions.has(sid)) return;
    sessions.delete(sid);
    if (s.waiter) s.waiter('closed');
    clearTimeout(s.graceTimer);
    clearTimeout(s.loginTimer);
    if (s.client) s.client.end();
    if (s.ws) s.ws.close(ENDED);
  };

  // a new socket's takeover, everything past since replayed first
  s.join = (ws, since) => {
    clearTimeout(s.graceTimer);
    if (s.ws && s.ws !== ws) s.ws.close(TAKEN);
    s.ws = ws;
    let at = s.base;
    for (const c of s.chunks) {
      const skip = Math.max(0, since - at);
      if (skip < c.length) send(ws, skip ? c.subarray(skip) : c);
      at += c.length;
    }
    ws.on('message', (data, isBinary) => {
      if (s.ws !== ws) return;
      if (isBinary) {
        // phosphorus's typed command: Enter to run it, ctrl-c to refuse it
        if (s.waiter && data.includes(0x0d)) s.waiter('enter');
        else if (s.waiter && data.includes(0x03)) s.waiter('cancel');
        if (s.onInput) s.onInput(data);
        return;
      }
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'close') { s.end(); return; }
      // the tab's owner letting phosphorus read this screen, never write to it
      if (m.type === 'share') {
        s.shared = m.on === true;
        if (typeof m.by === 'string') s.owner = m.by.slice(0, MAX_FIELD);
        return;
      }
      if (m.type !== 'resize') return;
      s.cols = dim(m.cols, s.cols);
      s.rows = dim(m.rows, s.rows);
      if (s.stream) s.stream.setWindow(s.rows, s.cols, 0, 0);
    });
    ws.on('close', () => {
      if (s.ws !== ws) return;
      s.ws = null;
      // a login in progress, not worth keeping
      if (!s.stream) s.end();
      else s.graceTimer = setTimeout(s.end, GRACE_MS);
    });
  };

  sessions.set(sid, s);
  return s;
}

// login and password prompts, then the host's own shell, or a known sid's rejoin
function attach(ws, { host, sid, since, resume, sshHost, port, shell }) {
  ws.on('error', () => {});
  const live = sessions.get(sid);
  if (live) { live.join(ws, since); return; }
  if (resume) {
    send(ws, '\r\n\x1b[2m[session ended]\x1b[0m\r\n');
    ws.close(ENDED);
    return;
  }

  const s = createSession(sid);
  s.join(ws, 0);
  s.loginTimer = setTimeout(() => { if (!s.stream) s.end(); }, LOGIN_TIMEOUT_MS);

  // one line off the socket, echoed only when asked
  function ask(label, echo) {
    s.out(label);
    return new Promise((resolve) => {
      let line = '';
      s.onInput = (buf) => {
        for (const ch of buf.toString('utf8')) {
          if (ch === '\r' || ch === '\n') {
            s.out('\r\n');
            s.onInput = null;
            resolve(line);
            return;
          }
          if (ch === '\x7f' || ch === '\b') {
            if (!line) continue;
            line = Array.from(line).slice(0, -1).join('');
            if (echo) s.out('\b \b');
          } else if (ch >= ' ' && line.length < MAX_FIELD) {
            line += ch;
            if (echo) s.out(ch);
          }
        }
      };
    });
  }

  // null once the shell is up, else why not
  function connect(username, password) {
    return new Promise((resolve) => {
      const c = new Client();
      s.client = c;
      c.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => finish(prompts.map(() => password)));
      c.on('error', (err) => resolve(err.level === 'client-authentication' ? 'access denied' : err.message));
      c.on('close', () => { if (s.stream) s.end(); });
      c.on('ready', () => {
        const pty = { term: 'xterm-256color', cols: s.cols, rows: s.rows };
        const opened = (err, st) => {
          if (err) { c.end(); resolve(err.message); return; }
          s.stream = st;
          st.on('data', s.out);
          st.stderr.on('data', s.out);
          st.on('close', s.end);
          s.onInput = (buf) => st.write(buf);
          resolve(null);
        };
        // a command: no MOTD or last-login line, and powershell over Windows sshd's cmd.exe
        if (shell) c.exec(shell, { pty }, opened);
        else c.shell(pty, opened);
      });
      c.connect({ host: sshHost, port, username, password, tryKeyboard: true, readyTimeout: 10000 });
    });
  }

  (async () => {
    for (let i = 0; i < MAX_TRIES; i++) {
      const user = (await ask(`${host} login: `, true)).trim();
      if (!sessions.has(sid)) return;
      if (!user) { i--; continue; }
      const why = await connect(user, await ask('password: ', false));
      if (!why || !sessions.has(sid)) return;
      s.client = null;
      s.out(`${why}\r\n\r\n`);
    }
    s.end();
  })();
}

// the browser's socket spliced onto the owning peer's, frames as they come,
// held from the start so nothing's lost to the peer's lookup
function forward(ws, host, lookup, resume) {
  ws.on('error', () => {});
  let up = null;
  const early = [];
  // a new session's failure final, a rejoin's retried by the tab
  const fail = (why) => {
    send(ws, `${why}\r\n`);
    ws.close(resume ? 1000 : ENDED);
  };
  ws.on('message', (d, binary) => {
    if (up && up.readyState === WebSocket.OPEN) up.send(d, { binary });
    else early.push([d, binary]);
  });
  ws.on('close', () => { if (up) up.terminate(); });
  lookup.then((url) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!url) { fail(`can't find ${host} on the tailnet`); return; }
    // else an asleep peer's SYN hanging the tab for minutes
    up = new WebSocket(url, { handshakeTimeout: HOP_TIMEOUT_MS });
    up.on('open', () => {
      for (const [d, binary] of early) up.send(d, { binary });
      early.length = 0;
    });
    up.on('message', (d, binary) => { if (ws.readyState === WebSocket.OPEN) ws.send(d, { binary }); });
    // ENDED and TAKEN passed on, for the tab's no retry
    up.on('close', (code) => ws.close(code === ENDED || code === TAKEN ? code : 1000));
    up.on('error', (err) => fail(`${host} didn't answer: ${err.message}`));
  });
}

const sessionCount = () => sessions.size;

// kept output replayed through a headless xterm at the tab's size: the screen
// as the owner sees it, not raw escapes
function render(s) {
  return new Promise((resolve) => {
    const t = new Terminal({ cols: s.cols, rows: s.rows, scrollback: SCREEN_LINES, allowProposedApi: true });
    t.write(Buffer.concat(s.chunks), () => {
      const b = t.buffer.active;
      const lines = [];
      for (let i = Math.max(0, b.length - SCREEN_LINES); i < b.length; i++) lines.push(b.getLine(i).translateToString(true));
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      t.dispose();
      resolve(lines.join('\n'));
    });
  });
}

// every logged-in session its owner shared, read only, by: one person's only
const screens = (by = '') => Promise.all([...sessions.values()].filter((s) => s.shared && s.stream && (!by || s.owner === by))
  .map(async (s) => ({ id: s.sid.slice(0, 6), cols: s.cols, rows: s.rows, screen: await render(s) })));

// a command typed into the owner's shared, logged-in screen, left for them to
// run, then the screen once Enter's output settles
async function type(by, id, text, waitS) {
  const mine = [...sessions.values()].filter((x) => x.shared && x.stream && by && x.owner === by && x.sid.startsWith(id || ''));
  if (mine.length !== 1) throw new Error(mine.length ? 'several shared terminals, give its id' : 'no terminal of theirs is shared with phosphorus and logged in here');
  const s = mine[0];
  if (s.waiter) throw new Error('already waiting on a command there');
  const before = await render(s);
  if (SECRET_PROMPT.test(before.split('\n').pop() || '')) throw new Error('the terminal is asking for a credential, they type that themselves');
  const cmd = String(text || '').replace(CONTROL, '').slice(0, MAX_COMMAND);
  if (!cmd.trim()) throw new Error('nothing to type');
  s.stream.write(cmd);
  const until = Date.now() + waitS * 1000;
  const key = await new Promise((resolve) => {
    const t = setTimeout(() => { s.waiter = null; resolve('timeout'); }, waitS * 1000);
    s.waiter = (k) => { clearTimeout(t); s.waiter = null; resolve(k); };
  });
  const id6 = s.sid.slice(0, 6);
  if (key !== 'enter') {
    const why = { cancel: 'they cancelled it', closed: 'the terminal closed', timeout: `no Enter in ${waitS}s, still typed there` }[key];
    return { id: id6, ran: false, why, screen: await render(s) };
  }
  const entered = Date.now();
  while (Date.now() < until && Date.now() - Math.max(s.lastOut, entered) < SETTLE_MS && sessions.has(s.sid)) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const settled = Date.now() - Math.max(s.lastOut, entered) >= SETTLE_MS;
  return {
    id: id6, ran: true, screen: await render(s),
    ...(settled ? {} : { note: 'still printing, terminal_screen with wait_s reads more' }),
  };
}

module.exports = { attach, forward, sessionCount, screens, type };
