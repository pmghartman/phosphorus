<p align="center"><img src=".github/assets/phosphorus-ascii.svg" alt="" width="160"></p>

<h2 align="center">Phosphorus</h2>

<p align="center"><b>Every computer you own, as one desktop in your browser.</b></p>

<p align="center">
  <a href="https://github.com/pmghartman/phosphorus/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/pmghartman/phosphorus?style=flat-square&color=a371f7"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/pmghartman/phosphorus?style=flat-square&color=f0883e"></a>
  <img alt="platforms" src="https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-555?style=flat-square">
</p>

Install it on each machine and they find each other. No servers to rent, no config files: one key, and your Macs, PCs and Linux boxes become one private mesh you can open from anywhere.

- **Terminals** on every host, a click away
- **One home folder** across every machine
- **Services and game servers**, started from the desktop
- **Git, chat and a local AI model**, shared by the whole mesh
- **Code sessions** with Claude Code or opencode on any host
- **Agents**: assign each mesh model to chat, inline suggestions, Claude Code and opencode from one page
- **An MCP server**, so Claude can work your mesh for you

<p align="center"><img src="packaging/sulfur/icon.svg" alt="" width="140"></p>

<h2 align="center">Sulfur</h2>

<p align="center"><b>A code editor that lives on every machine at once.</b></p>

Open any file on any host and edit it live, together. Build with each machine's own compilers. Run it in the browser or as its own desktop app, on the mesh or fully offline.

- **Feels like VS Code**: palette, completion, extensions, themes
- **Live collaboration** on every file
- **Language servers** for ten languages, installed per host
- **Claude Code and opencode** agents in the editor
- **Self-updating** apps for macOS, Windows and Linux

## Quick start

Grab Phosphorus or Sulfur from the [**latest release**](https://github.com/pmghartman/phosphorus/releases/latest), which has install steps for every platform. Phosphorus needs a free [Tailscale](https://tailscale.com) auth key; then open `http://HOST` from any device on your tailnet.

<details>
<summary><h2>Architecture</h2></summary>

```mermaid
flowchart TB
  subgraph release["GitHub release"]
    deb[".deb (amd64, arm64)<br/>binary, tailscale, cloudflared, forgejo"]
    dmg[".dmg"]
    exe["setup .exe"]
    sulf["Sulfur app<br/>.exe, .dmg, .deb"]
    feed["update feed: apt repo, app feed, latest.json"]
  end

  subgraph host["Host (Linux shown)"]
    dpkg["apt + postinst"]
    bin["phosphorus binary<br/>install, start, stop, keys, status, vpn, rebuild, upgrade, uninstall, ps"]
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
      model["model<br/>llama-server"]
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
  git <-->|"rsync replication, on change only"| peers
  ph --> model
  ph --> cfd --> cf --> browser
  browser -->|"/api/ping/host, timed by the page"| ph
  browser <-->|"tailnet, no domain"| ph
  sulf <-->|"mesh login, or offline"| ph
```

</details>

## License

Apache 2.0, see [`LICENSE`](LICENSE). Bundled software keeps its own license; full texts are in [`THIRD_PARTY_LICENSES.txt`](THIRD_PARTY_LICENSES.txt).

<p align="center">
  <img src=".github/assets/wright-alchemist.jpg" alt="The Alchemist Discovering Phosphorus, Joseph Wright of Derby" width="420">
</p>

<p align="center"><sub><i>The Alchymist, In Search of the Philosopher's Stone, Discovers Phosphorus</i>, Joseph Wright of Derby, 1771: Hennig Brand in 1669. Public domain, via <a href="https://commons.wikimedia.org/wiki/File:Joseph_Wright_of_Derby_The_Alchemist.jpg">Wikimedia Commons</a>.</sub></p>
