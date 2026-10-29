// --- the link between two hosts: one websocket a pair, JSON frames by type (packages/mesh/peers)

// first in both directions
export interface PeerHello {
  type: "hello";
  host: string;
  version: string;
  platform: string;
  bootId: string;
  // the store's digest and log head, the peer's cursor from then on
  storeDigest: string;
  storeSeq: number;
  // the highest seq of the other host's chat lines the sender already holds
  chatSince: number;
}

// the sender's state, only the keys that changed; every key again now and then
export interface PeerState {
  type: "state";
  presence?: unknown[];
  lock?: unknown;
  chain?: unknown;
  git?: unknown;
  model?: unknown;
  services?: unknown[];
}

// the sender's own chat lines
export interface PeerChat {
  type: "chat";
  lines: unknown[];
}

// the store's files changed up to seq
export interface PeerStore {
  type: "store";
  seq: number;
  files: Record<string, unknown>;
}

// the sender's store digest, for a receiver to notice drift
export interface PeerDigest {
  type: "digest";
  store: string;
}

// a request and its answer: ops store.stamps, store.files {rels}, chat.since {seq}
export interface PeerReq {
  type: "req";
  id: number;
  op: string;
  body?: unknown;
}
export interface PeerRes {
  type: "res";
  id: number;
  ok: boolean;
  body?: unknown;
}

export type PeerFrame = PeerHello | PeerState | PeerChat | PeerStore | PeerDigest | PeerReq | PeerRes;

// close codes a link uses
export const PeerCloseDuplicate = 4001;
export const PeerCloseWrongHost = 4003;
