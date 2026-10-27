// the code service: claude or opencode sessions on a mesh host over ssh, the
// host's folders listed and uploaded into, each harness probed and installed
export { answer, create, type CredsFn, get, list, newID, owns, permAnswer, remove, rename, send, setModel, setPerm, stop } from "./api.ts";
export { type Conn, idRe, logFile, record, type SessionRecord, setRunDir, type Usage } from "./claude.ts";
export { dupNames, type Entry, ls, okDir, okName, parseLs, upload, UploadMax } from "./fs.ts";
export { Claude, errB, type Harness, harnessByID, Harnesses, harnessesOn, harnessOf, type HarnessState, hostRe, installOf, missing, Opencode, parseProbe, type Res } from "./harness.ts";
export { Anthropic, type Creds, creds, envBlock, envLines, launchCommand, Mesh, Perms, provider, quote, setupScript } from "./script.ts";
export { setSpawn, type Spawner } from "./spawn.ts";
export { dial, dialAs, type Proc, Tail } from "./ssh.ts";
export { ocConfig, ocLaunch, ocTool } from "./opencode.ts";
export { attach } from "./ws.ts";
export { unzip, zipOf } from "./zip.ts";
