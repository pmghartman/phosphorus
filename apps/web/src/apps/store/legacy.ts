// the move off the git service phosphorus used to run itself, an admin's: the
// newest old copy of Forgejo's data moved into the installed Forgejo on its host, the
// other old copies' hosts its standbys; the old copies deleted once it serves

import type { LegacyGit } from '@phosphorus/wire';
import { jsonPost } from '../../lib/api.ts';
import { el, pageAsk } from '../../lib/dom.ts';
import { st } from '../../lib/state.ts';
import { pollState } from '../../lib/sync.ts';
import { dockerBusy, statusOn } from './catalog.ts';
import { draw } from './draw.ts';
import { stateVars } from './state.ts';

// the standbys picked, the other copies' hosts until changed
let picked: Set<string> | null = null;
let busy = false;
let error = '';

// each host still holding an old copy, the newest first
function copies(): string[] {
  return Object.entries(st.hostsInfo)
    .filter(([, i]) => i.legacyGit)
    .sort(
      ([a, x], [b, y]) =>
        y.legacyGit!.gen - x.legacyGit!.gen || y.legacyGit!.stamp - x.legacyGit!.stamp || a.localeCompare(b),
    )
    .map(([h]) => h);
}

// the old copies' hosts while an install of Forgejo would move them, none once moved;
// the server turns that install into the move, as here
export function legacyPending(source: string, ref: string): string[] {
  if (source !== 'phosphorus' || ref !== 'forgejo') return [];
  const l = st.lastState?.legacyGit;
  return l?.state === 'moved' || l?.cleared ? [] : copies();
}

const redraw = () => {
  stateVars.sig = '';
  draw();
};

async function post(path: string, body: unknown) {
  busy = true;
  error = '';
  redraw();
  try {
    const r = await fetch(path, { ...jsonPost(body), signal: AbortSignal.timeout(30000) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `status ${r.status}`);
    await pollState();
  } catch (e) {
    error = (e as Error).message;
  }
  busy = false;
  redraw();
}

async function move(from: string, standbys: string[]) {
  // Docker asked first of each host that has none yet
  for (const h of [from, ...standbys])
    if (st.hostsInfo[h]?.docker?.state === 'installable' && !dockerBusy(h))
      await fetch('/api/stacks/docker', jsonPost({ host: h })).catch(() => {});
  await post('/api/stacks/legacy-git/move', { from, standbys });
}

async function clear(hosts: string[]) {
  const ok = await pageAsk({
    title: 'delete the old git data',
    message: `The old built-in git's copies on ${hosts.join(', ')} go for good. Forgejo's data in the installed Forgejo stays.`,
    action: 'delete',
    danger: true,
  });
  if (ok) await post('/api/stacks/legacy-git/clear', {});
}

const pill = (label: string, on: () => void, disabled = false) => {
  const b = Object.assign(el('button', `store-pill${busy ? ' wait' : ''}`, label), {
    type: 'button',
    disabled: busy || disabled,
  });
  b.addEventListener('click', on);
  return b;
};

// the services tab's box for it, admins only; null with nothing old left
export function legacyGitBox(): HTMLElement | null {
  if (!st.acct?.admin) return null;
  const old = copies();
  if (!old.length) return null;
  const l: LegacyGit | null | undefined = st.lastState?.legacyGit;
  const git = st.lastState?.stacks?.forgejo;
  const box = el('div', 'store-repo store-legacy');
  const head = (t: string) => el('b', 'store-repo-head', t);
  const sub = (t: string) => el('span', 'store-repo-sub', t);
  const domain = st.meshDomain ? `forgejo.${st.meshDomain}` : 'forgejo';
  const alias = st.meshDomain ? `git.${st.meshDomain}` : 'git';

  if (l?.cleared) {
    box.append(head('deleting the old git data'), sub(`Still to go on ${old.join(', ')}, each once it's up.`));
  } else if (l?.state === 'asked' || l?.state === 'copying') {
    box.append(head('moving Forgejo into the services'), sub(`Copying the old git data on ${l.from} into Forgejo…`));
  } else if (git && (l?.state === 'moved' || !l || l.state === 'failed')) {
    const s = statusOn(git.active, 'forgejo');
    const serving = !!s && s.role === 'active' && s.running && s.healthy !== false;
    box.append(
      head(l?.state === 'moved' ? 'Forgejo moved into the services' : 'the old git data is still here'),
      sub(
        serving
          ? `Forgejo runs on ${git.active}${git.standbys.length ? `, standbys ${git.standbys.join(', ')}` : ''}. Once ${domain} shows your repos, delete the old copies on ${old.join(', ')}.`
          : `Forgejo is starting on ${git.active}. The old copies on ${old.join(', ')} stay until it serves.`,
      ),
    );
    const line = el('div', 'store-repo-line');
    line.append(pill('delete the old copies', () => void clear(old), !serving));
    box.append(line);
  } else {
    const from = old[0]!;
    const others = old.slice(1);
    if (!picked) picked = new Set(others);
    box.append(
      head('move git into Forgejo'),
      sub(
        `Forgejo now installs like any other service. The old built-in git's data is on ${old.join(', ')}; ${from} has the newest. ` +
          `Move it into Forgejo installed on ${from}, at ${domain}, and at ${alias} as before. Nothing old is deleted until you say so.`,
      ),
    );
    if (others.length) {
      const chips = el('div', 'store-repo-line');
      chips.append(el('span', 'store-repo-sub', 'standbys'));
      for (const h of others) {
        const on = picked.has(h);
        const b = Object.assign(el('button', `store-chip${on ? ' on' : ''}`, h), { type: 'button' });
        b.addEventListener('click', () => {
          if (on) picked!.delete(h);
          else picked!.add(h);
          redraw();
        });
        chips.append(b);
      }
      box.append(chips);
    }
    if (st.hostsInfo[from]?.docker?.state === 'unsupported')
      box.append(el('span', 'store-repo-err', `${from} can't run Docker; move the data by hand (see the README)`));
    const line = el('div', 'store-repo-line');
    line.append(
      pill(
        `move to ${from}`,
        () =>
          void move(
            from,
            [...(picked ?? [])].filter((h) => old.includes(h)),
          ),
      ),
    );
    box.append(line);
    if (l?.state === 'failed') box.append(el('span', 'store-repo-err', `the last move failed: ${l.error ?? ''}`));
  }
  if (error) box.append(el('span', 'store-repo-err', error));
  return box;
}
