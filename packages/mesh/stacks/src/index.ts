// the installed services: each a compose project the mesh wants (etc/stacks/<id>.json,
// @phosphorus/wire StackWant), every host bringing its copy to it. The active host
// runs it, standbys hold its images and a copy of its data; failover (./ha) moves
// the active role. This file is the seam between the runtime and failover.

// where a stack's want lives in the mesh's store
export const wantRel = (id: string) => `etc/stacks/${id}.json`;

// a stack's id: the compose project (phos-<id>), its folder and its route name
export const idRe = /^[a-z][a-z0-9-]{0,39}$/;

// what failover asks of this host's runtime for one stack
export interface Runtime {
  // <phosphorus>/stacks/<id>/data: what standbys copy
  dataDir(id: string): string;
  // compose up as the active copy, its page published
  up(id: string): Promise<void>;
  // compose stopped and its page withdrawn, the project and data kept
  down(id: string): Promise<void>;
  running(id: string): Promise<boolean>;
  // the manifest's backup hooks, around a copy of the data
  hook(id: string, phase: "pre" | "post"): Promise<void>;
}
