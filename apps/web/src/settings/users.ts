// --- settings › users: the mesh's users for an admin, and a device invited onto the tailnet

import { acctUsers } from '../features/account.ts';
import { copyIcon, el } from '../lib/dom.ts';
import { copyText } from '../lib/util.ts';

export function usersSection(pane: HTMLElement): void {
  const body = el('div', 'acct-pane set-acct');
  body.append(el('div', 'dk-pick-head', 'users'), acctUsers(), el('div', 'dk-pick-head', 'invite a device'), invite());
  pane.appendChild(body);
}

// one-use ephemeral tag:guest key, minted per press: a device that runs it joins the tailnet
// as a guest, reaching the game servers and nothing it isn't granted
function invite(): HTMLElement {
  const box = el('div', 'join-key');
  const go = Object.assign(el('button', 'join-key-btn', 'request guest key'), {
    type: 'button',
    title: 'single use, lasts 3 days',
  });
  const get = Object.assign(el('a', '', 'install tailscale'), {
    href: 'https://tailscale.com/download',
    target: '_blank',
    rel: 'noopener',
  });
  const out = el('div', 'join-key-out');
  box.append(el('p', 'dk-note', 'Install Tailscale on the device, then run this.'), go, get, out);
  go.addEventListener('click', async () => {
    out.replaceChildren();
    go.disabled = true;
    try {
      const r = await fetch('/api/join-key', { method: 'POST' });
      const got = await r.json().catch(() => ({}));
      if (!r.ok || !got.key) throw new Error(got.error || `status ${r.status}`);
      const cmd = `tailscale up --auth-key=${got.key}`;
      const row = el('div', 'join-key-cmd');
      row.title = 'single use, 3 days';
      const copy = Object.assign(el('button', 'copy-btn'), { type: 'button', title: 'copy', ariaLabel: 'copy' });
      copy.appendChild(copyIcon());
      copy.addEventListener('click', () =>
        copyText(cmd)
          .then(() => {
            copy.replaceChildren(copyIcon(true));
            setTimeout(() => copy.replaceChildren(copyIcon()), 1200);
          })
          .catch(() => {}),
      );
      row.append(el('code', '', cmd), copy);
      out.append(row);
    } catch (err) {
      out.append(el('div', 'join-key-err', `no key: ${(err as Error).message}`));
    } finally {
      go.disabled = false;
    }
  });
  return box;
}
