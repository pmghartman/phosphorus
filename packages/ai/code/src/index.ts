// the code service: claude or opencode sessions on a mesh host over ssh, the
// host's folders listed and uploaded into, each harness probed and installed
export {
  answer,
  type CredsFn,
  create,
  get,
  list,
  newID,
  owns,
  permAnswer,
  remove,
  rename,
  send,
  setModel,
  setPerm,
  stop,
} from "./api.ts";
export { type Conn, idRe, logFile, record, type SessionRecord, setRunDir, type Usage } from "./claude.ts";
export { dupNames, type Entry, ls, okDir, okName, parseLs, UploadMax, upload } from "./fs.ts";
export {
  Claude,
  errB,
  type Harness,
  Harnesses,
  type HarnessState,
  harnessByID,
  harnessesOn,
  harnessOf,
  hostRe,
  installOf,
  missing,
  Opencode,
  parseProbe,
  type Res,
} from "./harness.ts";
export { ocConfig, ocLaunch, ocTool } from "./opencode.ts";
export {
  Anthropic,
  type Creds,
  creds,
  envBlock,
  envLines,
  launchCommand,
  Mesh,
  Perms,
  provider,
  quote,
  setupScript,
} from "./script.ts";
export { type Spawner, setSpawn } from "./spawn.ts";
export { dial, dialAs, type Proc, Tail } from "./ssh.ts";
export { attach } from "./ws.ts";
export { unzip, zipOf } from "./zip.ts";
