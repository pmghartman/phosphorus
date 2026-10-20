<p align="center">
  <img src=".github/assets/phosphorus.svg" alt="" width="210">
</p>

<h1 align="center">Phosphorus</h1>

<p align="center"><b>Every computer you own, as one desktop in your browser.</b></p>

<p align="center">
  <a href="https://github.com/pmghartman/phosphorus/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/pmghartman/phosphorus?style=flat-square&color=a371f7"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/pmghartman/phosphorus?style=flat-square&color=f0883e"></a>
  <img alt="platforms" src="https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-555?style=flat-square">
</p>

<p align="center">
  <a href="https://github.com/pmghartman/phosphorus/releases/latest">Download</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#everyday-use">Everyday use</a> ·
  <a href="#architecture">Architecture</a>
</p>

## Features

- **Terminals** on every host in browser windows, with `ssh <host>` to any peer
- **Files** across all hosts as one home, with a shared live editor and chosen files mirrored to every host
- **Services and game servers**, proxied by path or subdomain and started from the desktop
- **Chat**, live **status** and notifications, shared by the mesh
- **Git** on Forgejo, replicated to every host with an elected master
- **A local AI model**, hosted on one machine for all of them, with projects it works on alone in a sandbox
- **An MCP server** at `/api/mcp`: Claude or any MCP client reads the mesh and acts on it with your rights, running scripts on each host with your saved login and working on Forgejo with your saved git login; the agent button copies its url for any agent's MCP connector (web, desktop, phone), or downloads a Claude plugin (Claude Code, Cowork) of mesh skills and an operator agent that work through that connector, no key inside; with **show agent on screen** checked, every call it makes opens and lights the window it works in: editors for its files, the files window where it browses, a console per host for its commands and logs, the status, chat and git views
- **Accounts** with admin roles and a per-user vault of host and page logins

## Quick start

You need a [Tailscale](https://tailscale.com) account (the free plan works) and a reusable auth key.

1. **Download** the host installer from the [latest release](https://github.com/pmghartman/phosphorus/releases/latest).
2. **Install** it:

   | | |
   |---|---|
   | macOS | Open the `.dmg`, drag Phosphorus to Applications, open it (first time: right-click, Open) |
   | Windows | Run the setup `.exe` (SmartScreen: More info, Run anyway) |
   | Linux | `sudo apt install ./phosphorus_VERSION_ARCH.deb`, then `sudo phosphorus` |

3. **Enter your Tailscale auth key.** Tailscale is installed if missing. Every other host copies the rest from the mesh.
4. **Open** `http://HOST` from any device on the tailnet, using a host's name or tailnet IP.

The first login is `admin` with your admin password. Create your own admin account and that login turns off.

### Optional

- **A domain:** a [Cloudflare](https://cloudflare.com) domain and tunnel token give you `https://your-domain` off the tailnet, plus git.
- **More keys:** a Tailscale API token (game server DNS) and an admin password, set on the first host.

Change keys later with **Edit Keys** in the menu bar or tray icon (a form in your browser, served on this machine only), or `phos keys`.

## Everyday use

| | |
|---|---|
| Menu bar / tray icon (macOS, Windows) | Open Phosphorus, Start, Stop, Check for Updates, Edit Keys, Uninstall, Quit; updates itself from the signed feed |
| `phos` | Terminal UI |
| `phos start` / `stop` / `status` | Control this host |
| `phos vpn on` / `off` | Tailscale up, or Phosphorus and Tailscale down |
| `phos update` / `update all` | Update this host, or every host in the mesh at once |
| `phos uninstall` | Remove Phosphorus and its data |

A model host downloads llama.cpp, opencode and the model, often several GB. You pick the model, so its license is yours to follow.

## Architecture

<details>
<summary>How the pieces fit</summary>

```mermaid
flowchart TB
  subgraph release["GitHub release"]
    deb[".deb (amd64, arm64)<br/>binary, tailscale, cloudflared, forgejo"]
    dmg[".dmg"]
    exe["setup .exe"]
    feed["update feed: apt repo, app feed, latest.json"]
  end

  subgraph host["Host (Linux shown)"]
    dpkg["apt + postinst"]
    bin["phosphorus binary<br/>install, start, stop, keys, status, vpn, rebuild, upgrade, ps"]
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
      cfd["cloudflared<br/>with a domain only"]
      model["model<br/>llama-server, opencode"]
      git["git daemon, with a domain<br/>forgejo, rsyncd, elector"]
    end
  end

  subgraph mesh["Tailnet"]
    peers["other hosts, Linux, macOS and Windows"]
  end
  cf["Cloudflare tunnel (optional)"]
  browser["Browser<br/>http://host on the tailnet, or BASE_DOMAIN"]

  deb --> dpkg --> bin
  dmg & exe -->|"menu bar app: install, start, keys, self-update"| bin
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
  browser -->|"/api/ping/host, timed by the page"| ph
  browser <-->|"tailnet, no domain"| ph
```

</details>

## License

Apache 2.0, see [`LICENSE`](LICENSE). Bundled software keeps its own license; full texts are in `THIRD_PARTY_LICENSES.txt`, included in every installer.

<p align="center">
  <img src=".github/assets/wright-alchemist.jpg" alt="The Alchemist Discovering Phosphorus, Joseph Wright of Derby" width="420">
</p>

<p align="center"><sub><i>The Alchymist, In Search of the Philosopher's Stone, Discovers Phosphorus</i>, Joseph Wright of Derby, 1771: Hennig Brand in 1669. Public domain, via <a href="https://commons.wikimedia.org/wiki/File:Joseph_Wright_of_Derby_The_Alchemist.jpg">Wikimedia Commons</a>.</sub></p>
