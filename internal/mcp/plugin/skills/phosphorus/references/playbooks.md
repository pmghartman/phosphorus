# Playbooks

Tool names are the phosphorus MCP server's. Run independent reads in parallel.

## Mesh overview

1. `mesh_hosts`, `mesh_health`, `services`, `update_status` in parallel.
2. Per host: answering, version, rtt, tunnel state. Flag any host on a different version, not answering, tunnel down, or an update paused or failed.
3. Offer the next step for each flag (diagnose, update retry), never take it unasked.

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

## Publish a web service

1. `host_config` on the host: existing services, ports in use.
2. `service_edit` `name`, `fields: {"port":"8096","scheme":"http","mode":"subdomain"}`, `dry_run: true`. Add `"public":"true"` only when asked; public means reachable from the internet past the tailnet.
3. Show the diff, then the same call without `dry_run`.
4. `service_health` until listening and published, then `services` for its URL.

Game server: `fields: {"type":"game","port":"25565","start":"...","stop":"..."}`; `game_power` runs exactly those.

## Find and change a file

1. `files_search` `query` (names) or `content: true` with `glob` to narrow. No host searches every host.
2. `files_read` the hit, paging with `from` while there's more.
3. `files_write` with `old` (an exact passage found once) and `new`. Whole file `text` only for new files or full rewrites.
4. `open: true` or `open_file` puts it in front of the user; `show_file` invites someone else.

## Move data between hosts

`files_copy` `from: {host, share, path}` `to: {host, share, path}`. Folders copy whole; `move: true` deletes the source after the copy lands. An existing file at `to` is replaced, so `files_stat` the target first.

## Run a job on a host

- Short: `terminal_run` `command`. Check the exit code.
- Long: `terminal_run` `nohup cmd > /tmp/job.log 2>&1 & echo $!`, then poll `tail -n 50 /tmp/job.log; kill -0 <pid> && echo running`.
- Write a file the share doesn't reach: `terminal_run` `command: "cat > /etc/thing.conf"` with `stdin`.
- Watch with the user: `open_terminal`, then `terminal_run` `mode: tab` or `terminal_type` (they press Enter), `terminal_screen` `wait_s` to follow.

## Git work

1. `git`: which host is the Forgejo master and whether replicas are current.
2. `forgejo` `GET /user`, `GET /repos/search?q=<name>`, `GET /repos/{owner}/{repo}` for `clone_url`.
3. Clone or push: `terminal_run` `git: true` `command: "git clone <clone_url> /tmp/repo"`.
4. Issues, PRs, reviews, releases: `forgejo` under `/api/v1` with `body` as an object.
5. Master down: `make_git_master` on the healthiest replica, once, on the user's word.

## Mesh update

1. `update_status`; nothing running, `update_history` for the last result.
2. `update_control` `start` (admin). Follow with `update_status` every 15 to 30 s.
3. Paused: report why, `continue` on the user's word. Failed hosts: `update_control` `start` `hosts: [...]` retries just those.
4. After: `mesh_health` shows every host on the new version.

## Chat

- Read: `chat_history` `channel: mesh` or `dm:<name>`, keep the last line's `ms`.
- Send: `send_message` `text` (markdown), `to` for a direct message. It posts as the user.
- Wait for a reply: `chat_wait` `channel`, `since: <ms>`, `wait_s` up to 300; loop until it lands or the user stops.
- Fix a line: `chat_edit` with its `ref`.

## Models

`models` for the chimp (chat) and orangutan (projects) roles as chosen and as answering, providers, and model hosts' state. `set_model_role` `role`, `model: provider/model` or `phosphorus/<host>`, admin only. `projects` follows the orangutan's long work.
