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
