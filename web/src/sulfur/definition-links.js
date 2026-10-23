import { inCommentOrString } from './completion.js';

const keywords = new Set('if else for foreach while do switch case default break continue return throw try catch finally class interface struct enum namespace using import export from package public private protected internal static readonly const let var new delete this base super null true false void async await function def pass yield extends implements abstract override virtual sealed partial get set'.split(' '));

export function definitionIdentifier(text, offset, { tree, extension = '' } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || offset >= text.length) return null;
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  const end = text.indexOf('\n', offset);
  const line = text.slice(start, end < 0 ? text.length : end);
  let hit;
  for (const match of line.matchAll(/[$\p{L}_][$\p{L}\p{N}\p{M}_]*/gu)) {
    if (start + match.index > offset) break;
    if (offset < start + match.index + match[0].length) { hit = match; break; }
  }
  if (!hit || keywords.has(hit[0]) || inCommentOrString(text, offset, extension)) return null;
  for (let node = tree?.resolveInner(offset, 1); node; node = node.parent) if (/Comment|String|Character|RegExp/.test(node.name)) return null;
  return { from: start + hit.index, to: start + hit.index + hit[0].length, name: hit[0] };
}

// Modifier changes also refresh a stationary pointer. No definition request is
// sent until a click; the preview has no effect on the caret, selection or undo.
export function mountDefinitionLinks({ target, document, window, enabled, locate, show, clear, mac = false }) {
  let point = null;
  const modifier = (event) => mac ? event.metaKey : event.ctrlKey;
  const move = (event) => {
    point = { clientX: event.clientX, clientY: event.clientY };
    if (enabled() && modifier(event) && !event.altKey) show(locate(point)); else clear();
  };
  const leave = () => { point = null; clear(); };
  const key = (event) => {
    if (!modifier(event) || event.altKey) clear();
    else if (point && enabled()) show(locate(point));
  };
  const visibility = () => { if (document.hidden) leave(); };
  target.addEventListener('mousemove', move);
  target.addEventListener('mouseleave', leave);
  target.addEventListener('input', clear);
  target.addEventListener('blur', clear);
  document.addEventListener('keydown', key, true);
  document.addEventListener('keyup', key, true);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('blur', leave);
  return {
    leave,
    dispose() {
      leave();
      target.removeEventListener('mousemove', move); target.removeEventListener('mouseleave', leave);
      target.removeEventListener('input', clear); target.removeEventListener('blur', clear);
      document.removeEventListener('keydown', key, true); document.removeEventListener('keyup', key, true);
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('blur', leave);
    },
  };
}
