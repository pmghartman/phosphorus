// --- settings › users: the mesh's users for an admin, and a guest's device invited onto the mesh

import { acctUsers } from '../features/account.ts';
import { copyIcon, el, noFill } from '../lib/dom.ts';
import { qrSVG } from '../lib/qr.ts';
import { copyText } from '../lib/util.ts';
import { cardify } from './settings.ts';

export function usersSection(pane: HTMLElement): void {
  const body = el('div', 'acct-pane set-acct');
  body.append(
    ...cardify([
      el('div', 'dk-pick-head', 'users'),
      acctUsers(),
      el('div', 'dk-pick-head', 'invite a device'),
      invite(),
    ]),
  );
  pane.appendChild(body);
}

// a guest's WireGuard config, made per press: a device on the WireGuard app that
// reaches the game servers and nothing it isn't granted, gone after three days
function invite(): HTMLElement {
  const box = el('div', 'join-key');
  const name = noFill(
    Object.assign(el('input', 'dk-ap-in'), { placeholder: 'their device, sam-phone say', spellcheck: false }),
  );
  const go = Object.assign(el('button', 'btn primary join-key-btn', 'make a guest config'), {
    type: 'button',
    title: 'lasts 3 days',
  });
  const out = el('div', 'join-key-out');
  box.append(
    el('p', 'dk-note', 'they install the wireguard app (wireguard.com/install), then scan this or open the file'),
    name,
    go,
    out,
  );
  go.addEventListener('click', async () => {
    out.replaceChildren();
    go.disabled = true;
    try {
      const r = await fetch('/api/guest', { method: 'POST', body: JSON.stringify({ name: name.value }) });
      const got = await r.json().catch(() => ({}));
      if (!r.ok || !got.config) throw new Error(got.error || `status ${r.status}`);
      const qr = el('div', 'net-qr');
      qr.appendChild(qrSVG(got.config));
      const row = el('div', 'join-key-cmd');
      row.title = 'shown this once';
      const copy = Object.assign(el('button', 'copy-btn'), { type: 'button', title: 'copy', ariaLabel: 'copy' });
      copy.appendChild(copyIcon());
      copy.addEventListener('click', () =>
        copyText(got.config)
          .then(() => {
            copy.replaceChildren(copyIcon(true));
            setTimeout(() => copy.replaceChildren(copyIcon()), 1200);
          })
          .catch(() => {}),
      );
      row.append(el('code', '', got.config), copy);
      const file = Object.assign(el('a', 'btn', 'download the config'), {
        href: URL.createObjectURL(new Blob([got.config], { type: 'text/plain' })),
        download: `${got.name}.conf`,
      });
      out.append(qr, row, file);
    } catch (err) {
      out.append(el('div', 'join-key-err', `no config: ${(err as Error).message}`));
    } finally {
      go.disabled = false;
    }
  });
  return box;
}
