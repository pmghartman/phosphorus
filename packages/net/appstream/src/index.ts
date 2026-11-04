// app streaming: one GUI app on a host as a window in the browser. The host runs it
// on its own headless X server (agent.py), ffmpeg encodes that display, and the
// frames go to the viewer's VideoDecoder over the socket as they come

export { ffmpegArgs, missing, parseCaps, shq } from "./encode.ts";
export { parseExec } from "./exec.ts";
export { codecOf, FlvReader } from "./flv.ts";
export { keycodeOf, keysymOf } from "./keys.ts";
export { localRunner } from "./local.ts";
export { appCount, busy, find, launch, lingerMs, list, reapApps } from "./registry.ts";
export { AppSession, type Chan, caps, MsgConfig, MsgFrame, type Runner, type Start, type Viewer } from "./session.ts";
