// what every tool file shares: the server's views of the mesh, a call's
// caller, the tool record, its errors, and the JSON helpers Go's util gave
import type { Located } from "@phosphorus/files";
import { jsNumber } from "@phosphorus/files";
import { obj } from "@phosphorus/util";

export const protocol = "2025-06-18";
export const waitMaxS = 120;
export const noCreds = "Never asks for, takes or types a password, key or any other credential.";

// [status, body]: what every pressed button answers
export type Res = [number, any];
type R = Res | Promise<Res>;
// a file's place: host, share id, path from the share's root
export type Loc = [string, string, string];
export type Action = Record<string, any>;

// Asker the person behind a keyed call
export type Asker = { name: string; ui: (action: Action) => boolean | Promise<boolean> };

// Actions the buttons phosphorus may press
export type Actions = {
  game: (host: string, name: string, action: string) => R;
  gitMaster: (host: string) => R;
  agentModel: (agent: string, slot: string, model: string) => R;
  update: (action: string, admin: boolean, only: string[]) => R;
  // op a host operation: health, power, term_close, shell, exec,
  // service_health, or mesh-wide mesh_health and update_history (services, mesh_hosts, update_status)
  op: (host: string, op: string, p: Record<string, any> | undefined) => R;
  chatEdit: (user: string, ref: string, action: string, text: string) => R;
  files: (c: Caller | undefined, host: string, op: string, share: string, body: Record<string, any>) => R;
  copy: (c: Caller | undefined, from: Loc, to: Loc, move: boolean) => R;
  logs: (host: string, p: Record<string, any>) => R;
  config: (host: string, p: Record<string, any>) => R;
  userUI: (user: string, action: Action) => boolean | Promise<boolean>;
  // userUIAsync the same, never waiting on a peer
  userUIAsync?: (user: string, action: Action) => void | Promise<void>;
  service: (
    host: string,
    name: string,
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string,
  ) => R;
  modelColor: string;
};

// Src server's views of the mesh
export type Src = {
  self: () => Record<string, any>;
  domain: () => string;
  tailnet: () => Record<string, any>[];
  routes: () => Record<string, any>[];
  peerIPs: () => Record<string, string>;
  gitHosts: () => unknown;
  model: () => Record<string, any>;
  chat: () => Record<string, any>[];
  people: () => Record<string, any>[];
  lock: () => unknown;
  chain: () => unknown;
  actions: Actions;
  post: (by: string, to: string, text: string, via: string) => R;
  // known a person by chat name: a user, or anyone the chat has seen
  known: (name: string) => boolean;
  show: (by: string, to: string, f: Record<string, any>) => R;
  locate: (abs: string) => Located | undefined;
};

// a view left out of init throws when a tool reaches for it, caught as that call's error
export let src = {} as Src;
export const init = (s: Partial<Src>) => void (src = s as Src);

// Caller a user's own key, its rights theirs, via the agent using it
export type Caller = {
  user: string;
  admin?: boolean;
  via?: string;
  // login the host login the key carries, undefined for none
  login?: (host: string) => { user: string; pass: string } | undefined;
  // pages the page logins the key carries by name: url, user, pass
  pages?: () => Record<string, any> | undefined;
  // hosts the hosts the key carries a saved login for
  hosts?: () => string[];
};

// Meta a call's context: its keyed caller, if any; local an unkeyed call from this host itself
export type Meta = { caller?: Caller; local: boolean };

// ToolError a failure with its short code: not_found, bad_input, forbidden,
// unreachable, conflict or failed, data riding along when there is some
export class ToolError extends Error {
  constructor(
    public code: string,
    msg: string,
    public data?: unknown,
  ) {
    super(msg);
  }
}
export const errc = (code: string, msg: string) => new ToolError(code, msg);

// codeOf an http status as a tool error's code
export function codeOf(status: number): string {
  if (status === 400 || status === 413 || status === 422) return "bad_input";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 502 || status === 503 || status === 504) return "unreachable";
  return "failed";
}

// pressed a button's answer as a result, a failing status as its error
export async function pressed(r: R): Promise<any> {
  const [status, body] = await r;
  if (status >= 300) throw new ToolError(codeOf(status), str(obj(body)?.error) || `status ${status}`);
  if (body === null || body === undefined) return { ok: true };
  return body;
}

// JSON values read as the web client's JS would: String(v || "")
export function str(v: unknown): string {
  if (
    v === null ||
    v === undefined ||
    v === false ||
    v === "" ||
    (typeof v === "number" && (v === 0 || Number.isNaN(v)))
  )
    return "";
  return jsString(v);
}
// as a JS template literal renders a JSON value
export const jsString = (v: unknown): string => (v === null || v === undefined ? "null" : String(v));
// JS truthiness of a JSON value
export const truthy = (v: unknown) => !!v;
export const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
export const num = (v: unknown) => (typeof v === "number" ? v : 0);
export function numOr(v: unknown, def: number): number {
  const n = jsNumber(v);
  return n === 0 || Number.isNaN(n) ? def : n;
}
// clip s to n code points
export const runes = (s: string, n: number) => {
  const r = [...s];
  return r.length > n ? r.slice(0, n).join("") : s;
};

export const object = (props?: Record<string, any>, ...required: string[]) => ({
  type: "object",
  properties: props ?? {},
  required,
});
export const name = { type: "string", description: "host name, as mesh_hosts lists it" };

export const nameRe = /^[A-Za-z0-9-]{1,63}$/;
export const gameNameRe = /^[a-z0-9][a-z0-9-]*$/;

export function hostOf(a: Record<string, any>): string {
  const h = str(a.host);
  if (!h) throw errc("bad_input", "missing 'host'");
  if (!nameRe.test(h)) throw errc("bad_input", `bad host ${jsString(h)}`);
  return h;
}

// meshHosts this host then every phosphorus peer
export function meshHosts(): string[] {
  const hosts = [str(src.self().host)];
  const seen = new Set(hosts);
  for (const h of src.tailnet()) {
    const n = str(h.name);
    if (h.phosphorus === true && !seen.has(n)) {
      seen.add(n);
      hosts.push(n);
    }
  }
  return hosts;
}

// knownHost hostOf held to the phosphorus hosts answering on the mesh
export function knownHost(a: Record<string, any>): string {
  const h = hostOf(a);
  if (meshHosts().includes(h)) return h;
  throw errc("not_found", `no phosphorus host ${h} answering on the mesh; mesh_hosts lists them`);
}

// adminOf throws unless the caller, when keyed, is an admin
export function adminOf(m: Meta) {
  if (m.caller && !m.caller.admin) throw errc("forbidden", "admins only");
}

export const byOf = (m: Meta) => m.caller?.user ?? "phosphorus";

export function askerOf(m: Meta): Asker {
  const c = m.caller;
  if (c) return { name: c.user, ui: (a) => src.actions.userUI(c.user, a) };
  throw errc("forbidden", "buttons are pressed only on a user's key");
}

export type Tool = {
  name: string;
  // title a person's name for it, as a client lists it
  title: string;
  description: string;
  schema: Record<string, any>;
  read?: boolean;
  // scope: "" any caller, "key" a user's key only
  scope?: "" | "key";
  destructive?: boolean;
  open?: boolean;
  // admin a key's tool for admins only, kept off other keys' lists
  admin?: boolean;
  run: (a: Record<string, any>, m: Meta) => unknown;
};

// every tool, filled once by index's build
export const tools: Tool[] = [];
