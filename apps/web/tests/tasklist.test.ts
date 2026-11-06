import { expect, test } from 'bun:test';
import type { Item } from '../src/desktop/desk/hosts.ts';
import { appOf, barTasks, label, type Task } from '../src/desktop/desk/tasklist.ts';

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

test("a window's app, for its icon: by its program, else by the app named at the end of its title", () => {
  const apps: Item[] = [
    { name: 'Slack', kind: 'gui', path: 'C:\\Users\\a\\Start Menu\\Programs\\Slack.lnk', icon: 'l:x' },
    { name: 'Visual Studio Code', kind: 'gui', path: 'C:\\x\\Code.lnk', icon: 'f:y' },
    { name: 'Discord', kind: 'gui', path: 'C:\\x\\Discord.lnk' },
    { name: 'git', kind: 'cli', run: 'git' },
  ];
  expect(appOf(task({ name: 'slack.exe', windows: [[1, 'general - mulab - Slack']] }), apps)?.name).toBe('Slack');
  expect(appOf(task({ name: 'Code.exe', windows: [[1, 'spaces.ts - Visual Studio Code']] }), apps)?.name).toBe(
    'Visual Studio Code',
  );
  expect(
    appOf(task({ name: 'Update.exe', exe: 'C:\\a\\Discord\\Update.exe', windows: [[1, '#dev - Discord']] }), apps)
      ?.name,
  ).toBe('Discord');
  expect(appOf(task({ name: 'git.exe', windows: [[1, 'git']] }), apps)).toBeUndefined();
  expect(appOf(task({ name: 'x.exe', windows: [[1, 'Slackware']] }), apps)).toBeUndefined();
});
