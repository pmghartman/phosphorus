# Mesh status

One-screen health of the whole mesh, or of one host when named. Change nothing.

1. In one parallel batch: `mesh_health`, `host_stats` with no host, `services`, `update_status`, `git`.
2. A host named, or one flagged below: `host_stats` on it and `host_logs` on it with `level: error`, `since: 1h`, `lines: 50`.

Report a compact table: host, answering, version, rtt ms, tunnel, cpu, mem, disk. Under it, one line for each thing wrong: a host down or on another version, disk over 85%, memory over 90%, swap over 50%, a tunnel down on a host that has one, a git replica behind or unreachable, an update running, paused or failed. End with the next step for each.
