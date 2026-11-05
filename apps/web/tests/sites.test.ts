import { expect, test } from 'bun:test';
import type { Item } from '../src/desktop/desk/hosts.ts';
import { siteOf } from '../src/desktop/desk/sites.ts';

const gui = (o: Partial<Item>): Item => ({ name: '', kind: 'gui', ...o });
const url = (o: Partial<Item>) => siteOf(gui(o))?.url;

test('windows: by name, .lnk and store package family', () => {
  expect(url({ name: 'Slack', path: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Slack.lnk' })).toBe(
    'https://app.slack.com/client',
  );
  // squirrel launchers point at Update.exe, the shortcut's name carries it
  expect(url({ name: 'Discord Canary', path: 'C:\\Users\\a\\Desktop\\Discord.lnk' })).toBe('https://discord.com/app');
  expect(url({ name: 'Spotify Music', id: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' })).toBe(
    'https://open.spotify.com',
  );
  expect(url({ name: 'Microsoft Teams', id: 'MSTeams_8wekyb3d8bbwe!MSTeams' })).toBe('https://teams.microsoft.com');
});

test('linux: desktop ids and flatpaks', () => {
  expect(url({ name: 'Spotify', path: '/var/lib/flatpak/exports/share/applications/com.spotify.Client.desktop' })).toBe(
    'https://open.spotify.com',
  );
  expect(url({ name: 'Telegram Desktop', id: 'org.telegram.desktop.desktop' })).toBe('https://web.telegram.org');
});

test('only window apps, nothing unknown', () => {
  expect(siteOf({ name: 'claude', kind: 'cli', run: 'claude' })).toBeUndefined();
  expect(url({ name: 'Visual Studio Code', path: 'C:\\x\\Code.lnk' })).toBeUndefined();
  expect(url({ name: 'Slackware notes', path: '/usr/share/applications/notes.desktop' })).toBeUndefined();
  expect(url({ name: '' })).toBeUndefined();
});
