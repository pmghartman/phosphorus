// --- settings › profile: the hosts this user logs into, the page logins kept for them and the
// password, all sealed in the vault on the mesh

import { acctSave, type Chip, dkForget, dkUnlock } from '../features/account.ts';
import { serviceUrl } from '../features/mesh/mesh.ts';
import { acctCall } from '../lib/api.ts';
import { el, noFill } from '../lib/dom.ts';
import { dk, st } from '../lib/state.ts';
import { copyText } from '../lib/util.ts';

export function profileSection(pane: HTMLElement): void {
  const body = el('div', 'acct-pane set-acct');
  pane.appendChild(body);
  const draw = () => {
    const acct = st.acct!;
    const hosts = el('ul', 'dk-rows');
    const names = [...new Set([...Object.keys(acct.vault.hosts), ...st.terminalHosts])].sort(
      (a, b) => Number(!acct.vault.hosts[a]) - Number(!acct.vault.hosts[b]) || a.localeCompare(b),
    );
    hosts.replaceChildren(
      ...(names.length
        ? names.map((h) => {
            const li = el('li', 'dk-row acct-user');
            const saved = acct.vault.hosts[h];
            const act = Object.assign(el('button', saved ? 'danger' : '', saved ? 'forget' : 'log in'), {
              type: 'button',
            });
            act.addEventListener('click', () => {
              if (saved) {
                dkForget(h);
                draw();
                return;
              }
              const chip = [...(dk.desk?.hosts.children || [])].find((c) => c.textContent === h) as Chip | undefined;
              if (chip) dkUnlock(h, chip);
            });
            li.append(
              el('span', 'dk-host', h),
              el('span', 'dk-state', saved ? saved.user : st.terminalHosts.includes(h) ? 'locked' : ''),
              act,
            );
            return li;
          })
        : [el('li', 'empty', 'no hosts')]),
    );

    const pages = el('ul', 'dk-rows');
    const keys = Object.keys(acct.vault.pages).sort();
    pages.replaceChildren(
      ...(keys.length
        ? keys.map((k) => {
            const p = acct.vault.pages[k]!;
            const li = el('li', 'dk-row acct-page');
            const cu = Object.assign(el('button', '', 'copy user'), { type: 'button' });
            const cp = Object.assign(el('button', '', 'copy pass'), { type: 'button' });
            const del = Object.assign(el('button', 'danger', 'delete'), { type: 'button' });
            cu.addEventListener('click', () => copyText(p.user));
            cp.addEventListener('click', () => copyText(p.pass));
            del.addEventListener('click', () => {
              delete acct.vault.pages[k];
              acctSave();
              draw();
            });
            const name = Object.assign(el('span', 'dk-host', k), { title: p.url || k });
            li.append(name, el('span', 'dk-state', p.user), cu, cp, del);
            return li;
          })
        : [el('li', 'empty', 'none saved')]),
    );
    const pName = noFill(Object.assign(el('input'), { placeholder: 'page', spellcheck: false }));
    pName.setAttribute('list', 'acct-page-names');
    const opts = el('datalist');
    opts.id = 'acct-page-names';
    // the mesh's services and its git (forgejo) login, each a page login's name
    const loginable = [...dk.services, ...(st.gitRoute ? [st.gitRoute] : [])];
    opts.replaceChildren(...loginable.map((r) => Object.assign(el('option'), { value: r.name })));
    const pUser = noFill(Object.assign(el('input'), { placeholder: 'user', spellcheck: false }));
    const pPass = noFill(Object.assign(el('input'), { placeholder: 'password' }), true);
    const pAdd = Object.assign(el('button', 'primary', 'save'), { type: 'button' });
    pAdd.addEventListener('click', () => {
      const k = pName.value.trim();
      if (!k || !pUser.value) return;
      const svc = loginable.find((r) => r.name === k);
      acct.vault.pages[k] = { url: svc ? serviceUrl(svc) : '', user: pUser.value, pass: pPass.value };
      acctSave();
      draw();
    });
    const pRow = el('div', 'dk-row acct-new');
    pRow.append(pName, pUser, pPass, pAdd);

    const pw = el('form', 'dk-row acct-new');
    const old = noFill(Object.assign(el('input'), { placeholder: 'current' }), true);
    const neu = noFill(Object.assign(el('input'), { placeholder: 'new' }), true);
    const pwGo = Object.assign(el('button', 'primary', 'change'), { type: 'submit' });
    const pwWhy = el('div', 'dk-state');
    pw.append(old, neu, pwGo);
    pw.addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await acctCall('/api/me/password', { old: old.value, pass: neu.value });
      pwWhy.className = `dk-state ${r.ok ? 'ok' : 'bad'}`;
      pwWhy.textContent = r.ok ? 'changed' : r.error || 'no answer';
      if (r.ok) {
        old.value = '';
        neu.value = '';
      }
    });

    body.replaceChildren(
      el('div', 'dk-pick-head', 'hosts'),
      hosts,
      el('div', 'dk-pick-head', 'page logins'),
      pages,
      pRow,
      opts,
      el('div', 'dk-pick-head', 'password'),
      pw,
      pwWhy,
    );
  };
  draw();
}
