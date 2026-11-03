# Git

The mesh's Forgejo, installed from the services tab as the service `git` (another name: pass it as `service`): repos, issues, pull requests, releases, clone and push.

1. Where it runs and whether it's well: `services` with host and name, or `mesh_hosts`; its standbys take over by themselves.
2. API as the user with `forgejo` under `/api/v1`: `GET /repos/search?limit=50`, `/repos/{owner}/{repo}`, `/issues`, `/pulls`, `/releases`, `/contents/{path}`. Writes (`POST`, `PATCH`, `DELETE`) only as the user asks; `body` is an object.
3. Clone, fetch, push: `terminal_run` `git: true` on the host that needs the checkout, with the repo's `clone_url`.
4. Not installed: say so; an admin installs Forgejo from the services tab.
5. No Forgejo login saved: say so; the user saves the `git` page login in Phosphorus.
