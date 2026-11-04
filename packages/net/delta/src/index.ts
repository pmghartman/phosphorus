// files moved between hosts as diffs: cut into content-defined chunks named by their bytes, a
// receiver rebuilding a file from the chunks it already holds and fetching only the rest
export { type Chunk, chunkAvg, chunkFile, chunkMax, chunkMin, chunkName, cutAt } from "./chunk.ts";
export { type Fetch, maxAsk, rebuild, serveChunks, splitChunks } from "./rebuild.ts";
export { type ChunkList, Chunks, cleanRel, versionOf } from "./tree.ts";
