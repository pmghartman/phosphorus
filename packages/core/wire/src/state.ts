import type { DockerInfo, StackStatus, StackView } from "./stacks.ts";

// --- /api/state: buildState() in packages/server/src/server.ts, pushed over the same path's socket

// a device on the tailnet, phosphorus hosts marked (packages/mesh)
export interface TailnetDevice {
  name: string;
  os?: string;
  phosphorus?: boolean;
  // ever answered as a phosphorus host: quiet now, not just a phone
  phosphorusSeen?: boolean;
  version?: string;
}

// a served destination: a host's service, or a game server (packages/services rows, with host put in)
export interface Route {
  host: string;
  name: string;
  // 'game' for a game server, else a web service
  type?: string;
  // subdomain or path for a service, game for a game server
  mode?: string;
  // the mode picked by its host, services.export leaving it blank
  auto?: boolean;
  base_path?: string;
  port?: number;
  scheme?: string;
  // open to all behind its own login, no phosphorus login
  public?: boolean;
  // the git service: its master flag, set on the serving copy
  master?: boolean;
  // a game server's: online, offline, starting, stopping; and whether it has start/stop commands
  status?: string;
  controllable?: boolean;
  [k: string]: unknown;
}

// one git host on the card (packages/git rowsOf)
export interface GitHost {
  host: string;
  reachable: boolean;
  role?: string;
  master?: string;
  gen?: number | null;
  ageSec?: number | null;
  eligible?: boolean;
  updating?: boolean;
}

// a model host's row, with the agents asking it (packages/model Summary)
export interface ModelHost {
  host: string;
  file?: string;
  ready?: boolean;
  loading?: boolean;
  why?: string;
  download?: { done: number; total: number };
  // the last ask: tokens per second, and the context window's parts
  use?: { tps?: number; system?: number; chat?: number; ask?: number; reply?: number };
  ctx?: number;
  agents?: string[];
}
export interface ModelAgentSlot {
  chosen?: string;
  ready?: boolean;
  host?: string;
  why?: string;
  inherited?: boolean;
}
export interface ModelAgent {
  id: string;
  label: string;
  about?: string;
  parent?: string;
  fast?: boolean;
  slots: Record<string, ModelAgentSlot>;
}
export interface ModelSummary {
  models: ModelHost[];
  agents?: ModelAgent[];
}

// the mesh update's walk, as chainStatus_() in packages/update marshals it
export interface Chain {
  chainId: string;
  order: string[];
  // host -> pending, running, ok, current, fail, unreachable, skipped
  results: Record<string, string>;
  // host -> its stage while running: asked, installing, restarting
  versions?: Record<string, { stage?: string; [k: string]: string | undefined }>;
  target?: string;
  errors?: Record<string, string>;
  details?: Record<string, string>;
  done: boolean;
  finishedAt?: number;
}

// a walk under way somewhere on the mesh, who started it
export interface MeshLock {
  initiator: string;
  chainId?: string;
  startedAt?: string;
  done?: boolean;
}

// a share as a host publishes it in its info.json (packages/files Share, the page's fields)
export interface HostShare {
  id: string;
  label: string;
  perms?: string;
  home?: boolean;
}
// each host's info.json off sys: version, platform, its files and Desktop stamps
export interface HostInfo {
  version?: string;
  platform?: string;
  // the cpu as docker names it (amd64, arm64, arm), os-release's ID and ID_LIKE, and the
  // TCP ports open on the host: what the installer's check reads (packages/catalog)
  arch?: string;
  distro?: string;
  listening?: number[];
  files?: { enabled?: boolean; shares?: HostShare[] };
  apps?: Record<string, AppStatus>;
  // a service's step on the host (packages/webapps services): its log's tail, its exit once ended
  services?: Record<string, { log: string; exit?: number }>;
  // web pages listening on the host that its services.export doesn't name (packages/services Found)
  found?: FoundPage[];
  // *.<domain> reaching the mesh through the tunnel, as this host last saw it (packages/services Wildcard)
  wildcard?: { state: string; why?: string };
  // this host's copy of each installed app (packages/stacks)
  stacks?: Record<string, StackStatus>;
  // docker here, for the install check
  docker?: DockerInfo;
}

export interface FoundPage {
  port: number;
  scheme: string;
  title: string;
  // a services.export name guessed from the title
  name: string;
}

export interface SelfInfo {
  host: string;
  version?: string;
  platform?: string;
  bootId?: string;
}

// an optional app the mesh wants (packages/webapps Want), and a host's copy of one (Status)
export interface AppWant {
  version: string;
  // where every host serves it
  mount?: string;
  url?: string;
  sha256?: string;
  from?: string;
  at?: number;
}
export interface AppStatus {
  version: string;
  busy?: boolean;
  error?: string;
}

export interface State {
  domain?: string;
  gameZone?: string;
  self: SelfInfo;
  routes: Route[];
  tailnet: TailnetDevice[];
  lock?: MeshLock | null;
  gitHosts: GitHost[];
  model?: ModelSummary;
  chain?: Chain | null;
  chainMine?: boolean;
  hosts?: Record<string, HostInfo>;
  // the optional apps picked for the mesh, by id
  apps?: Record<string, AppWant>;
  // the installed services, by id
  stacks?: Record<string, StackView>;
  // the home's digest on this host: anything in it changed, the folders shown read again
  home?: string;
  pollMs?: number;
}

// --- /api/update

// the release feed as /api/update/check answers
export interface UpdateCheck {
  latest?: string;
  error?: string;
}

// a press phosphorus makes on this page (packages/mcp's ui actions)
export interface UiAction {
  kind: string;
  host?: string;
  share?: string | boolean;
  path?: string;
  view?: string;
  title?: string;
  body?: string;
  // an agent call's start or end
  id?: string;
  phase?: string;
  tool?: string;
  args?: Record<string, any>;
  ok?: boolean;
  out?: string;
  error?: string;
  exit?: number | null;
  timedOut?: boolean;
}

// what the state socket carries besides the state itself, to one user's pages
export type PageMessage =
  | { type: "phosphorus-ui"; action: UiAction }
  | { type: "model-purged"; id: string; error?: string };
