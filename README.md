<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/title-dark.svg">
    <img src=".github/assets/title-light.svg" alt="hesperus" width="360">
  </picture>
</p>

<p align="center">
  <img src=".github/assets/hesperus-mengs.jpg" alt="Hesperus as personification of the evening, Anton Raphael Mengs" width="420">
  <br>
  <sub><i>Hesperus als Personifikation des Abends</i>, Anton Raphael Mengs, c. 1765. Public domain, via <a href="https://commons.wikimedia.org/wiki/File:Mengs,_Hesperus_als_Personifikation_des_Abends.jpg">Wikimedia Commons</a>.</sub>
</p>

One container per machine, each a **host** on the mesh at `BASE_DOMAIN` (`.env`):
its services published, the others' polled, one web UI and cli for all of them.

## Install

From the latest release:

| OS | Needs | Install |
|---|---|---|
| Linux (Debian, Ubuntu) | nothing, apt pulls Docker | `sudo apt install ./hesperus_VER_ARCH.deb` (`amd64` or `arm64`) |
| macOS | [colima](https://github.com/abiosoft/colima), Homebrew `docker`, `docker-compose` | open `hesperus-VER-macos-universal.dmg`, drag Hesperus to Applications, open it (first open: right-click > Open) |
| Windows | Docker Desktop (host networking on) | run `hesperus-VER-windows-x86_64-setup.exe` (SmartScreen: More info > Run anyway) |

Each host's own files live in its **home**: `/var/lib/hesperus` (Linux),
`~/Library/Hesperus` (macOS), `%USERPROFILE%\hesperus` (Windows). That covers `.env`, `config/`,
`state/`, `git/data/`, `files/` and `models/`, none of them touched by an update. Fill in
`.env` from `.env.example`, then `hesperus start` (`sudo` on Linux; the tray's Start on
macOS and Windows). On macOS set `hostname:` in `colima start --edit` first.
`TS_AUTHKEY` and `TS_API_KEY` in `.env` expire every 90 days.

Images come prebuilt from `ghcr.io/pmghartman/hesperus` and `hesperus-git`, tagged by
release. A git checkout still runs from source: `./scripts/run-linux.sh` (or `run-mac.sh`,
`scripts/windows/run.ps1`) builds them locally.

## Updates

The update button checks the release feed first, then walks the mesh host by host. Each
host hands the update to its agent:

- Linux: `hesperus-update.path` runs `apt` against the signed feed, postinst pulls and swaps.
- macOS, Windows: the tray app runs the Tauri updater, relaunches, pulls and swaps.

`hesperus update` and the tray's Check for Updates do the same for one host.

## From phosphorus

Installing on a host that runs an old phosphorus (or git-era hesperus) checkout migrates
it. The installer finds the old checkout through its container, stops it (kept, restart
off, for a rollback), then moves into the home:

- `.env` as it was, `PHOS_UPDATE_PASSWORD` renamed `HESPERUS_UPDATE_PASSWORD`, `GAME_ZONE=hesperus`
- `config/phos.ini` as `config/hesperus.ini`, `services.export`, `state/`, `files/`, `models/`, `git/data/`
- the tailscale volume, so the node keeps its tailnet name and ip with no new auth key, and
  the Windows git and model volumes

Never press update on an old phosphorus host: it resets to the phosphorus repo's `main`,
now a different project. Migrate the git master first, then the replicas, in one sitting.
Delete the old checkout once hesperus is up. By hand: `scripts/migrate.sh OLD HOME`.

## Releasing

The manual `release` workflow: images to ghcr, `.deb`, `.dmg`, setup `.exe`, release
`vVERSION`, and the `update` feed. Once: make both ghcr packages public, set secrets
`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `APT_GPG_KEY` and variable
`TAURI_UPDATER_PUBKEY`. Without them the installers still build, with no update feed.

## hesperus

| Command | Does |
|---|---|
| `hesperus` | The cli |
| `hesperus start` / `stop` / `restart` | Start, stop, restart this host |
| `hesperus update` | Update this host from the release feed |
| `hesperus update all` | Update the mesh (`HESPERUS_UPDATE_PASSWORD`) |

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

## hesperus.ini

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

- **Chat**: channels, dms, reactions, replies, attachments, markdown and LaTeX.
  `/chimp` asks the small model through
  [opencode](https://github.com/anomalyco/opencode)'s harness, with its own
  tools (bash, files, grep in the container's files share), web search and
  hesperus's MCP tools (`POST /api/mcp`). A password an action needs (a mesh
  update's) goes in a box by the chat, never to the model. The editor tab last open goes with
  each ask. Right click a line to react, reply, edit or delete.
- **Files**: each host's shares, opened in a live shared editor, saved as you
  type, markdown rendered with checkable tasks, nothing ever executed.
- **Projects**: the orangutan (the big model) only works on these: a brief and
  up to 14 days (72h default), worked alone in rounds of plan, execute, test and
  refine until it calls `project_finish` or time runs out. One per host,
  resumed after a restart, told when one cut a round short. Its model host going offline pauses it, mid-round
  too, the clock held, until that same model answers again. It has opencode's own tools: its bash runs in a
  `hesperus-sandbox-<id>` container off the hesperus image, on the `hesperus-sandbox` network, which iptables cuts off
  from the tailnet, the lan and the host; its file and search tools are held to the workspace, links out of it
  refused; todowrite is the task list shown; task hands pieces to an `orangutan-helper` subagent; webfetch goes
  through the frontend's fenced fetch, public addresses only at every redirect; lsp servers (typescript,
  pyright, bash, gopls, rust-analyzer, clangd) and formatters run by `docker exec` in the sandbox, installed
  there as needed, never on the host. Records in `state/project-runs/`,
  workspaces in `state/projects/`, served read only as the `projects` share.
  API: `GET/POST /api/projects`, `GET /api/projects/<host>/<id>`,
  `POST .../stop|note|delete`.
- **Status**: btop for the whole mesh, one card per host.
- **Terminals**: a shell on any host.

## Layout

```
config/      services.export, hesperus.ini (per host)
container/   hesperus image
frontend/    node service; web/ the UI, cli/ hesperus
git/         hesperus-git image
scripts/     hesperus, run, rebuild, install, migrate, upgrade
build/       .deb packaging
gui/         tray app (Tauri), macOS and Windows
files/       default share
state/       runtime state (not shipped)
models/      ggufs (not shipped)
```

## License

Copyright © 2026 Patrick Hartman. Apache License 2.0, see `LICENSE`.
Third-party licenses in `THIRD_PARTY_NOTICES.md`.
