// the server's shapes as the page reads them, from packages/server/src and the packages it
// calls: buildState() in server.ts, the chat socket in chatws.ts and chat.ts, the files api in
// packages/files, the account in packages/users, code in packages/code, stats in packages/stats.
// The server marshals most of these as Record<string, any>, so each field here is one the page
// relies on, optional where a host may leave it out.

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
export interface ModelAgentSlot { chosen?: string; ready?: boolean; host?: string; why?: string; inherited?: boolean }
export interface ModelAgent {
  id: string;
  label: string;
  about?: string;
  parent?: string;
  fast?: boolean;
  slots: Record<string, ModelAgentSlot>;
}
export interface ModelSummary { models: ModelHost[]; agents?: ModelAgent[] }

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
export interface MeshLock { initiator: string; chainId?: string; startedAt?: string; done?: boolean }

// a share as a host publishes it in its info.json (packages/files Share, the page's fields)
export interface HostShare { id: string; label: string; perms?: string; home?: boolean }
// each host's info.json off sys: version, platform, its files and Desktop stamps
export interface HostInfo {
  version?: string;
  platform?: string;
  files?: { enabled?: boolean; shares?: HostShare[] };
  desk?: Record<string, string>;
  apps?: Record<string, AppStatus>;
  // a service's step on the host (packages/webapps services): its log's tail, its exit once ended
  services?: Record<string, { log: string; exit?: number }>;
}

export interface SelfInfo { host: string; version?: string; platform?: string; bootId?: string }

// an optional app the mesh wants (packages/webapps Want), and a host's copy of one (Status)
export interface AppWant { version: string; url?: string; sha256?: string; from?: string; at?: number }
export interface AppStatus { version: string; busy?: boolean; error?: string }

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
  pollMs?: number;
}

// --- /api/update

// the release feed as /api/update/check answers
export interface UpdateCheck { latest?: string; error?: string }

// --- /api/chat: packages/server/src/chat.ts and chatws.ts

// a file shared in the chat (packages/chatmedia's meta with its host and id)
export interface ChatFile { host: string; id: string; name: string; type?: string; size?: number }
// a file offered to work on together, as the files tab names it
export interface ShowFile { host: string; share: string; path: string; label: string }

// one line of the log as the host keeps it: by host:seq; kind '' or absent for a plain line,
// else dm, model, sys, show, topic, or a mark (react, edit, delete) on ref
export interface ChatMsg {
  host: string;
  seq: number;
  timestamp: number;
  name: string;
  color?: string;
  kind?: string;
  text?: string;
  html?: string;
  ch?: string;
  dm?: string;
  // the agent that posted on this user's key
  via?: string;
  // the line replied to, host:seq
  re?: string;
  // a mark's target, host:seq
  ref?: string;
  emoji?: string;
  on?: boolean;
  files?: ChatFile[];
  file?: ShowFile;
  [k: string]: unknown;
}

// a reaction folded into its line
export interface Reaction { name: string; emoji: string; on: boolean; at: number }

// someone on the chat, peers merged in by the frontend
export interface Person { name: string; color?: string; host?: string; typing?: string }

// a channel's mesh-wide meta: when made, its topic, its last close
export interface ChannelMeta { created?: number; topic?: string; closedAt?: number; closedBy?: string }

// what the chat socket sends the page
export type ChatWsMessage =
  | { type: 'pong' }
  | { type: 'history'; messages: ChatMsg[]; channels?: Record<string, ChannelMeta>; closed?: Record<string, unknown> }
  | ({ type: 'message' } & ChatMsg)
  | { type: 'phosphorus-ui'; action: UiAction }
  | { type: 'model-purged'; id: string; error?: string }
  | { type: 'retract'; host: string; seq: number }
  | { type: 'presence'; people: Person[] }
  | { type: 'system'; text: string }
  | { type: 'clear'; by?: string }
  | { type: 'close'; ch: string; by?: string; at?: number }
  | { type: 'channel'; ch: string; meta: ChannelMeta };

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

// --- /api/files/<host>/<op>: packages/files

// one entry of a listing; hosts, live, stale and at are the merged home's own
export interface FileEntry {
  name: string;
  dir: boolean;
  empty?: boolean;
  link?: boolean;
  size?: number | null;
  mtime?: number | null;
  // a home file kept on every host
  all?: boolean;
  // the merged home: the hosts holding it, those online, none online, the folder it sits in
  hosts?: string[];
  live?: string[];
  stale?: boolean;
  at?: string;
}
export interface FileListing { path: string; entries: FileEntry[]; truncated?: boolean }
export interface FilesInfo { enabled?: boolean; shares?: HostShare[] }
export interface FileRead { path: string; size?: number; text?: string; tooBig?: boolean; binary?: boolean }
// a sealed run link for a page, an app folder or a .wasm
export interface FileRun { url: string; kind?: string }

// --- /api/me: packages/users Me()

export interface VaultHost { user: string; pass: string }
export interface VaultPage { url?: string; user: string; pass: string }
export interface Vault { hosts: Record<string, VaultHost>; pages: Record<string, VaultPage> }
export interface Me {
  user: string;
  admin: boolean;
  boot: boolean;
  vault?: Vault;
  vaultOK?: boolean;
  prefs?: Record<string, string>;
  prefsAt?: number;
  wallpaper?: number;
}
export interface UserRow { name: string; admin: boolean }

// --- /api/me/mcp: packages/server/src/mcpops.ts, the user's key and calls from the mesh

export interface McpCall {
  host?: string;
  tool: string;
  detail?: string;
  ok?: boolean;
  error?: string;
  ms?: number;
  at?: number;
  since?: number;
}
export interface McpStatus {
  configured?: boolean;
  seen?: number;
  at?: number;
  now?: number;
  client?: string;
  calls?: McpCall[];
  recent?: McpCall[];
}

// --- /api/term/<host>: a saved login handed to the server once, its prompts answered there

export interface TermLogin { user: string; pass: string; run?: string; dir?: string; then?: string }

// --- /api/code: packages/code

export interface CodeUsage { in?: number; out?: number; costUSD?: number }
// a session as the page sees it (packages/code SessionRecord)
export interface CodeSession {
  id: string;
  user?: string;
  host: string;
  dir: string;
  title: string;
  model: string;
  perm: string;
  status: string;
  err?: string;
  created: number;
  updated?: number;
  usage?: CodeUsage;
  harness?: string;
}
export interface CodeModel { id: string; label?: string; provider?: string; ready?: boolean; why?: string }
export interface CodeHarness { id: string; label: string; about?: string; meshOnly?: boolean; site?: string }
export interface CodeOptions {
  hosts?: string[];
  models?: CodeModel[];
  anthropic?: boolean;
  harnesses?: CodeHarness[];
  blocked?: string;
  error?: string;
}
export interface CodeHarnessOn { id: string; label: string; installed: boolean; version?: string }
export interface CodeHarnesses { harnesses?: CodeHarnessOn[]; error?: string; why?: string }
export interface CodeLsEntry { name: string; dir: boolean; size?: number; mtime?: number }
export interface CodeLs { dir: string; entries?: CodeLsEntry[]; more?: boolean }
// a line of a session's transcript over its socket
export interface CodeWsMessage {
  seq?: number;
  kind?: string;
  // a claude stream-json event
  ev?: Record<string, any>;
  text?: string;
  record?: CodeSession;
  reqId?: string;
  allow?: boolean;
  cancelled?: boolean;
  truncated?: boolean;
  tool?: string;
  input?: Record<string, any>;
  reason?: string;
}

// --- /api/stats: one host's sample (packages/stats)

export interface StatsGpu { name: string; util: number | null; mhz?: number; mhzMax?: number; memUsed?: number; memTotal?: number; temp: number | null }
export interface StatsPart { name: string; cpu: number; mem: number; pids: number }
export interface StatsProc { name: string; pid: number; cpu: number; mem: number; cmd?: string; role?: string }
export interface StatsSample {
  host: string;
  at: number;
  platform?: string;
  version?: string;
  cpu: { total: number; cores: number[]; model: string; load: number[] };
  mem: { total: number; used: number; avail: number; cached: number; swapTotal: number; swapUsed: number };
  net: { name: string; rx: number; tx: number }[];
  netDay: { rx: number; tx: number; since: number };
  io: { r: number; w: number };
  disk: { total: number; used: number; count: number };
  gpus: StatsGpu[];
  uptime?: number;
  parts?: StatsPart[];
  procs?: { count: number; top: StatsProc[] };
}

// --- /api/md: a document's top-level blocks

export interface MdBlock { from: number; raw: string; html: string | null }
