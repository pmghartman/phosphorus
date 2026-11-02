# Services

Publishes, changes, removes or checks a web service or game server, and calls a service's API.

Each host finds the web pages listening on it and offers them for an admin to publish (apps' discovered); publishing one writes its port alone into the host's `services.export`, behind the phosphorus login; a section removed stays removed. With `*.<domain>` routed through the tunnel (wildcard `up` in `mesh_hosts` `health: true`) a service gets `<name>.<domain>`, or a path when another host already has that name. Check `services` first.

- Read first, in parallel: `services`, `host_config` on the host.
- Publish or change: `service_edit` `host`, `name` (lowercase, digits, -), `fields` (web: `port`, `scheme` http|https, `max_body` such as 50MB, `public`; leave `scheme` out unless the user asks: it is sniffed; game: `type: game`, `port`, `start`, `stop`). `dry_run: true` first, show the diff, then for real once the user agrees. `public: "true"` puts it on the internet; only when asked.
- Remove: `service_edit` `remove: true`, dry run first.
- Verify: `services` `host` `name` until it listens and is published, then the URL from `services`.
- Game: `game_power` `start` or `stop`, then `host_logs` `source: game:<name>`.
- API: `service_request` `service`, `path`, `method`, `body`; `headers` for the service's own token only when the user gave one.
