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

## Bring-up

| OS | Install yourself |
|---|---|
| Linux | Docker Engine + Compose, `git`, sudo |
| macOS | [colima](https://github.com/abiosoft/colima), Homebrew `docker`, `docker-compose`, `docker-buildx`, Xcode CLI tools, sudo |
| Windows | Docker Desktop (host networking on), Git for Windows, admin PowerShell |

```
git clone https://github.com/pmghartman/hesperus.git && cd hesperus
cp .env.example .env         # then fill it in
./scripts/run-linux.sh      # or run-mac.sh, or scripts/windows/run.ps1
```

Safe to re-run. On macOS set `hostname:` in `colima start --edit` first.
`TS_AUTHKEY` and `TS_API_KEY` in `.env` expire every 90 days.

## hesperus

| Command | Does |
|---|---|
| `hesperus` | The cli |
| `hesperus start` / `stop` / `restart` | Start, stop, restart this host |
| `hesperus update` | Update this host |
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
scripts/     hesperus, run, rebuild, update
files/       default share
state/       runtime state (not shipped)
models/      ggufs (not shipped)
```

## License

Copyright © 2026 Patrick Hartman. Apache License 2.0, see `LICENSE`.
Third-party licenses in `THIRD_PARTY_NOTICES.md`.
