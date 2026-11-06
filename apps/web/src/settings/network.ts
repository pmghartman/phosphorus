// --- settings › network: the mesh's control server (headscale on a public Linux host),
// its DERP relay, and the commands and keys that bring devices and hosts on

import { copyIcon, el, noFill } from '../lib/dom.ts';
import { copyText } from '../lib/util.ts';
import { cardify } from './settings.ts';

type Control = { host: string; url: string; relay: boolean };
type Device = { id: string; name: string; tags: string[]; seen: number; online: boolean; ips: string[] };
type Status = {
  control: Control | null;
  health: { ok: boolean; why?: string } | null;
  hosts: { name: string; ip: string }[];
  devices?: Device[];
  error?: string;
};

const kindOf = (d: Device) =>
  d.tags.includes('tag:host') ? 'host' : d.tags.includes('tag:guest') ? 'guest' : 'device';

// how long ago, coarsely
function ago(ms: number): string {
  if (!ms) return 'never';
  const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

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

export function networkSection(pane: HTMLElement): () => void {
  const body = el('div', 'acct-pane set-acct');
  const err = el('div', 'join-key-err');
  pane.appendChild(body);
  let gone = false;
  let timer = 0;
  // a step's control held while it runs, the page drawn again after
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

  // a button minting something shown under it
  const minted = (label: string, action: string, show: (got: any) => HTMLElement | undefined) => {
    const b = btn(label);
    const out = el('div', 'join-key-out');
    b.addEventListener('click', async () => {
      const got = await step(b, { action });
      const shown = got && show(got);
      if (shown) out.replaceChildren(shown);
    });
    return [acts(b), out];
  };

  const pickServer = (s: Status): HTMLElement[] => {
    const items = [
      head('control server'),
      note(
        'headscale on a Linux host with its own public address: ports 443 and, for the relay, udp 3478 open, and a DNS name pointing straight at it, outside any tunnel',
      ),
    ];
    if (!s.hosts.length) return [...items, note('no Linux host on the mesh has a public address')];
    const pick = el('select', 'dk-ap-in');
    for (const h of s.hosts) pick.append(Object.assign(el('option', '', `${h.name} (${h.ip})`), { value: h.name }));
    const name = noFill(Object.assign(el('input', 'dk-ap-in'), { placeholder: 'hs.example.com', spellcheck: false }));
    const go = btn('use this host', 'primary');
    go.addEventListener('click', () => void step(go, { action: 'set', host: pick.value, name: name.value }));
    return [...items, row('host', pick), row('name', name, 'its https address'), acts(go)];
  };

  // one row per device: rename on anything phosphorus doesn't name, remove after a second press
  const deviceRow = (d: Device, c: Control): HTMLElement => {
    const li = el('li', 'dk-row net-dev');
    const kind = kindOf(d);
    const name = el('span', 'net-name');
    name.append(el('span', `net-dot${d.online ? ' on' : ''}`), el('span', '', d.name));
    name.title = d.online ? 'online' : 'offline';
    const acts = el('span', 'net-acts');
    if (kind !== 'host') {
      const ren = btn('rename');
      ren.addEventListener('click', () => {
        const box = noFill(Object.assign(el('input'), { value: d.name, spellcheck: false }));
        const save = async () => {
          if (box.value.trim() && box.value.trim() !== d.name)
            await step(box, { action: 'rename', id: d.id, name: box.value });
          void load(true);
        };
        box.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') void load(true);
        });
        name.replaceChildren(box);
        box.focus();
        box.select();
      });
      acts.append(ren);
    }
    if (d.name !== c.host) {
      const del = btn('remove', 'danger');
      del.title = 'off the mesh until it joins again';
      del.addEventListener('click', () => {
        if (del.textContent !== 'sure?') {
          del.textContent = 'sure?';
          return;
        }
        void step(del, { action: 'remove', id: d.id });
      });
      acts.append(del);
    }
    li.append(
      name,
      el('span', `net-kind ${kind}`, kind),
      el('span', 'net-ip', d.ips.find((ip) => ip.includes('.')) ?? d.ips[0] ?? ''),
      el('span', 'dk-state net-seen', d.online ? 'online' : ago(d.seen)),
      acts,
    );
    return li;
  };

  const deviceList = (s: Status, c: Control): HTMLElement[] => {
    if (!s.devices) return [head('devices'), note(`couldn’t list them: ${s.error || 'no answer'}`)];
    const ds = [...s.devices].sort((a, b) => kindOf(a).localeCompare(kindOf(b)) * -1 || a.name.localeCompare(b.name));
    const on = ds.filter((d) => d.online).length;
    const list = el('ul', 'dk-rows');
    const top = el('li', 'dk-row net-dev net-head');
    top.append(
      el('span', '', 'name'),
      el('span', '', 'kind'),
      el('span', 'net-ip', 'address'),
      el('span', 'net-seen', 'last seen'),
      el('span'),
    );
    list.append(top, ...ds.map((d) => deviceRow(d, c)));
    return [head(`devices, ${on} of ${ds.length} online`), list];
  };

  const draw = (s: Status) => {
    const c = s.control;
    if (!c) {
      body.replaceChildren(...cardify([...pickServer(s), err]));
      return;
    }
    const h = s.health;
    const items: HTMLElement[] = [
      head('control server'),
      row('host', c.host),
      row('address', el('code', '', c.url)),
      row('answering', h?.ok ? 'yes' : `no${h?.why ? `: ${h.why}` : ''}`),
    ];

    const relay = el('label', 'dk-ap-check');
    const box = Object.assign(el('input'), { type: 'checkbox', checked: c.relay });
    relay.append(box, el('span', 'dk-ap-check-t', `use ${c.host} as DERP relay`));
    box.addEventListener('change', () => void step(box, { action: 'relay', on: box.checked }));
    items.push(
      relay,
      note(
        c.relay
          ? `devices that can’t reach each other directly relay through ${c.host} or tailscale’s DERP servers, whichever is nearest; udp 3478 must be open on ${c.host}`
          : 'devices that can’t reach each other directly relay through tailscale’s DERP servers',
      ),
      err,
    );

    items.push(...deviceList(s, c));

    items.push(
      head('connect a device'),
      note('a laptop or desktop with tailscale installed: run this once in a terminal, as admin on windows'),
      ...minted('new device command', 'device-key', (got) =>
        got.command ? copyRow(got.command, 'works once, within a day') : undefined,
      ),
      note(`a phone: in the tailscale app, use an alternate server, ${c.url}; then paste the auth id it shows`),
    );
    const id = noFill(Object.assign(el('input', 'dk-ap-in'), { placeholder: 'auth id', spellcheck: false }));
    const ok = btn('approve');
    // an approved device shows in the list above
    ok.addEventListener('click', () => void step(ok, { action: 'approve', authId: id.value }));
    items.push(row('approve a device', id), acts(ok));

    items.push(
      head('add a host'),
      note('the join key a new phosphorus host asks for on its first start; reusable, 90 days'),
      ...minted('new join key', 'join-key', (got) =>
        got.key ? copyRow(got.key, 'reusable, lasts 90 days') : undefined,
      ),
    );
    body.replaceChildren(...cardify(items));
  };

  // drawn again only when what it shows changed, and not while a field is being typed in;
  // force: a rename given up, drawn as it was
  let last = '';
  const load = async (force = false) => {
    try {
      const s = (await api()) as Status;
      const sig = JSON.stringify({ ...s, devices: s.devices?.map((d) => ({ ...d, seen: d.online ? 0 : d.seen })) });
      const typing = body.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT';
      if (force || (sig !== last && !typing)) {
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
