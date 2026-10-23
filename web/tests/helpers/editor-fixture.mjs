import { EditorHistory } from '../../src/editor-history.js';
import { opApply, opEdits } from '../../src/text-operations.js';

export class Element extends EventTarget {
  constructor(tag = 'div', className = '', text = '') {
    super(); Object.assign(this, { tag, className, textContent: text, children: [], attributes: {}, style: {}, hidden: false, selectionStart: 0, selectionEnd: 0, scrollTop: 0, scrollLeft: 0, clientHeight: 220, offsetHeight: 22, offsetWidth: 430, offsetTop: 0 });
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  get firstChild() { return this.children[0]; }
  getBoundingClientRect() { return { top: 0, left: 0, width: 1000, height: 700 }; }
  getContext() { return { measureText: () => ({ width: 8 }) }; }
  focus() { document.activeElement = this; }
  remove() {}
  emit(type, props = {}) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, props); this.dispatchEvent(event); return event;
  }
}

export function editorFixture(t, text = 'const answer = ') {
  const original = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle, fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
  const doc = new EventTarget();
  doc.createElement = (tag) => new Element(tag);
  globalThis.document = doc;
  globalThis.getComputedStyle = () => ({ font: '13px monospace', lineHeight: '20px', fontSize: '13px', paddingTop: '0', paddingLeft: '8', tabSize: '4' });
  const ta = new Element('textarea', 'code-ta');
  const scroller = new Element('div', 'code-ed');
  const view = new Element('div', 'ide-view-ed');
  view.querySelector = (selector) => selector === '.code-ta' ? ta : selector === '.code-ed' ? scroller : view.children.find((x) => x.className === selector.slice(1)) || null;
  const history = new EditorHistory();
  const edits = [], previews = [], diagnostics = [], semantics = [];
  const tab = { id: 'test', rel: 'src/test.js', view, info: { lang: 'javascript' }, dispose: () => { tab.disposed = true; } };
  tab.ed = {
    text: () => text, selection: () => [ta.selectionStart, ta.selectionEnd], ready: () => true,
    focus: () => ta.focus(), setDiagnostics(value) { diagnostics.push(value); },
    setSemanticTokens(ranges, source) { semantics.push({ ranges, source }); },
    setInlineSuggestion: (value) => previews.push(value),
    editMany(batch, selection) {
      edits.push(batch);
      const op = opEdits(text, batch);
      history.recordOperation(text, op, this.selection(), selection);
      text = opApply(text, op);
      ta.selectionStart = selection[0]; ta.selectionEnd = selection[1];
    },
  };
  const setText = (next, caret = next.length) => { text = next; ta.selectionStart = ta.selectionEnd = caret; };
  setText(text); ta.focus();
  const cleanups = [];
  t.after(() => { try { for (const cleanup of cleanups) cleanup(); } finally { Object.assign(globalThis, original); } });
  return { tab, ta, view, doc, scroller, setText, edits, previews, diagnostics, semantics, history, cleanups, alive: (target) => target === tab && !tab.disposed };
}

export const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
