// the side: places and hosts

import { type Fm, filesCall, fmIcon, fmSame, HOME, homeOnline, type Loc } from '../../features/home/home.ts';
import { el } from '../../lib/dom.ts';
import { st } from '../../lib/state.ts';
import { fmDropZone } from './actions.ts';
import { fmGo } from './nav.ts';

// each online host's shares, asked once a host comes up, as its own [files] perms allow

export async function fmSide(fm: Fm) {
  const render = () => {
    const hosts = homeOnline();
    const home = el('div', `fm-place fm-share${fmSame(HOME, fm.loc) ? ' here' : ''}`);
    home.append(fmIcon('dir'), el('span', '', 'home'));
    home.title = "every host's home as one";
    home.addEventListener('click', () => fmGo(fm, HOME, ''));
    fmDropZone(fm, home, () => ({ loc: HOME, dir: '' }));
    const out = [home, el('div', 'fm-side-head', 'hosts')];
    for (const h of hosts) {
      const info = fm.shares.get(h);
      const hostRow = el('div', 'fm-place fm-hostrow');
      hostRow.append(fmIcon('host'), el('span', '', h));
      out.push(hostRow);
      if (!info) {
        out.push(el('div', 'fm-place-note', '…'));
        continue;
      }
      if (info.error) {
        out.push(Object.assign(el('div', 'fm-place-note bad', info.error), { title: info.error }));
        continue;
      }
      for (const loc of info.shares!) {
        const row = el('div', `fm-place fm-share${fmSame(loc, fm.loc) ? ' here' : ''}`);
        row.append(fmIcon('dir'), el('span', '', loc.root));
        row.title = `${h}/${loc.root}`;
        row.addEventListener('click', () => fmGo(fm, loc, ''));
        fmDropZone(fm, row, () => ({ loc, dir: '' }));
        out.push(row);
      }
    }
    fm.side.replaceChildren(...out);
  };
  fm.renderSide = render;
  render();
  await fmHosts(fm);
  // no place yet: the home, the boot admin's first share
  if (!fm.loc) {
    const first = [...fm.shares.values()].find((i) => i?.shares?.length);
    if (st.acct && !st.acct.boot) fmGo(fm, HOME, '');
    else if (first) fmGo(fm, first.shares![0]!, '');
  }
}

// the side kept to the hosts up: a new one's shares asked, a gone one's place left
export async function fmHosts(fm: Fm): Promise<void> {
  const on = homeOnline();
  // asked on every state push: nothing redrawn while the hosts up are the same
  const sig = on.join('\n');
  if (sig === fm.sideSig) return;
  fm.sideSig = sig;
  if (fm.loc && fm.loc.host !== '*' && !on.includes(fm.loc.host)) fmGo(fm, HOME, '');
  else fm.renderSide?.();
  await Promise.all(
    on
      .filter((h) => !fm.shares.has(h))
      .map(async (h) => {
        fm.shares.set(h, null);
        try {
          // what the host published in sys, else asked
          const info = st.hostsInfo[h.toLowerCase()]?.files || (await filesCall({ host: h }, 'info'));
          // the home only as the merged one above, ssh logins no part of it
          fm.shares.set(
            h,
            info.enabled
              ? {
                  shares: info
                    .shares!.filter((sh) => sh.id !== 'home')
                    .map((sh): Loc => ({ host: h, share: sh.id, root: sh.label, perms: sh.perms || '' })),
                }
              : { error: 'no files directory' },
          );
        } catch (err) {
          fm.shares.set(h, { error: (err as Error).message });
        }
        fm.renderSide?.();
      }),
  );
  for (const h of [...fm.shares.keys()]) if (!on.includes(h)) fm.shares.delete(h);
}
