// the installer's data: the catalogues' apps (packages/mesh/catalog), each app's page
// and its check, the install form's values, and what the mesh runs (State.stacks, each
// host's StackStatus); an admin's install, update, remove, backups and move one POST each

import type {
  AppPage,
  AppSummary,
  CheckResult,
  HostFit,
  SourceId,
  SourceInfo,
  StackStatus,
  StackView,
} from '@phosphorus/wire';
import { jsonPost } from '../../lib/api.ts';
import { st } from '../../lib/state.ts';
import { pollState } from '../../lib/sync.ts';
import { ago2 } from '../../lib/util.ts';
import { draw } from './draw.ts';
import { stateVars } from './state.ts';

export let catalog: { sources: SourceInfo[]; apps: AppSummary[] } | null = null;
export let catalogError = '';

// an app as `source/ref`, ref holding a github repo's own slash
export const keyOf = (source: string, ref: string) => `${source}/${ref}`;
export function splitKey(key: string): { source: SourceId; ref: string } {
  const at = key.indexOf('/');
  return { source: key.slice(0, at) as SourceId, ref: key.slice(at + 1) };
}
const refPath = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

// --- one service in several catalogues ------------------------------------------------------

// a service known by its name, bare: the same in every catalogue that lists it
export const bare = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const twinKey = (a: { id: string; name: string }) => bare(a.name) || bare(a.id);

// every service once, its listings one per catalogue in the catalogues' order; worked out again
// when the catalogue is read again
let grouped: { of: AppSummary[]; map: Map<string, AppSummary[]> } | null = null;
export function services(): AppSummary[][] {
  if (!catalog) return [];
  if (grouped?.of !== catalog.apps) {
    const order: string[] = catalog.sources.map((s) => s.id);
    const map = new Map<string, AppSummary[]>();
    for (const a of catalog.apps) {
      const list = map.get(twinKey(a)) ?? [];
      if (!list.some((x) => x.source === a.source)) list.push(a);
      map.set(twinKey(a), list);
    }
    for (const list of map.values()) list.sort((x, y) => order.indexOf(x.source) - order.indexOf(y.source));
    grouped = { of: catalog.apps, map };
  }
  return [...grouped.map.values()];
}

// an app's listings in every catalogue that has it, its own among them
export function twins(source: string, ref: string): AppSummary[] {
  const a = catalog?.apps.find((x) => x.source === source && x.ref === ref);
  if (!a) return [];
  services();
  return grouped?.map.get(twinKey(a)) ?? [a];
}

// a discovered page's service in the catalogues, by its guessed name
export function twinsNamed(name: string): AppSummary[] {
  services();
  return grouped?.map.get(bare(name)) ?? [];
}

// the catalogue picked on a service's page, kept for its tile while the page lives
const picks = new Map<string, string>();
export const pickSource = (a: AppSummary) => picks.set(twinKey(a), a.source);

// the listing a service's tile shows: the one installed, else the catalogue filtered on, else the
// one picked on its page, else the first catalogue's
export const lead = (list: AppSummary[], source = ''): AppSummary =>
  list.find((a) => installedAs(a.source, a.ref)) ??
  list.find((a) => a.source === source) ??
  list.find((a) => a.source === picks.get(twinKey(a))) ??
  list[0]!;

// a failed call's words for people: github's rate limit, a repo with no compose file
export function why(status: number, error: string): string {
  if (status === 429 || /rate.?limit/i.test(error))
    return status === 429 && error
      ? error
      : `GitHub's limit on unsigned calls is spent for now: ${error || `status ${status}`}`;
  if (/compose/i.test(error) && /\bno\b|not found|without|none/i.test(error)) return 'This repo has no compose file.';
  if (status === 404) return error || 'not found';
  return error || `status ${status}`;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(30000), ...init });
  const out = await r.json().catch(() => ({}));
  if (!r.ok || out.ok === false) {
    const e = new Error(why(r.status, out.error || '')) as Error & { status: number };
    e.status = r.status;
    throw e;
  }
  return out as T;
}

const redraw = () => {
  stateVars.sig = '';
  draw();
};

export async function readCatalog() {
  try {
    catalog = await call('/api/stacks/catalog');
    catalogError = '';
  } catch (e) {
    catalogError = (e as Error).message;
  }
  redraw();
}

// a page as read: the page, or why not, or still loading
export interface Loaded {
  page?: AppPage;
  error?: string;
  loading?: boolean;
}
export const pages = new Map<string, Loaded>();

export async function loadPage(key: string, fresh = false) {
  const was = pages.get(key);
  if (was?.loading || (was?.page && !fresh)) return;
  pages.set(key, { ...was, loading: true });
  redraw();
  const { source, ref } = splitKey(key);
  try {
    pages.set(key, { page: await call<AppPage>(`/api/stacks/app/${source}/${refPath(ref)}`) });
  } catch (e) {
    pages.set(key, { error: (e as Error).message });
  }
  redraw();
}

// the repo box: its text, a call under way, why the last one failed
export const repoBox = { url: '', busy: false, error: '' };

// a public github repo opened: its page kept under github/<owner>/<repo>, then shown as stack:<key>
export async function openRepo(show: (key: string) => void) {
  const url = repoBox.url.trim();
  if (!/^(https?:\/\/)?(www\.)?github\.com\/[\w.-]+\/[\w.-]+|^[\w.-]+\/[\w.-]+\/?$/i.test(url)) {
    repoBox.error = 'a GitHub repo: github.com/owner/name, or owner/name';
    redraw();
    return;
  }
  repoBox.busy = true;
  repoBox.error = '';
  redraw();
  try {
    const page = await call<AppPage>('/api/stacks/repo', jsonPost({ url }));
    const key = keyOf(page.def.source, page.def.ref);
    pages.set(key, { page });
    repoBox.url = '';
    show(`stack:${key}`);
  } catch (e) {
    repoBox.error = (e as Error).message;
  }
  repoBox.busy = false;
  redraw();
}

// --- the install form ---------------------------------------------------------------

export interface Form {
  env: Record<string, string>;
  active: string;
  standbys: string[];
  // the check again with the form's values, the page's own until then
  check?: CheckResult;
  checking: boolean;
  busy: boolean;
  error: string;
}
const forms = new Map<string, Form>();

export function formOf(key: string): Form {
  let f = forms.get(key);
  if (!f) {
    f = { env: {}, active: '', standbys: [], checking: false, busy: false, error: '' };
    forms.set(key, f);
  }
  return f;
}

// the hosts that fit, the manifest's preferred one first
export function fitting(page: AppPage, check: CheckResult): HostFit[] {
  const pref = page.def.manifest.preferredHost;
  return check.hosts
    .filter((h) => h.ok)
    .sort((a, b) => Number(b.host === pref) - Number(a.host === pref) || a.host.localeCompare(b.host));
}

// the values given, blanks left out so defaults and generated secrets stand
export const given = (f: Form) => Object.fromEntries(Object.entries(f.env).filter(([, v]) => v.trim() !== ''));

let checkTimer: ReturnType<typeof setTimeout> | null = null;
// the check asked again a moment after the last keystroke
export function recheck(key: string) {
  const f = formOf(key);
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = setTimeout(async () => {
    checkTimer = null;
    const { source, ref } = splitKey(key);
    f.checking = true;
    redraw();
    try {
      f.check = await call<CheckResult>('/api/stacks/check', jsonPost({ source, ref, env: given(f) }));
      f.error = '';
    } catch (e) {
      f.error = `the check: ${(e as Error).message}`;
    }
    f.checking = false;
    redraw();
  }, 450);
}

// an admin's install of the form's app onto the hosts picked
export async function install(key: string) {
  const f = formOf(key);
  const { source, ref } = splitKey(key);
  f.busy = true;
  f.error = '';
  redraw();
  try {
    // Docker asked first of each picked host that has none yet, those hosts installing it
    const hosts = (f.check ?? pages.get(key)?.page?.check)?.hosts ?? [];
    for (const h of hosts)
      if ((h.host === f.active || f.standbys.includes(h.host)) && h.docker === 'installable' && !dockerBusy(h.host))
        await call('/api/stacks/docker', jsonPost({ host: h.host }));
    await call(
      '/api/stacks/install',
      jsonPost({
        source,
        ref,
        env: given(f),
        active: f.active,
        standbys: f.standbys,
      }),
    );
    // the secrets typed are the server's now; the want in the state before the form goes
    f.env = {};
    await pollState();
  } catch (e) {
    f.error = `not installed: ${(e as Error).message}`;
  }
  f.busy = false;
  redraw();
}

// --- what the mesh runs ---------------------------------------------------------------

export const stackViews = (): StackView[] =>
  Object.values(st.lastState?.stacks ?? {}).sort((a, b) => a.summary.name.localeCompare(b.summary.name));

// the installed app behind a page, when it's this one
export function installedAs(source: string, ref: string): StackView | undefined {
  return stackViews().find((v) => v.summary.source === source && v.summary.ref === ref);
}

export const statusOn = (host: string, id: string): StackStatus | undefined => st.hostsInfo[host]?.stacks?.[id];

// Docker being set up on a host, or why it couldn't be
export const dockerBusy = (host: string) => !!st.hostsInfo[host]?.docker?.installing;
export const dockerError = (host: string) => st.hostsInfo[host]?.docker?.error ?? '';

// whether a host is up on the tailnet as phosphorus sees it
export const hostUp = (host: string) =>
  host === st.selfHost || !!st.lastState?.tailnet?.some((d) => d.name === host && d.phosphorus);

export interface StackFacts {
  // the host serving it, and the hosts named, it first
  live: string;
  hosts: string[];
  active?: StackStatus;
  // a step under way somewhere, and the hosts with one
  busy: string[];
  failed: string[];
  // the oldest copy among the backups, ms; 0 when one has none yet
  synced?: number;
  // a failover or handoff, as the hosts tell it
  event?: [cls: string, text: string];
  sub: [cls: string, text: string];
}

// the host serving it now, as the hosts tell it: failover's leader, which may not be the
// want's active (an install naming an empty host never starts over another's copy)
export function liveHost(v: StackView): string {
  const id = v.summary.id;
  return [v.active, ...v.standbys].find((h) => statusOn(h, id)?.role === 'active') ?? v.active;
}

export function stackFacts(v: StackView): StackFacts {
  const id = v.summary.id;
  const live = liveHost(v);
  const hosts = [live, ...[v.active, ...v.standbys].filter((h) => h !== live)];
  const active = statusOn(live, id);
  const busy = hosts.filter((h) => {
    const j = statusOn(h, id)?.job;
    return j && !j.done;
  });
  const failed = hosts.filter((h) => statusOn(h, id)?.job?.ok === false);
  const syncs = hosts.slice(1).map((h) => statusOn(h, id)?.lastSync ?? 0);
  const synced = syncs.length ? Math.min(...syncs) : undefined;
  // a promotion under way or done, or the active host gone quiet
  let event: [string, string] | undefined;
  const promoting = hosts.find((h) => statusOn(h, id)?.job?.op === 'promote');
  if (promoting) {
    const j = statusOn(promoting, id)!.job!;
    event = !j.done
      ? ['wait', `${promoting} is taking over`]
      : j.ok
        ? ['new', `${promoting} took over`]
        : ['bad', `${promoting} couldn't take over`];
  } else if (!hostUp(live))
    event =
      hosts.length > 1
        ? ['bad', `${live} is down; a backup takes over`]
        : ['bad', `${live} is down and it has no backup`];
  const op = busy.length ? statusOn(busy[0]!, id)!.job!.op : '';
  const sub: [string, string] = busy.length
    ? ['wait', `${opWords[op] ?? op} on ${busy.join(', ')}`]
    : failed.length
      ? ['bad', `${statusOn(failed[0]!, id)!.job!.op} failed on ${failed.join(', ')}`]
      : active?.error
        ? ['bad', active.error]
        : !active
          ? ['wait', `waiting for ${live}`]
          : !active.running
            ? ['bad', `stopped on ${live}`]
            : active.healthy === false
              ? ['bad', `unhealthy on ${live}`]
              : ['on', `on ${live}`];
  return { live, hosts, active, busy, failed, synced, event, sub };
}

export const opWords: Record<string, string> = {
  install: 'installing',
  update: 'updating',
  remove: 'removing',
  promote: 'taking over',
};

// ms ago in words: 'just now', '5m ago'
export const agoText = (ms: number) => (ago2(ms) === 'now' ? 'just now' : `${ago2(ms)} ago`);

// an admin's step on an installed app: update, remove, standbys, move
export async function stackAct(id: string, op: 'update' | 'remove' | 'standbys' | 'move', body: unknown = {}) {
  stateVars.busyId = `stack:${id}`;
  redraw();
  try {
    await call(`/api/stacks/${encodeURIComponent(id)}/${op}`, jsonPost(body));
    stateVars.actError = '';
  } catch (e) {
    stateVars.actError = `${id}: ${(e as Error).message}`;
  }
  stateVars.busyId = '';
  await pollState();
  redraw();
}

// while a step runs anywhere, the state asked for every two seconds, its log coming in
let jobTimer: ReturnType<typeof setTimeout> | null = null;
export function followJobs(watching: boolean) {
  if (jobTimer || !watching) return;
  const running = stackViews().some((v) => stackFacts(v).busy.length) || stateVars.busyId.startsWith('stack:');
  if (!running) return;
  jobTimer = setTimeout(async () => {
    jobTimer = null;
    await pollState();
    draw();
  }, 2000);
}

// the source as the badge shows it
export function sourceOf(id: SourceId): SourceInfo | undefined {
  return catalog?.sources.find((s) => s.id === id);
}
export const SOURCE_NAMES: Record<SourceId, string> = {
  phosphorus: 'Phosphorus',
  casaos: 'CasaOS',
  runtipi: 'Runtipi',
  cosmos: 'Cosmos',
  github: 'GitHub',
};
