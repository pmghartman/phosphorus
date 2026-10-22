import {
  codeKey,
  codeLang,
  codeName,
  codeTabs,
  color,
  colorFor,
  dk,
  editors,
  el,
  esc,
  hostUrl,
  lines,
  name,
  shareMenu,
} from '../app.js';
import { ERR_MAX, highlight, parserFor, parserNow, syntaxErrors } from '../lezer.js';
import { mdBlocks, renderMd } from '../md.js';
import { opApply, opTransform, opDiff, opMap, opEdits } from '../text-operations.js';
import { EditorHistory } from '../editor-history.js';

// --- code editor ------------------------------------------------------------------
// a share's text or code file in a tab of its own, joined to the file's live
// session on its host, so everyone with it open edits the same text: highlighted
// as it's typed (a textarea over its highlighted copy), indents kept, pairs
// closed, syntax errors marked by a parse alone, saved once typing pauses;
// nothing in it ever runs


// --- editors ---------------------------------------------------------------------

const anyCodeDirty = () => [...editors.values()].some((ed) => ed.dirty());
window.addEventListener('beforeunload', (e) => { if (anyCodeDirty()) e.preventDefault(); });

// opts.bare: no bar of its own, for a host that draws its own (the ide), told
// of every change by opts.onState
function codeEditor(view, file, btn, id, opts = {}) {
  const lang = codeLang(file.path) || { hl: 'plaintext', check: '', comment: '' };
  const bare = !!opts.bare;
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
  // a find's matches, the current one stronger, drawn as the squiggles are
  const finds = el('pre', 'code-hl code-finds');
  // an agent's edit as it lands: what it wrote lit, its caret where it's writing
  const agentL = el('pre', 'code-hl code-agent');
  const ta = Object.assign(document.createElement('textarea'), { className: 'code-ta', spellcheck: false, autocomplete: 'off', wrap: 'off' });
  ta.setAttribute('autocapitalize', 'off');
  ta.setAttribute('aria-label', file.label);
  body.append(agentL, finds, pre, squig, ta);
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
  if (bare) bar.hidden = true;

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
  const history = new EditorHistory();
  let historyText = '';
  let historyReady = false;
  let beforeSelection = [0, 0];
  let historyGroup = '';
  let agentSequence = 0;

  function historyStep(redo = false) {
    if (ta.readOnly) return false;
    const next = history.step(ta.value, [ta.selectionStart, ta.selectionEnd], redo);
    if (!next) return false;
    ta.value = next.text;
    historyText = next.text;
    ta.setSelectionRange(...next.selection);
    beforeSelection = next.selection;
    redraw(); flush(); paintState(); caretInView(); sendCursor();
    return true;
  }

  // --- drawing ---
  let drawFrame = 0;
  let hlText = null;
  const HL_MAX = 8 * 1024 * 1024;
  // past this, a file's highlighted again once typing stops, plain between
  const HL_IDLE = 256 * 1024;
  const SERVER_HL_MAX = 200 * 1024;
  let bigTimer = 0;
  let hlNow = false;
  function draw() {
    drawFrame = 0;
    const text = ta.value;
    // a tab shown again with the same text: its highlight kept
    if (text === hlText) { paintMarks(); return; }
    const parser = text.length <= HL_MAX && parserNow(lang.check);
    const big = text.length > HL_IDLE && hlText !== null && !hlNow;
    hlText = text;
    if (parser && !big) code.innerHTML = `${highlight(parser, text)}\n`;
    else {
      code.textContent = `${text}\n`;
      if (parser) {
        clearTimeout(bigTimer);
        bigTimer = setTimeout(() => { if (closed || ta.value !== text) return; hlText = null; hlNow = true; draw(); hlNow = false; }, 400);
      } else if (lang.check && text.length <= HL_MAX) parserFor(lang.check).then((p) => { if (p) { hlText = null; redraw(); } });
      else if (lang.hl !== 'plaintext' && text.length <= SERVER_HL_MAX) serverHighlight(text);
    }
    const lines = text.split('\n').length;
    if (nums.dataset.n !== String(lines)) {
      nums.dataset.n = String(lines);
      nums.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
    }
    paintMarks();
    paintFinds();
    paintAgent();
    checkSoon();
  }
  const redraw = () => { drawFrame ||= requestAnimationFrame(draw); mdSoon(); };

  // --- a find's matches, set by the host, redrawn with the text ---
  let findRanges = [];
  let findAt = -1;
  function paintFinds() {
    if (!findRanges.length) { if (finds.firstChild) finds.textContent = ''; return; }
    const text = ta.value;
    let html = '';
    let at = 0;
    findRanges.forEach(([a, b], i) => {
      if (a < at || b > text.length) return;
      html += `${esc(text.slice(at, a))}<mark${i === findAt ? ' class="now"' : ''}>${esc(text.slice(a, b))}</mark>`;
      at = b;
    });
    finds.innerHTML = `${html}${esc(text.slice(at))}\n`;
  }

  // --- an agent's edits, typed in a little at a time where the user sees them ---
  let agentMarks = [];
  let agentAt = -1;
  let agentFade = 0;
  let agentChain = Promise.resolve();
  function paintAgent() {
    if (!agentMarks.length && agentAt < 0) { if (agentL.firstChild) agentL.textContent = ''; return; }
    const text = ta.value;
    const pts = [...agentMarks.map(([a, b, cls]) => ({ a, b, cls })), ...(agentAt >= 0 ? [{ a: agentAt, b: agentAt, cls: 'caret' }] : [])]
      .sort((x, y) => x.a - y.a || (x.cls === 'caret') - (y.cls === 'caret'));
    let html = '';
    let at = 0;
    for (const x of pts) {
      if (x.a < at || x.b > text.length) continue;
      html += esc(text.slice(at, x.a));
      html += x.cls === 'caret' ? '<span class="caret"></span>' : `<mark class="${x.cls}">${esc(text.slice(x.a, x.b))}</mark>`;
      at = x.b;
    }
    agentL.innerHTML = `${html}${esc(text.slice(at))}\n`;
  }
  // a place in the text scrolled to, the user's own caret and selection left as they are
  function revealAt(pos) {
    const before = ta.value.slice(0, pos);
    const line = before.split('\n').length - 1;
    const cs = getComputedStyle(ta);
    const lh = parseFloat(cs.lineHeight) || 18;
    const y = parseFloat(cs.paddingTop) + line * lh;
    if (y < scroller.scrollTop || y + lh > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = Math.max(0, y - scroller.clientHeight / 3);
    const cw = chWidthIn(ta);
    const x = gutter.offsetWidth + parseFloat(cs.paddingLeft) + (before.length - before.lastIndexOf('\n') - 1) * cw;
    if (x > scroller.scrollLeft + scroller.clientWidth - cw * 2 || x < scroller.scrollLeft + gutter.offsetWidth) scroller.scrollLeft = Math.max(0, x - scroller.clientWidth / 2);
  }
  // from..to replaced with text: what goes lit red a moment, the new typed in
  // over a second or so; one edit after another, resolved false if it can't land
  function agentEdit(from, to, text, o = {}) {
    const go = () => new Promise((resolve) => {
      const t0 = Date.now();
      const wait = () => {
        if (closed) { resolve(false); return; }
        if (!ready) { if (Date.now() - t0 < 8000) setTimeout(wait, 100); else resolve(false); return; }
        if (ta.readOnly || from < 0 || to > ta.value.length || from > to) { resolve(false); return; }
        start();
      };
      const group = `agent:${++agentSequence}`;
      const put = (str, a, b) => {
        beforeSelection = [ta.selectionStart, ta.selectionEnd];
        historyGroup = group;
        try { ta.setRangeText(str, a, b, 'preserve'); ta.dispatchEvent(new Event('input')); }
        finally { historyGroup = ''; }
      };
      const finish = (n) => {
        agentAt = -1;
        agentMarks = n ? [[from, from + n, 'add done']] : [];
        paintAgent();
        clearTimeout(agentFade);
        agentFade = setTimeout(() => { agentMarks = []; paintAgent(); }, 2200);
        resolve(true);
      };
      const start = () => {
        clearTimeout(agentFade);
        revealAt(from);
        agentMarks = to > from ? [[from, to, 'del']] : [];
        agentAt = from;
        paintAgent();
        setTimeout(() => {
          if (closed) { resolve(false); return; }
          put('', from, to);
          const total = text.length;
          const ms = o.instant ? 0 : Math.min(1400, 6 * total + 150);
          if (!ms || !total) { if (total) put(text, from, from); finish(total); return; }
          const began = performance.now();
          let n = 0;
          const step = (now) => {
            if (closed) { resolve(false); return; }
            const want = Math.min(total, Math.max(n + 1, Math.ceil(total * Math.min(1, (now - began) / ms))));
            put(text.slice(n, want), from + n, from + n);
            n = want;
            agentMarks = [[from, from + n, 'add']];
            agentAt = from + n;
            revealAt(agentAt);
            paintAgent();
            if (n < total) setTimeout(() => step(performance.now()), 16); else finish(n);
          };
          // timers, not frames: a hidden window still finishes its edit
          setTimeout(() => step(performance.now()), 16);
        }, to > from && !o.instant ? 260 : 0);
      };
      wait();
    });
    const p = agentChain.then(go, go);
    agentChain = p;
    return p;
  }
  // text an agent already wrote, there when the file opened: lit a moment
  function agentFlash(from, to) {
    agentChain = agentChain.then(() => {
      if (closed || from < 0 || to > ta.value.length) return;
      clearTimeout(agentFade);
      revealAt(from);
      agentMarks = [[from, to, 'add done']];
      paintAgent();
      agentFade = setTimeout(() => { agentMarks = []; paintAgent(); }, 2200);
    });
    return agentChain;
  }

  // --- the host told: state, caret and errors, once a frame at most ---
  let tellFrame = 0;
  const tell = () => { if (opts.onState && !tellFrame) tellFrame = requestAnimationFrame(() => { tellFrame = 0; if (!closed) opts.onState(info()); }); };
  const lineAt = (text, p) => { let n = 1; for (let i = text.indexOf('\n'); i >= 0 && i < p; i = text.indexOf('\n', i + 1)) n += 1; return n; };
  function info() {
    const text = ta.value;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const u = unit();
    return {
      ready, dirty: dirty(), readOnly: ta.readOnly, state: stateEl.textContent, bad: stateEl.classList.contains('bad'),
      lang: lang.hl, line: lineAt(text, e), col: e - text.lastIndexOf('\n', e - 1), sel: Math.abs(e - s),
      indent: u === '\t' ? 'tab' : u.length, eol: text.includes('\r\n') ? 'CRLF' : 'LF', length: text.length,
      errors: errs.map((x) => ({ from: x.from, to: x.to, what: x.what, source: x.source, severity: x.severity, line: lineAt(text, x.from), col: x.from - text.lastIndexOf('\n', x.from - 1) })),
      people: people.filter((p) => (me ? p.id !== me : p.name !== name)),
    };
  }
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
        if (from < 0) paintState('edit lost');
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
  let languageErrors = null;
  let checkTimer = 0;
  const checkSoon = () => { clearTimeout(checkTimer); checkTimer = setTimeout(check, 300); };
  async function check() {
    const text = ta.value;
    const parser = languageErrors === null && lang.check && text.length <= HL_MAX && await parserFor(lang.check);
    if (closed || text !== ta.value) return;
    errs = languageErrors === null ? parser ? syntaxErrors(parser, text) : [] : languageErrors;
    const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    let html = '';
    let at = 0;
    for (const e of errs) {
      const to = Math.max(e.to, Math.min(e.from + 1, text.length));
      if (e.from < at) continue;
      const bit = text.slice(e.from, to).replace(/\n/g, ' \n');
      html += `${esc(text.slice(at, e.from))}<mark class="${e.severity === 2 ? 'code-warning' : e.severity > 2 ? 'code-hint' : ''}">${esc(bit) || ' '}</mark>`;
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
    tell();
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
    if (!bare) {
      btn.classList.toggle('dirty', d);
      btn.querySelector('.tab-label').textContent = `${codeName(file)}${d ? ' •' : ''}`;
    }
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
    tell();
  }

  // the caret kept in view as it moves, the scroller being the editor, not the box
  // center: a jump from afar put mid-view, as a find or a go to line wants
  function caretInView(center = false) {
    const before = ta.value.slice(0, ta.selectionEnd);
    const line = before.split('\n').length - 1;
    const col = before.length - before.lastIndexOf('\n') - 1;
    const cs = getComputedStyle(ta);
    const lh = parseFloat(cs.lineHeight) || 18;
    const cw = chWidthIn(ta);
    const y = parseFloat(cs.paddingTop) + line * lh;
    const x = gutter.offsetWidth + parseFloat(cs.paddingLeft) + col * cw;
    const out = y < scroller.scrollTop || y + lh > scroller.scrollTop + scroller.clientHeight;
    if (center && out) scroller.scrollTop = Math.max(0, y - scroller.clientHeight / 2);
    else if (y < scroller.scrollTop) scroller.scrollTop = y;
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
    if (historyReady && ta.value !== text) history.remote(opDiff(ta.value, text));
    historyReady = true;
    ta.value = text;
    historyText = text;
    if (keepSel) ta.setSelectionRange(Math.min(s0, text.length), Math.min(s1, text.length));
    redraw();
  }

  function remote(ops, agent = '') {
    const C = ta.value;
    const P = inflight ? opApply(S, inflight.ops) : S;
    let r = ops;
    if (inflight) [inflight.ops, r] = opTransform(inflight.ops, r);
    const [, r2] = opTransform(opDiff(P, C), r);
    const [s0, s1] = [ta.selectionStart, ta.selectionEnd];
    const top = scroller.scrollTop;
    const next = opApply(C, r2);
    if (agent) history.record(C, next, [s0, s1], [opMap(r2, s0), opMap(r2, s1)], `agent:remote:${agent}`);
    else history.remote(r2);
    ta.value = next;
    historyText = ta.value;
    ta.setSelectionRange(opMap(r2, s0), opMap(r2, s1));
    scroller.scrollTop = top;
    redraw();
  }

  let refused = '';
  function connect() {
    if (closed) return;
    const q = new URLSearchParams({ share: file.share, path: file.path });
    sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${hostUrl(file.host, `/api/code/${encodeURIComponent(file.host)}`)}?${q}`);
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
        // a host's own share without its login: read only
        if (msg.perms !== undefined) perms = file.share !== 'home' && !dk.creds.has(file.host) ? msg.perms.replace(/[^r]/g, '') : msg.perms;
        if (msg.people) people = msg.people;
        if (msg.you) me = msg.you;
        inflight = null;
        ready = true;
        setText(S, true);
        paintState(lost ? 'edit dropped' : '');
        if (msg.type === 'init' && !view.dataset.seen) { view.dataset.seen = '1'; ta.setSelectionRange(0, 0); }
      } else if (msg.type === 'op') {
        if (inflight && msg.id === inflight.id) {
          S = opApply(S, msg.ops);
          V = msg.v;
          inflight = null;
          flush();
        } else {
          remote(msg.ops, msg.agent ? msg.agentEdit || msg.by || 'agent' : '');
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
  // All edits go through the same history, including synthetic and agent edits.
  function typeIn(from, to, text, selFrom, selTo) {
    beforeSelection = [ta.selectionStart, ta.selectionEnd];
    history.boundary();
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
    if (mod && !e.altKey && ['z', 'y'].includes(e.key.toLowerCase())) {
      e.preventDefault(); e.stopPropagation();
      historyStep(e.key.toLowerCase() === 'y' || e.shiftKey);
      return;
    }
    // the ide's escape its own: a find closed, the focus kept
    if (e.key === 'Escape' && !bare) { e.preventDefault(); ta.blur(); return; }
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
  ta.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') { e.preventDefault(); historyStep(e.inputType === 'historyRedo'); return; }
    beforeSelection = [ta.selectionStart, ta.selectionEnd];
  });
  ta.addEventListener('input', (e) => {
    const group = historyGroup || (/^(insertText|deleteContentBackward|deleteContentForward)$/.test(e.inputType) ? e.inputType : '');
    history.record(historyText, ta.value, beforeSelection, [ta.selectionStart, ta.selectionEnd], group);
    historyText = ta.value;
    beforeSelection = [ta.selectionStart, ta.selectionEnd];
    redraw(); flush(); paintState(); caretInView(); sendCursor();
  });
  for (const ev of ['keyup', 'click', 'select']) ta.addEventListener(ev, () => { caretInView(); sendCursor(); tell(); });

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
    btn.querySelector('.tab-label').textContent = 'unsaved';
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
    undo: () => historyStep(),
    redo: () => historyStep(true),
    focus: () => ta.focus(),
    show: () => { redraw(); },
    text: () => ta.value,
    info,
    editMany: (edits, selection) => {
      if (ta.readOnly || !ready) return false;
      const before = ta.value;
      const ops = opEdits(before, edits);
      const next = opApply(before, ops);
      const sel = selection || [opMap(ops, ta.selectionStart), opMap(ops, ta.selectionEnd)];
      history.recordOperation(before, ops, [ta.selectionStart, ta.selectionEnd], sel);
      ta.value = next; historyText = next; beforeSelection = sel;
      ta.setSelectionRange(...sel);
      redraw(); flush(); paintState(); caretInView(); sendCursor();
      return true;
    },
    // Programmatic edits share the same history as typing and agent edits.
    edit: (from, to, text, selFrom, selTo) => {
      if (ta.readOnly) return false;
      ta.focus();
      typeIn(from, to, text, selFrom, selTo);
      caretInView();
      return true;
    },
    // focus false: the caret moved and shown, the focus left where it is (a find's box)
    select: (from, to = from, { focus = true } = {}) => {
      if (focus) ta.focus();
      ta.setSelectionRange(from, to);
      caretInView(true);
      sendCursor();
      tell();
    },
    selection: () => [ta.selectionStart, ta.selectionEnd],
    agentEdit,
    agentFlash,
    ready: () => ready,
    setDiagnostics: (errors) => { languageErrors = errors === null ? null : [...errors].sort((a, b) => a.from - b.from); check(); },
    setFinds: (ranges, at = -1) => { findRanges = ranges; findAt = at; paintFinds(); },
    preview: isMd ? (on) => setRendered(on ?? !rendered) : null,
    previewing: () => rendered,
    close: () => {
      closed = true;
      if (sock) sock.close();
      if (codeTabs.get(codeKey(file)) === id) codeTabs.delete(codeKey(file));
      editors.delete(id);
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
