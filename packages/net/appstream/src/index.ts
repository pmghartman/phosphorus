// app streaming: one GUI app on a host as a window in the browser. A Linux host runs
// the app on its own headless X server (agent.js, run by its phosphorus over ssh as the
// viewer's login) and sends the pixels as the rectangles that change, no video, ffmpeg
// encoding video only while the picture keeps moving; where it has no phosphorus, afterglow
// (github.com/pmghartman/afterglow, @phosphorus/afterglow) streams it as video. A
// Windows host's phosphorus drives its afterglow over one loopback link, video too.
// Either way it goes to the viewer over the socket as it comes

export { bunPaths, ffmpegArgs, missing, parseCaps, shq } from "./encode.ts";
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
  type Mode,
  MsgConfig,
  MsgFrame,
  MsgRect,
  MsgSize,
  type Opened,
  type PixelSink,
  pixelTuning,
  RectDeflated,
  RectHead,
  RectMSBFirst,
  type Runner,
  type Sink,
  type Source,
  type Start,
  type Video,
  type VideoSink,
  type Viewer,
} from "./session.ts";
export { AgentReader, agentCmd, caps, XSource } from "./xsource.ts";
