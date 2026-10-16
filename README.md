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
| Linux | nothing | `sudo apt install ./phosphorus_VERSION_ARCH.deb`, then `sudo phosphorus` |
| macOS | colima, docker | `.dmg` |
| Windows | Docker Desktop, host networking on | setup `.exe` |

The installer carries the `phosphorus` binary, which installs the release into the host folder (`/var/lib/phosphorus`, `~/Library/Phosphorus` or `%USERPROFILE%\phosphorus`) and brings it up. There are no scripts to run.

## Keys

On first start the app opens a keys window and `phosphorus` opens a keys form. Paste the keys there; they go into the host folder's `.env`.

| Key | Needed |
|---|---|
| `TS_AUTHKEY` | always, a reusable Tailscale auth key |
| `BASE_DOMAIN` | first host of a mesh, copied from a peer otherwise |
| `TUNNEL_TOKEN` | first host of a mesh, copied from a peer otherwise |
| `TS_API_KEY` | optional, game split DNS, copied from a peer otherwise |
| `ADMIN_PASS` | optional, setup admin login and mesh update gate, copied from a peer otherwise |

A host joining an existing mesh needs only `TS_AUTHKEY`: once on the tailnet it copies the rest from the first peer that answers.

`.env` is readable only by root on Linux, and by the account running Docker plus SYSTEM on macOS and Windows. Keys are never displayed. To replace one, use Edit Keys in the tray, `phos keys`, or `k` in the cli. Paste the new value; blank fields keep what is set. Saving recreates the containers with the new keys.

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

- `phosphorus` (or `phos`): the cli; `start`, `stop`, `restart`, `update`, `update all`, `keys`
- Tray (macOS, Windows): Start, Stop, Check for Updates, Edit Keys, Quit
- Mesh update: update icon in the bar (admins) or `phos update all`. Every peer updates at once through its own installer, then the host that started it
- Projects API: `/api/projects`, see `internal/project`

## How it fits together

```mermaid
flowchart TB
  subgraph release["GitHub release"]
    deb[".deb (amd64, arm64)"]
    dmg[".dmg"]
    exe["setup .exe"]
    feed["update feed: apt repo, app feed, latest.json"]
    ghcr["ghcr.io images: phosphorus, -model, -git"]
  end

  subgraph host["Host machine"]
    subgraph installers["Installer"]
      dpkg["apt + postinst"]
      tray["Tray app: Start, Stop, Check for Updates, Edit Keys, Quit"]
    end
    bin["phosphorus binary<br/>install, start, stop, keys, rebuild, upgrade"]
    agent["update agent<br/>systemd path unit or tray app"]
    subgraph home["Host folder"]
      env[".env (locked)"]
      cfg["config/ phosphorus.ini, services.export"]
      state["state/"]
      files["files/ and [files] shares"]
    end
    sshd["host sshd"]
    subgraph docker["Docker"]
      ph["phosphorus<br/>tailscaled, frontend, cloudflared"]
      model["phosphorus-model<br/>llama-server, opencode"]
      search["phosphorus-search<br/>searxng"]
      git["phosphorus-git<br/>forgejo, litefs, elector"]
      updater["phosphorus-updater<br/>compose swap"]
    end
  end

  subgraph mesh["Tailnet"]
    peers["other hosts"]
  end
  cf["Cloudflare tunnel"]
  browser["Browser at BASE_DOMAIN"]

  deb --> dpkg --> bin
  dmg --> tray
  exe --> tray
  tray -->|"keys window, install, start"| bin
  bin -->|"keys form"| env
  bin -->|"release synced, old files removed"| home
  bin -->|"admin setup once"| sshd
  bin -->|"pull, compose up"| ghcr
  bin -->|"compose swap"| updater
  updater --> ph & model & search & git
  ph -->|"reconfig: phosphorus rebuild"| updater
  env --> ph
  cfg --> ph
  state <--> ph
  files <--> ph
  ph -->|"terminals, game play/stop"| sshd
  ph -->|"update request"| state
  state --> agent
  agent -->|"apt upgrade or app update"| feed
  agent --> bin
  ph <-->|"snapshots, files, chat, updates"| peers
  ph -->|"missing keys from /internal/keys"| peers
  git <-->|"litefs replication"| peers
  ph --> model & search
  ph --> cf --> browser
```

## Layout

```
cmd/          phosphorus: container roles (serve, model, elector, cli, ssh-relay), host commands; webbuild
internal/     Go packages, internal/host the host side the installers run
web/          browser client, bundled into the binary by go generate
container/    Dockerfile (phosphorus, model, git targets) and their scripts
config/       default host config
packaging/    deb/ and app/ (Tauri tray app for macOS and Windows)
```

`make build`, `make check`, `make test`.

## License

Apache 2.0, see `LICENSE` and `THIRD_PARTY_NOTICES.md`.
