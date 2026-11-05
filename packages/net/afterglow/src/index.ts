// @phosphorus/afterglow: a host's native apps streamed to a viewer as low-latency H.264.
// AfterglowSource drives afterglow (its own repo, Windows and Linux) over one loopback
// link, afterglow's docs/protocol.md the contract and protoRange the versions spoken,
// and keeps the contract a driver expects of a source (source.ts)

export {
  type AfterglowPaths,
  appsText,
  confText,
  driverVer,
  linkPort,
  linkText,
  pathsOf,
  readLink,
  svcBinPath,
  tokenOf,
  unitText,
} from "./afterglow/config.ts";
export { asText, InputPacker, modOf, pack, vkOf } from "./afterglow/input.ts";
export {
  allAfterglow,
  exeName,
  type Installed,
  pickAfterglow,
  readInstalled,
  releaseDir,
  updatesDir,
  versionCmp,
} from "./afterglow/install.ts";
export {
  configOf,
  cursorOf,
  type Ended,
  type EndOpts,
  frameOf,
  In,
  jsonOf,
  Link,
  type LinkAddr,
  type LinkEvents,
  LinkReader,
  maxLen,
  message as linkMessage,
  Out,
  type Proc,
  type Ready,
  type Transport,
} from "./afterglow/link.ts";
export { protoOf, protoOfFeatures, protoOK, protoRange, protoWhy } from "./afterglow/proto.ts";
export { AfterglowSource, type AfterglowTarget } from "./afterglow/source.ts";

export { FrameRoom, type Opened, type Sink, type Source, type Start, type Video, type VideoSink } from "./source.ts";
