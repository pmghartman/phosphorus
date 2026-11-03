// where a stack's want lives in the mesh's store
export const wantRel = (id: string) => `etc/stacks/${id}.json`;

// a stack's id: the compose project (phos-<id>), its folder and its route name
export const idRe = /^[a-z][a-z0-9-]{0,39}$/;
