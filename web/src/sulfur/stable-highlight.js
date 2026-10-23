// Lexical colors kept as steady as VS Code's line tokenizer keeps them. A parser
// recovering from half-typed code (`int x = |`, `foo(a, |`) can reclassify lines far
// from the caret on every keystroke. While an edit leaves the parse with an error it
// didn't have, only the edited lines take the new parse's colors and the rest keep
// theirs, until the code parses as well as it did or the edit opens or closes a
// comment or string that runs past the edited lines (which VS Code recolors too).
import { rebaseHighlightRanges, classAt, rangeIndex } from './semantic-tokens.js';
import { commonEnds } from '../text-operations.js';

// state: { ranges, from, to, errors, dirty } — ranges drawn for from..to, the error
// positions the last accepted parse had there, and the span edited since, if unsettled

const lineStartOf = (text, p) => text.lastIndexOf('\n', p - 1) + 1;
const lineAfter = (text, p) => { const e = text.indexOf('\n', p); return e < 0 ? text.length : e + 1; };
const open = (cls) => /hljs-(comment|string|regexp)/.test(cls) ? cls : '';
const mapPosition = (p, head, endA, delta) => p < head ? p : p >= endA ? p + delta : -1;

// the state moved onto the edited text: ranges and errors past the edit shifted, the
// edited span added to the unsettled one
export function rebaseLexical(state, before, after, change = commonEnds(before, after)) {
  if (!state || before === after) return state;
  const { head, tail } = change;
  const endA = before.length - tail, endB = after.length - tail, delta = after.length - before.length;
  const at = (p) => p < head ? p : p >= endA ? p + delta : head;
  const dirty = state.dirty ? { from: Math.min(at(state.dirty.from), head), to: Math.max(state.dirty.to >= endA ? state.dirty.to + delta : endB, endB) } : { from: head, to: endB };
  return {
    ranges: rebaseHighlightRanges(before, after, state.ranges, change),
    from: at(state.from), to: Math.max(at(state.from), state.to >= endA ? state.to + delta : endB),
    errors: state.errors.map((p) => mapPosition(p, head, endA, delta)).filter((p) => p >= 0),
    dirty,
  };
}

const clip = (ranges, from, to, out) => {
  if (to <= from) return;
  for (let i = rangeIndex(ranges, from); i < ranges.length; i++) {
    const r = ranges[i];
    if (r.to <= from) continue;
    if (r.from >= to) break;
    out.push(r.from >= from && r.to <= to ? r : { ...r, from: Math.max(from, r.from), to: Math.min(to, r.to) });
  }
};

// the colors to draw for from..to of text, given the fresh parse's ranges and error
// positions there
export function settleLexical(state, fresh, errors, from, to, text) {
  const accept = () => ({ ranges: fresh, from, to, errors, dirty: null });
  if (!state?.dirty) return accept();
  const a = lineStartOf(text, state.dirty.from), b = Math.max(a, lineAfter(text, state.dirty.to));
  const known = new Set(state.errors);
  const inside = (p) => p >= a && p < b;
  const covered = (p) => p >= state.from && p < state.to;
  const worse = errors.some((p) => !known.has(p) && (inside(p) || covered(p)));
  // a comment or string opened or closed by the edit: everything after it changes
  const crossed = b < text.length && open(classAt(fresh, b)) !== open(classAt(state.ranges, b));
  if (!worse || crossed) return accept();
  const ranges = [];
  const piece = (x, y) => {
    if (y <= x) return;
    if (x >= a && y <= b) { clip(fresh, x, y, ranges); return; }
    // what the old state covered from it, the fresh parse for the rest
    const s = Math.max(x, state.from), e = Math.min(y, state.to);
    if (e <= s) { clip(fresh, x, y, ranges); return; }
    clip(fresh, x, s, ranges); clip(state.ranges, s, e, ranges); clip(fresh, e, y, ranges);
  };
  piece(from, Math.min(to, a)); piece(Math.max(from, a), Math.min(to, b)); piece(Math.max(from, b), to);
  return {
    ranges, from, to, dirty: state.dirty,
    errors: [...state.errors, ...errors.filter((p) => !inside(p) && !covered(p))],
  };
}
