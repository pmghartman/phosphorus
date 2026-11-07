# Mesh update

Checks, starts, follows, retries or cancels a mesh update.

1. `update_status` `history: true` and `mesh_hosts` `health: true` in parallel.
2. Status: what runs, who started it, each host's step and result; the last finished update and its errors.
3. Only on the user's explicit word: `update_control` `start` (admin); retry with `start` and `hosts` set to the ones that failed; `cancel`. Never start one while one runs.
4. Follow with `update_status` every 15 to 30 s until done or failed, reporting each host's change briefly. Done: `mesh_hosts` `health: true` shows every host's version.
5. A host failed: quote its error. `couldn't fetch wintun` means a Windows host's download of the tunnel's pinned driver (from wintun.net) failed; the host keeps running, and a retry with `hosts` set to it fetches again. An Intel Mac stays on the last release built for it: report it as left behind, never retry it.
