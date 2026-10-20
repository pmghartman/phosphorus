# Git

The mesh's Forgejo: replication, repos, issues, pull requests, releases, clone and push.

1. `git` for the master and replicas, how far behind, reachable.
2. API as the user with `forgejo` under `/api/v1`: `GET /repos/search?limit=50`, `/repos/{owner}/{repo}`, `/issues`, `/pulls`, `/releases`, `/contents/{path}`. Writes (`POST`, `PATCH`, `DELETE`) only as the user asks; `body` is an object.
3. Clone, fetch, push: `terminal_run` `git: true` on the host that needs the checkout, with the repo's `clone_url`.
4. Master down and the user asks: `make_git_master` on the most current reachable replica, once.
5. No Forgejo login saved: say so; the user saves the `git` page login in Phosphorus.
