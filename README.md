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

Every computer you own as one shared desktop in the browser: terminals, files, web services, chat, status, git and a local AI model across all hosts, at your domain.

## Install

From the [latest release](https://github.com/pmghartman/phosphorus/releases/latest):

| System | Needs | Install |
|---|---|---|
| Linux | nothing | `sudo apt install ./phosphorus_VERSION_ARCH.deb` |
| macOS | colima, docker, docker-compose | `.dmg` |
| Windows | Docker Desktop, host networking on | setup `.exe` |

Fill in `.env` from `.env.example` in the host folder (`/var/lib/phosphorus`, `~/Library/Phosphorus` or `%USERPROFILE%\phosphorus`), then `sudo phosphorus start` or Start in the tray.

First login: user `admin`, password `ADMIN_PASS`; create a real admin and that login turns off.

## Config

`config/phosphorus.ini`, applied on save:

```ini
[files]
dir = files, /srv/media   # shared folders
priv = rwd, r             # read, write, delete per folder

[home]
dir = files               # which share holds home/ (users, shared/, sys/)

[git]
host = true               # run a git server replica here

[model]
host = true               # run the AI model, projects and web search here
gpu = true
url = https://huggingface.co/.../model.gguf
```

`config/services.export`, web services and game servers on this host:

```ini
[grafana]
port = 3001               # yourdomain/host/grafana/, or mode = subdomain

[terraria]
port = 7777
type = game
start = systemctl --user start tmodloader
stop = systemctl --user stop tmodloader
```

## Use

- `phosphorus` (or `phos`): terminal UI; `start`, `stop`, `restart`, `update`
- Mesh update: update icon in the bar (admins), one host at a time
- Projects API: `/api/projects`, see `internal/project`

## Layout

```
cmd/          phosphorus (every role: serve, model, elector, cli, ssh-relay), webbuild
internal/     Go packages
web/          browser client, bundled into the binary by go generate
container/    Dockerfile (phosphorus, model, git targets) and their scripts
scripts/      host install, start, rebuild and update (windows/ for Windows)
config/       default host config
packaging/    deb/ and app/ (Tauri tray app for macOS and Windows)
```

`make build`, `make check`, `make test`.

## License

Apache 2.0, see `LICENSE` and `THIRD_PARTY_NOTICES.md`.
