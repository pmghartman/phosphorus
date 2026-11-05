// a host's Electron app served to the browser: its own renderer in the page, its own main
// process on the host as the backend, IPC carried between (see inject/hook.js, inject/runtime.js)

export { needsWrap, wrapImports } from "./dynimport.ts";
export { codec, Op } from "./frames.ts";
export { commandOf, type Started, start } from "./launch.ts";
export { localHost } from "./local.ts";
export type { Host, Pipe, Proc } from "./pipe.ts";
export { execWords, resolve, type Target, winWords } from "./resolve.ts";
export { appUrlOf, handle } from "./serve.ts";
export {
  AppWeb,
  busy,
  byResourceKey,
  bySyncKey,
  count,
  find,
  list,
  reap,
  setSecret,
  type Viewer,
  type ViewerInfo,
} from "./session.ts";
export { type SshClient, sshHost } from "./ssh.ts";
