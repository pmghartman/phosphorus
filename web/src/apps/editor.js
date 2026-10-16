import {
  codeKey,
  codeLang,
  codeName,
  codeTabs,
  color,
  colorFor,
  dk,
  editorGone,
  editors,
  el,
  esc,
  lines,
  name,
  shareMenu,
} from '../app.js';
import { ERR_MAX, highlight, parserFor, parserNow, syntaxErrors } from '../lezer.js';
import { mdBlocks, renderMd } from '../md.js';

// --- code editor ------------------------------------------------------------------
// a share's text or code file in a tab of its own, joined to the file's live
// session on its host, so everyone with it open edits the same text: highlighted
// as it's typed (a textarea over its highlighted copy), indents kept, pairs
// closed, syntax errors marked by a parse alone, saved once typing pauses;
// nothing in it ever runs


// --- the text operations the session speaks (collab.js's, here for the tab's end) ---

const opIns = (o) => typeof o === 'string';
const opDel = (o) => typeof o === 'number' && o < 0;
function opBuilder() {
  const ops = [];
  const add = (o) => {
    if (o === 0 || o === '') return;
    const last = ops[ops.length - 1];
    if (opIns(o) && opDel(last)) {
      const before = ops[ops.length - 2];
      if (opIns(before)) ops[ops.length - 2] = before + o; else ops.splice(ops.length - 1, 0, o);
    } else if (last !== undefined && typeof last === typeof o && (opIns(o) || (o > 0) === (last > 0))) ops[ops.length - 1] = last + o;
    else ops.push(o);
  };
  return { ops, retain: (n) => add(n), insert: (s) => add(s), del: (n) => add(-n) };
}
function opApply(doc, ops) {
  let out = '';
  let at = 0;
  for (const o of ops) {
    if (opIns(o)) out += o;
    else if (o > 0) { out += doc.slice(at, at + o); at += o; } else at -= o;
  }
  return out;
}
function opTransform(a, b) {
  const a1 = opBuilder();
  const b1 = opBuilder();
  let i = 0;
  let j = 0;
  let x = a[i++];
  let y = b[j++];
  for (;;) {
    if (x === undefined && y === undefined) break;
    if (opIns(x)) { a1.insert(x); b1.retain(x.length); x = a[i++]; continue; }
    if (opIns(y)) { a1.retain(y.length); b1.insert(y); y = b[j++]; continue; }
    if (x === undefined || y === undefined) throw new Error('operations of different lengths');
    const n = Math.min(Math.abs(x), Math.abs(y));
    if (x > 0 && y > 0) { a1.retain(n); b1.retain(n); } else if (x < 0 && y > 0) a1.del(n); else if (x > 0 && y < 0) b1.del(n);
    x = Math.abs(x) === n ? a[i++] : x > 0 ? x - n : x + n;
    y = Math.abs(y) === n ? b[j++] : y > 0 ? y - n : y + n;
  }
  return [a1.ops, b1.ops];
}
// one replace: what changed between two texts, by their common ends
function opDiff(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s += 1;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e += 1;
  const o = opBuilder();
  o.retain(s);
  o.insert(b.slice(s, b.length - e));
  o.del(a.length - s - e);
  o.retain(e);
  return o.ops;
}
// where a place in the text lands after an edit
function opMap(ops, pos) {
  let i = 0;
  let j = 0;
  for (const o of ops) {
    if (opIns(o)) { j += o.length; continue; }
    const n = Math.abs(o);
    if (pos <= i + n) return o > 0 ? j + (pos - i) : j;
    i += n;
    if (o > 0) j += n;
  }
  return j;
}

// --- editors ---------------------------------------------------------------------

const anyCodeDirty = () => [...editors.values()].some((ed) => ed.dirty());
window.addEventListener('beforeunload', (e) => { if (anyCodeDirty()) e.preventDefault(); });

function codeEditor(view, file, btn, id) {
  const lang = codeLang(file.path) || { hl: 'plaintext', check: '', comment: '' };
  const bar = el('div', 'code-bar');
  const pathEl = el('span', 'code-path', file.label);
  const whoEl = el('span', 'code-who');
  const stateEl = el('span', 'code-state', 'connecting');
  const errEl = Object.assign(el('button', 'code-errs-btn'), { type: 'button', title: 'show the syntax errors', hidden: true });
  const saveBtn = Object.assign(el('button', 'code-btn', 'save'), { type: 'button', title: 'save to the share now' });
  const isMd = lang.hl === 'markdown';
  const viewBtn = Object.assign(el('button', 'code-btn'), { type: 'button', hidden: !isMd });
  const shareBtn = Object.assign(el('button', 'code-btn', 'share'), { type: 'button', title: 'invite someone to work on it with you' });
  bar.append(pathEl, el('span', 'code-lang', lang.hl), whoEl, errEl, stateEl, viewBtn, shareBtn, saveBtn);

  const scroller = el('div', 'code-ed');
  const gutter = el('div', 'code-gutter');
  const nums = el('pre', 'code-nums');
  gutter.append(nums);
  const body = el('div', 'code-body');
  const pre = el('pre', 'code-hl');
  const code = el('code', `hljs language-${lang.hl}`);
  pre.append(code);
  const squig = el('pre', 'code-hl code-squig');
  const ta = Object.assign(document.createElement('textarea'), { className: 'code-ta', spellcheck: false, autocomplete: 'off', wrap: 'off' });
  ta.setAttribute('autocapitalize', 'off');
  ta.setAttribute('aria-label', file.label);
  body.append(pre, squig, ta);
  scroller.append(gutter, body);

  const out = el('div', 'code-out');
  out.hidden = true;
  const outHead = el('div', 'code-out-head');
  const outTitle = el('span', 'code-out-title');
  const outClose = Object.assign(el('button', 'code-btn', '×'), { type: 'button', title: 'hide errors' });
  outHead.append(outTitle, outClose);
  const outList = el('div', 'code-out-text');
  out.append(outHead, outList);
  // markdown rendered, each block its source again on a double click
  const mdView = Object.assign(el('div', 'code-md'), { hidden: true, tabIndex: -1 });
  view.append(bar, scroller, mdView, out);

  // the session: the server's text and version, the edit in flight to it
  let S = '';
  let V = 0;
  let saved = -1;
  // the text as last saved, when this tab knows it, so an undo back to it is clean
  let savedText = null;
  let perms = '';
  let ready = false;
  let inflight = null;
  let wantSave = false;
  let sock = null;
  let closed = false;
  let retry = 1000;
  let people = [];
  // this tab's own id in the session, its own caret never drawn
  let me = 0;
  let opSeq = 0;
  const canWrite = () => perms.includes('w');
  const say = (body) => sock && sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify(body));

  // --- drawing ---
  let drawFrame = 0;
  let hlText = null;
  const HL_MAX = 200 * 1024;
  function draw() {
    drawFrame = 0;
    const text = ta.value;
    // a tab shown again with the same text: its highlight kept
    if (text === hlText) { paintMarks(); return; }
    hlText = text;
    const parser = text.length <= HL_MAX && parserNow(lang.check);
    if (parser) code.innerHTML = `${highlight(parser, text)}\n`;
    else {
      code.textContent = `${text}\n`;
      if (lang.check && text.length <= HL_MAX) parserFor(lang.check).then((p) => { if (p) { hlText = null; redraw(); } });
      else if (lang.hl !== 'plaintext' && text.length <= HL_MAX) serverHighlight(text);
    }
    const lines = text.split('\n').length;
    if (nums.dataset.n !== String(lines)) {
      nums.dataset.n = String(lines);
      nums.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
    }
    paintMarks();
    checkSoon();
  }
  const redraw = () => { drawFrame ||= requestAnimationFrame(draw); mdSoon(); };
  // a grammar the page has no parser for: chroma's, once typing pauses
  let hlTimer = 0;
  function serverHighlight(text) {
    clearTimeout(hlTimer);
    hlTimer = setTimeout(async () => {
      try {
        const r = await fetch('/api/md', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ highlight: lang.hl, text }) });
        const { html } = r.ok ? await r.json() : {};
        if (typeof html === 'string' && ta.value === text) code.innerHTML = `${html}\n`;
      } catch {}
    }, 150);
  }

  // --- markdown rendered: the source's blocks drawn, one edited at a time in place ---
  const MD_KEY = 'phosphorus-md-rendered';
  let rendered = false;
  let mdEditing = null;
  let mdTimer = 0;
  const mdSoon = () => { if (rendered) { clearTimeout(mdTimer); mdTimer = setTimeout(paintMd, 120); } };
  function setRendered(on) {
    rendered = isMd && on;
    scroller.hidden = rendered;
    mdView.hidden = !rendered;
    viewBtn.textContent = rendered ? 'source' : 'view';
    viewBtn.title = rendered ? 'back to the markdown source' : 'show it rendered, a block edited on a double click';
    if (isMd) try { localStorage.setItem(MD_KEY, rendered ? '1' : ''); } catch {}
    if (rendered) paintMd(); else if (mdEditing) mdEditing.box.blur();
  }
  let mdSeq = 0;
  async function paintMd() {
    if (!rendered || mdEditing) return;
    const text = ta.value;
    const seq = mdSeq += 1;
    const blocks = await mdBlocks(text);
    if (seq !== mdSeq || !rendered || mdEditing || ta.value !== text) return;
    const top = mdView.scrollTop;
    const edit = canWrite();
    mdView.replaceChildren(...blocks.map((b) => {
      const d = el('div', 'md-block');
      renderMd(d, b.raw.replace(/\n+$/, ''), false, b.html);
      if (edit) {
        d.title = 'double click to edit';
        d.addEventListener('dblclick', (e) => { if (!e.target.closest('input, a, summary')) editBlock(d, b); });
        d.querySelectorAll('li.task input').forEach((box, i) => {
          box.disabled = false;
          box.addEventListener('change', () => tickTask(b, i, box.checked));
        });
      }
      return d;
    }));
    if (!blocks.length) mdView.append(el('div', 'md-empty', 'empty'));
    if (edit) {
      const add = Object.assign(el('button', 'md-add', '+ add a block'), { type: 'button' });
      add.addEventListener('click', () => {
        const t = ta.value;
        const gap = !t || t.endsWith('\n\n') ? '' : t.endsWith('\n') ? '\n' : '\n\n';
        editBlock(add, { from: t.length, raw: '', gap });
      });
      mdView.append(add);
    }
    mdView.scrollTop = top;
  }
  // a task's [ ] or [x] flipped in the source, its block found again if it moved
  function tickTask(b, i, on) {
    const marks = [...b.raw.matchAll(/^[ \t>]*(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\]/gm)];
    const now = ta.value;
    const from = now.slice(b.from, b.from + b.raw.length) === b.raw ? b.from : now.indexOf(b.raw);
    if (!marks[i] || from < 0) { paintMd(); return; }
    const at = from + marks[i].index + marks[i][0].length - 2;
    ta.setRangeText(on ? 'x' : ' ', at, at + 1);
    ta.dispatchEvent(new Event('input'));
  }
  function editBlock(d, b) {
    if (mdEditing) return;
    const src = b.raw.replace(/\n+$/, '');
    const tail = b.raw.slice(src.length) || (b.raw ? '' : '\n');
    const box = Object.assign(document.createElement('textarea'), { className: 'md-edit', value: src, spellcheck: true });
    const grow = () => { box.style.height = 'auto'; box.style.height = `${box.scrollHeight + 2}px`; };
    d.replaceWith(box);
    mdEditing = { box };
    grow();
    box.focus();
    const done = (keep) => {
      if (mdEditing?.box !== box) return;
      mdEditing = null;
      if (keep && box.value !== src) {
        // found again if others' edits moved it meanwhile
        const now = ta.value;
        const from = now.slice(b.from, b.from + b.raw.length) === b.raw ? b.from : b.raw ? now.indexOf(b.raw) : now.length;
        if (from < 0) paintState('that block changed under you, your edit was not kept');
        else {
          const put = box.value.trim() ? `${b.gap || ''}${box.value.replace(/\n+$/, '')}${tail}` : '';
          ta.setRangeText(put, from, from + b.raw.length, 'end');
          ta.dispatchEvent(new Event('input'));
        }
      }
      paintMd();
    };
    box.addEventListener('input', grow);
    box.addEventListener('blur', () => done(true));
    box.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); mdView.focus(); }
      else if (mod && e.key === 'Enter') { e.preventDefault(); done(true); mdView.focus(); }
      // a tab character typed in, focus staying in the block
      else if (e.key === 'Tab' && !mod && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (!document.execCommand('insertText', false, '\t')) {
          box.setRangeText('\t', box.selectionStart, box.selectionEnd, 'end');
          grow();
        }
      }
    });
  }
  viewBtn.addEventListener('click', () => setRendered(!rendered));

  // --- syntax errors: a squiggle under each, a mark in the gutter, a list to jump from ---
  let errs = [];
  let checkTimer = 0;
  const checkSoon = () => { clearTimeout(checkTimer); checkTimer = setTimeout(check, 300); };
  async function check() {
    const parser = lang.check && ta.value.length <= HL_MAX && await parserFor(lang.check);
    const text = ta.value;
    errs = parser ? syntaxErrors(parser, text) : [];
    const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    let html = '';
    let at = 0;
    for (const e of errs) {
      const to = Math.max(e.to, Math.min(e.from + 1, text.length));
      if (e.from < at) continue;
      const bit = text.slice(e.from, to).replace(/\n/g, ' \n');
      html += `${esc(text.slice(at, e.from))}<mark>${esc(bit) || ' '}</mark>`;
      at = to;
    }
    squig.innerHTML = `${html}${esc(text.slice(at))}\n`;
    const lineOf = (p) => text.slice(0, p).split('\n').length;
    errEl.hidden = !errs.length;
    errEl.textContent = `${errs.length}${errs.length >= ERR_MAX ? '+' : ''} error${errs.length === 1 ? '' : 's'}`;
    outTitle.textContent = errEl.textContent;
    outList.replaceChildren(...errs.map((e) => {
      const row = Object.assign(el('button', 'code-err-row'), { type: 'button' });
      row.append(el('span', 'code-out-dim', `line ${lineOf(e.from)}`), el('span', 'code-out-err', e.what));
      row.addEventListener('click', () => { ta.focus(); ta.setSelectionRange(e.from, e.from); caretInView(); });
      return row;
    }));
    if (!errs.length) out.hidden = true;
    paintMarks();
  }

  // the others' carets as marks in the gutter, their colour, their name on hover
  function paintMarks() {
    for (const m of gutter.querySelectorAll('.code-mark')) m.remove();
    const lh = parseFloat(getComputedStyle(nums).lineHeight) || 18;
    const padTop = parseFloat(getComputedStyle(nums).paddingTop) || 0;
    for (const line of new Set(errs.map((e) => ta.value.slice(0, Math.min(e.from, ta.value.length)).split('\n').length - 1))) {
      const mk = Object.assign(el('div', 'code-mark code-mark-err'), { title: 'syntax error' });
      mk.style.top = `${padTop + line * lh}px`;
      mk.style.height = `${lh}px`;
      gutter.append(mk);
    }
    for (const c of body.querySelectorAll('.code-caret')) c.remove();
    const cs = getComputedStyle(ta);
    const cw = chWidthIn(ta);
    for (const p of people) {
      if (me ? p.id === me : p.name === name) continue;
      const before = ta.value.slice(0, Math.min(p.pos, ta.value.length));
      const line = before.split('\n').length - 1;
      const col = [...before.slice(before.lastIndexOf('\n') + 1)].reduce((n, ch) => (ch === '\t' ? n + 4 - (n % 4) : n + 1), 0);
      const tint = p.color || colorFor(p.name);
      const mk = Object.assign(el('div', p.agent ? 'code-mark agent' : 'code-mark'), { title: p.name });
      mk.style.top = `${padTop + line * lh}px`;
      mk.style.height = `${lh}px`;
      if (!p.agent) mk.style.background = tint;
      gutter.append(mk);
      // their caret in the text, their name over it
      const caret = el('div', p.agent ? 'code-caret agent' : 'code-caret');
      caret.style.cssText = `top:${parseFloat(cs.paddingTop) + line * lh}px;left:${parseFloat(cs.paddingLeft) + col * cw}px;height:${lh}px;--who:${tint}`;
      const flag = caret.appendChild(el('span', 'code-caret-name', p.agent ? '' : p.name));
      if (p.agent) flag.append(el('span', 'who-model', p.name));
      body.append(caret);
    }
  }

  const dirty = () => ready && !(saved < 0 && !ta.value) && (savedText === null || !!inflight || ta.value !== S || S !== savedText);
  function paintState(note) {
    const d = dirty();
    btn.classList.toggle('dirty', d);
    btn.querySelector('.tab-label').textContent = `${codeName(file)}${d ? ' •' : ''}`;
    stateEl.textContent = note || (!ready ? 'connecting' : !canWrite() ? 'read-only' : saved < 0 && !ta.value ? 'new file' : d ? 'saving' : 'saved');
    stateEl.classList.toggle('bad', !!note);
    saveBtn.disabled = !ready || !canWrite();
    ta.readOnly = !ready || !canWrite();
    const others = people.filter((p) => p.name !== name);
    whoEl.replaceChildren(...others.map((p) => {
      const s = el('span', p.agent ? 'who who-model' : 'who', p.name);
      if (!p.agent) s.style.color = p.color || colorFor(p.name);
      return s;
    }));
    whoEl.hidden = !others.length;
  }

  // the caret kept in view as it moves, the scroller being the editor, not the box
  function caretInView() {
    const before = ta.value.slice(0, ta.selectionEnd);
    const line = before.split('\n').length - 1;
    const col = before.length - before.lastIndexOf('\n') - 1;
    const cs = getComputedStyle(ta);
    const lh = parseFloat(cs.lineHeight) || 18;
    const cw = chWidthIn(ta);
    const y = parseFloat(cs.paddingTop) + line * lh;
    const x = gutter.offsetWidth + parseFloat(cs.paddingLeft) + col * cw;
    if (y < scroller.scrollTop) scroller.scrollTop = y;
    else if (y + lh > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + lh - scroller.clientHeight + 4;
    if (x < scroller.scrollLeft + gutter.offsetWidth) scroller.scrollLeft = Math.max(0, x - gutter.offsetWidth - cw * 4);
    else if (x > scroller.scrollLeft + scroller.clientWidth - cw * 2) scroller.scrollLeft = x - scroller.clientWidth + cw * 4;
  }

  // --- the session ---
  function flush() {
    if (inflight || !ready || !canWrite() || ta.value === S) return;
    inflight = { id: `${id}-${opSeq += 1}`, ops: opDiff(S, ta.value) };
    say({ type: 'op', base: V, ops: inflight.ops, id: inflight.id });
  }

  function setText(text, keepSel) {
    const [s0, s1] = [ta.selectionStart, ta.selectionEnd];
    ta.value = text;
    if (keepSel) ta.setSelectionRange(Math.min(s0, text.length), Math.min(s1, text.length));
    redraw();
  }

  function remote(ops) {
    const C = ta.value;
    const P = inflight ? opApply(S, inflight.ops) : S;
    let r = ops;
    if (inflight) [inflight.ops, r] = opTransform(inflight.ops, r);
    const [, r2] = opTransform(opDiff(P, C), r);
    const [s0, s1] = [ta.selectionStart, ta.selectionEnd];
    const top = scroller.scrollTop;
    ta.value = opApply(C, r2);
    ta.setSelectionRange(opMap(r2, s0), opMap(r2, s1));
    scroller.scrollTop = top;
    redraw();
  }

  let refused = '';
  function connect() {
    if (closed) return;
    const q = new URLSearchParams({ share: file.share, path: file.path });
    sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/code/${encodeURIComponent(file.host)}?${q}`);
    // the chat's name, else the user this desktop logged into the host as
    const who = name || dk.creds.get(file.host)?.user || 'anon';
    sock.onopen = () => { retry = 1000; say({ type: 'join', name: who, color: color || colorFor(who) }); };
    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'init' || msg.type === 'resync') {
        const lost = ready && ta.value !== S && ta.value !== msg.text;
        S = msg.text;
        V = msg.v;
        saved = msg.saved;
        savedText = saved >= 0 && saved === V ? S : null;
        if (msg.perms !== undefined) perms = msg.perms;
        if (msg.people) people = msg.people;
        if (msg.you) me = msg.you;
        inflight = null;
        ready = true;
        setText(S, true);
        paintState(lost ? 'out of step, your last edit was dropped' : '');
        if (msg.type === 'init' && !view.dataset.seen) { view.dataset.seen = '1'; ta.setSelectionRange(0, 0); }
      } else if (msg.type === 'op') {
        if (inflight && msg.id === inflight.id) {
          S = opApply(S, msg.ops);
          V = msg.v;
          inflight = null;
          flush();
        } else {
          remote(msg.ops);
          S = opApply(S, msg.ops);
          V = msg.v;
        }
        if (wantSave && !inflight && ta.value === S) { wantSave = false; say({ type: 'save' }); }
        paintState();
      } else if (msg.type === 'saved') {
        saved = msg.v;
        if (saved === V) savedText = S;
        paintState();
      } else if (msg.type === 'people') {
        people = Array.isArray(msg.people) ? msg.people : [];
        paintState();
        paintMarks();
      } else if (msg.type === 'error') {
        refused = msg.error;
        paintState(msg.error);
      }
    };
    sock.onclose = () => {
      ready = false;
      inflight = null;
      if (closed) return;
      // the host said why: said once, never retried
      if (refused) { paintState(refused); return; }
      paintState('reconnecting');
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 10000);
    };
  }

  // --- editing ---
  const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
  const CLOSERS = new Set([')', ']', '}']);
  function unit() {
    const t = ta.value;
    if (/^\t/m.test(t) && !/^ {2}/m.test(t)) return '\t';
    if (lang.hl === 'python') return '    ';
    const m = t.slice(0, 20000).match(/^( +)\S/gm) || [];
    const w = Math.min(...m.map((s) => s.length - 1).filter((n) => n > 0), 8);
    return ' '.repeat(Number.isFinite(w) && w <= 8 && w > 0 ? (w >= 4 ? 4 : w) : 2);
  }
  // typed in through the browser's own edit, so ctrl+z undoes it
  function typeIn(from, to, text, selFrom, selTo) {
    ta.setSelectionRange(from, to);
    const ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
    if (!ok) { ta.setRangeText(text, from, to, 'end'); ta.dispatchEvent(new Event('input')); }
    if (selFrom !== undefined) ta.setSelectionRange(selFrom, selTo ?? selFrom);
  }
  const lineStart = (p) => ta.value.lastIndexOf('\n', p - 1) + 1;
  const lineEnd = (p) => { const e = ta.value.indexOf('\n', p); return e < 0 ? ta.value.length : e; };

  function shiftLines(out) {
    const u = unit();
    const a = lineStart(ta.selectionStart);
    const b = lineEnd(ta.selectionEnd - (ta.selectionEnd > ta.selectionStart && ta.value[ta.selectionEnd - 1] === '\n' ? 1 : 0));
    const lines = ta.value.slice(a, b).split('\n');
    const n = u === '\t' ? 4 : u.length;
    const next = lines.map((l) => (out
      ? (l.startsWith('\t') ? l.slice(1) : l.replace(new RegExp(`^ {1,${n}}`), ''))
      : (l ? u + l : l))).join('\n');
    typeIn(a, b, next, a, a + next.length);
  }

  function toggleComment() {
    if (!lang.comment) return;
    const c = lang.comment;
    const a = lineStart(ta.selectionStart);
    const b = lineEnd(ta.selectionEnd);
    const lines = ta.value.slice(a, b).split('\n');
    const on = lines.filter((l) => l.trim()).every((l) => l.trimStart().startsWith(c));
    const next = lines.map((l) => {
      if (!l.trim()) return l;
      if (on) return l.replace(new RegExp(`^(\\s*)${c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} ?`), '$1');
      const ind = l.match(/^\s*/)[0];
      return `${ind}${c} ${l.slice(ind.length)}`;
    }).join('\n');
    typeIn(a, b, next, a, a + next.length);
  }

  // ctrl+s the file's save, never the browser's save page
  view.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); save(); }
  });

  ta.addEventListener('keydown', (e) => {
    const s = ta.selectionStart;
    const t = ta.selectionEnd;
    const v = ta.value;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') { e.preventDefault(); ta.blur(); return; }
    if (mod && e.key === '/') { e.preventDefault(); toggleComment(); return; }
    if (ta.readOnly || mod || e.altKey) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey || v.slice(s, t).includes('\n')) shiftLines(e.shiftKey);
      else typeIn(s, t, unit());
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const ls = lineStart(s);
      const ind = v.slice(ls, s).match(/^[ \t]*/)[0];
      const before = v.slice(ls, s).trimEnd();
      const opens = /[{[(]$/.test(before) || (lang.hl === 'python' && before.endsWith(':'));
      const u = unit();
      if (opens && CLOSERS.has(v[t])) {
        typeIn(s, t, `\n${ind}${u}\n${ind}`, s + 1 + ind.length + u.length);
      } else typeIn(s, t, `\n${ind}${opens ? u : ''}`);
      return;
    }
    if (e.key === 'Backspace' && s === t && s > 0) {
      if (PAIRS[v[s - 1]] && PAIRS[v[s - 1]] === v[s]) { e.preventDefault(); typeIn(s - 1, s + 1, ''); return; }
      const ls = lineStart(s);
      const u = unit();
      if (u !== '\t' && /^ +$/.test(v.slice(ls, s))) {
        e.preventDefault();
        const n = (s - ls) % u.length || u.length;
        typeIn(s - n, s, '');
      }
      return;
    }
    if (e.key.length !== 1) return;
    // a closer already there stepped over
    if ((CLOSERS.has(e.key) || `"'\``.includes(e.key)) && s === t && v[s] === e.key) {
      e.preventDefault();
      ta.setSelectionRange(s + 1, s + 1);
      return;
    }
    if (PAIRS[e.key]) {
      const quote = `"'\``.includes(e.key);
      if (s !== t) { e.preventDefault(); typeIn(s, t, `${e.key}${v.slice(s, t)}${PAIRS[e.key]}`, s + 1, t + 1); return; }
      const next = v[s] || '';
      const prev = v[s - 1] || '';
      const free = !next || /\s/.test(next) || CLOSERS.has(next) || next === ',' || next === ';';
      if (free && (!quote || !/[\w"'`]/.test(prev))) { e.preventDefault(); typeIn(s, t, `${e.key}${PAIRS[e.key]}`, s + 1); }
    }
  });

  let cursorTimer = 0;
  const sendCursor = () => {
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => say({ type: 'cursor', pos: ta.selectionStart }), 250);
  };
  ta.addEventListener('input', () => { redraw(); flush(); paintState(); caretInView(); sendCursor(); });
  for (const ev of ['keyup', 'click', 'select']) ta.addEventListener(ev, () => { caretInView(); sendCursor(); });

  function save() {
    if (!ready || !canWrite()) return;
    if (inflight || ta.value !== S) { wantSave = true; flush(); return; }
    say({ type: 'save' });
  }

  errEl.addEventListener('click', () => { out.hidden = !out.hidden; });
  saveBtn.addEventListener('click', save);
  shareBtn.addEventListener('click', () => shareMenu(shareBtn, file, (said) => {
    stateEl.textContent = said;
    setTimeout(() => paintState(), 3000);
  }));
  if (isMd) { let on = false; try { on = localStorage.getItem(MD_KEY) === '1'; } catch {} setRendered(on); }
  outClose.addEventListener('click', () => { out.hidden = true; });
  // the gutter scrolled with the text, kept at the left edge
  scroller.addEventListener('click', (e) => { if (e.target === scroller || e.target === body) ta.focus(); });

  // a close with unsaved edits held once: the label says so, a second close goes
  let armed = 0;
  function holdClose() {
    if (!dirty() || armed) return false;
    btn.querySelector('.tab-label').textContent = `${codeName(file)} unsaved, close again`;
    armed = setTimeout(() => { armed = 0; paintState(); }, 3000);
    return true;
  }

  connect();
  redraw();
  paintState();
  return {
    file,
    dirty,
    save,
    holdClose,
    focus: () => ta.focus(),
    show: () => { redraw(); },
    text: () => ta.value,
    close: () => {
      closed = true;
      if (sock) sock.close();
      if (codeTabs.get(codeKey(file)) === id) codeTabs.delete(codeKey(file));
      editors.delete(id);
      editorGone(id);
    },
  };
}

// a monospace advance, measured once per element's font
const chWidths = new Map();
function chWidthIn(node) {
  const font = getComputedStyle(node).font;
  if (chWidths.has(font)) return chWidths.get(font);
  const probe = Object.assign(document.createElement('span'), { textContent: '0'.repeat(50) });
  probe.style.cssText = `font:${font};position:absolute;visibility:hidden;white-space:pre`;
  document.body.append(probe);
  const w = probe.getBoundingClientRect().width / 50;
  probe.remove();
  if (w) chWidths.set(font, w);
  return w || 8;
}
document.fonts.addEventListener('loadingdone', () => chWidths.clear());

// the editor tabs from the last visit, back on their sessions


export { codeEditor };
