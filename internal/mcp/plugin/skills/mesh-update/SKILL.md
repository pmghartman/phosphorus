---
name: mesh-update
description: Checks, starts, follows, continues, retries or cancels a Phosphorus mesh update. Use for "update the mesh", "update phosphorus", "is the update done", "retry the failed hosts", "cancel the update".
argument-hint: "[status | start | continue | cancel | retry]"
---

Mesh update: `$ARGUMENTS` (blank means status).

1. `update_status` and `update_history` in parallel, plus `mesh_health` for versions.
2. `status`: what runs, who started it, each host's step and result; the last finished update and any errors.
3. `start` (admin key): `update_control` `start`. `retry`: `update_control` `start` `hosts` set to the hosts that failed last time. `continue` or `cancel`: `update_control` with that action. Act only on the user's explicit word; an update already running is never started again.
4. Follow: `update_status` every 15 to 30 s until done, paused or failed. Report each host's change as it happens, briefly.
5. Done: `mesh_health` to confirm every host's version.
