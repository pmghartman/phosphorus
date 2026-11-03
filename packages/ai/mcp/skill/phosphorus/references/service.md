# Services

Publishes, changes, removes or checks a web service, calls a service's API, and starts or stops a game server.

Each host finds the web pages listening on it and offers them for an admin to publish (apps' discovered); publishing one writes its port alone as the host's record in the mesh's store, behind the phosphorus login; a record removed stays removed. An installed service's page comes from the wizard (`stacks`, `stack_control`), not `service_edit`. With `*.<domain>` routed through the tunnel (wildcard `up` in `mesh_hosts` `health: true`) a service gets `<name>.<domain>`, or a path when another host already has that name. Check `services` first.

- Read first, in parallel: `services`, `host_config` on the host.
- Publish or change: `service_edit` `host`, `name` (lowercase, digits, -), `fields` (`port`, `scheme` http|https, `max_body` such as 50MB, `public`, `aliases`; leave `scheme` out unless the user asks: it is sniffed). `dry_run: true` first, show the diff, then for real once the user agrees. `public: "true"` puts it on the internet; only when asked.
- Remove: `service_edit` `remove: true`, dry run first.
- Verify: `services` `host` `name` until it listens and is published, then the URL from `services`.
- Game (the Games app installed; its page says which games exist): `games` to find it, `game_power` `start` or `stop`, then `game_log` if it doesn't come up.
- API: `service_request` `service`, `path`, `method`, `body`; `headers` for the service's own token only when the user gave one.
