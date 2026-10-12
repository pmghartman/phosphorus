'use strict';
// shared code and text: one live session per file, held on the host whose
// share has it, every editor tab on that file joined over a socket, the tab's
// own host passing it on. Edits are text operations (ot.js's: a retain as a
// positive count, a delete as a negative one, an insert as a string), rebased
// here in arrival order and sent to everyone, so every tab ends on the same
// text. A save writes the session's text through the share's own perms

const WebSocket = require('ws');
const files = require('./files');

const MAX_TEXT = 512 * 1024;
const HISTORY = 2000;
// a session outliving its last tab this long, a reload never losing edits
const IDLE_MS = 60 * 1000;
const HOP_TIMEOUT_MS = 5000;
// an agent's edit typed in this many steps, its caret kept a while after
const TYPE_STEPS = 24;
const TYPE_MS = 40;
const AGENT_STAY_MS = 10 * 1000;
// saved on its own once typing pauses, never further behind than the max
const AUTOSAVE_MS = 1500;
const AUTOSAVE_MAX_MS = 10 * 1000;

// --- text operations -------------------------------------------------------------

const isRetain = (o) => typeof o === 'number' && o > 0;
const isDelete = (o) => typeof o === 'number' && o < 0;
const isInsert = (o) => typeof o === 'string';

// adjacent parts of a kind merged, an insert kept before a delete beside it
function builder() {
  const ops = [];
  const add = (o) => {
    if (o === 0 || o === '') return;
    const last = ops[ops.length - 1];
    if (isInsert(o) && isDelete(last)) {
      const before = ops[ops.length - 2];
      if (isInsert(before)) ops[ops.length - 2] = before + o; else ops.splice(ops.length - 1, 0, o);
    } else if (last !== undefined && typeof last === typeof o && (isInsert(o) || (o > 0) === (last > 0))) ops[ops.length - 1] = last + o;
    else ops.push(o);
  };
  return { ops, retain: (n) => add(n), insert: (s) => add(s), del: (n) => add(-n) };
}

const baseLength = (ops) => ops.reduce((n, o) => n + (isInsert(o) ? 0 : Math.abs(o)), 0);
const valid = (ops) => Array.isArray(ops) && ops.length <= 10000
  && ops.every((o) => (typeof o === 'string' && o.length) || (Number.isSafeInteger(o) && o !== 0));

function apply(doc, ops) {
  if (baseLength(ops) !== doc.length) throw new Error('operation does not fit the text');
  let out = '';
  let at = 0;
  for (const o of ops) {
    if (isInsert(o)) out += o;
    else if (o > 0) { out += doc.slice(at, at + o); at += o; } else at -= o;
  }
  return out;
}

// a and b made from the same text: a' after b and b' after a, the same text
// either way, a's insert first where both insert at one place
function transform(a, b) {
  const a1 = builder();
  const b1 = builder();
  let i = 0;
  let j = 0;
  let x = a[i++];
  let y = b[j++];
  for (;;) {
    if (x === undefined && y === undefined) break;
    if (isInsert(x)) { a1.insert(x); b1.retain(x.length); x = a[i++]; continue; }
    if (isInsert(y)) { a1.retain(y.length); b1.insert(y); y = b[j++]; continue; }
    if (x === undefined || y === undefined) throw new Error('operations of different lengths');
    const n = Math.min(Math.abs(x), Math.abs(y));
    if (isRetain(x) && isRetain(y)) { a1.retain(n); b1.retain(n); }
    else if (isDelete(x) && isRetain(y)) a1.del(n);
    else if (isRetain(x) && isDelete(y)) b1.del(n);
    // both deleting: gone already on either side
    x = Math.abs(x) === n ? a[i++] : x > 0 ? x - n : x + n;
    y = Math.abs(y) === n ? b[j++] : y > 0 ? y - n : y + n;
  }
  return [a1.ops, b1.ops];
}

// where a place in the text lands after an edit
function mapPos(ops, pos) {
  let i = 0;
  let j = 0;
  for (const o of ops) {
    if (isInsert(o)) { j += o.length; continue; }
    const n = Math.abs(o);
    if (pos <= i + n) return o > 0 ? j + (pos - i) : j;
    i += n;
    if (o > 0) j += n;
  }
  return j;
}

// --- sessions -----------------------------------------------------------------

const sessions = new Map();
const keyOf = (share, rel) => `${share.id}\n${rel}`;

function people(s) {
  return [...s.clients].filter((c) => c.who).map((c) => ({ name: c.who.name, color: c.who.color, pos: c.pos || 0, ...(c.agent ? { agent: true } : {}) }));
}

function send(ws, body) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(body)); }
function toAll(s, body) { for (const c of s.clients) send(c, body); }

function open(share, rel) {
  const key = keyOf(share, rel);
  const held = sessions.get(key);
  if (held) { clearTimeout(held.idle); return [200, held]; }
  const [status, f] = files.read(share, rel);
  if (status === 404) return [200, newSession(key, share, rel, '', -1)];
  if (status !== 200) return [status, f];
  if (f.binary) return [415, { error: 'a binary file, not text' }];
  if (f.tooBig) return [413, { error: 'over 512KB, too big to edit here' }];
  return [200, newSession(key, share, rel, f.text, 0)];
}

// held with \n alone, as every textarea gives it back, the file's own endings on save
const lf = (t) => t.replace(/\r\n?/g, '\n');
const onDisk = (s) => (s.eol === '\r\n' ? s.text.replace(/\n/g, '\r\n') : s.text);

// saved: the version on disk, -1 for a file not made yet
function newSession(key, share, rel, text, saved) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const s = { key, share, rel, text: lf(text), eol, version: 0, saved, history: [], clients: new Set(), idle: null };
  sessions.set(key, s);
  return s;
}

function leave(s, ws) {
  s.clients.delete(ws);
  toAll(s, { type: 'people', people: people(s) });
  if (!s.clients.size) s.idle = setTimeout(() => { saveNow(s); sessions.delete(s.key); }, IDLE_MS);
}

// the session's text to disk through the share's perms, everyone told
function saveNow(s, by = '') {
  clearTimeout(s.autosave);
  s.dirtyAt = 0;
  if (s.saved === s.version) return [200, { path: s.rel }];
  if (!files.can(s.share, 'w')) return [403, { error: 'this share is read-only' }];
  const [status, out] = files.save(s.share, s.rel, { text: onDisk(s) });
  if (status !== 200) { toAll(s, { type: 'error', error: out.error || `save failed (${status})` }); return [status, out]; }
  s.saved = s.version;
  toAll(s, { type: 'saved', v: s.version, by });
  return [status, out];
}
function saveSoon(s) {
  if (!files.can(s.share, 'w')) return;
  clearTimeout(s.autosave);
  s.dirtyAt ||= Date.now();
  s.autosave = setTimeout(() => saveNow(s), Math.max(0, Math.min(AUTOSAVE_MS, s.dirtyAt + AUTOSAVE_MAX_MS - Date.now())));
}

function onMessage(s, ws, msg) {
  if (msg.type === 'join') {
    ws.who = { name: String(msg.name || 'anon').slice(0, 32), color: String(msg.color || '').slice(0, 16) };
    toAll(s, { type: 'people', people: people(s) });
    return;
  }
  if (msg.type === 'cursor') {
    ws.pos = Math.max(0, Math.min(s.text.length, Number(msg.pos) || 0));
    toAll(s, { type: 'people', people: people(s) });
    return;
  }
  if (msg.type === 'save') {
    if (!files.can(s.share, 'w')) { send(ws, { type: 'error', error: 'this share is read-only' }); return; }
    saveNow(s, ws.who ? ws.who.name : '');
    return;
  }
  if (msg.type !== 'op') return;
  if (!files.can(s.share, 'w')) { send(ws, { type: 'error', error: 'this share is read-only' }); return; }
  const base = Number(msg.base);
  let ops = msg.ops;
  const oldest = s.version - s.history.length;
  // out of step: its whole text again, its edit dropped
  const resync = () => send(ws, { type: 'resync', text: s.text, v: s.version, saved: s.saved, id: msg.id });
  if (!valid(ops) || !Number.isSafeInteger(base) || base > s.version || base < oldest) { resync(); return; }
  try {
    for (const h of s.history.slice(base - oldest)) [ops] = transform(ops, h);
    const text = apply(s.text, ops);
    if (text.length > MAX_TEXT) { send(ws, { type: 'error', error: 'over 512KB, the edit was not kept' }); resync(); return; }
    s.text = text;
  } catch { resync(); return; }
  commit(s, ops, msg.id, ws);
}

// an edit kept and sent to all, everyone else's caret carried along with it
function commit(s, ops, id, by) {
  s.version += 1;
  s.history.push(ops);
  if (s.history.length > HISTORY) s.history.shift();
  for (const c of s.clients) if (c !== by && c.pos) c.pos = mapPos(ops, c.pos);
  toAll(s, { type: 'op', v: s.version, ops, id, by: by.who ? by.who.name : '' });
  if (by.agent) toAll(s, { type: 'people', people: people(s) });
  saveSoon(s);
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// a save from outside the editor (phos, the files tab): into the file's live
// session when one is open, an agent typing it in with its caret shown,
// straight to disk otherwise
async function write(share, rel, p) {
  const s = sessions.get(keyOf(share, rel));
  if (!s || !s.clients.size) return files.save(share, rel, p);
  if (!files.can(share, 'w')) return [403, { error: 'this share is read-only' }];
  let target = typeof p.text === 'string' ? lf(p.text) : undefined;
  if (typeof p.old === 'string' && typeof p.new === 'string') {
    const old = lf(p.old);
    const at = old ? s.text.indexOf(old) : -1;
    if (at < 0) return [409, { error: 'old text not found' }];
    if (s.text.indexOf(old, at + 1) >= 0) return [409, { error: 'old text found more than once, give more of it' }];
    target = s.text.slice(0, at) + lf(p.new) + s.text.slice(at + old.length);
  }
  if (typeof target !== 'string') return [400, { error: 'text, or old and new' }];
  if (target.length > MAX_TEXT) return [413, { error: 'over 512KB' }];
  const by = p.by && typeof p.by === 'object' ? p.by : {};
  const agent = { agent: true, readyState: 0, who: { name: String(by.name || 'phos').slice(0, 32), color: String(by.color || '').slice(0, 16) }, pos: 0 };
  clearTimeout(s.idle);
  s.clients.add(agent);
  // the one changed run, by the texts' common ends: deleted at once, typed in after
  let a = 0;
  while (a < s.text.length && a < target.length && s.text[a] === target[a]) a += 1;
  let e = 0;
  while (e < s.text.length - a && e < target.length - a && s.text[s.text.length - 1 - e] === target[target.length - 1 - e]) e += 1;
  const gone = s.text.length - a - e;
  const typed = target.slice(a, target.length - e);
  const put = (at, del, ins) => {
    const b = builder();
    b.retain(at);
    b.insert(ins);
    b.del(del);
    b.retain(s.text.length - at - del);
    s.text = apply(s.text, b.ops);
    agent.pos = at + ins.length;
    commit(s, b.ops, `agent-${Date.now()}`, agent);
  };
  agent.pos = a;
  toAll(s, { type: 'people', people: people(s) });
  if (gone) put(a, gone, '');
  const step = Math.max(1, Math.ceil(typed.length / TYPE_STEPS));
  for (let i = 0; i < typed.length; i += step) {
    await sleep(TYPE_MS);
    put(Math.min(agent.pos, s.text.length), 0, typed.slice(i, i + step));
  }
  const [status, out] = saveNow(s, agent.who.name);
  setTimeout(() => leave(s, agent), AGENT_STAY_MS);
  return [status, status === 200 ? { ...out, live: true, note: 'typed into the open editor and saved' } : out];
}

// a tab on this host's file: its session, opened on the first
function attach(ws, shareId, rel) {
  ws.on('error', () => {});
  const share = files.shareOf(shareId);
  const fail = (error) => { send(ws, { type: 'error', error }); ws.close(1000); };
  if (!files.enabled() || !share) { fail('no such share here'); return; }
  if (!files.can(share, 'r')) { fail('this share is not readable'); return; }
  const [status, s] = open(share, String(rel || ''));
  if (status !== 200) { fail(s.error || `can't open it (${status})`); return; }
  s.clients.add(ws);
  send(ws, { type: 'init', text: s.text, v: s.version, saved: s.saved, perms: share.perms, people: people(s) });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg && typeof msg === 'object') onMessage(s, ws, msg);
  });
  ws.on('close', () => leave(s, ws));
}

// a tab whose file is on another host: passed through to it as is
function forward(ws, lookup) {
  ws.on('error', () => {});
  let up = null;
  const early = [];
  ws.on('message', (d) => { if (up && up.readyState === WebSocket.OPEN) up.send(d.toString()); else early.push(d.toString()); });
  ws.on('close', () => { if (up) up.terminate(); });
  lookup.then((url) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!url) { send(ws, { type: 'error', error: "can't find that host on the tailnet" }); ws.close(1000); return; }
    up = new WebSocket(url, { handshakeTimeout: HOP_TIMEOUT_MS });
    up.on('open', () => { for (const d of early) up.send(d); early.length = 0; });
    up.on('message', (d) => { if (ws.readyState === WebSocket.OPEN) ws.send(d.toString()); });
    up.on('close', () => ws.close(1000));
    up.on('error', (err) => { send(ws, { type: 'error', error: `that host didn't answer: ${err.message}` }); ws.close(1000); });
  });
}

module.exports = { attach, forward, write, transform, apply };
