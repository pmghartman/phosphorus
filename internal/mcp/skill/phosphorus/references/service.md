# Services

Publishes, changes, removes or checks a web service or game server, and calls a service's API.

- Read first, in parallel: `services`, `host_config` on the host.
- Publish or change: `service_edit` `host`, `name` (lowercase, digits, -), `fields` (web: `port`, `scheme` http|https, `mode` path|subdomain, `base_path`, `public`; game: `type: game`, `port`, `start`, `stop`). `dry_run: true` first, show the diff, then for real once the user agrees. `public: "true"` puts it on the internet; only when asked.
- Remove: `service_edit` `remove: true`, dry run first.
- Verify: `service_health` until it listens and is published, then the URL from `services`.
- Game: `game_power` `start` or `stop`, then `host_logs` `source: game:<name>`.
- API: `service_request` `service`, `path`, `method`, `body`; `headers` for the service's own token only when the user gave one.
