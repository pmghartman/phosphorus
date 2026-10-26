import test from 'node:test';
import assert from 'node:assert/strict';
import { bindContextMenu } from '../src/sulfur/context-menu.js';

function fixture(options) {
  const node = new EventTarget(), shown = [];
  bindContextMenu(node, () => [{ label: 'Open' }], (...args) => shown.push(args), options);
  const send = (type, props = {}) => {
    const event = new Event(type, { cancelable: true });
    const target = { closest: () => false, getBoundingClientRect: () => ({ left: 12, bottom: 38 }) };
    const { target: actualTarget = target, ...rest } = props;
    Object.defineProperty(event, 'target', { value: actualTarget });
    Object.assign(event, { clientX: 42, clientY: 52, ...rest });
    node.dispatchEvent(event); return event;
  };
  return { node, shown, send };
}

test('panel context menus use pointer coordinates and prevent competing ancestor menus', () => {
  const f = fixture();
  const event = f.send('contextmenu');
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(f.shown[0][0], { x: 42, y: 52 });
  assert.equal(f.shown[0][1][0].label, 'Open');
});

test('Shift+F10 and the menu key open at the focused item and focus the first action', () => {
  const f = fixture();
  f.send('keydown', { key: 'F10', shiftKey: true });
  f.send('keydown', { key: 'ContextMenu' });
  f.send('keydown', { key: 'F10', shiftKey: false });
  assert.equal(f.shown.length, 2);
  assert.deepEqual(f.shown[0][0], { x: 12, y: 38 });
  assert.equal(f.shown[0][2].focusFirst, true);
});

test('native input menus and events already handled by child rows remain intact', () => {
  const f = fixture();
  f.send('contextmenu', { target: { closest: () => true } });
  const handled = new Event('contextmenu', { cancelable: true }); handled.preventDefault(); f.node.dispatchEvent(handled);
  assert.equal(f.shown.length, 0);
  const terminal = fixture({ nativeInputs: false });
  terminal.send('contextmenu', { target: { closest: () => true } });
  assert.equal(terminal.shown.length, 1);
});
