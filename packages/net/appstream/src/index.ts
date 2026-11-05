// app streaming: one GUI app on a host as a window in the browser. A Linux host runs
// it on its own headless X server (agent.py) and ffmpeg encodes that display; a
// Windows host runs it through afterglow, phosphorus's own fork of Apollo installed
// with it, over one loopback link. afterglow is its own repo's
// (github.com/pmghartman/afterglow, @phosphorus/afterglow), a source the session
// drives like XSource. Either way the frames go to the viewer's VideoDecoder over the
// socket as they come

export { ffmpegArgs, missing, parseCaps, shq } from "./encode.ts";
export { parseExec } from "./exec.ts";
export { codecOf, FlvReader } from "./flv.ts";
export { keycodeOf, keysymOf } from "./keys.ts";
export { localRunner } from "./local.ts";
export { appCount, busy, find, launch, lingerMs, list, reapApps } from "./registry.ts";
export { relayFrames } from "./relay.ts";
export {
  AppSession,
  type Chan,
  HeadLen,
  MsgConfig,
  MsgFrame,
  type Opened,
  type Runner,
  type Sink,
  type Source,
  type Start,
  type Video,
  type VideoSink,
  type Viewer,
} from "./session.ts";
export { caps, XSource } from "./xsource.ts";
