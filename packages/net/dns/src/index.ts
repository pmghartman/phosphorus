// the mesh's own authoritative DNS: the domain's zone served from the edge
// hosts, and the questions phosphorus asks to check it
export { type Ask, query } from "./client.ts";
export { type Served, serve } from "./server.ts";
export {
  canon,
  type Parsed,
  parseQuery,
  parseReply,
  type Query,
  Rcode,
  type RData,
  type Reply,
  type RR,
  Type,
  writeQuery,
  writeReply,
} from "./wire.ts";
export { answer, build, type Srv, type Zone, type ZoneSpec } from "./zone.ts";
