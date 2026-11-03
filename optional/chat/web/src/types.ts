// what the chat's socket (server/socket.ts) sends and holds

// an attachment: the host it was sent to, its id there
export interface ChatFile {
  host: string;
  id: string;
  name: string;
  type?: string;
  size?: number;
}

// one line of the log as the host keeps it: by host:seq; kind '' or absent for a plain line,
// else dm, model, sys, show (an old invite), topic, or a mark (react, edit, delete) on ref
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
  file?: { label: string };
  [k: string]: unknown;
}

// a reaction folded into its line
export interface Reaction {
  name: string;
  emoji: string;
  on: boolean;
  at: number;
}

// someone on the chat, on whichever host
export interface Person {
  name: string;
  color?: string;
  host?: string;
  typing?: string;
}

// a channel's mesh-wide meta: when made, its topic, its last close
export interface ChannelMeta {
  created?: number;
  topic?: string;
  closedAt?: number;
  closedBy?: string;
}

export type ChatWsMessage =
  | { type: "pong" }
  | {
      type: "history";
      me: string;
      messages: ChatMsg[];
      channels?: Record<string, ChannelMeta>;
      closed?: Record<string, unknown>;
    }
  | ({ type: "message" } & ChatMsg)
  | { type: "retract"; host: string; seq: number }
  | { type: "presence"; people: Person[] }
  | { type: "system"; text: string }
  | { type: "clear"; by?: string }
  | { type: "close"; ch: string; by?: string; at?: number }
  | { type: "channel"; ch: string; meta: ChannelMeta };
