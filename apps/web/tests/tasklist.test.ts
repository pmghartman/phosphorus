import { expect, test } from 'bun:test';
import { barTasks, label, type Task } from '../src/desktop/desk/tasklist.ts';

const task = (o: Partial<Task>): Task => ({
  pid: 1,
  started: 1,
  name: 'a.exe',
  exe: '',
  windows: [],
  shell: false,
  ...o,
});
const none = { pids: new Set<number>(), wids: new Set<number>() };

test("a host's windows on its task bar: titled ones, the shell's desktop never one", () => {
  const app = task({ pid: 10, name: 'notepad.exe', windows: [[5, 'notes.txt - Notepad']] });
  const untitled = task({ pid: 11, name: 'helper.exe', windows: [[6, '']] });
  const desk = task({ pid: 12, name: 'explorer.exe', shell: true, windows: [[7, 'Program Manager']] });
  const folders = task({
    pid: 12,
    name: 'explorer.exe',
    shell: true,
    windows: [
      [8, 'Downloads'],
      [7, 'Program Manager'],
    ],
  });
  expect(barTasks([app, untitled, desk], none)).toEqual([app]);
  expect(barTasks([folders], none)).toEqual([folders]);
  expect(label(app)).toBe('notes.txt - Notepad');
  expect(label(folders)).toBe('File Explorer');
  expect(label(task({ name: 'Game.EXE', windows: [[1, ' ']] }))).toBe('Game');
});

test('an app already streamed here has its own window button, by pid or by its windows', () => {
  const a = task({ pid: 10, windows: [[5, 'A']] });
  const b = task({
    pid: 11,
    windows: [
      [6, 'B'],
      [9, 'B dialog'],
    ],
  });
  const c = task({ pid: 12, windows: [[7, 'C']] });
  expect(barTasks([a, b, c], { pids: new Set([10]), wids: new Set([9]) })).toEqual([c]);
});
