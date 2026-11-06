// --- settings › network: the mesh's own control server (headscale on one Linux host), its
// optional relay, every host moved onto it together, join keys and device approvals

import { copyIcon, el, noFill } from '../lib/dom.ts';
import { copyText } from '../lib/util.ts';
import { cardify } from './settings.ts';

type Stage = 'running' | 'prepared' | 'switching' | 'done';
type Control = { host: string; url: string; relay: boolean; stage: Stage; at?: number; by?: string };
type HostRow = { name: string; platform: string; up: boolean; on: string; ready: boolean };
type Status = {
  control: Control | null;
  self: string;
  on: string;
  hosted: string;
  health: { ok: boolean; why?: string } | null;
  hosts: HostRow[];
  others: { name: string; os: string; online: boolean }[];
};

const btn = (label: string, cls = '') => Object.assign(el('button', `btn ${cls}`.trim(), label), { type: 'button' });
const head = (t: string) => el('div', 'dk-pick-head', t);
const note = (t: string) => el('p', 'dk-note', t);
const acts = (...b: HTMLElement[]) => {
  const d = el('div', 'update-actions set-acts');
  d.append(...b);
  return d;
};
const row = (k: string, ...v: (HTMLElement | string)[]) => {
  const r = el('div', 'dk-ap-row');
  r.append(el('span', 'dk-ap-k', k), ...v.map((x) => (typeof x === 'string' ? el('span', 'dk-ap-note', x) : x)));
  return r;
};

async function api(body?: Record<string, unknown>): Promise<any> {
  const r = await fetch('/api/control', body ? { method: 'POST', body: JSON.stringify(body) } : {});
  const got = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(got.error || `status ${r.status}`);
  return got;
}

// a command or key shown with its copy button
function copyRow(text: string, title = ''): HTMLElement {
  const r = el('div', 'join-key-cmd');
  r.title = title;
  const copy = Object.assign(el('button', 'copy-btn'), { type: 'button', title: 'copy', ariaLabel: 'copy' });
  copy.appendChild(copyIcon());
  copy.addEventListener('click', () =>
    copyText(text)
      .then(() => {
        copy.replaceChildren(copyIcon(true));
        setTimeout(() => copy.replaceChildren(copyIcon()), 1200);
      })
      .catch(() => {}),
  );
  r.append(el('code', '', text), copy);
  return r;
}

const stageText: Record<Stage, string> = {
  running: 'running, nothing moved yet',
  prepared: 'prepared, every host holds its join key',
  switching: 'switching',
  done: 'every host is on it',
};

export function networkSection(pane: HTMLElement): () => void {
  const body = el('div', 'acct-pane set-acct');
  const err = el('div', 'join-key-err');
  pane.appendChild(body);
  let gone = false;
  let timer = 0;
  // a step's buttons held while it runs, the page drawn again after
  const step = async (b: HTMLButtonElement | HTMLInputElement, req: Record<string, unknown>) => {
    err.textContent = '';
    b.disabled = true;
    try {
      const got = await api(req);
      await load();
      return got;
    } catch (x) {
      err.textContent = (x as Error).message;
    } finally {
      b.disabled = false;
    }
  };

  const draw = (s: Status) => {
    const c = s.control;
    const linux = s.hosts.filter((h) => h.platform === 'linux');
    const items: HTMLElement[] = [head('control server')];
    if (!c || c.stage === 'running' || c.stage === 'prepared') {
      items.push(
        note(
          'the mesh’s own coordination server, headscale, on a Linux host every device can reach: a public address with ports 443 and, for the relay, udp 3478 open, and a DNS name pointing straight at it, outside any tunnel',
        ),
      );
    }
    if (!c) {
      const pick = el('select', 'dk-ap-in');
      for (const h of linux) pick.append(Object.assign(el('option', '', h.name), { value: h.name }));
      const name = noFill(Object.assign(el('input', 'dk-ap-in'), { placeholder: 'hs.example.com', spellcheck: false }));
      const go = btn('use this host', 'primary');
      go.addEventListener('click', () => void step(go, { action: 'set', host: pick.value, name: name.value }));
      items.push(row('host', pick), row('name', name, 'its https address'), acts(go));
      if (!linux.length) items.push(note('no Linux host on the mesh yet'));
    } else {
      const h = s.health;
      items.push(
        row('host', c.host),
        row('address', el('code', '', c.url)),
        row('state', stageText[c.stage] ?? c.stage),
        row('answering', h?.ok ? 'yes' : `no${h?.why ? `: ${h.why}` : ''}`),
      );
      const relay = el('label', 'dk-ap-check');
      const box = Object.assign(el('input'), { type: 'checkbox', checked: c.relay });
      relay.append(box, el('span', 'dk-ap-check-t', `relay through ${c.host} beside tailscale’s relays`));
      box.addEventListener('change', () => void step(box, { action: 'relay', on: box.checked }));
      items.push(relay, note('off: devices that can’t reach each other directly go through tailscale’s relays'));
      const b: HTMLElement[] = [];
      if (c.stage === 'running') {
        const prep = btn('prepare the move', 'primary');
        prep.disabled = !h?.ok;
        prep.addEventListener('click', () => void step(prep, { action: 'prepare' }));
        b.push(prep);
      }
      if (c.stage === 'prepared') {
        const waiting = s.hosts.filter((x) => x.up && !x.ready).map((x) => x.name);
        const sw = btn('switch every host', 'primary');
        sw.disabled = waiting.length > 0;
        sw.title = waiting.length ? `waiting on ${waiting.join(', ')}` : 'every host moves within the minute';
        sw.addEventListener('click', () => void step(sw, { action: 'switch' }));
        b.push(sw);
      }
      if (c.stage === 'running' || c.stage === 'prepared') {
        const stop = btn('stop');
        stop.addEventListener('click', () => void step(stop, { action: 'stop' }));
        b.push(stop);
      }
      if (b.length) items.push(acts(...b));
      if (c.stage === 'switching')
        items.push(
          note('hosts drop off and come back on the new server; this page reconnects once this host has moved'),
        );
    }
    items.push(err);

    items.push(head('hosts'));
    for (const x of s.hosts) {
      const where = !x.on
        ? 'not seen'
        : c && x.on === c.url
          ? 'on the mesh’s server'
          : x.on === s.hosted
            ? 'on tailscale’s'
            : x.on;
      const parts = [x.up ? where : `away, last ${where}`];
      if (c && c.stage !== 'running' && x.on !== c.url) parts.push(x.ready ? 'ready' : 'no join key yet');
      items.push(row(x.name, parts.join(', ')));
    }

    if (c && c.stage !== 'running') {
      items.push(head('devices without phosphorus'));
      if (s.others.length)
        items.push(
          note(
            `move each by hand once the hosts have: phones in the tailscale app’s settings, use an alternate server, ${c.url}; then paste the auth id its sign-in page shows below`,
          ),
          ...s.others.map((o) => row(o.name, `${o.os || 'device'}${o.online ? '' : ', offline'}`)),
        );
      const id = noFill(Object.assign(el('input', 'dk-ap-in'), { placeholder: 'auth id', spellcheck: false }));
      const ok = btn('approve');
      const out = el('div', 'join-key-out');
      ok.addEventListener('click', async () => {
        const got = await step(ok, { action: 'approve', authId: id.value });
        if (got?.name) {
          out.replaceChildren(note(`${got.name} is on the mesh`));
          id.value = '';
        }
      });
      items.push(row('approve a device', id), acts(ok), out);
      items.push(note(`a laptop: tailscale login --login-server=${c.url}, then approve it the same way`));
    }

    if (c && c.stage !== 'running') {
      items.push(head('join key'));
      const mint = btn('new join key');
      const out = el('div', 'join-key-out');
      mint.addEventListener('click', async () => {
        const got = await step(mint, { action: 'join-key' });
        if (got?.key) out.replaceChildren(copyRow(got.key, 'reusable, lasts 90 days'));
      });
      items.push(
        note('the one key a new host needs, pasted when phosphorus first asks; reusable, 90 days'),
        acts(mint),
        out,
      );
    }
    body.replaceChildren(...cardify(items));
  };

  // drawn again only when what it shows changed, and not while a field is being typed in
  let last = '';
  const load = async () => {
    try {
      const s = (await api()) as Status;
      const sig = JSON.stringify(s);
      const typing = body.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT';
      if (sig !== last && !typing) {
        last = sig;
        draw(s);
      }
    } catch (x) {
      if (!last) body.replaceChildren(err);
      err.textContent = (x as Error).message;
    }
  };
  const tick = async () => {
    await load();
    if (!gone) timer = window.setTimeout(tick, 5000);
  };
  void tick();
  return () => {
    gone = true;
    clearTimeout(timer);
  };
}
