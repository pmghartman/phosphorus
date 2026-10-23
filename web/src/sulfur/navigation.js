import { offsetAt } from './language-client.js';
import { opDiff } from '../text-operations.js';

export function sidebarRight(mode, location) {
  return location === 'right' || (location !== 'left' && mode === 'visualStudio');
}

export function runTargetName(context, tab) {
  if (context?.pending) return 'Finding target…';
  const item = context?.item;
  return item?.label || item?.target || (item?.executable && String(item.executable).split(/[\\/]/).pop()) || (context?.project ? 'Select startup target…' : tab?.ed ? tab.title : 'Select a target…');
}

// Both hierarchical DocumentSymbol and older SymbolInformation responses are
// used by servers. Keep declaration selections separate from enclosing scopes.
export function documentSymbols(text, values, uri) {
  const out = [];
  const walk = (items, owner = null) => {
    for (const item of items || []) {
      if (item.location?.uri && item.location.uri !== uri) continue;
      try {
        const range = item.range || item.location?.range;
        const selection = item.selectionRange || range;
        const s = { name: item.name, detail: item.detail || '', kind: [5, 10, 11, 23, 26].includes(item.kind) ? 'type' : [6, 9, 12].includes(item.kind) ? 'method' : [7, 8, 20, 22].includes(item.kind) ? 'field' : 'variable', from: offsetAt(text, selection.start), to: offsetAt(text, selection.end), start: offsetAt(text, range.start), end: offsetAt(text, range.end), owner };
        if (s.from > s.to || s.start > s.from || s.to > s.end || typeof s.name !== 'string') continue;
        out.push(s);
        walk(item.children, s);
      } catch { /* Ignore invalid ranges without breaking the remaining symbols. */ }
    }
  };
  walk(values);
  // Flat responses have no parent relationship. Infer only strict containment.
  for (const s of out) if (!s.owner) s.owner = out.filter((p) => p !== s && ['type', 'method'].includes(p.kind) && p.start <= s.start && p.end >= s.end && (p.start < s.start || p.end > s.end)).sort((a, b) => a.end - a.start - (b.end - b.start))[0] || null;
  return out.sort((a, b) => a.from - b.from);
}

export function moveBookmarks(bookmarks, before, after) {
  if (before === after || !bookmarks.length) return bookmarks;
  const operation = opDiff(before, after);
  // A line's bookmark follows insertions at its first character. Editor caret
  // mapping has left affinity at this boundary, so use right affinity here.
  const map = (pos) => {
    let from = 0, to = 0;
    for (const part of operation) {
      if (typeof part === 'string') { to += part.length; continue; }
      if (pos < from + Math.abs(part)) return part > 0 ? to + pos - from : to;
      from += Math.abs(part);
      if (part > 0) to += part;
    }
    return to;
  };
  for (const bookmark of bookmarks) {
    const at = map(Math.max(0, Math.min(before.length, bookmark.offset || 0)));
    bookmark.offset = at > 0 ? after.lastIndexOf('\n', at - 1) + 1 : 0;
    bookmark.line = after.slice(0, bookmark.offset).split('\n').length;
  }
  return bookmarks;
}
