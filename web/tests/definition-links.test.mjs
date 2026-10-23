import test from 'node:test';
import assert from 'node:assert/strict';
import { definitionIdentifier, mountDefinitionLinks } from '../src/sulfur/definition-links.js';
import { offsetAtColumn } from '../src/sulfur/diagnostics.js';

test('definition links identify the exact hovered UTF-16 token and reject whitespace, keywords and literals', () => {
  const text = '\tScriptComponent component;\r\n  café.Read(); // component\n  "component"';
  assert.equal(definitionIdentifier(text, offsetAtColumn(text, 0, 5, 4), { extension: 'cs' }).name, 'ScriptComponent');
  assert.equal(definitionIdentifier(text, text.indexOf('café') + 3).name, 'café');
  assert.equal(definitionIdentifier(text, 0), null);
  assert.equal(definitionIdentifier(text, text.indexOf('//') + 4, { extension: 'cs' }), null);
  assert.equal(definitionIdentifier(text, text.lastIndexOf('component') + 1, { extension: 'cs' }), null);
  assert.equal(definitionIdentifier('public Player', 2), null);
  assert.equal(definitionIdentifier('Player ', 6), null);
  assert.equal(definitionIdentifier(text, null), null);
  const tree = { resolveInner: () => ({ name: 'Identifier', parent: { name: 'BlockComment' } }) };
  assert.equal(definitionIdentifier('component', 2, { tree }), null);
});

function fixture(mac = false) {
  const target = new EventTarget(), document = new EventTarget(), window = new EventTarget();
  const shown = []; let active = null;
  const links = mountDefinitionLinks({ target, document, window, mac, enabled: () => true, locate: (point) => ({ from: point.clientX, to: point.clientX + 5 }), show: (value) => { active = value; shown.push(value); }, clear: () => { active = null; } });
  const emit = (node, name, fields = {}) => node.dispatchEvent(Object.assign(new Event(name), fields));
  return { target, document, window, links, emit, shown, active: () => active };
}

test('Ctrl hover updates a stationary pointer and clears on release, pointer leave, edits and disposal', () => {
  const f = fixture();
  f.emit(f.target, 'mousemove', { clientX: 10, clientY: 20, ctrlKey: false });
  assert.equal(f.active(), null);
  f.emit(f.document, 'keydown', { ctrlKey: true });
  assert.equal(f.active().from, 10);
  f.emit(f.document, 'keyup', { ctrlKey: false }); assert.equal(f.active(), null);
  f.emit(f.target, 'mousemove', { clientX: 20, clientY: 20, ctrlKey: true });
  assert.equal(f.active().from, 20);
  f.emit(f.target, 'input'); assert.equal(f.active(), null);
  f.emit(f.target, 'mouseleave');
  f.emit(f.document, 'keydown', { ctrlKey: true }); assert.equal(f.active(), null);
  f.links.dispose();
  f.emit(f.target, 'mousemove', { clientX: 30, clientY: 20, ctrlKey: true }); assert.equal(f.active(), null);
});

test('macOS uses Command and window blur removes hover even if keyup arrives elsewhere', () => {
  const f = fixture(true);
  f.emit(f.target, 'mousemove', { clientX: 10, clientY: 20, ctrlKey: true }); assert.equal(f.active(), null);
  f.emit(f.target, 'mousemove', { clientX: 10, clientY: 20, metaKey: true }); assert.ok(f.active());
  f.emit(f.window, 'blur'); assert.equal(f.active(), null);
  f.emit(f.document, 'keydown', { metaKey: true }); assert.equal(f.active(), null);
  f.links.dispose();
});
