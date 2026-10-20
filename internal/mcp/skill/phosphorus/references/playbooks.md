# Playbooks

Tool names are the Phosphorus connector's. Run independent reads in parallel.

## A host is slow or full

1. `host_stats` on it: cpu, memory, disk, gpu, top processes, containers.
2. Disk over 90%: `terminal_run` `df -h; du -xh --max-depth=2 / 2>/dev/null | sort -h | tail -20` (Linux) and report the largest paths.
3. A runaway process or container: `host_logs` with `source: container:<name>` or `match` on its name, `since: 1h`.
4. Propose the fix; restart a container with `container_control` only on the user's word.

## A service is down

1. `services` to find its host and name; `service_health` on it.
2. Not listening: `containers` (if it's dockerized) and `host_logs` `source: container:<name>` `level: error` `since: 2h`.
3. Listening but not published: `host_config`, check its `[service]` block; fix with `service_edit` `dry_run: true` first.
4. Tunnel side: `mesh_health` tunnel state and `host_logs` `source: cloudflared`.
5. After any fix, `service_health` again and report the new status.

## A host doesn't answer

1. `mesh_health`: unreachable from here, or answering with errors.
2. `mesh_hosts`: is it on the tailnet at all (online, last seen).
3. From another host: `terminal_run` `tailscale ping -c 3 <host>`.
4. Answering but broken: `host_logs` on it `source: phosphorus` `level: error` `since: 30m`.
5. `host_power` `restart` restarts phosphorus only; `reboot` the machine. Both need the user's word and `confirm: <host>`.

## Move data between hosts

`files_copy` `from: {host, share, path}` `to: {host, share, path}`. Folders copy whole; `move: true` deletes the source after the copy lands. An existing file at `to` is replaced, so `files_stat` the target first.

## Run a job on a host

- Short: `terminal_run` `command`. Check the exit code.
- Long: `terminal_run` `nohup cmd > /tmp/job.log 2>&1 & echo $!`, then poll `tail -n 50 /tmp/job.log; kill -0 <pid> && echo running`.
- Write a file the share doesn't reach: `terminal_run` `command: "cat > /etc/thing.conf"` with `stdin`.
- Watch with the user: `open_terminal`, then `terminal_run` `mode: tab` or `terminal_type` (they press Enter), `terminal_screen` `wait_s` to follow.

## Models

`models` for the chimp (chat) and orangutan (projects) roles as chosen and as answering, providers, and model hosts' state. `set_model_role` `role`, `model: provider/model` or `phosphorus/<host>`, admin only. `projects` follows the orangutan's long work.
