import test from 'node:test';
import assert from 'node:assert/strict';
import { mountHoverIntent, hoverBridgeContains } from '../src/sulfur/hover-intent.js';

function fixture(t, rect = { left: 112, right: 420, top: 120, bottom: 240 }) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const target = new EventTarget(), tooltip = new EventTarget();
  tooltip.hidden = true;
  tooltip.getBoundingClientRect = () => rect;
  const moves = [];
  let hides = 0;
  const intent = mountHoverIntent({ target, tooltip, onMove: (e) => moves.push([e.clientX, e.clientY]), hide: () => { hides++; tooltip.hidden = true; } });
  t.after(() => intent.dispose());
  const emit = (node, type, x = 100, y = 100) => node.dispatchEvent(Object.assign(new Event(type), { clientX: x, clientY: y }));
  emit(target, 'mousemove'); // the symbol's hover opens here
  tooltip.hidden = false;
  return { target, tooltip, emit, moves, intent, hides: () => hides };
}

test('Quick Fix remains reachable while slowly crossing text and the gap below a symbol', (t) => {
  const f = fixture(t);
  for (const [x, y] of [[103, 105], [107, 111], [112, 118]]) {
    f.emit(f.target, 'mousemove', x, y);
    t.mock.timers.tick(1000);
    assert.equal(f.tooltip.hidden, false);
    assert.equal(f.moves.length, 1, 'crossed text must not replace the original diagnostic');
  }
  f.emit(f.target, 'mouseleave');
  f.emit(f.tooltip, 'mouseenter');
  t.mock.timers.tick(1000);
  assert.equal(f.hides(), 0);
});

test('moving away updates the symbol only after resting, and entering the popup cancels pending replacement', (t) => {
  const f = fixture(t);
  f.emit(f.target, 'mousemove', 50, 100);
  t.mock.timers.tick(399);
  assert.equal(f.moves.length, 1);
  f.emit(f.tooltip, 'mouseenter');
  t.mock.timers.tick(1000);
  assert.equal(f.moves.length, 1);
  f.emit(f.target, 'mousemove', 40, 90);
  t.mock.timers.tick(400);
  assert.deepEqual(f.moves.at(-1), [40, 90]);
});

test('leaving the popup dismisses it, returning cancels dismissal, and disposal clears timers', (t) => {
  const f = fixture(t);
  f.emit(f.tooltip, 'mouseleave');
  t.mock.timers.tick(200);
  f.emit(f.tooltip, 'mouseenter');
  t.mock.timers.tick(400);
  assert.equal(f.hides(), 0);
  f.emit(f.tooltip, 'mouseleave');
  t.mock.timers.tick(400);
  assert.equal(f.hides(), 1);
  f.emit(f.tooltip, 'mouseleave');
  f.intent.dispose();
  t.mock.timers.tick(1000);
  f.emit(f.target, 'mousemove', 1, 1);
  assert.equal(f.hides(), 1);
  assert.equal(f.moves.length, 1);
});

test('travel region follows popups clamped above or left of the symbol without retaining unrelated words', () => {
  assert.equal(hoverBridgeContains({ x: 96, y: 86 }, { x: 100, y: 100 }, { left: 10, right: 90, top: 10, bottom: 80 }), true);
  assert.equal(hoverBridgeContains({ x: 350, y: 100 }, { x: 100, y: 100 }, { left: 112, right: 420, top: 120, bottom: 240 }), false);
  assert.equal(hoverBridgeContains({ x: 80, y: 180 }, { x: 100, y: 100 }, { left: 112, right: 420, top: 120, bottom: 240 }), false);
});
