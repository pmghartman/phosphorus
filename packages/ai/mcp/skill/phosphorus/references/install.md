# Installed services and apps

Installs, updates, moves or removes a service from the wizard, or one of phosphorus's optional apps.

A wizard service is a Docker Compose stack an admin installs onto one host (its active) and any standbys, which keep a copy of its data and take over when it goes down. Its page is published as `<id>.<domain>` (plus its aliases). Data lives in `<phosphorus>/stacks/<id>/data` on each copy's host.

- Read first, in parallel: `stacks`, `mesh_hosts`.
- Find it: `stack_catalog` `q`, then with `source` and `ref` for its page: env fields, web port, data, and the check (`verdict`, why each host fits or not).
- Install: `stack_catalog` with `env` to check the values, then `stack_control` `install` with `source`, `ref`, `active`, `standbys`, `env`. Blank secret fields are generated; never invent a password. Follow `stacks` until the active copy is running and healthy, then `services` for its URL.
- Update: `stack_control` `update` `id`. Remove: `remove` `id`; data is kept unless the user says to delete it (`keep_data: false`, which can't be undone).
- Failover: `standbys` sets the hosts keeping a copy; `move` `to` a standby hands it over on purpose.
- Bringing in data from an old install: stop the old one, copy its data into the stack's data folder on the active host with `terminal_run` before installing (a removed stack's data stays there for a reinstall), then install.
- Optional apps (Code, Chat, Viewer, Games): `apps` lists them; `app_control` `install` or `remove` by id, every host following.

Each of `stack_control` and `app_control` needs the user's word for that service and host.
