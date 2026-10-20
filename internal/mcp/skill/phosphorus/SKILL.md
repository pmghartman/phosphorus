---
name: phosphorus
description: Operates the user's self-hosted Phosphorus mesh through the Phosphorus connector's tools. Use when the user names phosphorus or the mesh, one of its hosts by name, or asks about their own servers, homelab or tailnet: hosts up or slow, services and game servers on the mesh, files in mesh shares, terminals or commands on a host, host or container logs, the mesh's forgejo, the mesh chat, its models (chimp, orangutan) or projects, or a mesh update.
---

# Phosphorus

Phosphorus is a mesh of the user's own machines on one tailnet. Every machine running phosphorus is a **host**: it shares folders, publishes web services and game servers, runs terminals, keeps logs, and may carry a Forgejo replica or a model. The Phosphorus connector (an MCP server, named phosphorus or Phosphorus) answers for the whole mesh from any host; every call is made as **{{USER}}**{{ADMIN_NOTE}}, with exactly that user's rights. Its tools may show with a prefix (`mcp__phosphorus__`, `Phosphorus:`); the bare names below are the same tools. No Phosphorus tools at all: tell the user to add the connector with the url from **copy mcp url** in the agent tray, and stop.

Every tool's description and arguments come with the connector itself. `references/tools.md` holds the same text, generated for this user; read it only when a tool's schema isn't loaded.

Read the one job file that fits the request before the first call:

| request | file |
|---|---|
| how's the mesh, is everything up, check on a host | `references/status.md` |
| something is down, slow, failing or erroring | `references/diagnose.md` |
| run a command or script on a host or every host | `references/run.md` |
| find, read, edit, copy or organize files | `references/files.md` |
| publish, change, remove or check a service or game server, call its API | `references/service.md` |
| update the mesh, follow, retry or cancel an update | `references/update.md` |
| read or post chat, message someone, wait for a reply | `references/chat.md` |
| forgejo, repos, issues, pull requests, clone or push, replication | `references/git.md` |
| a host slow, full or not answering, moving data between hosts, long jobs, models | `references/playbooks.md` |

Multi-step work across many hosts: run independent calls in parallel and report only the outcome and its evidence, never every raw result.

## Ground rules

- Scope: the mesh is the Phosphorus connector's alone. Its hosts, shares, services, terminals, logs, Forgejo, chat and projects are read and changed only with Phosphorus tools, never looked for in another app ("files" are mesh shares, "chat" is the mesh chat, unless the user says otherwise). Other connectors and tools stay free for their own part of a request, alongside these (mail a summary, put a date in a calendar, save a report to a drive); use one only when the request calls for it.

- Start with `mesh_hosts` once per session. Host names come only from it; never guess or shorten one. Only hosts with phosphorus can be acted on.
- Read before acting: `host_config` before `config_set` or `service_edit`, `files_read` or `files_stat` before `files_write` with old/new, `containers` before `container_control`, `update_status` before `update_control`.
- Fan out reads. Independent reads (several hosts' `host_stats`, `mesh_health` with `services`) go in one parallel batch.
- Prefer the narrowest tool: `files_stat` over `files_read`, `files_search` over walking `files_list`, `service_health` over `terminal_run curl`, `host_logs` with `level`, `match`, `since` over a bare tail.
- Never ask for, take or type a password, key or token. Credentials live in the user's vault in phosphorus; `terminal_run` and `forgejo` use the saved login on their own. A missing login is an answer to report, never a prompt.
- Destructive tools (`host_power`, `container_control`, `files_change` delete, `files_copy` move, `config_set`, `service_edit`, `update_control`, `make_git_master`, `game_power`) need the user's clear intent for that exact target in this conversation. Use `dry_run` first where it exists and show the diff. `host_power` takes `confirm` equal to the host name; never press `make_git_master` twice.
- Every write through the key lands in `audit_log`. Report what changed, where, and how to undo it.
- A tool missing from the list is not a failure to work around: `version` names every tool kept off this key and why (admin only, local only).

## Which tool

| need | tool |
|---|---|
| what's on the mesh | `mesh_hosts`, `services`, `files_list` (no host) |
| is it up, is it slow | `mesh_health`, `host_stats`, `service_health` |
| why did it break | `host_logs` (source, level, since), `containers`, `update_history` |
| run something | `terminal_run` (session keeps cwd and env; `mode: ssh` for a clean shell) |
| the user's own terminal | `open_terminal`, `terminal_screen`, `terminal_type` (they press Enter) |
| find, read, write files | `files_search`, `files_read` (12000 chars a page, `from`), `files_write`, `files_change`, `files_copy` |
| a service's API | `service_request` (past phosphorus's login, over the tailnet) |
| publish or change a service | `host_config`, `service_edit` (dry_run), `service_health` |
| config | `host_config`, `config_set` (dry_run) |
| git | `git` (replication), `forgejo` (API as the user), `terminal_run` with `git: true` (clone, push) |
| people and chat | `people`, `chat_history`, `send_message`, `chat_wait`, `chat_edit` |
| the user's Phosphorus window | `open_view`, `open_file`, `show_file`, `switch_host`, `notify` |
| models and projects | `models`, `set_model_role`, `projects` |
| updates | `update_status`, `update_history`, `update_control` |
| outside the mesh | `fetch_page` (public pages only) |

## Shares and paths

- A share is a folder a host exports, addressed as host + share id + path relative to the share root. `files_list` with no host gives every host's shares and their perms: `r` read and download, `w` write, upload, mkdir, rename, `d` delete.
- `home` is the merged per user share; on a key only the user's own part is visible.
- Folders end in `/` in listings. `files_change` rename with `to` ending in `/` moves into that folder. `steps` batches several changes and stops at the first failure.
- Binary files and files over 512KB are described, never read; move them with `files_copy`, inspect them with `terminal_run`.

## terminal_run

- Runs as the user's saved login for that host. Default mode with a saved login is a persistent session: `cd`, exports and background jobs carry across calls. `reset: true` starts it fresh.
- Multi-line scripts work over session and ssh. Feed file content through `stdin` (`cat > path`) instead of quoting it into the command.
- `wait_s` up to 600 before the command is killed; start long jobs in the background (`nohup ... &`) and poll.
- `git: true` hands git the user's Forgejo login for https clone, fetch and push, in a fresh shell.
- Exit code and combined output come back; a non-zero exit is the result to read, not a reason to retry blindly.

## Errors

Failed calls return `code: message`, with `data` when there's more:

- `bad_input`: fix the arguments from the message; never retry unchanged.
- `not_found`: a host, share, path, service or person that isn't there; re-list instead of guessing.
- `forbidden`: the key lacks the right (share perm, admin); say so and stop.
- `unreachable`: the host is down or off the tailnet; check `mesh_health` and `host_logs` on another host.
- `key refused` (HTTP 401): the key was refreshed or revoked; the user pastes the new url from **copy mcp url** into the connector.

## Reporting

Lead with the answer. Name hosts, services and paths exactly as phosphorus does. For a change: what, where, the before and after, how to undo. For a diagnosis: the evidence lines from logs or stats, the cause, the fix taken or proposed.

Built {{BUILT}} for the mesh at {{BASE}}, phosphorus {{VERSION}}; `references/tools.md` matches that release. A newer mesh: download the skill again from the agent tray.
