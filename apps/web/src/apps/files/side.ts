// the side: Home, then each host and its shares

import { api, hostInfo } from '../../desktop/desk/hosts.ts';
import {
  deskLoc,
  deskRel,
  type Fm,
  filesCall,
  fmIcon,
  fmSame,
  homeLoc,
  isDesk,
  isHome,
  type Loc,
} from '../../features/home/home.ts';
import { phosphorusHosts } from '../../features/mesh/hosts.ts';
import { acctCall } from '../../lib/api.ts';
import { el } from '../../lib/dom.ts';
import { st } from '../../lib/state.ts';
import { fmDropZone } from './actions.ts';
import { fmGo } from './nav.ts';

// the hosts up, this one first
const fmHostsUp = () => [...new Set([st.selfHost, ...phosphorusHosts()].filter(Boolean))];

// a share's friendly name: its folder's own
export const shareLabel = (root: string) =>
  root
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .pop() || root;

// a host's disk: its home, then every drive or mount, read once a window
type Root = { name: string; path: string; label: string };
const roots = new Map<string, Root[]>();

function deskSide(fm: Fm, h: string): HTMLElement[] {
  const place = (label: string, rel: string, title: string, kind = 'dir') => {
    const row = el('div', `fm-place fm-share${fm.dir === rel ? ' here' : ''}`);
    row.append(fmIcon(kind), el('span', '', label));
    row.title = title;
    row.addEventListener('click', () => fmGo(fm, deskLoc(h), rel));
    return row;
  };
  const out: HTMLElement[] = [el('div', 'fm-side-head', h)];
  const home = hostInfo(h).desk?.home;
  if (home) out.push(place('home', deskRel(home), home));
  const list = roots.get(h);
  if (!list) {
    roots.set(h, []);
    void acctCall<{ roots: Root[] }>(api(h, 'roots')).then((r) => {
      if (r.ok && r.roots) roots.set(h, r.roots);
      fm.renderSide?.();
    });
  }
  for (const r of list ?? []) {
    const label = r.label && !r.label.startsWith('/dev/') ? `${r.name} ${r.label}` : r.name;
    out.push(place(label, deskRel(r.path), r.path, 'drive'));
  }
  return out;
}

export async function fmSide(fm: Fm) {
  const render = () => {
    // a host's disk: that host's places alone, as on its own desktop
    if (isDesk(fm.loc)) {
      fm.side.replaceChildren(...deskSide(fm, fm.loc!.host));
      return;
    }
    const place = (loc: Loc, label: string, title: string, cls = '') => {
      const row = el('div', `fm-place fm-share${cls}${fmSame(loc, fm.loc) ? ' here' : ''}`);
      row.append(fmIcon('dir'), el('span', '', label));
      row.title = title;
      row.addEventListener('click', () => fmGo(fm, loc, ''));
      fmDropZone(fm, row, () => ({ loc, dir: '' }));
      return row;
    };
    const out: HTMLElement[] = [];
    if (st.acct) {
      const home = place(homeLoc(), 'home', 'your home, the same on every host', ' fm-home');
      // Home is one place on every host: here whichever host shows it
      home.classList.toggle('here', isHome(fm.loc));
      out.push(home);
    }
    const hosts = fmHostsUp().filter((h) => fm.shares.get(h)?.shares?.length);
    if (hosts.length) out.push(el('div', 'fm-side-head', 'hosts'));
    for (const h of hosts) {
      const hostRow = el('div', 'fm-place fm-hostrow');
      hostRow.append(fmIcon('host'), el('span', '', h));
      out.push(hostRow);
      for (const loc of fm.shares.get(h)!.shares!) out.push(place(loc, shareLabel(loc.root!), `${h}: ${loc.root}`));
    }
    fm.side.replaceChildren(...out);
  };
  fm.renderSide = render;
  render();
  await fmHosts(fm);
  // no place yet: the home, else the first share
  if (!fm.loc) {
    const first = [...fm.shares.values()].find((i) => i?.shares?.length);
    if (st.acct) fmGo(fm, homeLoc(), '');
    else if (first) fmGo(fm, first.shares![0]!, '');
  }
}

// the side kept to the hosts up: a new one's shares asked, a gone one's place left
export async function fmHosts(fm: Fm): Promise<void> {
  const on = fmHostsUp();
  // asked on every state push: nothing redrawn while the hosts up are the same
  const sig = on.join('\n');
  if (sig === fm.sideSig) return;
  fm.sideSig = sig;
  if (fm.loc && !isHome(fm.loc) && !isDesk(fm.loc) && !on.includes(fm.loc.host)) fmGo(fm, homeLoc(), '');
  else fm.renderSide?.();
  await Promise.all(
    on
      .filter((h) => !fm.shares.has(h))
      .map(async (h) => {
        fm.shares.set(h, null);
        try {
          // what the host published in sys, else asked
          const info = st.hostsInfo[h.toLowerCase()]?.files || (await filesCall({ host: h }, 'info'));
          fm.shares.set(h, {
            shares: (info.shares || [])
              .filter((sh) => sh.id !== 'home')
              .map((sh): Loc => ({ host: h, share: sh.id, root: sh.label, perms: sh.perms || '' })),
          });
        } catch (err) {
          fm.shares.set(h, { error: (err as Error).message });
        }
        fm.renderSide?.();
      }),
  );
  for (const h of [...fm.shares.keys()]) if (!on.includes(h)) fm.shares.delete(h);
}
