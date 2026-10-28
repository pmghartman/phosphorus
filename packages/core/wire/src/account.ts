// --- /api/me: packages/users Me()

export interface VaultHost {
  user: string;
  pass: string;
}
export interface VaultPage {
  url?: string;
  user: string;
  pass: string;
}
export interface Vault {
  hosts: Record<string, VaultHost>;
  pages: Record<string, VaultPage>;
}
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
export interface UserRow {
  name: string;
  admin: boolean;
}

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

export interface TermLogin {
  user: string;
  pass: string;
  run?: string;
  dir?: string;
  then?: string;
}
