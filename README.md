<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/wordmark-dark.svg">
    <img src=".github/assets/wordmark-light.svg" alt="phosphorus" width="440">
  </picture>
</p>

<p align="center">
  <img src=".github/assets/wright-alchemist.jpg" alt="The Alchemist in Search of the Philosopher's Stone, Joseph Wright of Derby" width="420">
  <br>
  <sub><i>The Alchemist in Search of the Philosopher's Stone</i>, Joseph Wright of Derby, 1771. Public domain, via <a href="https://commons.wikimedia.org/wiki/File:Joseph_Wright_of_Derby_The_Alchemist.jpg">Wikimedia Commons</a>.</sub>
</p>

One container per machine, each a **host** on the mesh at `BASE_DOMAIN` (`.env`):
its services published, the others' polled, one web UI and cli for all of them.

## Install

From the latest release:

| OS | Needs | Install |
|---|---|---|
| Linux (Debian, Ubuntu) | nothing, apt pulls Docker | `sudo apt install ./phosphorus_VER_ARCH.deb` (`amd64` or `arm64`) |
| macOS | [colima](https://github.com/abiosoft/colima), Homebrew `docker`, `docker-compose` | open `phosphorus-VER-macos-universal.dmg`, drag Phosphorus to Applications, open it (first open: right-click > Open) |
| Windows | Docker Desktop (host networking on) | run `phosphorus-VER-windows-x86_64-setup.exe` (SmartScreen: More info > Run anyway) |

Windows over ssh, no desktop needed (an admin account's session):

```powershell
Start-Process .\phosphorus-VER-windows-x86_64-setup.exe -ArgumentList '/S' -Wait
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Phosphorus\release\scripts\windows\install.ps1" -Headless
Get-Content -Wait $env:TEMP\phosphorus-install.log
```

`-Headless` runs detached from the session, so a dropped ssh never cuts the install short.

Each host's own files live in its **home**: `/var/lib/phosphorus` (Linux),
`~/Library/Phosphorus` (macOS), `%USERPROFILE%\phosphorus` (Windows). That covers `.env`, `config/`,
`state/`, `git/data/`, `files/` and `models/`, none of them touched by an update. Fill in
`.env` from `.env.example`, then `phosphorus start` (`sudo` on Linux; the tray's Start on
macOS and Windows). On macOS set `hostname:` in `colima start --edit` first.
`TS_AUTHKEY` and `TS_API_KEY` in `.env` expire every 90 days.

Images come prebuilt from `ghcr.io/pmghartman/phosphorus` and `phosphorus-git`, tagged by
release. The installers are the only way in; a clone of this repo doesn't run.

## Updates

The update button checks the release feed first, then walks the mesh host by host. Each
host hands the update to its agent:

- Linux: `phosphorus-update.path` runs `apt` against the signed feed, postinst pulls and swaps.
- macOS, Windows: the tray app runs the Tauri updater, relaunches, pulls and swaps.

`phosphorus update` and the tray's Check for Updates do the same for one host.

## Releasing

The manual `release` workflow: images to ghcr, `.deb`, `.dmg`, setup `.exe`, release
`vVERSION`, and the `update` feed. Once: make both ghcr packages public, set secrets
`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `APT_GPG_KEY` and variable
`TAURI_UPDATER_PUBKEY`. Without them the installers still build, with no update feed.

## phosphorus

| Command | Does |
|---|---|
| `phosphorus` | The cli, `phos` for short, every command below too |
| `phosphorus start` / `stop` / `restart` | Start, stop, restart this host |
| `phosphorus update` | Update this host from the release feed |
| `phosphorus update all` | Update the mesh (`PHOSPHORUS_UPDATE_PASSWORD`) |

## Services

`config/services.export`, a bad entry keeping the last good version:

```
[grafana]
port = 3001
mode = subdomain

[terraria]
port = 7777
type = game
start = systemctl --user start tmodloader
stop = systemctl --user stop tmodloader
```

| Key | Default | Meaning |
|---|---|---|
| `port` | none | TCP port (required), bound to `0.0.0.0` or the tailnet IP |
| `scheme` | `http` | `http` or `https` |
| `mode` | `path` | `path`: `<domain>/<host>/<name>/`, `subdomain`: `<name>.<domain>` |
| `base_path` | none | Sub-path stripped before proxying |
| `extras` | `{}` | JSON: `max_body`, `forwarded_proto` |
| `type` | none | `game`: tailnet only, at `<name>.<GAME_ZONE>:<port>` |
| `start`, `stop` | none | Games only: play/stop commands |

## phosphorus.ini

```
[files]
dir = files, /srv/media
priv = rwd, r

[git]
host = true

[model]
host = true
gpu = true
url = https://huggingface.co/ggml-org/gpt-oss-120b-GGUF/resolve/main/gpt-oss-120b-MXFP4.gguf
```

- `[files]`: shared directories, `r` read, `w` write, `d` delete. No auth, so
  never `/` or a home directory.
- `[git]`: runs forgejo, one elected master, the rest replicas.
- `[model]`: `host`, `gpu` (nvidia, x64), `url` (one `.gguf`), `ctx` (65536),
  `slots` (4). Needs ram plus vram of about the gguf's size plus 64KB a token.

Applied a few seconds after a change.

## Using it

The page is one desktop: log into one or more hosts over ssh, then icons for each
host's terminal, files, the editor, chat, status, projects, git and every service, windows
that move, snap and minimize to the task bar, and widgets on the desk. The `Φ` button
lists every app, shows or hides each widget, and opens about.

Widgets, placed and sized per browser:

- **mesh**: the hosts, the tailnet and the pings; expanded, a click moves this page to a host.
- **model**: each role's model and its context, picked here or in status.
- **game servers**: play and stop, the join address, a guest key.

Apps:

- **Chat**: channels, dms, reactions, replies, attachments, markdown and LaTeX.
  `/chimp` asks the small model through
  [opencode](https://github.com/anomalyco/opencode)'s harness, with its own
  tools (bash, files, grep in the container's files share), web search and
  phosphorus's MCP tools (`POST /api/mcp`). A password an action needs (a mesh
  update's) goes in a box by the chat, never to the model. The editor last focused goes with
  each ask. Unread lines badge the chat icon and its task. Right click a line to react, reply, edit or delete.
- **Files**: a file manager over each host's shares, cut, copy and paste across hosts;
  text opens in the editor, live and shared, saved as you type, markdown rendered with
  checkable tasks, nothing ever executed.
- **Git**: the git hosts, master and replicas with how far each trails, a caught up one
  made master in a click, beside forgejo itself.
- **Projects**: the orangutan (the big model) only works on these: a brief and
  up to 14 days (72h default), worked alone in rounds of plan, execute, test and
  refine until it calls `project_finish` or time runs out. One per host,
  resumed after a restart, told when one cut a round short. Its model host going offline pauses it, mid-round
  too, the clock held, until that same model answers again. It has opencode's own tools: its bash runs in a
  `phosphorus-sandbox-<id>` container off the phosphorus image, on the `phosphorus-sandbox` network, which iptables cuts off
  from the tailnet, the lan and the host; its file and search tools are held to the workspace, links out of it
  refused; todowrite is the task list shown; task hands pieces to an `orangutan-helper` subagent; webfetch goes
  through the frontend's fenced fetch, public addresses only at every redirect; lsp servers (typescript,
  pyright, bash, gopls, rust-analyzer, clangd) and formatters run by `docker exec` in the sandbox, installed
  there as needed, never on the host. Records in `state/project-runs/`,
  workspaces in `state/projects/`, served read only as the `projects` share.
  API: `GET/POST /api/projects`, `GET /api/projects/<host>/<id>`,
  `POST .../stop|note|delete`.
- **Status**: btop for the whole mesh, one card per host.
- **Terminal**: a shell on a logged in host.

## Layout

```
config/      services.export, phosphorus.ini (per host)
container/   phosphorus image
frontend/    node service; web/ the UI, cli/ phosphorus
git/         phosphorus-git image
scripts/     phosphorus, run, rebuild, install, upgrade
build/       .deb packaging
gui/         tray app (Tauri), macOS and Windows
files/       default share
state/       runtime state (not shipped)
models/      ggufs (not shipped)
```

## License

Copyright © 2026 Patrick Hartman. Apache License 2.0, see `LICENSE`.
Third-party licenses in `THIRD_PARTY_NOTICES.md`.
