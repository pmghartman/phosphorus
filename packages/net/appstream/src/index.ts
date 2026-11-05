// app streaming: one GUI app on a host as a window in the browser, through afterglow
// (github.com/pmghartman/afterglow, @phosphorus/afterglow), phosphorus's streaming host
// installed with each release. A Linux host runs it over ssh as the viewer's login
// (`afterglow --stdio`, linuxsource.ts), or, where afterglow isn't installed, runs the
// app on its own headless X server (agent.py) for ffmpeg to encode; a Windows host's
// phosphorus drives its afterglow over one loopback link. Either way the frames go to
// the viewer's VideoDecoder over the socket as they come

export { ffmpegArgs, missing, parseCaps, shq } from "./encode.ts";
export { parseExec } from "./exec.ts";
export { codecOf, FlvReader } from "./flv.ts";
export { keycodeOf, keysymOf } from "./keys.ts";
export { afterglowCmd, chanTransport, LinuxSource } from "./linuxsource.ts";
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
