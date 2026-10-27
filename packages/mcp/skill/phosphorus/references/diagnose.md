# Diagnose

Root-causes a broken, slow, full or silent host, service or game server from its health, stats and logs.

1. Resolve the target from `mesh_hosts` and `services`, in parallel. Ask only if it stays ambiguous.
2. Gather in parallel, as they apply:
   - host slow or full: `host_stats` on it (cpu, memory, disk with percents, parts, top processes), `host_logs` `level: warn` `since: 2h`
   - host not answering: `mesh_hosts` `health: true` (answering? still on the tailnet?), then from another host `terminal_run` `tailscale ping -c 3 <host>`
   - service: `services` `host` `name`, `host_config` (its `[service]` block), `host_logs` `match: <name>` `since: 2h`
   - game: `services`, `host_logs` `source: game:<name>`
   - tunnel or public URL: `mesh_hosts` `health: true` tunnel state, `host_logs` `source: cloudflared` `since: 2h`
   - git: `git`, `host_logs` `source: git`
3. Narrow with more `host_logs` (`match` on the first error, an earlier `since`) or a read-only `terminal_run`: `systemctl status`, `ss -ltnp`, `journalctl -u ...`, and for a full Linux disk `df -h; du -xh --max-depth=2 / 2>/dev/null | sort -h | tail -20`.
4. Confirm a past error still matters before calling it the cause: a later success line, or the current `git`, `services` check or `mesh_hosts` health.
5. Report the cause, the evidence lines verbatim, and the fix. Apply one (`service_edit`, `config_set`, `host_power` `restart` for phosphorus or `reboot` for the machine) only on the user's word, `dry_run` first where it exists, then verify with a `services` check or `host_stats`.
