# Mesh status

One-screen health report of the whole Phosphorus mesh, or of one host when named. Use for "mesh status", "is everything up", "how's the mesh", "check on <host>".

1. In parallel: `mesh_hosts`, `mesh_health`, `services`, `update_status`, `git`.
2. With a host named: also `host_stats` on it and `host_logs` on it with `level: error`, `since: 1h`, `lines: 50`.
3. Without one: `host_stats` in parallel on every phosphorus host that answers.

Report as a compact table: host, answering, version, rtt ms, tunnel, cpu, memory, disk. Under it, one line each for anything wrong: a host down or on a different version, disk over 85%, memory over 90%, a tunnel down on a host that has one, a git replica behind or unreachable, an update running, paused or failed. End with the next step for each problem. Change nothing.
