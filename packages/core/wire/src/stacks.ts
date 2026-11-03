// the installer's shapes: an app from a catalogue or a GitHub repo, normalized
// (packages/mesh/catalog), the check of whether it installs, what the mesh wants
// of it (etc/stacks/<id>.json) and each host's copy (packages/mesh/stacks); the
// page reads them over /api/stacks/*

// where an app came from: phosphorus's own few, a catalogue fetched at run time, or
// a repo opened by url
export type SourceId = "phosphorus" | "casaos" | "runtipi" | "cosmos" | "github";

// a catalogue as the page lists it: its terms shown beside every app it gives
export interface SourceInfo {
  id: SourceId;
  name: string;
  // the catalogue's repo, and its licence as an SPDX id
  repo: string;
  licence: string;
  apps: number;
  // when this host last fetched it, ms; 0 never
  fetchedAt: number;
  error?: string;
}

// one env value the person may or must give at install
export interface EnvField {
  name: string;
  label: string;
  default?: string;
  // generated once at install when blank, never shown again
  secret?: boolean;
  required?: boolean;
  // one of these, when the source names choices
  options?: string[];
}

// a volume of a service: data is replicated to standbys, cache is not
export interface VolumeRef {
  service: string;
  // the path inside the container
  target: string;
  kind: "data" | "cache";
}

// a step run in a service's container around a copy of its data: a database
// dumped before, say, so the copy is consistent
export interface Hook {
  service: string;
  // argv, run with docker compose exec
  run: string[];
}

// the thin layer phosphorus keeps over a compose file: from phos.yml in a repo,
// a source's own hints, or derived
export interface PhosManifest {
  volumes: VolumeRef[];
  backup?: { pre?: Hook[]; post?: Hook[] };
  // the service and what answers when it's well: an http path or just its port open
  health?: { service: string; path?: string; port?: number };
  // the web page the mesh publishes: its service and container port
  web?: { service: string; port: number };
  // more names the web page answers at, <name>.<domain> each, one a real route takes over
  aliases?: string[];
  // a host to install on unless the person picks another
  preferredHost?: string;
}

// an app normalized, whatever its source
export interface AppDef {
  // unique on the mesh: [a-z0-9-], the project and route name
  id: string;
  source: SourceId;
  // the app within its source: its folder in a catalogue, owner/repo for github
  ref: string;
  name: string;
  tagline: string;
  description: string;
  // a url off the source, never a copy of the logo
  icon: string;
  category: string;
  // the app's own project, and its source's licence (the catalogue's or the repo's)
  repo: string;
  licence: string;
  // docker platforms its images run on, empty when unknown
  archs: string[];
  // the compose file as phosphorus will render it: source variables already mapped to
  // ${APP_DATA}, ${PUID}, ${PGID}, ${TZ}, ${APP_URL}, ${APP_DOMAIN} and the env fields;
  // a repo's build contexts and files under ${APP_REPO}, its clone
  compose: string;
  env: EnvField[];
  manifest: PhosManifest;
}

// one entry in the store's grid
export type AppSummary = Pick<
  AppDef,
  "id" | "source" | "ref" | "name" | "tagline" | "icon" | "category" | "licence"
> & {
  installed?: boolean;
};

// a repo's file as the viewer lists it
export interface TreeEntry {
  path: string;
  type: "file" | "dir";
  size?: number;
}

// --- the check -------------------------------------------------------------------

export type Verdict = "installable" | "needs-input" | "blocked";

export interface CheckItem {
  level: "ok" | "warn" | "block";
  // short and plain: "image for arm64", "port 8080 taken on razer", "runs privileged"
  text: string;
}

// one host as a place for the app: whether it can run it, and why not
export interface HostFit {
  host: string;
  ok: boolean;
  docker: "present" | "installable" | "unsupported";
  arch: string;
  why?: string;
}

// docker on one host, in its info: what the check reads of it (packages/stacks)
export interface DockerInfo {
  state: HostFit["docker"];
  // docker's name for the machine: amd64, arm64, arm
  arch: string;
  version?: string;
  compose?: string;
  // Docker being installed here, asked by POST /api/stacks/docker
  installing?: boolean;
  error?: string;
}

export interface CheckResult {
  verdict: Verdict;
  items: CheckItem[];
  // the fields still wanting a value
  missing: string[];
  hosts: HostFit[];
}

// --- what the mesh wants ---------------------------------------------------------

// etc/stacks/<id>.json, written by an admin's install, every host following
export interface StackWant {
  def: AppDef;
  // the person's values; secrets sealed by the server, never sent to the page
  env: Record<string, string>;
  active: string;
  standbys: string[];
  // bumped on each install, update or move; a host's copy names the gen it ran
  gen: number;
  by: string;
  at: number;
}

// the want as the page sees it: no env values
export type StackView = Omit<StackWant, "env" | "def"> & { summary: AppSummary; web?: PhosManifest["web"] };

export type StackRole = "active" | "standby" | "none";

// one host's copy, in its info
export interface StackStatus {
  role: StackRole;
  gen: number;
  running: boolean;
  healthy?: boolean;
  // a standby's last copy of the data, ms; the active's last snapshot
  lastSync?: number;
  // an install, update or removal under way here, its log's tail
  job?: { op: "install" | "update" | "remove" | "promote"; log: string; done: boolean; ok?: boolean };
  error?: string;
}

// --- /api/stacks ----------------------------------------------------------------
//
// GET  /api/stacks/catalog?q=&source=&category=  -> { sources: SourceInfo[]; apps: AppSummary[] }   (catalog)
// GET  /api/stacks/app/<source>/<ref>             -> AppPage                                        (catalog)
// POST /api/stacks/repo { url }                   -> AppPage, a public GitHub repo opened            (catalog)
// POST /api/stacks/check { source, ref, env }     -> CheckResult                                     (catalog)
// POST /api/stacks/install { source, ref, env, active, standbys } -> { ok, want: StackView }         (stacks, admin)
// POST /api/stacks/<id>/update                    -> { ok }                                          (stacks, admin)
// POST /api/stacks/<id>/remove { keepData }       -> { ok }                                          (stacks, admin)
// POST /api/stacks/docker { host }                -> { ok }   Docker installed on a Debian/Ubuntu host  (stacks, admin)
// POST /api/stacks/<id>/standbys { standbys }     -> { ok, want: StackView }                         (ha, admin)
// POST /api/stacks/<id>/move { to }               -> { ok }   a planned handoff                      (ha, admin)
// State.stacks carries every StackView; HostInfo.stacks each host's StackStatus, HostInfo.docker its DockerInfo.

// the move off the git service phosphorus used to run itself (etc/stacks/legacy/git.json):
// the old master's Forgejo data copied into the git stack on that host, the old servants
// its standbys; the old copies deleted once an admin says the stack serves
export interface LegacyGit {
  from: string;
  standbys: string[];
  by: string;
  at: number;
  state: "asked" | "copying" | "moved" | "failed";
  // the install's own fields when it came as one, its secrets left out
  env?: Record<string, string>;
  error?: string;
  cleared?: { by: string; at: number };
}

// POST /api/stacks/legacy-git/move { from, standbys } -> { ok, legacy }   (stacks, admin)
// POST /api/stacks/legacy-git/clear                    -> { ok, legacy }   (stacks, admin)
// POST /api/stacks/install of the featured Forgejo while an old copy waits is that move,
// answering { ok, legacy }; fresh: true installs it empty instead.
// State.legacyGit carries the record, HostInfo.legacyGit each host's old copy while it has one.

export interface AppPage {
  def: AppDef;
  readme: string;
  tree: TreeEntry[];
  check: CheckResult;
}
