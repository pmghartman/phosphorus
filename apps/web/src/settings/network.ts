// --- settings › network: the mesh's domain and the edge hosts that serve it (its DNS,
// its certificate, public ports), its control server (headscale on a public Linux host),
// its DERP relay, and the commands and keys that bring devices and hosts on

import { copyIcon, el, noFill } from '../lib/dom.ts';
import { st } from '../lib/state.ts';
import { copyText } from '../lib/util.ts';
import { cardify } from './settings.ts';

type Control = { host: string; url: string; relay: boolean };
type Device = { id: string; name: string; tags: string[]; seen: number; online: boolean; ips: string[] };
type EdgeInfo = { dns: string; tls: string; ports: Record<string, string> };
type Port = { host: string; name: string; port: number; proto: 'tcp' | 'udp'; pub: number; srv?: string; open: string };
type Edge = {
  domain: string;
  edges: { host: string; ip: string; up: boolean; info?: EdgeInfo }[];
  candidates: { host: string; ip: string }[];
  nameservers: { name: string; ip: string }[];
  delegation: { ok: boolean; why: string };
  tls: {
    state: 'none' | 'ordering' | 'valid' | 'expiring';
    notAfter?: number;
    names?: string[];
    error?: string;
    by: string;
  };
  ports: Port[];
};
type Status = {
  control: Control | null;
  health: { ok: boolean; why?: string } | null;
  hosts: { host: string; ip: string }[];
  edge: Edge;
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

const until = (ms: number) => new Date(ms).toISOString().slice(0, 10);

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
const input = (placeholder: string, value = '') =>
  noFill(Object.assign(el('input', 'dk-ap-in'), { placeholder, value, spellcheck: false, autocapitalize: 'off' }));
const secret = (placeholder: string) =>
  noFill(Object.assign(el('input', 'dk-ap-in'), { placeholder, spellcheck: false, autocapitalize: 'off' }), true);

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

// a second press does it
function sure(b: HTMLButtonElement, go: () => void) {
  const was = b.textContent;
  b.addEventListener('click', () => {
    if (b.textContent !== 'sure?') {
      b.textContent = 'sure?';
      setTimeout(() => (b.textContent = was), 4000);
      return;
    }
    go();
  });
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
      await load(true);
      return got;
    } catch (x) {
      err.textContent = (x as Error).message;
    } finally {
      b.disabled = false;
    }
  };

  // a step after which every host's frontend starts again with the new domain: the
  // page waits for them and reloads
  const restarting = async (b: HTMLButtonElement, req: Record<string, unknown>) => {
    const got = await step(b, req);
    if (!got) return;
    b.disabled = true;
    b.textContent = 'saved, the hosts restart with it…';
    setTimeout(() => location.reload(), 8000);
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

  // the edge hosts to tick: every Linux host with a public address
  const edgePicks = (e: Edge, chosen: Set<string>) => {
    const wrap = el('div', 'net-edges');
    const boxes: HTMLInputElement[] = [];
    for (const h of e.candidates) {
      const lab = el('label', 'dk-ap-check');
      const box = Object.assign(el('input'), { type: 'checkbox', checked: chosen.has(h.host), value: h.host });
      lab.append(box, el('span', 'dk-ap-check-t', `${h.host} (${h.ip})`));
      wrap.appendChild(lab);
      boxes.push(box);
    }
    return { wrap, picked: () => boxes.filter((b) => b.checked).map((b) => b.value) };
  };

  // --- the domain --------------------------------------------------------------------
  const domainCard = (e: Edge): HTMLElement[] => {
    const items: HTMLElement[] = [head('domain')];
    if (!e.domain) {
      items.push(
        note(
          'a name of your own: the desktop at https://<domain> from anywhere, every service at <name>.<domain>; phosphorus serves the domain’s DNS from its edge hosts and gets its certificate from let’s encrypt, no other provider involved',
        ),
      );
      if (!e.candidates.length)
        return [
          ...items,
          note('no Linux host on the mesh has a public address: a VPS or a host with a public IP serves the domain'),
        ];
      const name = input('example.com');
      const picks = edgePicks(e, new Set(e.candidates.length === 1 ? [e.candidates[0]!.host] : []));
      const go = btn('use this domain', 'primary');
      go.addEventListener(
        'click',
        () => void restarting(go, { action: 'domain', name: name.value, edges: picks.picked() }),
      );
      return [...items, row('domain', name), row('edge hosts', picks.wrap), acts(go)];
    }
    items.push(row('domain', el('code', '', e.domain)));
    const edges = el('div', 'net-edges');
    for (const h of e.edges) {
      const line = el('div', 'net-edge');
      const dot = el('span', `net-dot${h.up ? ' on' : ''}`);
      const parts: string[] = [];
      if (h.info) {
        parts.push(`dns ${h.info.dns}`, `https ${h.info.tls}`);
        const bad = Object.entries(h.info.ports).filter(([, why]) => why);
        if (bad.length) parts.push(`ports: ${bad.map(([k, why]) => `${k} ${why}`).join(', ')}`);
      } else parts.push(h.up ? 'not serving yet' : 'offline');
      line.append(
        dot,
        el('span', 'net-name', `${h.host} (${h.ip || 'no public address'})`),
        el('span', 'dk-ap-note', parts.join(', ')),
      );
      edges.appendChild(line);
    }
    items.push(row('edge hosts', edges));
    if (e.nameservers.length) {
      items.push(
        head('nameservers'),
        note(
          `at the registrar, set ${e.domain}’s nameservers to these, each with its address (a glue or host record): then the world asks the edge hosts about the domain`,
        ),
        ...e.nameservers.map((n) => copyRow(`${n.name}  ${n.ip}`, 'nameserver and its address')),
        row('delegation', e.delegation.ok ? 'the registrar points here' : e.delegation.why || 'checking'),
      );
      if (!e.delegation.ok) items.push(...porkbunForm(e));
    }
    const t = e.tls;
    let cert = '';
    if (t.state === 'valid') cert = `valid until ${until(t.notAfter!)}`;
    else if (t.state === 'expiring') cert = `renewing, valid until ${until(t.notAfter!)}`;
    else if (t.state === 'ordering') cert = `being issued by ${t.by}`;
    else cert = e.delegation.ok ? `none yet, ${t.by || 'an edge'} orders it` : 'none yet, waiting on the delegation';
    if (t.error) cert += `; last try: ${t.error}`;
    items.push(row('certificate', cert));
    // the edges changed, or the domain dropped
    const picks = edgePicks(e, new Set(e.edges.map((h) => h.host)));
    const save = btn('save edge hosts');
    save.addEventListener('click', () => void step(save, { action: 'domain', name: e.domain, edges: picks.picked() }));
    const drop = btn('remove the domain', 'danger');
    sure(drop, () => void restarting(drop, { action: 'domain', name: '' }));
    items.push(row('serve from', picks.wrap), acts(save, drop));
    return items;
  };

  // a domain at porkbun pointed here in one press: its API keys used for the host records
  // and the nameservers, then forgotten
  // the last press's word, kept through the page's redraws
  let delegated: { steps?: string[]; error?: string } | undefined;
  const porkbunForm = (e: Edge): HTMLElement[] => {
    const key = secret('porkbun API key');
    const sec = secret('porkbun secret API key');
    const go = btn(`point ${e.domain} here through porkbun`, 'primary');
    const out = el('div', 'join-key-out');
    const show = () => {
      if (!delegated) return;
      out.replaceChildren(
        ...(delegated.steps ?? []).map((s) => note(s)),
        ...(delegated.error ? [el('div', 'join-key-err', delegated.error)] : []),
      );
    };
    show();
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const got = await api({ action: 'delegate', registrar: 'porkbun', apikey: key.value, secretapikey: sec.value });
        delegated = { steps: got.steps as string[] };
        key.value = '';
        sec.value = '';
      } catch (x) {
        delegated = { error: (x as Error).message };
      } finally {
        go.disabled = false;
      }
      show();
    });
    return [
      head('at porkbun'),
      note(
        `a domain registered at porkbun can be pointed here from this page: at porkbun turn on API access for ${e.domain} (domain management, its details) and make an API key (account, API access); the keys are used for the host records and the nameservers above, then forgotten. any other registrar takes the nameservers by hand`,
      ),
      row('API key', key),
      row('secret', sec),
      acts(go),
      out,
    ];
  };

  // --- public ports --------------------------------------------------------------------
  const portsCard = (e: Edge): HTMLElement[] => {
    const items: HTMLElement[] = [
      head('public ports'),
      note(
        'a tcp or udp port of a service on any host, open on the internet at the edge hosts and carried over the tailnet; with an srv service (minecraft, say) players use <name>.<domain> without the port',
      ),
    ];
    if (e.ports.length) {
      const list = el('ul', 'dk-rows');
      for (const p of e.ports) {
        const li = el('li', 'dk-row net-dev');
        const del = btn('remove', 'danger');
        sure(del, () => void step(del, { action: 'port-remove', host: p.host, name: p.name }));
        li.append(
          el('span', 'net-name', `${p.name}.${e.domain}`),
          el('span', 'net-kind', `${p.proto} ${p.pub}`),
          el('span', 'net-ip', `${p.host}:${p.port}${p.srv ? ` (srv ${p.srv})` : ''}`),
          el('span', `dk-state net-seen${p.open ? ' bad' : ''}`, p.open ? p.open : 'open'),
          del,
        );
        list.appendChild(li);
      }
      items.push(list);
    }
    const host = el('select', 'dk-ap-in');
    for (const h of Object.keys(st.hostsInfo).sort()) host.append(Object.assign(el('option', '', h), { value: h }));
    const name = input('name');
    const port = input('port on the host');
    const proto = el('select', 'dk-ap-in');
    proto.append(
      Object.assign(el('option', '', 'tcp'), { value: 'tcp' }),
      Object.assign(el('option', '', 'udp'), { value: 'udp' }),
    );
    const pub = input('public port');
    const srv = input('srv service, optional');
    const add = btn('open it', 'primary');
    add.addEventListener(
      'click',
      () =>
        void step(add, {
          action: 'port-set',
          host: host.value,
          name: name.value,
          port: Number(port.value),
          proto: proto.value,
          pub: Number(pub.value),
          srv: srv.value,
        }),
    );
    items.push(
      row('host', host),
      row('name', name),
      row('port', port, proto),
      row('public port', pub),
      row('srv', srv),
      acts(add),
    );
    return items;
  };

  // --- the control server ------------------------------------------------------------
  const pickServer = (s: Status): HTMLElement[] => {
    const items = [
      head('control server'),
      note(
        `headscale on a Linux host with its own public address: ports 443 and, for the relay, udp 3478 open, and a DNS name pointing straight at it${s.edge.domain ? `; on ${s.edge.domain} phosphorus serves control.${s.edge.domain} itself` : ''}`,
      ),
    ];
    if (!s.hosts.length) return [...items, note('no Linux host on the mesh has a public address')];
    const pick = el('select', 'dk-ap-in');
    for (const h of s.hosts) pick.append(Object.assign(el('option', '', `${h.host} (${h.ip})`), { value: h.host }));
    const name = input(s.edge.domain ? `control.${s.edge.domain}` : 'hs.example.com');
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
      sure(del, () => void step(del, { action: 'remove', id: d.id }));
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
    const items: HTMLElement[] = [...domainCard(s.edge)];
    if (s.edge.domain) items.push(...portsCard(s.edge));
    const c = s.control;
    if (!c) {
      body.replaceChildren(...cardify([...items, ...pickServer(s), err]));
      return;
    }
    const h = s.health;
    items.push(
      head('control server'),
      row('host', c.host),
      row('address', el('code', '', c.url)),
      row('answering', h?.ok ? 'yes' : `no${h?.why ? `: ${h.why}` : ''}`),
    );

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
    const id = input('auth id');
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
  // force: after a step, or a rename given up
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
