// an installable app's server half: one module, server/index.js in its signed
// bundle, exporting register(ctx); the host it runs on hands it routes under
// /api/app/<id>/, sockets, a slice of the mesh's store, its peers on other hosts,
// the people asking and the desktop to reach. Types only: the bundle imports
// nothing of phosphorus at run time.

// the person behind a request: a logged in user, admin or not
export type Who = { user: string; admin: boolean };

// one request to the app
export type AppRequest = {
  req: Request;
  // what follows the app's prefix, "/" at least
  path: string;
  query: URLSearchParams;
  // the logged in person; undefined on a public or internal route asked by none
  who?: Who;
  // the asking host on an internal route, "" otherwise
  peer: string;
  // the body as JSON, {} when empty, undefined when it isn't JSON
  json(): Promise<any>;
};

// a response, or [status, a body sent as JSON]
export type Reply = Response | [number, unknown];
export type Handler = (r: AppRequest) => Reply | Promise<Reply>;

// public: no login needed; admin: admins only; internal: other phosphorus
// hosts only, at /internal/app/<id>/, for peer()
export type RouteOpts = { public?: boolean; admin?: boolean; internal?: boolean };

export interface AppSocket {
  readonly open: boolean;
  // bytes sent and not yet taken by the network, to hold back on
  queued(): number;
  send(msg: unknown): void;
  close(code?: number, reason?: string): void;
  onMessage(fn: (msg: any) => void): void;
  onClose(fn: () => void): void;
}

// what the app may do to a person's desktop, on every host they have it open
export type UiAction =
  | { kind: "notify"; title: string; body?: string }
  | { kind: "terminal"; host: string }
  | { kind: "view"; view: string };

// a tool's caller: a user's key, via the agent using it
export type Caller = Who & { via: string };

// a tool for the mesh's MCP server, listed to agents while the app is installed;
// an error thrown with a code (not_found, bad_input, forbidden, unreachable,
// conflict) is reported with it
export type Tool = {
  name: string;
  title: string;
  description: string;
  schema: Record<string, unknown>;
  read?: boolean;
  admin?: boolean;
  destructive?: boolean;
  run(args: Record<string, any>, who: Caller): Promise<unknown>;
};

// where a socket was opened: what follows the app's prefix, and its query
export type SocketAt = { path: string; query: URLSearchParams };

// a person's own secrets, for an app that acts as them on their hosts (Code runs
// claude there over ssh). Their vault is sealed under their password and opens
// only for a request carrying their login, so each call takes the Who one of this
// app's routes or sockets was handed: one made up, or another app's, opens
// nothing. Narrow on purpose: host logins, the Anthropic token and what an agent
// needs to reach the mesh, never the page logins or the vault whole
export interface Vault {
  // whether this host can open it yet: just after a login it may still be syncing in
  ready(who: Who): Promise<boolean>;
  // the hosts they saved a login for, sorted
  hosts(who: Who): Promise<string[]>;
  // their saved login on host, undefined for none
  login(who: Who, host: string): Promise<{ user: string; pass: string } | undefined>;
  // their Anthropic subscription token (claude setup-token's), "" for none
  anthropic(who: Who): Promise<string>;
  // the token kept, "" clearing it; throws saying why it wasn't
  setAnthropic(who: Who, token: string): Promise<void>;
  // what an agent the app runs as them needs to reach the mesh: their MCP key (the
  // mesh's tools and models answer it as them), where this host's phosphorus answers
  // over the tailnet, and the phosphorus skill's zip naming the address they know
  agent(who: Who): Promise<{ key: string; base: string; skill: Uint8Array }>;
}

// the mesh's store under etc/appdata/<id>/: JSON on every host, the newest write
// winning; rel is a path of up to three [a-z0-9._-] parts, no .json
export interface AppStore {
  read(rel: string): unknown;
  write(rel: string, v: unknown): void;
  remove(rel: string): void;
  list(dir?: string): string[];
  watch(fn: (rel: string) => void): void;
}

// a peerFetch: GET unless a method is given
export type PeerInit = { method?: string; body?: BodyInit; timeoutMs?: number };

export interface AppContext {
  id: string;
  version: string;
  // this host's name on the mesh
  host: string;
  // this host's own folder for the app, kept across updates, gone on remove
  dataDir: string;
  log(fmt: string, ...a: unknown[]): void;
  // a route: path exact, or ending /* for everything under it
  route(method: string, path: string, h: Handler, opts?: RouteOpts): void;
  // a websocket at /api/app/<id><path>, for logged in people unless public; path
  // exact, or ending /* for everything under it
  socket(
    path: string,
    open: (ws: AppSocket, who: Who | undefined, at: SocketAt) => void,
    opts?: { public?: boolean },
  ): void;
  store: AppStore;
  // the phosphorus hosts up now, this one too
  hosts(): string[];
  // a host's tailnet IPv4, "" when it can't be found
  address(host: string): Promise<string>;
  vault: Vault;
  // the app's internal route on another host: POST with body as JSON, its JSON back
  peer(host: string, path: string, body?: unknown): Promise<any>;
  // the same route's response as it comes, for a body that isn't JSON (a file)
  peerFetch(host: string, path: string, init?: PeerInit): Promise<Response>;
  // whether name is one of the mesh's users
  isUser(name: string): boolean;
  ui(user: string, action: UiAction): void;
  tools(list: Tool[]): void;
  // run when the app is removed, replaced by another version, or the host stops
  onStop(fn: () => void | Promise<void>): void;
}

export type App = { register(ctx: AppContext): void | Promise<void> };

export const defineApp = (a: App) => a;
