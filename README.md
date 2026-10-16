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

From the [latest release](https://github.com/pmghartman/phosphorus/releases/latest), per OS:

| System | Client only | Host | Host needs |
|---|---|---|---|
| Linux | `sudo apt install ./phosphorus-client_VERSION_ARCH.deb` | `sudo apt install ./phosphorus_VERSION_ARCH.deb`, then `sudo phosphorus` | systemd |
| macOS | `phosphorus-client-VERSION-macos-universal.dmg` | `phosphorus-VERSION-macos-universal.dmg` | colima, docker |
| Windows | `phosphorus-client-VERSION-windows-x86_64-setup.exe` | `phosphorus-VERSION-windows-x86_64-setup.exe` | Docker Desktop, host networking on |

The client is the mesh's frontend in a window with no menu bar; it asks for the mesh's domain on first start. The macOS and Windows host apps include the client: opening the app opens the same window, and a tray icon runs the host.

The host installer carries the `phosphorus` binary, which installs the release into the host folder (`/var/lib/phosphorus`, `~/Library/Phosphorus` or `%USERPROFILE%\phosphorus`) and brings it up. There are no scripts to run.

On Linux the host runs natively, no Docker: `phosphorus.service` runs `phosphorus run`, which keeps the frontend, cloudflared, the model and the git daemon as its own labelled child processes (`phos ps`, logs in `journalctl -u phosphorus`). Tailscale is the machine's own `tailscaled` when one is running, else the bundled one as `phosphorus-tailscaled.service`. cloudflared, forgejo and tailscale ship in the package under `/usr/libexec/phosphorus`; the distro packages a role needs (git, rsync, sqlite3 on a git host, curl, ripgrep, libgomp1 on a model host) are installed on the first start that needs them.

A Linux host still on the Docker release moves over on its next update by itself: the same tailnet node, git data and model, then its old containers, images, volumes and networks removed. If the native service doesn't come up, the containers are started again as they were. macOS and Windows hosts still run in Docker.

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

`.env` is readable only by root on Linux, and by the account running Docker plus SYSTEM on macOS and Windows. Keys are never displayed. To replace one, use Edit Keys in the tray, `phos keys`, or `k` in the cli. Paste the new value; blank fields keep what is set. Saving restarts phosphorus with the new keys.

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
host = true               # run the AI model here (projects coming soon)
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

- `phosphorus` (or `phos`): the cli; `start`, `stop`, `restart`, `update`, `update all`, `keys`, `ps` (Linux: phosphorus's processes by role)
- Host app (macOS, Windows): opening it opens the frontend; tray: Start, Stop, Check for Updates, Edit Keys, Quit
- Mesh update: update icon in the bar (admins) or `phos update all`. Every peer updates at once through its own installer, then the host that started it
- Projects: coming soon, shelved while their sandboxes move off Docker; `/api/projects` still lists past ones

## How it fits together

```mermaid
flowchart TB
  subgraph release["GitHub release"]
    deb[".deb (amd64, arm64)<br/>binary, tailscale, cloudflared, forgejo"]
    dmg[".dmg"]
    exe["setup .exe"]
    client["client-only installers"]
    feed["update feed: apt repo, app feed, latest.json"]
    ghcr["ghcr.io images, macOS and Windows hosts"]
  end

  subgraph host["Linux host"]
    dpkg["apt + postinst"]
    bin["phosphorus binary<br/>install, start, stop, keys, rebuild, upgrade, ps"]
    agent["update agent<br/>phosphorus-update.path"]
    tsd["tailscaled<br/>the machine's, or phosphorus-tailscaled.service"]
    subgraph home["/var/lib/phosphorus"]
      env[".env (locked)"]
      cfg["config/ phosphorus.ini, services.export"]
      state["state/ native.env and the rest"]
      files["files/ and [files] shares"]
      gitdata["git/ forgejo data"]
    end
    sshd["host sshd"]
    subgraph svc["phosphorus.service: phosphorus run"]
      ph["frontend<br/>phosphorus serve"]
      cfd["cloudflared"]
      model["model<br/>llama-server, opencode"]
      git["git daemon<br/>forgejo, rsyncd, elector"]
    end
  end

  subgraph mesh["Tailnet"]
    peers["other hosts, macOS and Windows ones in Docker"]
  end
  cf["Cloudflare tunnel"]
  browser["Browser or client app at BASE_DOMAIN"]

  deb --> dpkg --> bin
  dmg & exe -->|"tray app, Docker"| ghcr
  bin -->|"keys form"| env
  bin -->|"release synced, old files removed"| home
  bin -->|"admin setup once"| sshd
  bin -->|"rebuild: native.env, systemctl"| svc
  ph -->|"reconfig: phosphorus rebuild"| bin
  env & cfg --> ph
  state <--> ph
  files <--> ph
  git <--> gitdata
  ph -->|"terminals, game play/stop"| sshd
  ph -->|"update request"| state
  state --> agent
  agent -->|"apt upgrade"| feed
  agent --> bin
  ph --- tsd
  ph <-->|"snapshots, files, chat, updates"| peers
  ph -->|"missing keys from /internal/keys"| peers
  git <-->|"rsync replication"| peers
  ph --> model
  ph --> cfd --> cf --> browser
  client --> browser
  browser -->|"/api/ping/host, timed by the client"| ph
```

## Layout

```
cmd/          phosphorus: roles (serve, model, elector, cli, ssh-relay), host commands (run, start, rebuild, ps and the rest); webbuild
internal/     Go packages, internal/host the host side the installers run
web/          browser client, bundled into the binary by go generate
container/    Dockerfile for the macOS and Windows hosts, and the git daemon every host runs
config/       default host config
packaging/    deb/ (Linux host: units, bundled tools) and app/ (Tauri app: the client everywhere, the host tray on macOS and Windows)
```

`make build`, `make check`, `make test`.

## License

Apache 2.0, see `LICENSE` and `THIRD_PARTY_NOTICES.md`.
