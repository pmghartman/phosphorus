// A textarea that holds only a window of its text. A browser's textarea lays out, paints and
// edits the whole of its value on every keystroke, so typing in a file of ten thousand lines
// costs ten times one of a thousand; here a long file's textarea holds the lines on screen and
// around the selection, the rest kept as a string beside it. Its own value, selectionStart,
// selectionEnd, selectionDirection, setSelectionRange, setRangeText and select are the whole
// text's, in its offsets, so everything reading or editing it (the editor, completion, find)
// sees the file as one. Native typing, pasting, IME, selecting, copying and the caret stay the
// browser's.
//
// The window always holds the lines on screen (a press is placed by the browser before any
// handler runs, so they must be there already), and the selection with lines to spare when
// it's near them. A selection scrolled far from the view, or too long to hold, is kept here
// instead ("away"): the editor draws it, and any key brings it back into the window before the
// browser acts on the key.
//
// o.view() the lines on screen, { first, last } (last exclusive); o.lineOf(text, offset) and
// o.lineStart(text, line) the editor's line index; o.lines(text) its line count; o.placed(line,
// away) the window moved, or the selection went away or came back; o.offsetAt(event) the
// offset under a mouse event; o.moved() the selection moved by a key handled here.
import { commonEnds, knownEdit } from '../text-operations.js';

// a file under this many lines is held whole, as a textarea always held it
export const WINDOW_LINES = 3000;
// a selection of more lines than this is held in the window only while a key acts on it
const HOLD_LINES = 4000;

const P = globalThis.HTMLTextAreaElement?.prototype;
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'OS', 'Hyper', 'Super']);

export function textWindow(ta, o) {
  if (!P) return null;
  const V = Object.getOwnPropertyDescriptor(P, 'value');
  const SS = Object.getOwnPropertyDescriptor(P, 'selectionStart');
  const SE = Object.getOwnPropertyDescriptor(P, 'selectionEnd');
  const SD = Object.getOwnPropertyDescriptor(P, 'selectionDirection');
  const nativeValue = () => V.get.call(ta);
  const setNative = (a, b, dir) => P.setSelectionRange.call(ta, a, b, dir);
  // the textarea's whole value replaced as an edit of it, not by assigning it: assigning moves a
  // focused textarea's caret to its end and scrolls the editor there
  const replaceNative = (str) => P.setRangeText.call(ta, str, 0, nativeValue().length, 'start');

  // the whole text; the window [from, from + shown.length) of it the textarea holds, shown its
  // value as last read (an edit typed into it is folded into text when it's next read); line
  // the window's first line; away the selection when the window doesn't hold it
  let text = nativeValue(), from = 0, shown = text, line = 0, away = null;
  let composing = false, dragging = false;
  function sync() {
    const now = nativeValue();
    if (now === shown) return;
    // the whole text held: the textarea's own string, so comparing it with others is immediate
    if (from === 0 && shown.length === text.length) { const before = text; text = shown = now; noteEdit(before, now); return; }
    let head = 0;
    const max = Math.min(now.length, shown.length);
    while (head < max && now.charCodeAt(head) === shown.charCodeAt(head)) head++;
    let tail = 0;
    while (tail < max - head && now.charCodeAt(now.length - 1 - tail) === shown.charCodeAt(shown.length - 1 - tail)) tail++;
    const before = text, after = text.length - from - shown.length + tail;
    text = text.slice(0, from + head) + now.slice(head, now.length - tail) + text.slice(from + shown.length - tail);
    shown = now;
    knownEdit(before, text, from + head, after);
  }
  // a whole-text edit's span, for the diffs that follow it (text-operations.js)
  function noteEdit(before, after) { const { head, tail } = commonEnds(before, after); knownEdit(before, after, head, tail); }
  const count = () => o.lines(text);
  const windowed = () => count() > WINDOW_LINES;
  const endLine = () => o.lineOf(text, from + shown.length) + 1;
  const offsetOfLine = (l) => (l >= count() ? text.length : o.lineStart(text, Math.max(0, l)));
  const screen = () => { const { first, last } = o.view(); return Math.max(1, last - first); };
  // lines kept beyond the view and the selection: more than a PageUp or PageDown reaches
  const marginOf = (span) => Math.max(120, span * 3);
  const selection = () => (away ? away : [from + SS.get.call(ta), from + SE.get.call(ta), SD.get.call(ta)]);
  const fits = (a, b) => a >= from && b <= from + shown.length;

  // the window put over lines [a, b), the selection held in it when it lies inside, else away
  function place(a, b, sel = selection()) {
    sync();
    const n = count();
    a = Math.max(0, Math.min(a, n)); b = Math.max(a, Math.min(b, n));
    const nf = offsetOfLine(a), nt = offsetOfLine(b);
    const to = from + shown.length;
    if (nf !== from || nt !== to) {
      if (dragging && !away && nf <= from && nt >= to) {
        // a selection being dragged out with the mouse: the window only grows, at its ends, so
        // the browser's own drag keeps its anchor in the text it holds
        if (nt > to) P.setRangeText.call(ta, text.slice(to, nt), shown.length, shown.length, 'preserve');
        if (nf < from) P.setRangeText.call(ta, text.slice(nf, from), 0, 0, 'preserve');
        from = nf; shown = nativeValue(); line = a;
        o.placed(line, away);
        return;
      }
      replaceNative(text.slice(nf, nt));
      from = nf; shown = nativeValue(); line = a;
    }
    hold(sel);
  }
  // the selection into the window when it lies inside, else kept away
  function hold(sel) {
    if (fits(Math.min(sel[0], sel[1]), Math.max(sel[0], sel[1]))) { away = null; setNative(sel[0] - from, sel[1] - from, sel[2]); }
    else { away = [sel[0], sel[1], sel[2] || 'none']; setNative(0, 0); }
    o.placed(line, away);
  }
  // the lines [a, b) a window should hold for the view and, when it's near, the selection
  function plan() {
    const n = count();
    if (n <= WINDOW_LINES) return { a: 0, b: n, holds: true };
    const { first, last } = o.view();
    const margin = marginOf(Math.max(1, last - first));
    const [s, e] = selection();
    const la = o.lineOf(text, Math.min(s, e)), lb = o.lineOf(text, Math.max(s, e));
    if (la >= first - margin * 2 && lb < last + margin * 2 && lb - la < HOLD_LINES) return { a: Math.min(first, la) - margin, b: Math.max(last, lb + 1) + margin, holds: true };
    return { a: first - margin, b: last + margin, holds: false };
  }
  // the window around a selection alone, for a key to act on it: all of it, however long
  function around(sel) {
    const n = count();
    if (n <= WINDOW_LINES) return [0, n];
    const margin = marginOf(screen());
    return [o.lineOf(text, Math.min(sel[0], sel[1])) - margin, o.lineOf(text, Math.max(sel[0], sel[1])) + 1 + margin];
  }

  Object.defineProperties(ta, {
    value: {
      configurable: true,
      get() { sync(); return text; },
      set(v) {
        const before = text;
        text = String(v ?? '');
        noteEdit(before, text);
        away = null;
        // as the browser does: the caret to the end of the new text
        const [l0, l1] = around([text.length, text.length]);
        const a = Math.max(0, l0), b = Math.min(count(), l1);
        const nf = offsetOfLine(a), nt = offsetOfLine(b);
        replaceNative(text.slice(nf, nt));
        from = nf; shown = nativeValue(); line = a;
        setNative(nt - nf, nt - nf);
        o.placed(line, away);
      },
    },
    selectionStart: {
      configurable: true,
      get() { return selection()[0]; },
      set(v) { const [, e, d] = selection(); ta.setSelectionRange(v, Math.max(v, e), d); },
    },
    selectionEnd: {
      configurable: true,
      get() { return selection()[1]; },
      set(v) { const [s, , d] = selection(); ta.setSelectionRange(Math.min(s, v), v, d); },
    },
    selectionDirection: {
      configurable: true,
      get() { return selection()[2]; },
      set(v) { const [s, e] = selection(); ta.setSelectionRange(s, e, v); },
    },
    setSelectionRange: {
      configurable: true,
      value(a, b, dir) {
        sync();
        const n = text.length;
        a = Math.max(0, Math.min(n, Math.trunc(Number(a)) || 0));
        b = Math.max(a, Math.min(n, Math.trunc(Number(b)) || 0));
        if (fits(a, b)) {
          const was = away;
          away = null;
          setNative(a - from, b - from, dir);
          if (was) o.placed(line, away);
          return;
        }
        // a selection the window doesn't hold: the window moved to it, a long one kept away
        const sel = [a, b, dir];
        const [l0, l1] = o.lineOf(text, b) - o.lineOf(text, a) < HOLD_LINES ? around(sel) : around([b, b]);
        place(l0, l1, sel);
      },
    },
    setRangeText: {
      configurable: true,
      value(str, a, b, mode = 'preserve') {
        sync();
        str = String(str);
        if (a === undefined) { [a, b] = selection(); mode = 'preserve'; }
        const n = text.length;
        a = Math.max(0, Math.min(n, a)); b = Math.max(a, Math.min(n, b));
        const to = from + shown.length;
        if (mode === 'preserve' && (b < from || a > to || away)) {
          // outside the window, or the selection away: the text changed here, the selection
          // moved as the browser moves it for an edit (after the edit: by its length; inside
          // it: to its start)
          const before = text, delta = str.length - (b - a);
          text = text.slice(0, a) + str + text.slice(b);
          knownEdit(before, text, a, before.length - b);
          const map = (p) => (p > b ? p + delta : p > a ? a : p);
          if (away) away = [map(away[0]), map(away[1]), away[2]];
          if (b < from) { from += delta; line = o.lineOf(text, from); }
          else if (a <= to) {
            // an edit across the window: the window rebuilt over it
            const l0 = o.lineOf(text, Math.min(a, from)), l1 = o.lineOf(text, Math.max(a + str.length, to + delta)) + 1;
            const nf = offsetOfLine(l0), nt = offsetOfLine(Math.min(count(), l1));
            replaceNative(text.slice(nf, nt));
            from = nf; shown = nativeValue(); line = l0;
            setNative(0, 0);
          }
          o.placed(line, away);
          return;
        }
        if (!fits(a, b)) { const [l0, l1] = around([a, b]); place(l0, l1, [a, b]); }
        P.setRangeText.call(ta, str, a - from, b - from, mode);
        sync();
      },
    },
    select: { configurable: true, value() { ta.setSelectionRange(0, text.length); } },
  });

  // a selection kept away brought back into the window, all of it, for the browser to act on
  function bringBack() {
    if (!away) return;
    const sel = away;
    const [l0, l1] = around(sel);
    away = null;
    place(l0, l1, sel);
  }

  // keys the browser would take to the textarea's own start or end, the window's rather than
  // the file's: taken to the file's
  const mac = /Mac|iPhone|iPad/.test(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '');
  ta.addEventListener('keydown', (e) => {
    if (e.isComposing || MODIFIERS.has(e.key) || !windowed()) return;
    const mod = mac ? e.metaKey : e.ctrlKey;
    const k = e.key;
    let target = null;
    if (mod && !e.altKey && !e.shiftKey && k.toLowerCase() === 'a') { e.preventDefault(); ta.setSelectionRange(0, text.length, 'forward'); o.moved?.(); return; }
    if (mod && !e.altKey && (k === 'Home' || (mac && k === 'ArrowUp'))) target = 0;
    else if (mod && !e.altKey && (k === 'End' || (mac && k === 'ArrowDown'))) target = text.length;
    if (target !== null) {
      e.preventDefault();
      const [s, en, d] = selection();
      const anchor = d === 'backward' ? en : s;
      if (e.shiftKey) ta.setSelectionRange(Math.min(anchor, target), Math.max(anchor, target), target < anchor ? 'backward' : 'forward');
      else ta.setSelectionRange(target, target);
      o.moved?.();
      return;
    }
    // any other key: the selection back in the window with lines to spare either side, so the
    // browser's own typing, deleting, moving or copying finds the text it reaches
    if (away) bringBack();
    else edge();
  }, true);
  // a press: placed by the browser on the lines on screen, which the window holds already; a
  // selection kept away gives way to it, but for a shift press, which extends it from there
  ta.addEventListener('mousedown', (e) => {
    if (e.button > 2) return;
    if (away && windowed()) {
      const at = e.shiftKey || e.button === 2 ? o.offsetAt(e) : null;
      if (e.button === 0 && at !== null) {
        e.preventDefault();
        ta.focus({ preventScroll: true });
        const [s, en, d] = away;
        const anchor = d === 'backward' ? en : s;
        ta.setSelectionRange(Math.min(anchor, at), Math.max(anchor, at), at < anchor ? 'backward' : 'forward');
        o.moved?.();
        return;
      }
      if (e.button === 2) {
        // the browser may keep the selection under a right press: the caret put where it was
        // pressed unless that's inside the selection, as VS Code does
        const [s, en] = away;
        if (at !== null && (at < Math.min(s, en) || at > Math.max(s, en))) ta.setSelectionRange(at, at);
        return;
      }
      away = null;
      o.placed(line, away);
    }
    if (e.button !== 0) return;
    dragging = true;
    const up = () => { dragging = false; removeEventListener('mouseup', up, true); removeEventListener('blur', up); check(); };
    addEventListener('mouseup', up, true);
    addEventListener('blur', up);
  }, true);
  ta.addEventListener('compositionstart', () => { composing = true; });
  ta.addEventListener('compositionend', () => { composing = false; });

  // before a key the browser acts on: the selection more than a screen from the window's
  // edges, so a move or a delete never reaches past them
  function edge() {
    if (composing) return;
    sync();
    const n = count();
    const l0 = line, l1 = endLine();
    const [s, e] = selection();
    const guard = screen() + 2;
    const la = o.lineOf(text, Math.min(s, e)), lb = o.lineOf(text, Math.max(s, e));
    if ((la - l0 < guard && l0 > 0) || (l1 - lb < guard && l1 < n)) { const [a, b] = around([s, e]); place(a, b); }
  }
  // once a frame after scrolling or the caret moving: the window holding the view (and the
  // selection when near it), moved when either nears its edges, a selection away brought back
  // once the view's near it, or cut back when it holds far more than it needs
  function check() {
    if (composing || dragging) { if (dragging) grow(); return; }
    sync();
    const n = count();
    if (n <= WINDOW_LINES) { if (from !== 0 || shown.length !== text.length || away) place(0, n); return; }
    const { first, last } = o.view();
    const margin = marginOf(Math.max(1, last - first));
    const l0 = line, l1 = endLine();
    const [s, e] = selection();
    const la = o.lineOf(text, Math.min(s, e)), lb = o.lineOf(text, Math.max(s, e));
    const close = (x0, x1) => (x0 - l0 < margin / 2 && l0 > 0) || (l1 - x1 < margin / 2 && l1 < n);
    const want = plan();
    if (close(first, last - 1) || (!away && close(la, lb)) || (away && want.holds) || l1 - l0 > (want.b - want.a) + margin * 4) place(want.a, want.b);
  }
  // a drag scrolling the view on: the window grown toward it, never cut while held
  function grow() {
    const n = count();
    if (n <= WINDOW_LINES) return;
    sync();
    const { first, last } = o.view();
    const span = Math.max(1, last - first);
    const l0 = line, l1 = endLine();
    if (first - l0 < span * 2 && l0 > 0) place(Math.min(l0, first) - span * 8, l1);
    else if (l1 - last < span * 2 && l1 < n) place(l0, Math.max(l1, last) + span * 8);
  }

  return {
    check,
    // the first line the textarea holds, for drawing it from there
    line: () => line,
    // the selection when it's kept away from the window, for the editor to draw it
    away: () => away,
  };
}
