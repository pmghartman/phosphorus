# Diagnose

Root-causes a broken or slow host, service, container or game server on the Phosphorus mesh from its health, stats and logs. Use for "X is down", "X is slow", "why did X stop", "X won't load", "errors on X".

1. Resolve the target: `mesh_hosts` and `services` in parallel. A service name gives its host; a container name needs `containers` on the likely hosts. Ask only if it stays ambiguous.
2. Gather in parallel, as they apply:
   - host: `mesh_health`, `host_stats`, `host_logs` `level: warn` `since: 2h`
   - service: `service_health`, `host_config` (its `[service]` block), `host_logs` `source: container:<name>` or `match: <name>`
   - container: `containers`, `host_logs` `source: container:<name>` `lines: 300`
   - game: `services`, `host_logs` `source: game:<name>`
   - tunnel or public URL: `host_logs` `source: cloudflared` `since: 2h`
3. Narrow with more `host_logs` (`match` on the first error, an earlier `since`), or a read-only `terminal_run` (`systemctl status`, `ss -ltnp`, `docker inspect`, `journalctl -u ...`).
4. Report: cause, the evidence lines verbatim, the fix. Apply a fix (`container_control`, `service_edit`, `config_set`, `host_power`) only when the user says so, `dry_run` first where it exists, then verify with `service_health` or `host_stats`.
