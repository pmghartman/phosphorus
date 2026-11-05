// app streaming: one GUI app on a host as a window in the browser. A Linux host runs
// it on its own headless X server (agent.py) and ffmpeg encodes that display; a
// Windows host runs it through afterglow (afterglow/), phosphorus's own fork of
// Apollo installed with it, over one loopback link; or, for a host's own Sunshine
// or Apollo entries, through glow (glow/), phosphorus's GameStream client. Either way
// the frames go to the viewer's VideoDecoder over the socket as they come

export { linkFile, linkOf } from "./afterglow/host.ts";
export {
  configOf,
  frameOf,
  In,
  Link,
  type LinkAddr,
  LinkReader,
  message as linkMessage,
  Out,
} from "./afterglow/link.ts";
export { AfterglowSource, type AfterglowTarget } from "./afterglow/source.ts";

export { ffmpegArgs, missing, parseCaps, shq } from "./encode.ts";
export { parseExec } from "./exec.ts";
export { codecOf, FlvReader } from "./flv.ts";
export { type Identity, makeIdentity, signatureOf } from "./glow/cert.ts";
export {
  addClient,
  addLauncher,
  filesOf,
  GlowHost,
  launcherName,
  type Platform,
  parseConf,
  unixLike,
  windows,
} from "./glow/host.ts";
export { InputPacker } from "./glow/input.ts";
export { confOf, type Instance, startInstance } from "./glow/instance.ts";
export { type App, apps as hostApps, cancel, type Host, pair, serverInfo } from "./glow/lumen.ts";
export { avccOf, Depacketizer, nalsOf } from "./glow/photon.ts";
export { GlowSource, type GlowTarget } from "./glow/source.ts";
export { pack, Sealer } from "./glow/spark.ts";
export { asText, utf8Chunks, vkOf } from "./glow/vk.ts";
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
