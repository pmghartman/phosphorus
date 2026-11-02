# Services

Publishes, changes, removes or checks a web service or game server, and calls a service's API.

Each host publishes on its own the web pages it finds listening (`# found by phosphorus` in its `services.export`, port alone, behind the phosphorus login); a section removed stays removed. With `*.<domain>` routed through the tunnel (wildcard `up` in `mesh_hosts` `health: true`) a service with no `mode` gets `<name>.<domain>`, or a path when another host already has that name. Most requests need no edit at all: check `services` first.

- Read first, in parallel: `services`, `host_config` on the host.
- Publish or change: `service_edit` `host`, `name` (lowercase, digits, -), `fields` (web: `port`, `scheme` http|https, `mode` path|subdomain, `base_path`, `public`; leave `scheme` and `mode` out unless the user asks: the scheme is sniffed and the mode is a subdomain once `*.<domain>` reaches the mesh; set `mode` only to keep a service on a path; game: `type: game`, `port`, `start`, `stop`). `dry_run: true` first, show the diff, then for real once the user agrees. `public: "true"` puts it on the internet; only when asked.
- Remove: `service_edit` `remove: true`, dry run first.
- Verify: `services` `host` `name` until it listens and is published, then the URL from `services`.
- Game: `game_power` `start` or `stop`, then `host_logs` `source: game:<name>`.
- API: `service_request` `service`, `path`, `method`, `body`; `headers` for the service's own token only when the user gave one.
