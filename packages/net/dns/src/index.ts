// the mesh's own authoritative DNS: the domain's zone served from the edge
// hosts, and the questions phosphorus asks to check it
export { type Ask, query } from "./client.ts";
export { type Served, serve } from "./server.ts";
export {
  type Parsed,
  type Query,
  type RData,
  type Reply,
  type RR,
  canon,
  parseQuery,
  parseReply,
  Rcode,
  Type,
  writeQuery,
  writeReply,
} from "./wire.ts";
export { type Srv, type Zone, type ZoneSpec, answer, build } from "./zone.ts";
