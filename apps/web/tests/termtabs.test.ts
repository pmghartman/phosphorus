import { expect, test } from 'bun:test';
import {
  type TermTab,
  tabAdd,
  tabClose,
  tabDefaultHost,
  tabLabel,
  tabMove,
  tabStep,
} from '../src/desktop/desk/termtabs.ts';

const hosts = (tabs: TermTab[]) => tabs.map((t) => t.host);
const labels = (tabs: TermTab[]) => tabs.map((t) => tabLabel(tabs, t));

test('labels: the host alone, a counter once a host has several', () => {
  const tabs: TermTab[] = [];
  const a = tabAdd(tabs, 'nas', {});
  tabAdd(tabs, 'pc', {});
  expect(labels(tabs)).toEqual(['nas', 'pc']);
  tabAdd(tabs, 'nas', {});
  expect(labels(tabs)).toEqual(['nas (1)', 'pc', 'nas (2)']);
  // the lowest free counter reused, the others kept
  tabClose(tabs, a.id, a.id);
  expect(labels(tabs)).toEqual(['pc', 'nas']);
  tabAdd(tabs, 'nas', {});
  expect(labels(tabs)).toEqual(['pc', 'nas (2)', 'nas (1)']);
});

test('extra fields carried', () => {
  const tabs: (TermTab & { shared: boolean })[] = [];
  expect(tabAdd(tabs, 'nas', { shared: true }).shared).toBe(true);
});

test('move', () => {
  const tabs: TermTab[] = [];
  for (const h of ['a', 'b', 'c', 'd']) tabAdd(tabs, h, {});
  tabMove(tabs, 0, 2);
  expect(hosts(tabs)).toEqual(['b', 'c', 'a', 'd']);
  tabMove(tabs, 3, 0);
  expect(hosts(tabs)).toEqual(['d', 'b', 'c', 'a']);
  tabMove(tabs, 1, 99);
  expect(hosts(tabs)).toEqual(['d', 'c', 'a', 'b']);
  tabMove(tabs, 9, 0);
  expect(hosts(tabs)).toEqual(['d', 'c', 'a', 'b']);
});

test('close: the right neighbour shown next, else the left, null once empty', () => {
  const tabs: TermTab[] = [];
  const [a, b, c] = ['a', 'b', 'c'].map((h) => tabAdd(tabs, h, {}));
  expect(tabClose(tabs, b!.id, b!.id)).toBe(c!.id);
  expect(tabClose(tabs, c!.id, c!.id)).toBe(a!.id);
  expect(tabClose(tabs, 12345, a!.id)).toBe(a!.id);
  const d = tabAdd(tabs, 'd', {});
  // another closed: the active one stays
  expect(tabClose(tabs, d.id, a!.id)).toBe(a!.id);
  expect(tabClose(tabs, a!.id, a!.id)).toBeNull();
});

test('step round the ends', () => {
  const tabs: TermTab[] = [];
  const [a, b, c] = ['a', 'b', 'c'].map((h) => tabAdd(tabs, h, {}));
  expect(tabStep(tabs, a!.id, false)).toBe(b!.id);
  expect(tabStep(tabs, c!.id, false)).toBe(a!.id);
  expect(tabStep(tabs, a!.id, true)).toBe(c!.id);
  expect(tabStep([], 1, false)).toBeNull();
});

test('default host: the serving one, else the last used, else any', () => {
  expect(tabDefaultHost(['a', 'b', 'self'], 'self', 'b')).toBe('self');
  expect(tabDefaultHost(['a', 'b'], 'self', 'b')).toBe('b');
  expect(tabDefaultHost(['a', 'b'], 'self', 'gone')).toBe('a');
  expect(tabDefaultHost([], 'self', 'b')).toBe('');
});
