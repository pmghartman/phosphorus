// --- settings › network, in three parts down the rail. Mesh: the hub, every host and
// device on it with its path and its actions, adding one. DNS: the domain's records,
// phosphorus's and an admin's own, and a name looked up. Domain: the name, its edge
// hosts, delegation and certificate, public ports, the hub's host

import { copyIcon, el, noFill } from '../lib/dom.ts';
import { qrSVG } from '../lib/qr.ts';
import { st } from '../lib/state.ts';
import { copyText } from '../lib/util.ts';
import { cardify } from './settings.ts';

export const NET_SUBS = ['mesh', 'dns', 'domain'] as const;
type NetSub = (typeof NET_SUBS)[number];
let part: NetSub = 'mesh';
export const netSub = (): NetSub => part;

type Control = { host: string; url: string };
type Hub = { host: string; ip: string; key: string; endpoint: string };
type Device = {
  name: string;
  kind: 'host' | 'device' | 'guest';
  ip: string;
  online: boolean;
  ready: boolean;
  expires?: number;
  via: 'hub' | 'udp' | 'relay' | '';
  direct: string[];
};
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
type DNSRecord = { id: string; name: string; type: string; value: string; priority?: number };
type ZoneRow = { name: string; type: string; value: string; why: string };
type Status = {
  control: Control | null;
  hub: Hub | null;
  health: { ok: boolean; why?: string } | null;
  hosts: { host: string; ip: string }[];
  edge: Edge;
  devices: Device[];
  zone: string;
  records: DNSRecord[];
  builtIn: ZoneRow[];
};

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
const select = (opts: [string, string][], value = '') => {
  const s = el('select', 'dk-ap-in');
  for (const [v, t] of opts) s.append(Object.assign(el('option', '', t), { value: v, selected: v === value }));
  return s;
};
// a status line: a dot, what it is, how it stands
const stat = (on: boolean, k: string, v: string) => {
  const r = el('div', 'net-stat');
  r.append(el('span', `net-dot${on ? ' on' : ''}`), el('span', 'dk-ap-k', k), el('span', 'dk-ap-note', v));
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

// a device's config shown once: its QR code for the WireGuard app, the text and a file
function configView(name: string, config: string): HTMLElement {
  const box = el('div', 'net-config');
  const qr = el('div', 'net-qr');
  qr.appendChild(qrSVG(config));
  const file = Object.assign(el('a', 'btn', 'download the config'), {
    href: URL.createObjectURL(new Blob([config], { type: 'text/plain' })),
    download: `${name}.conf`,
  });
  box.append(
    note(`${name}: in the wireguard app, add a tunnel from this qr code or the file; its key is shown this once`),
    qr,
    copyRow(config, 'the wireguard config'),
    acts(file),
  );
  return box;
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

const pathWord = (d: Device) =>
  !d.online
    ? 'offline'
    : d.via === 'hub'
      ? 'the hub'
      : d.via === 'relay'
        ? 'relayed'
        : d.kind === 'host'
          ? 'udp'
          : 'on';

export function networkSection(pane: HTMLElement, sub?: string): () => void {
  if (NET_SUBS.includes(sub as NetSub)) part = sub as NetSub;
  const body = el('div', 'acct-pane set-acct');
  const err = el('div', 'join-key-err');
  pane.appendChild(body);
  let gone = false;
  let timer = 0;
  let last: Status | undefined;
  // a step's control held while it runs, the page drawn again after
  const step = async (b: HTMLButtonElement | HTMLInputElement | HTMLSelectElement, req: Record<string, unknown>) => {
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
        'a tcp or udp port of a service on any host, open on the internet at the edge hosts and carried over the mesh; with an srv service (minecraft, say) players use <name>.<domain> without the port',
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

  // --- mesh ---------------------------------------------------------------------------

  // what the last add made, kept through the page's redraws
  let made: HTMLElement | undefined;
  const madeBox = el('div', 'join-key-out');
  const showMade = () => madeBox.replaceChildren(...(made ? [made] : []));

  const pickHub = (s: Status): HTMLElement[] => {
    const items = [
      head('hub'),
      note(
        'the host every other host and device meets at: a Linux host with its own public address and udp 41641 open',
      ),
    ];
    if (!s.hosts.length) return [...items, note('no Linux host on the mesh has a public address')];
    const pick = select(s.hosts.map((h) => [h.host, `${h.host} (${h.ip})`]));
    const go = btn('use this host', 'primary');
    go.addEventListener('click', () => void step(go, { action: 'set', host: pick.value }));
    return [...items, row('host', pick), acts(go)];
  };

  // a round trip to a host from this page, through this host's frontend
  const ping = (b: HTMLButtonElement, host: string) => async () => {
    b.disabled = true;
    const t0 = performance.now();
    try {
      const r = await fetch(`/api/ping/${host}`, { cache: 'no-store' });
      const ms = Math.round(performance.now() - t0);
      b.textContent = r.status === 204 ? `${ms} ms` : `${r.status}`;
    } catch {
      b.textContent = 'no answer';
    }
    setTimeout(() => {
      b.textContent = 'ping';
      b.disabled = false;
    }, 3000);
  };

  // one row per host and device: its address and name on the mesh, how it gets to
  // the hub, and what can be done to it
  const deviceRow = (d: Device, s: Status): HTMLElement => {
    const c = s.control!;
    const li = el('li', 'dk-row net-dev');
    const name = el('span', 'net-name');
    name.append(el('span', `net-dot${d.online ? ' on' : ''}`), el('span', '', d.name));
    name.title = `${d.name}.${s.zone}`;
    const ops = el('span', 'net-acts');
    if (d.kind === 'host') {
      if (d.online && d.name !== st.selfHost) {
        const p = btn('ping');
        p.addEventListener('click', ping(p, d.name));
        ops.append(p);
      }
    } else {
      const ren = btn('rename');
      ren.addEventListener('click', () => {
        const box = noFill(Object.assign(el('input'), { value: d.name, spellcheck: false }));
        const save = async () => {
          if (box.value.trim() && box.value.trim() !== d.name)
            await step(box, { action: 'rename', name: d.name, to: box.value });
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
      const key = btn(d.ready ? 'new config' : 'make config', d.ready ? '' : 'primary');
      key.title = d.ready ? 'a new key: the old config stops working' : 'its wireguard config, at this address';
      key.addEventListener('click', async () => {
        const got = await step(key, { action: 'device-add', name: d.name, guest: d.kind === 'guest' });
        if (got?.config) {
          made = configView(got.name, got.config);
          showMade();
        }
      });
      ops.append(ren, key);
    }
    if (d.name !== c.host) {
      const del = btn('remove', 'danger');
      del.title = 'off the mesh until it joins again';
      sure(del, () => void step(del, { action: 'remove', name: d.name }));
      ops.append(del);
    }
    let state = pathWord(d);
    if (d.direct.length) state += `, direct to ${d.direct.join(', ')}`;
    if (d.kind !== 'host' && !d.ready) state = 'needs a config';
    else if (d.kind === 'guest' && d.expires) state += `, until ${until(d.expires)}`;
    li.append(
      name,
      el('span', `net-kind ${d.kind}`, d.kind),
      el('span', 'net-ip', d.ip),
      el('span', `dk-state net-seen${d.kind !== 'host' && !d.ready ? ' bad' : ''}`, state),
      ops,
    );
    return li;
  };

  // one bar adds anything: a device's config, a guest's, or a host's join key
  const addBar = (): HTMLElement[] => {
    const name = input('name: a phone, a laptop');
    const kind = select([
      ['device', 'a device, the wireguard app'],
      ['guest', 'a guest, 3 days, games only'],
      ['host', 'a host, phosphorus on it'],
    ]);
    const go = btn('add', 'primary');
    const sync = () => {
      name.hidden = kind.value === 'host';
      go.textContent = kind.value === 'host' ? 'make a join key' : 'make its config';
    };
    kind.addEventListener('change', sync);
    sync();
    go.addEventListener('click', async () => {
      if (kind.value === 'host') {
        const got = await step(go, { action: 'join-key' });
        if (got?.key) {
          made = el('div', 'net-config');
          made.append(
            note('the join key a new phosphorus host asks for on its first start; reusable, 90 days'),
            copyRow(got.key, 'reusable, lasts 90 days'),
          );
        }
      } else {
        const got = await step(go, { action: 'device-add', name: name.value, guest: kind.value === 'guest' });
        if (got?.config) made = configView(got.name, got.config);
      }
      showMade();
    });
    const bar = el('div', 'net-addbar');
    bar.append(kind, name, go);
    return [head('add'), bar, madeBox];
  };

  const meshPart = (s: Status): HTMLElement[] => {
    if (!s.control) return pickHub(s);
    const c = s.control;
    const hosts = s.devices.filter((d) => d.kind === 'host');
    const others = s.devices.filter((d) => d.kind !== 'host');
    const h = s.health;
    const top = [
      head('mesh'),
      stat(
        !!s.hub,
        'hub',
        s.hub ? `${c.host}, udp ${s.hub.endpoint || 'with no public address yet'}` : `${c.host}, not up`,
      ),
      stat(
        !!h?.ok,
        'joins at',
        c.url ? `${c.url}${h?.ok ? '' : `, not answering${h?.why ? `: ${h.why}` : ''}`}` : 'the domain, once set',
      ),
      stat(
        hosts.every((d) => d.online),
        'online',
        `${hosts.filter((d) => d.online).length} of ${hosts.length} hosts, ${others.filter((d) => d.online).length} of ${others.length} devices`,
      ),
      stat(true, 'names', `<name>.${s.zone}, asked of the hub`),
      err,
    ];
    const rank = { host: 0, device: 1, guest: 2 };
    const ds = [...s.devices].sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));
    const list = el('ul', 'dk-rows');
    const th = el('li', 'dk-row net-dev net-head');
    th.append(
      el('span', '', 'name'),
      el('span', '', 'kind'),
      el('span', 'net-ip', 'address'),
      el('span', 'net-seen', 'path'),
      el('span'),
    );
    list.append(th, ...ds.map((d) => deviceRow(d, s)));
    showMade();
    return [...top, head('hosts and devices'), list, ...addBar()];
  };

  // --- dns ------------------------------------------------------------------------------

  // the last lookup's answer, kept through redraws
  const lookedUp = el('div', 'join-key-out');

  const recordRow = (cells: string[], cls: string, op?: HTMLElement) => {
    const li = el('li', `dk-row net-rec ${cls}`.trim());
    li.append(...cells.map((t, i) => el('span', i === 2 ? 'net-ip' : '', t)), op ?? el('span'));
    return li;
  };

  const dnsPart = (s: Status): HTMLElement[] => {
    const e = s.edge;
    if (!e.domain) return [head('dns'), note('set the domain first, under domain'), err];
    const top = [
      head('dns'),
      stat(
        e.delegation.ok,
        e.domain,
        e.delegation.ok
          ? `served by ${e.nameservers.map((n) => n.name).join(', ')}`
          : e.delegation.why || 'delegation not checked yet',
      ),
      stat(!!s.hub, s.zone, 'every host and device by name, inside the mesh'),
      err,
    ];
    const list = el('ul', 'dk-rows');
    const th = el('li', 'dk-row net-rec net-head');
    th.append(
      el('span', '', 'name'),
      el('span', '', 'type'),
      el('span', 'net-ip', 'value'),
      el('span', '', 'by'),
      el('span'),
    );
    list.append(th);
    const fqdn = (n: string) => (n ? `${n}.${e.domain}` : e.domain);
    for (const r of s.records) {
      const del = btn('remove', 'danger');
      sure(del, () => void step(del, { action: 'record-remove', id: r.id }));
      list.append(
        recordRow(
          [fqdn(r.name), r.type, r.type === 'MX' ? `${r.priority ?? 10} ${r.value}` : r.value, 'yours'],
          '',
          del,
        ),
      );
    }
    for (const r of s.builtIn)
      list.append(recordRow([r.name === '*' ? `*.${e.domain}` : fqdn(r.name), r.type, r.value, r.why], 'builtin'));

    const name = input(`name under ${e.domain}, blank for it`);
    const type = select(['A', 'AAAA', 'CNAME', 'MX', 'TXT'].map((t) => [t, t]));
    const value = input('value');
    const prio = Object.assign(input('priority', '10'), { hidden: true });
    type.addEventListener('change', () => {
      prio.hidden = type.value !== 'MX';
      value.placeholder =
        {
          A: '203.0.113.7',
          AAAA: '2001:db8::7',
          CNAME: 'elsewhere.example.com',
          MX: 'mail.example.com',
          TXT: 'v=spf1 mx -all',
        }[type.value] ?? 'value';
    });
    const add = btn('add record', 'primary');
    add.addEventListener(
      'click',
      () =>
        void step(add, {
          action: 'record-add',
          name: name.value,
          type: type.value,
          value: value.value,
          priority: prio.value,
        }),
    );
    const bar = el('div', 'net-addbar');
    bar.append(name, type, prio, value, add);

    const qname = input(`a name to look up, www.${e.domain} say`);
    const qtype = select(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV'].map((t) => [t, t]));
    const ask = btn('look up');
    ask.addEventListener('click', async () => {
      const got = await step(ask, { action: 'lookup', name: qname.value, type: qtype.value });
      if (!got) return;
      const lines = got.answers.length
        ? got.answers.map((a: { name: string; ttl: number; value: string }) => `${a.name}  ${a.ttl}s  ${a.value}`)
        : [got.rcode === 'noerror' ? 'no records of that type' : got.rcode];
      lookedUp.replaceChildren(note(`asked ${got.server}`), copyRow(lines.join('\n')));
    });
    const qbar = el('div', 'net-addbar');
    qbar.append(qname, qtype, ask);
    return [
      ...top,
      head('records'),
      note('your own beside phosphorus’s; a name of yours wins over a service’s of the same name'),
      list,
      bar,
      head('look up'),
      qbar,
      lookedUp,
    ];
  };

  // --- domain ---------------------------------------------------------------------------

  const domainPart = (s: Status): HTMLElement[] => {
    const items: HTMLElement[] = [...domainCard(s.edge), err];
    if (s.edge.domain) items.push(...portsCard(s.edge));
    if (s.control && s.hosts.length > 1) {
      const pick = select(
        s.hosts.map((h) => [h.host, `${h.host} (${h.ip})`]),
        s.control.host,
      );
      const go = btn('move the hub');
      go.title = 'every host and device reconnects to the new hub; phones need new configs';
      sure(go, () => void step(go, { action: 'set', host: pick.value }));
      items.push(head('hub'), row('host', pick), acts(go));
    }
    return items;
  };

  const draw = (s: Status) => {
    last = s;
    const items = part === 'dns' ? dnsPart(s) : part === 'domain' ? domainPart(s) : meshPart(s);
    body.replaceChildren(...cardify(items));
  };

  // drawn again only when what it shows changed, and not while a field is being typed in;
  // force: after a step, or a rename given up
  let sig = '';
  const load = async (force = false) => {
    try {
      const s = (await api()) as Status;
      const next = JSON.stringify(s);
      const typing =
        body.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement?.tagName ?? '');
      if (force || (next !== sig && !typing)) {
        sig = next;
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
