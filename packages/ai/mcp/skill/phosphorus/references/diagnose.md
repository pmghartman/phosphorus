# Diagnose

Root-causes a broken, slow, full or silent host, service or game server from its health, stats and logs.

1. Resolve the target from `mesh_hosts` and `services`, in parallel. Ask only if it stays ambiguous.
2. Gather in parallel, as they apply:
   - host slow or full: `host_stats` on it (cpu, memory, disk with percents, parts, top processes), `host_logs` `level: warn` `since: 2h`
   - host not answering: `mesh_hosts` `health: true` (answering? its tunnel up?), then `host_logs` `source: net` `since: 2h` on it and on the control host, the hub every host reaches the mesh through
   - service: `services` `host` `name`, `host_config` (its entry in `services`), `host_logs` `match: <name>` `since: 2h`
   - game (the Games app installed): `games`, `game_log`
   - the mesh's tunnel down or waiting: `host_logs` `source: net` `since: 2h` says on what (the hub's answer, the tunnel device); a host whose UDP never reaches the hub on port 41641 falls back to the relay over https at the mesh's domain; on Windows the tunnel's driver, wintun, is fetched into `state/cache/tools`, and a `couldn't fetch` line clears with `host_power` `restart` once the host reaches wintun.net
   - the domain or a public URL: `mesh_hosts` `health: true` `edge` on each edge host (its dns, https and public ports), `host_logs` `match: edge` `since: 2h` there; a domain still pointing elsewhere is fixed at the registrar with the nameservers settings › network shows, a certificate not issued waits on that delegation
   - the hub (settings › network): `mesh_hosts` `health: true` `control` (`url` the mesh's domain, `host` the hub's, `serving` on it), `host_logs` `source: net` `since: 2h` there; a host off the mesh joins again with a new `MESH_KEY` in its `.env` on its next start
   - git (Forgejo): `services` with host and name `git`, `host_logs` `match: git` `since: 2h`
3. Narrow with more `host_logs` (`match` on the first error, an earlier `since`) or a read-only `terminal_run`: `systemctl status`, `ss -ltnp`, `journalctl -u ...`, and for a full Linux disk `df -h; du -xh --max-depth=2 / 2>/dev/null | sort -h | tail -20`.
4. Confirm a past error still matters before calling it the cause: a later success line, or the current `services` check or `mesh_hosts` health.
5. Report the cause, the evidence lines verbatim, and the fix. Apply one (`service_edit`, `config_set`, `host_power` `restart` for phosphorus or `reboot` for the machine) only on the user's word, `dry_run` first where it exists, then verify with a `services` check or `host_stats`.
