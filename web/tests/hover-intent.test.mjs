import test from 'node:test';
import assert from 'node:assert/strict';
import { mountHoverIntent } from '../src/sulfur/hover-intent.js';

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const target = new EventTarget(), tooltip = new EventTarget(); tooltip.hidden = true;
  const moves = []; let hides = 0;
  const intent = mountHoverIntent({ target, tooltip,
    isAnchor: (e) => e.clientX >= 100 && e.clientX <= 110 && e.clientY >= 100 && e.clientY <= 110,
    onMove: (e) => { moves.push([e.clientX, e.clientY]); tooltip.hidden = true; },
    hide: () => { hides++; tooltip.hidden = true; },
  });
  t.after(() => intent.dispose());
  const emit = (node, type, x = 100, y = 100) => node.dispatchEvent(Object.assign(new Event(type), { clientX: x, clientY: y }));
  emit(target, 'mousemove'); tooltip.hidden = false;
  return { target, tooltip, emit, moves, intent, hides: () => hides };
}

test('the actual source symbol retains the tip and the popup can be entered across a short gap', (t) => {
  const f = fixture(t);
  f.emit(f.target, 'mousemove', 105, 105); t.mock.timers.tick(1000);
  assert.equal(f.tooltip.hidden, false);
  f.emit(f.target, 'mousemove', 112, 115); t.mock.timers.tick(100);
  f.emit(f.target, 'mouseleave'); f.emit(f.tooltip, 'mouseenter');
  t.mock.timers.tick(1000);
  assert.equal(f.tooltip.hidden, false);
  assert.equal(f.moves.length, 1);
});

test('stopping between the symbol and popup dismisses the stale tooltip within 250ms', (t) => {
  const f = fixture(t);
  f.emit(f.target, 'mousemove', 112, 115);
  t.mock.timers.tick(249); assert.equal(f.tooltip.hidden, false);
  t.mock.timers.tick(1); assert.equal(f.tooltip.hidden, true);
});

test('continuous movement outside the symbol cannot prolong the dismissal deadline', (t) => {
  const f = fixture(t);
  for (const x of [112, 120, 130, 140]) { f.emit(f.target, 'mousemove', x, 115); t.mock.timers.tick(60); }
  assert.equal(f.tooltip.hidden, false);
  t.mock.timers.tick(10);
  assert.equal(f.tooltip.hidden, true);
  assert.deepEqual(f.moves.at(-1), [140, 115]);
});

test('leaving the popup dismisses it; returning to the anchor cancels that dismissal', (t) => {
  const f = fixture(t);
  f.emit(f.tooltip, 'mouseleave'); t.mock.timers.tick(100);
  f.emit(f.target, 'mouseenter', 105, 105); t.mock.timers.tick(500);
  assert.equal(f.tooltip.hidden, false);
  f.emit(f.tooltip, 'mouseleave'); t.mock.timers.tick(250);
  assert.equal(f.hides(), 1);
  f.emit(f.tooltip, 'mouseleave'); f.intent.dispose(); t.mock.timers.tick(1000);
  assert.equal(f.hides(), 1);
});
