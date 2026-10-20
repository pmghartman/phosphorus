---
name: phosphorus
description: Operates the user's self-hosted Phosphorus mesh through the Phosphorus connector's tools. Use when the user names phosphorus or the mesh, one of its hosts by name, or asks about their own servers, homelab or tailnet: hosts up or slow, services and game servers on the mesh, files in mesh shares, terminals or commands on a host, host logs, the mesh's forgejo, the mesh chat, its models (chimp, orangutan) or projects, or a mesh update.
---

# Phosphorus

Phosphorus is a mesh of the user's own machines on one tailnet. Every machine running phosphorus is a **host**: it shares folders, publishes web services and game servers, runs terminals, keeps logs, and may carry a Forgejo replica or a model. The Phosphorus connector (an MCP server, named phosphorus or Phosphorus) answers for the whole mesh from any host; every call is made as **{{USER}}**{{ADMIN_NOTE}}, with exactly that user's rights. Its tools may show with a prefix (`mcp__phosphorus__`, `Phosphorus:`); the bare names below are the same tools, and each one's own description is its full reference. No Phosphorus tools at all: tell the user to add the connector with the url from **copy mcp url** in the agent tray, and stop.

Read the one job file that fits before the first call; a plain one-tool question needs none:

| request | file |
|---|---|
| how's the mesh, is everything up, check on a host | `references/status.md` |
| something down, slow, full, failing, erroring or not answering | `references/diagnose.md` |
| run a command or script on a host or every host, long jobs | `references/run.md` |
| find, read, edit, copy, move or organize files | `references/files.md` |
| publish, change, remove or check a service or game server, call its API | `references/service.md` |
| update the mesh, follow, retry or cancel an update | `references/update.md` |
| read or post chat, message someone, wait for a reply | `references/chat.md` |
| forgejo, repos, issues, pull requests, clone or push, replication | `references/git.md` |

## Ground rules

- Scope: the mesh is the Phosphorus connector's alone. Its hosts, shares, services, terminals, logs, Forgejo, chat and projects are read and changed only with Phosphorus tools ("files" are mesh shares, "chat" is the mesh chat, unless the user says otherwise). Other connectors stay free for their own part of a request (mail a summary, save a report).
- Host names come only from `mesh_hosts` (once per session); never guess or shorten one. A device with `phosphorus: false` can't be acted on: say so instead of calling a tool on it.
- Load the tools a job needs in one tool search, then fan out: independent reads go in one parallel batch. Report only the outcome and its evidence.
- Narrowest tool first: `host_stats` with no host before one host's full sample, `files_stat` over `files_read`, `files_search` over walking `files_list`, `service_health` over `terminal_run curl`, `host_logs` with `level`, `match`, `since` over a bare tail.
- Read before acting: `host_config` before `config_set` or `service_edit`, `files_read` or `files_stat` before `files_write` with old/new, `update_status` before `update_control`.
- Destructive tools (`host_power`, `files_change` delete, `files_copy` move, `config_set`, `service_edit`, `update_control`, `make_git_master`, `game_power`) need the user's clear intent for that exact target in this conversation. `dry_run` first where it exists, and show the diff. `host_power` takes `confirm` equal to the host name; never press `make_git_master` twice.
- Never ask for, take or type a password, key or token. `terminal_run` and `forgejo` use the saved logins on their own; a missing login is an answer to report, never a prompt.
- Every write through the key lands in `audit_log`. Report what changed, where, and how to undo it.
- A tool missing from the list: `version` names every tool kept off this key and why.

## Which tool

| need | tool |
|---|---|
| what's on the mesh | `mesh_hosts`, `services`, `files_list` (no host) |
| is it up, is it slow | `mesh_health`, `host_stats` (no host: every host's percents), `service_health` |
| why did it break | `host_logs` (source, level, since), `update_history` |
| run something | `terminal_run`; the user's own terminal: `open_terminal`, `terminal_screen`, `terminal_type` |
| files | `files_search`, `files_stat`, `files_read`, `files_write`, `files_change`, `files_copy` |
| services and config | `host_config`, `service_edit`, `config_set`, `service_request`, `game_power` |
| git | `git` (replication), `forgejo` (API as the user), `terminal_run` with `git: true` |
| people and chat | `people`, `chat_history`, `send_message`, `chat_wait`, `chat_edit` |
| the user's Phosphorus window | `open_view`, `open_file`, `show_file`, `switch_host`, `notify` |
| models and projects | `models` (chimp chats, orangutan runs projects), `set_model_role` (admin), `projects` |
| updates | `update_status`, `update_history`, `update_control` |
| outside the mesh | `fetch_page` (public pages only) |

## Errors

Failed calls return `code: message`:

- `bad_input`: fix the arguments from the message; never retry unchanged.
- `not_found`: a host, share, path, service or person that isn't there; re-list instead of guessing.
- `forbidden`: the key lacks the right (share perm, admin); say so and stop.
- `unreachable`: the host is down or off the tailnet; check `mesh_health` and `host_logs` on another host.
- `key refused` (HTTP 401): the key was refreshed or revoked; the user pastes the new url from **copy mcp url** into the connector.

## Reporting

Lead with the answer. Name hosts, services and paths exactly as phosphorus does. For a change: what, where, the before and after, how to undo. For a diagnosis: the evidence lines, the cause, the fix taken or proposed.

Built {{BUILT}} for the mesh at {{BASE}}, phosphorus {{VERSION}}. A newer mesh: download the skill again from the agent tray.
