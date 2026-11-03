// the installed services: each a compose project the mesh wants (etc/stacks/<id>.json,
// @phosphorus/wire StackWant), every host bringing its copy to it. The active host
// runs it, standbys hold its images and a copy of its data; failover (./ha) moves
// the active role. This file is the seam between the runtime and failover.

export { idRe, wantRel } from "./ids.ts";

// what failover asks of this host's runtime for one stack
export interface Runtime {
  // <phosphorus>/stacks/<id>/data: what standbys copy
  dataDir(id: string): string;
  // compose up as the active copy, its page published
  up(id: string): Promise<void>;
  // compose stopped and its page withdrawn, the project and data kept
  down(id: string): Promise<void>;
  running(id: string): Promise<boolean>;
  // the want's gen this host's project was last rendered and pulled from, 0 none
  gen(id: string): Promise<number>;
  // the manifest's backup hooks, around a copy of the data
  hook(id: string, phase: "pre" | "post"): Promise<void>;
}

export { arch, detect as detectDocker, dockerInfo } from "./docker.ts";
export { dirOf, logFile, reset, roleOf, runtime, Start, statuses, tick } from "./reconcile.ts";
export { type Ctx, envText, interp, parsePort, quote, type Rendered, render } from "./render.ts";
export { type Publish, seams } from "./seams.ts";
export {
  AskDocker,
  defOf,
  fillEnv,
  Install,
  ids,
  keepDataOf,
  opened,
  Remove,
  removedRel,
  seal,
  Update,
  unseal,
  viewOf,
  views,
  wantOf,
} from "./want.ts";
