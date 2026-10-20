---
name: mesh-service
description: Publishes, changes, removes or checks a web service or game server on the Phosphorus mesh, and calls a service's API. Use for "publish X", "expose port N on <host>", "make X public", "remove the X service", "start the minecraft server", "call X's API".
argument-hint: "<host> <service> [what to do]"
---

Services: `$ARGUMENTS`.

- Read first, in parallel: `services`, `host_config` on the host.
- Publish or change: `service_edit` `host`, `name` (lowercase, digits, -), `fields` (web: `port`, `scheme` http|https, `mode` path|subdomain, `base_path`, `public`; game: `type: game`, `port`, `start`, `stop`). Run with `dry_run: true`, show the diff, then for real once the user agrees. `public: "true"` puts it on the internet; set it only when asked.
- Remove: `service_edit` `remove: true`, dry run first.
- Verify: `service_health` until it listens and is published, then give the URL from `services`.
- Game: `game_power` `start` or `stop`; follow with `host_logs` `source: game:<name>`.
- API call: `service_request` `service`, `path`, `method`, `body`, `headers` for the service's own token when the user gave one.
