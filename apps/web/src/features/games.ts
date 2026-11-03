// --- game servers -----------------------------------------------------------

import type { Route } from '@phosphorus/wire';
// not links: joined in-game at <name>.<zone>, tailnet only, play/stop open to
// any viewer
import { postFailure } from '../lib/api.ts';
import { gameIcon } from '../lib/dom.ts';
import { pollState } from '../lib/sync.ts';
import { copyText } from '../lib/util.ts';
import { serviceKey } from './mesh/mesh.ts';

// games joined at <name>.phosphorus
const gameZone = 'phosphorus';

const gameBusy = new Map<string, string>(); // key -> action, while its press is in flight
const gameError = new Map<string, string>(); // key -> message from the last failed press
let lastGamesSig = '';
let lastGames: Route[] = [];

// stopping still counted as up, so a press never reshuffles the list
const gameUp = (g: Route) => g.status === 'online' || g.status === 'stopping';

// rebuilt only on change, a 500ms rebuild eating clicks mid-press
export function renderGames(games: Route[]): void {
  lastGames = games.sort(
    (a, b) => Number(gameUp(b)) - Number(gameUp(a)) || a.host.localeCompare(b.host) || a.name.localeCompare(b.name),
  );
  const sig = JSON.stringify([games, [...gameBusy], [...gameError]]);
  if (sig === lastGamesSig) return;
  lastGamesSig = sig;

  const list = document.getElementById('game-servers-list')!;
  const focused = (document.activeElement?.closest?.('.game-card') as HTMLElement | null)?.dataset.key;
  list.innerHTML = '';
  if (!games.length) {
    list.innerHTML = '<li class="empty">none yet</li>';
    return;
  }
  for (const g of games) {
    const key = serviceKey(g);
    const li = document.createElement('li');
    const card = document.createElement('div');
    card.className = 'game-card';
    card.tabIndex = 0;
    card.dataset.key = key;

    // online: pause (stops it), offline: play (starts it), in between: spinner
    const busy = gameBusy.has(key) || g.status === 'starting' || g.status === 'stopping';
    const action = gameUp(g) ? 'stop' : 'start';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `game-btn ${busy ? 'busy' : g.status}`;
    btn.disabled = busy || !g.controllable;
    btn.title = busy
      ? `${gameBusy.get(key) || g.status}…`
      : g.controllable
        ? `${g.status}: ${action === 'start' ? 'play' : 'stop'}`
        : `${g.status}: no start/stop commands`;
    btn.appendChild(gameIcon(busy ? 'busy' : action === 'start' ? 'play' : 'pause'));
    btn.addEventListener('click', () => pressGame(g, action));

    const info = document.createElement('div');
    info.className = 'game-info';
    const title = document.createElement('div');
    title.textContent = g.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = g.host;
    title.appendChild(meta);

    const address = `${g.name}.${gameZone}:${g.port}`;
    const detail = document.createElement('div');
    detail.className = 'game-detail';
    const addr = document.createElement('span');
    addr.className = 'game-addr';
    addr.textContent = address;
    addr.title = 'join at this address, on the tailnet';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'game-copy';
    copy.title = 'copy';
    copy.appendChild(gameIcon('copy'));
    copy.addEventListener('click', () =>
      copyText(address)
        .then(() => {
          copy.replaceChildren(gameIcon('check'));
          setTimeout(() => copy.replaceChildren(gameIcon('copy')), 1200);
        })
        .catch(() => {}),
    );
    detail.append(addr, copy);
    info.append(title);
    if (gameError.has(key)) {
      const err = document.createElement('div');
      err.className = 'game-error';
      err.textContent = gameError.get(key)!;
      info.appendChild(err);
    }

    card.append(btn, info, detail);
    li.appendChild(card);
    list.appendChild(li);
  }
  if (focused) [...list.querySelectorAll<HTMLElement>('.game-card')].find((c) => c.dataset.key === focused)?.focus();
}

async function pressGame(g: Route, action: string) {
  const key = serviceKey(g);
  gameBusy.set(key, action);
  gameError.delete(key);
  renderGames(lastGames);
  const why = await postFailure(`/api/games/${encodeURIComponent(g.host)}/${encodeURIComponent(g.name)}/${action}`);
  if (why) gameError.set(key, `${action} failed: ${why}`);
  gameBusy.delete(key);
  renderGames(lastGames);
  pollState();
  const shown = gameError.get(key);
  if (shown)
    setTimeout(() => {
      if (gameError.get(key) === shown) {
        gameError.delete(key);
        renderGames(lastGames);
      }
    }, 15000);
}
