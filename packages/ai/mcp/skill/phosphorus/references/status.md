# Mesh status

One-screen health of the whole mesh, or of one host when named. Change nothing.

1. In one parallel batch: `mesh_hosts` `health: true`, `host_stats` with no host, `services`, `stacks`, `update_status`.
2. A host named, or one flagged below: `host_stats` on it and `host_logs` on it with `level: error`, `since: 1h`, `lines: 50`.

Report a compact table: host, answering, version, rtt ms, edge, cpu, mem, disk. Under it, one line for each thing wrong: a host down or on another version (an Intel Mac stays on the last release built for it), disk over 85%, memory over 90%, swap over 50%, an edge host whose dns or https isn't serving (`edge` says why), an installed service whose active copy isn't running or healthy, or a copy with an error, an update running or failed. End with the next step for each.
