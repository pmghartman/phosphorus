---
name: phosphorus
description: "Operates the user's live, self-hosted Phosphorus mesh through the Phosphorus connector's tools. Use whenever the user names phosphorus or the mesh, one of its hosts, or asks about their own servers, homelab or tailnet, even without saying \"phosphorus\": a host up, down, slow or full; services or game servers on the mesh; files in mesh shares; running a command on a host; host logs; the mesh's Forgejo; the mesh chat; its models and agents; a mesh update. Not for editing or building the phosphorus source code itself."
---

# Phosphorus

Phosphorus is a mesh of the user's own machines on one tailnet. Each machine running it is a **host**: it shares folders, publishes web services and game servers, runs terminals, keeps logs, and may carry a Forgejo replica or a model. The Phosphorus connector answers for the whole mesh from any host, and every call runs as the user who signed it in, with exactly that user's rights; the connector's instructions name them and whether they're an admin. Tool names may carry a prefix (`mcp__phosphorus__`, `Phosphorus:`); each tool's own description is its full reference, so this skill covers only how to combine them.

No Phosphorus tools at all, or the connector needs authentication: tell the user to run `/mcp`, pick phosphorus and sign in with their mesh login, and stop. The connector's instructions say what this key can do: admin or not, its saved host logins, its forgejo login and the tools kept off it. Never offer those; say who could.

## Job files

Read the one that fits before the first call; a one-tool question needs none.

| request | file |
|---|---|
| how's the mesh, is everything up, check a host | `references/status.md` |
| something down, slow, full, failing or silent | `references/diagnose.md` |
| run a command or script on a host or every host | `references/run.md` |
| find, read, edit, copy, move or organize files | `references/files.md` |
| publish, change, remove or check a service or game server, call its API | `references/service.md` |
| update the mesh, follow, retry or cancel an update | `references/update.md` |
| read or post chat, message someone, wait for a reply | `references/chat.md` |
| Forgejo repos, issues, PRs, clone or push, replication | `references/git.md` |

## Rules

- **Mesh things go through Phosphorus.** Hosts, shares, services, terminals, logs, Forgejo and chat are read and changed only with Phosphorus tools; "files" means mesh shares and "chat" the mesh chat unless the user says otherwise. Other connectors stay free for their own part (mail a summary, save a report).
- **Real host names only.** Take them from `mesh_hosts`, once per session; never guess or shorten one. A device with `phosphorus: false` can't be acted on: say so.
- **Batch and go narrow.** Load the tools a job needs in one tool search, run independent reads in one parallel batch. Prefer the cheap call: `host_stats` with no host before one host, `files_list` `stat: true` before `files_read`, `files_search` over walking `files_list`, a `services` check over curl in `terminal_run`, `host_logs` filtered by `level`, `match`, `since`.
- **Read before writing.** `host_config` before `config_set` or `service_edit`; read the passage before `files_write` with old/new; `update_status` before `update_control`.
- **Changes need the user's word for that target.** `host_power`, `files_change` delete, `files_copy` move, `config_set`, `service_edit`, `update_control`, `make_git_master`, `game_power`, and any `terminal_run` that changes a machine. Use `dry_run` first where it exists and show the diff. `host_power` takes `confirm` equal to the host name; never press `make_git_master` twice.
- **No secrets.** Never ask for, take or type a password, key or token. `terminal_run` and `forgejo` use the user's saved logins; a missing login is a finding to report, not a prompt.
- **Writes are audited** in `audit_log`. Report what changed, where, and how to undo it.

## Not covered by a job file

- Models: `models` shows which mesh host's model each agent (code, claude-code, opencode, and tavern while the tavern app is on the mesh) is assigned and answering with; `set_agent_model` assigns one (admin).
- The user's own Phosphorus window: `open_file` opens a share's file in a editor tab, `show_file` invites someone else into one, `open_terminal` opens a shared terminal tab.

## Errors

Failed calls return `code: message`.

- `bad_input`: fix the arguments from the message; never retry unchanged.
- `not_found`: re-list (`mesh_hosts`, `services`, `files_list`, `people`) instead of guessing.
- `forbidden`: the key lacks the right (share perm, admin, saved login); say so and stop.
- `unreachable`: the host is down or off the tailnet; check `mesh_hosts` `health: true`, and `host_logs` on another host.
- `key refused` (HTTP 401): the sign-in was revoked, voided by a password change or is a year old; the user signs in again from `/mcp`.

## Reporting

Lead with the answer. Name hosts, services and paths exactly as phosphorus does. A change: what, where, before and after, how to undo. A diagnosis: the evidence lines verbatim, the cause, the fix taken or proposed.

The mesh is at https://${user_config.domain}.
