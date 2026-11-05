// host apps that are a website in a shell: opened as that site in a tab,
// afterglow kept for a right click

import type { Item } from './hosts.ts';

export type Site = { name: string; url: string };

// keys: display names, exe or .lnk names, desktop ids and store package families, lowercase
const sites: (Site & { keys: string[] })[] = [
  {
    name: 'slack',
    url: 'https://app.slack.com/client',
    keys: ['slack', 'com.slack.slack', '91750d7e.slack'],
  },
  { name: 'discord', url: 'https://discord.com/app', keys: ['discord', 'com.discordapp.discord'] },
  {
    name: 'spotify',
    url: 'https://open.spotify.com',
    keys: ['spotify', 'com.spotify.client', 'spotify_spotify', 'spotifyab.spotifymusic'],
  },
  { name: 'notion', url: 'https://www.notion.so', keys: ['notion'] },
  { name: 'figma', url: 'https://www.figma.com/files', keys: ['figma'] },
  {
    name: 'teams',
    url: 'https://teams.microsoft.com',
    keys: [
      'microsoft teams',
      'microsoft teams (work or school)',
      'ms-teams',
      'msteams',
      'teams-for-linux',
      'com.github.ismaelmartinez.teams_for_linux',
    ],
  },
  { name: 'whatsapp', url: 'https://web.whatsapp.com', keys: ['whatsapp', '5319275a.whatsappdesktop'] },
  { name: 'linear', url: 'https://linear.app', keys: ['linear'] },
  { name: 'chatgpt', url: 'https://chatgpt.com', keys: ['chatgpt', 'openai.chatgpt-desktop'] },
  { name: 'claude', url: 'https://claude.ai', keys: ['claude'] },
  {
    name: 'telegram',
    url: 'https://web.telegram.org',
    keys: ['telegram', 'telegram desktop', 'org.telegram.desktop', 'telegrammessengerllp.telegramdesktop'],
  },
  { name: 'todoist', url: 'https://app.todoist.com', keys: ['todoist', 'com.todoist.todoist'] },
];

const byKey = new Map(sites.flatMap((s) => s.keys.map((k) => [k, { name: s.name, url: s.url }] as const)));

// a .lnk, .exe or .desktop file's name bare
const stem = (p: string) => (p.split(/[\\/]/).pop() ?? '').replace(/\.(lnk|exe|desktop)$/i, '').toLowerCase();

// a store AppID's package family, before its publisher hash or entry
const family = (id: string) => id.split(/[_!]/)[0]!.toLowerCase();

// the site a host's window app stands for, none for anything else
export function siteOf(it: Item): Site | undefined {
  if (it.kind !== 'gui') return;
  const keys = [it.name.toLowerCase(), stem(it.path ?? ''), stem(it.id ?? ''), family(it.id ?? '')];
  for (const k of keys) {
    const s = k && byKey.get(k);
    if (s) return s;
  }
}
