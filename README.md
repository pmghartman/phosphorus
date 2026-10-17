<p align="center">
  <img src=".github/assets/phosphorus.svg" alt="phosphorus" width="300">
</p>

<p align="center">
  <img src=".github/assets/wright-alchemist.jpg" alt="The Alchemist in Search of the Philosopher's Stone, Joseph Wright of Derby" width="420">
  <br>
  <sub><i>The Alchemist in Search of the Philosopher's Stone</i>, Joseph Wright of Derby, 1771. Public domain, via <a href="https://commons.wikimedia.org/wiki/File:Joseph_Wright_of_Derby_The_Alchemist.jpg">Wikimedia Commons</a>.</sub>
</p>

Every computer you own as one shared desktop in your browser: terminals, files, web services, game servers, chat, live status, git and a local AI model, across all your machines, at your own domain.

## What you need

- A [Tailscale](https://tailscale.com) account (the free plan is enough) and a reusable auth key
- A domain on [Cloudflare](https://cloudflare.com) and a Cloudflare tunnel token (only for the first host)

## Install

Download from the [latest release](https://github.com/pmghartman/phosphorus/releases/latest).

**Host** (a machine that joins the mesh):

- **macOS**: open `phosphorus-VERSION-macos-universal.dmg`, drag Phosphorus to Applications and open it (the first time: right-click, Open).
- **Windows**: run `phosphorus-VERSION-windows-x86_64-setup.exe` (if SmartScreen warns: More info, Run anyway).
- **Linux**: `sudo apt install ./phosphorus_VERSION_ARCH.deb`, then `sudo phosphorus`.

Tailscale is installed on first start if it's missing. On macOS, allow its VPN configuration when asked.

**Client only** (just a window onto the mesh, from any computer): install `phosphorus-client` for your system and enter your domain.

## First start

Phosphorus asks for its keys:

- **Tailscale auth key**: always needed. A machine joining an existing mesh needs nothing else; it copies the rest from the other hosts.
- **First setup** (only for the first host of a new mesh): your domain, the Cloudflare tunnel token, and optionally a Tailscale API token (for game server DNS) and an admin password.

Then open `https://your-domain`. The first login is user `admin` with your admin password; create your own admin account and that login turns off.

To change a key later: **Edit Keys** in the tray, or `phos keys`.

## Everyday use

**Tray icon** (macOS and Windows): Open, Start, Stop, Turn VPN Off/On, Check for Updates, Edit Keys, Uninstall, Quit.

**Command line** (any host): `phos` opens the terminal UI. Also `phos start`, `phos stop`, `phos status`, `phos vpn off`, `phos vpn on`, `phos update`, `phos update all`, `phos uninstall`.

**Updating**: admins click the update icon in the web bar (or run `phos update all`) to update every host at once.

## Settings

Edit `config/phosphorus.ini` in the host folder, or use `phos`. Changes apply when saved.

```ini
[files]
dir = files, /srv/media   # folders to share
priv = rwd, r             # read, write, delete for each folder

[git]
host = true               # keep a copy of the git server here (Linux only)

[model]
host = true               # run the AI model here, for the whole mesh
gpu = true                # use this machine's graphics card
url = https://huggingface.co/.../model.gguf
```

**A model host downloads a lot**: llama.cpp's `llama-server` (plus NVIDIA's CUDA runtime on an NVIDIA card), opencode, and the model itself, often several GB. Turning `host` off removes them. You pick the model, so following its license is up to you.

To show a web service or game server on the mesh, add it to `config/services.export`:

```ini
[grafana]
port = 3001               # at your-domain/host/grafana/

[terraria]
port = 7777
type = game
start = systemctl --user start tmodloader
stop = systemctl --user stop tmodloader
```

## Coming soon

**Projects**: long-running tasks the AI works on by itself in a sandbox. They're paused while the sandbox is rebuilt.

## Troubleshooting

| | Host folder | Log |
|---|---|---|
| macOS | `~/Library/Phosphorus` | `~/Library/Phosphorus/state/phosphorus.log` |
| Windows | `%USERPROFILE%\phosphorus` | `%USERPROFILE%\phosphorus\state\phosphorus.log` |
| Linux | `/var/lib/phosphorus` | `journalctl -u phosphorus` |

A failed install or update also leaves `state/install.log` in the host folder.

## How it fits together

```mermaid
flowchart TB
  subgraph release["GitHub release"]
    deb[".deb (amd64, arm64)<br/>binary, tailscale, cloudflared, forgejo"]
    dmg[".dmg"]
    exe["setup .exe"]
    client["client-only installers"]
    feed["update feed: apt repo, app feed, latest.json"]
  end

  subgraph host["Host (Linux shown)"]
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
    peers["other hosts, Linux, macOS and Windows"]
  end
  cf["Cloudflare tunnel"]
  browser["Browser or client app at BASE_DOMAIN"]

  deb --> dpkg --> bin
  dmg & exe -->|"tray app: install, start, keys"| bin
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

## Building

`make build` builds the binary, `make check` and `make test` run the checks, and `make licenses` refreshes `THIRD_PARTY_LICENSES.txt` after a dependency changes.

## License

Apache 2.0, see `LICENSE`. Everything phosphorus bundles or downloads keeps its own license; the full texts are in `THIRD_PARTY_LICENSES.txt`, included in every installer.
