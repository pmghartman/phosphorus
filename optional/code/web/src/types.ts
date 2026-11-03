// --- the code app's api, /api/app/code: optional/code/server

export interface CodeUsage {
  in?: number;
  out?: number;
  costUSD?: number;
}
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
export interface CodeModel {
  id: string;
  label?: string;
  provider?: string;
  ready?: boolean;
  why?: string;
}
export interface CodeHarness {
  id: string;
  label: string;
  about?: string;
  meshOnly?: boolean;
  site?: string;
}
export interface CodeOptions {
  // the hosts the user has a login on that are up; offline, the rest of them
  hosts?: string[];
  offline?: string[];
  models?: CodeModel[];
  anthropic?: boolean;
  harnesses?: CodeHarness[];
  blocked?: string;
  error?: string;
}
export interface CodeHarnessOn {
  id: string;
  label: string;
  installed: boolean;
  version?: string;
}
export interface CodeHarnesses {
  harnesses?: CodeHarnessOn[];
  error?: string;
  why?: string;
}
export interface CodeLsEntry {
  name: string;
  dir: boolean;
  size?: number;
  mtime?: number;
}
export interface CodeLs {
  dir: string;
  entries?: CodeLsEntry[];
  more?: boolean;
}
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
